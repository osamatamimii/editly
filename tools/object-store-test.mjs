/**
 * The seam that has to be right before anybody uses it.
 *
 * This package's whole purpose is that swapping object store is a variable and
 * not a rewrite. That claim is only worth anything if the second driver is
 * correct while nobody is running it — a driver switched on for the first time
 * during a migration, on live customer files, is not a plan.
 *
 * So the R2 signer is checked against **AWS's own published test vector**,
 * byte for byte. That vector is the only way to know a signature is right
 * without a Cloudflare account: SigV4 has no partial credit, and a signer that
 * is wrong in one character produces a 403 that names no cause.
 *
 * The rest is the property that matters more than either driver: **the two
 * behave the same at the seam.** Same key rule, same refusals, same shape of
 * answer. A caller that works on one and not the other means the seam is in
 * the wrong place.
 *
 * Usage: node tools/object-store-test.mjs
 * Requires: nothing. No network, no keys, no bucket.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { order } from "./lib/order.mjs";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-store-"));

function build(source, name) {
  const outfile = path.join(buildDir, name);
  const built = spawnSync(
    require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] }),
    [
      path.join(repoRoot, source),
      "--bundle", "--platform=node", "--format=esm", "--target=node22",
      `--outfile=${outfile}`, "--log-level=error",
    ],
    { stdio: "inherit" },
  );
  if (built.status !== 0) process.exit(1);
  return pathToFileURL(outfile).href;
}

const store = await import(build("lib/object-store/src/index.ts", "store.mjs"));
const sig = await import(build("lib/object-store/src/sigv4.ts", "sigv4.mjs"));
const keys = await import(build("lib/object-store/src/keys.ts", "keys.mjs"));

let checks = 0;
let failures = 0;
const check = (name, ok, detail = "") => {
  checks += 1;
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};
const section = (t) => console.log(`\n${t}`);

// ── The key rule ────────────────────────────────────────────────────────────

section("A key is a plain path, and nothing else gets through");
{
  check("an ordinary key passes", keys.isSafeKey("user1/proj2/clip.mp4"));
  check("a traversal does not", !keys.isSafeKey("user1/../../secrets/key"));
  /*
    The encoded form is the one that got through before.

    The API's old guard looked for a literal `..`; the URL parser resolves
    `%2e%2e` before the request leaves the process, and that process holds the
    service role key. The rule here matches on the shape a segment must have
    rather than on the shapes it must not, so there is no encoding to miss.
  */
  check("nor its percent-encoded twin", !keys.isSafeKey("user1/%2e%2e/%2e%2e/secrets"));
  check("nor a leading slash", !keys.isSafeKey("/user1/proj2/clip.mp4"));
  check("nor a trailing slash", !keys.isSafeKey("user1/proj2/"));
  check("nor a doubled slash", !keys.isSafeKey("user1//proj2/clip.mp4"));
  check("nor a segment starting with a dot", !keys.isSafeKey("user1/.hidden/clip.mp4"));
  check("nor two segments where three are required", !keys.isSafeKey("user1/clip.mp4"));
  check("nor an empty string", !keys.isSafeKey(""));
  check("ownership is the first segment", keys.isOwnedBy("user1/proj2/clip.mp4", "user1"));
  check("and not a prefix of it", !keys.isOwnedBy("user12/proj2/clip.mp4", "user1"));
  check("a prefix may be shorter than a key", keys.isSafePrefix("user1/proj2"));
  check("and may end in a slash", keys.isSafePrefix("user1/proj2/"));
  check("but still not traverse", !keys.isSafePrefix("user1/../other"));
}

// ── The signature ───────────────────────────────────────────────────────────

section("SigV4 matches AWS's own published vector");
{
  /*
    From AWS's "Example: GET Object" walkthrough for query-string
    authentication. Every input is theirs — the key, the credential, the date,
    the expiry, the region and service — so the expected signature is not a
    number this repository invented and could not have got wrong in both
    places at once.
  */
  const url = sig.presign({
    identity: {
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
      service: "s3",
    },
    method: "GET",
    endpoint: "https://examplebucket.s3.amazonaws.com",
    bucket: "test.txt",
    expiresInSeconds: 86400,
    now: new Date(Date.UTC(2013, 4, 24, 0, 0, 0)),
  });
  const signature = new URL(url).searchParams.get("X-Amz-Signature");
  check(
    "the signature is AWS's",
    signature === "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    signature ?? "none",
  );
  check("the algorithm is named", url.includes("X-Amz-Algorithm=AWS4-HMAC-SHA256"));
  check("and only host is signed", url.includes("X-Amz-SignedHeaders=host"));
  check("the secret never appears in the URL", !url.includes("wJalrXUtnFEMI"));
}

section("...and the encoding rules a signature is lost to");
{
  const identity = {
    accessKeyId: "AK",
    secretAccessKey: "SK",
    region: "auto",
    service: "s3",
  };
  const base = { identity, method: "GET", endpoint: "https://acc.r2.cloudflarestorage.com", bucket: "videos", expiresInSeconds: 60, now: new Date(0) };

  const slashes = sig.presign({ ...base, key: "u/p/clip.mp4" });
  check(
    "a key's slashes stay slashes",
    new URL(slashes).pathname === "/videos/u/p/clip.mp4",
    new URL(slashes).pathname,
  );

  /*
    `encodeURIComponent` leaves !'()* alone and the specification does not. A
    filename with an apostrophe signs one way here and verifies another way at
    the provider, and the 403 that comes back does not say which character did it.
  */
  const punctuation = sig.presign({ ...base, key: "u/p/it's (final)*.mp4" });
  check(
    "and RFC-3986 punctuation is escaped, which encodeURIComponent does not do",
    new URL(punctuation).pathname === "/videos/u/p/it%27s%20%28final%29%2A.mp4",
    new URL(punctuation).pathname,
  );

  // Query parameters are signed in sorted order; insertion order would sign a
  // different string than the provider rebuilds.
  const listed = sig.presign({ ...base, query: { prefix: "u/p/", "list-type": "2" } });
  const order = [...new URL(listed).searchParams.keys()].filter((k) => k !== "X-Amz-Signature");
  check("query parameters are signed in sorted order", order.join(",") === [...order].sort().join(","), order.join(","));

  const later = sig.presign({ ...base, key: "u/p/clip.mp4", now: new Date(3600_000) });
  check("a different minute gives a different signature", later !== slashes);
}

// ── The two drivers, at the seam ────────────────────────────────────────────

const supabase = store.objectStoreFrom({}, {
  provider: "supabase",
  bucket: "videos",
  supabase: { url: "https://example.supabase.co", serviceKey: "service-key" },
});
const r2 = store.objectStoreFrom({}, {
  provider: "r2",
  bucket: "videos",
  r2: { endpoint: "https://acc.r2.cloudflarestorage.com", accessKeyId: "AK", secretAccessKey: "SK" },
});

section("Both drivers refuse the same keys");
{
  for (const [name, s] of [["supabase", supabase], ["r2", r2]]) {
    let refused = 0;
    for (const bad of ["u/../p/x", "/u/p/x", "u/p/", "u/x", "u/%2e%2e/x"]) {
      try {
        s.address(bad, "GET");
      } catch {
        refused += 1;
      }
    }
    check(`${name} refuses all five`, refused === 5, `${refused}/5`);
  }
}

section("Both answer the same shape");
{
  const a = supabase.address("u/p/clip.mp4", "GET");
  const b = r2.address("u/p/clip.mp4", "GET");
  check("a GET address is a URL and a verb on both", a.url.startsWith("https://") && b.url.startsWith("https://") && a.method === "GET" && b.method === "GET");

  /*
    The verb is part of the address for exactly this reason.

    Supabase creates an object with POST and treats PUT as an update that 400s
    when the object does not exist; S3 has no POST for it. A caller that
    hardcoded either one would work on one provider only.
  */
  check("a write is POST on Supabase", supabase.address("u/p/clip.mp4", "PUT").method === "POST");
  check("and PUT on R2", r2.address("u/p/clip.mp4", "PUT").method === "PUT");

  check(
    "Supabase carries its credential in headers",
    Boolean(supabase.address("u/p/clip.mp4", "GET").headers.apikey),
  );
  check(
    "R2 carries none, because the signature is the credential",
    Object.keys(r2.address("u/p/clip.mp4", "GET").headers).length === 0,
  );
  check(
    "and R2's own URL never contains the secret",
    !r2.address("u/p/clip.mp4", "GET").url.includes("SK"),
  );
}

section("A signed upload URL is the point of the package");
{
  const signed = await r2.signedPut("u/p/clip.mp4", { expiresInSeconds: 600, contentType: "video/mp4" });
  check("R2 mints one without a network call", Boolean(signed?.url));
  check("it is a PUT", signed.method === "PUT");
  check("it expires", new Date(signed.expiresAt).getTime() > Date.now());
  check("it names the content type the browser must send", signed.headers["Content-Type"] === "video/mp4");
  check("it carries no credential of ours", !signed.url.includes("SK") && !signed.url.includes("service-key"));
  /*
    This is the whole migration in one assertion.

    Today the browser uploads to Supabase carrying the signed-in user's JWT,
    permitted by an RLS policy. R2 has no RLS, no JWT and no row policies —
    there is no equivalent and there never will be. A URL our own API signs is
    the only way a browser writes to R2, which makes this method the thing that
    has to exist before a migration is even possible.
  */
  check("and the browser needs nothing but the URL", new URL(signed.url).searchParams.has("X-Amz-Signature"));
}

section("What each provider can honestly say about itself");
{
  const facts = await r2.facts();
  check("R2 reports no per-file ceiling, rather than a comfortable number", facts.fileSizeLimit === null);
  check("and no content-type list", facts.allowedContentTypes === null);
  /*
    Not a shrug. It is the finding: on R2 every limit this product enforces has
    to be enforced in our code before the URL is signed. The 50 MB wall the app
    once promised past was a Supabase setting nobody here could see, and the
    refusal reached a browser our server never heard from.
  */
  check("private by default when no custom domain is attached", facts.publicReads === false);
  check("and it names which provider answered", facts.provider === "r2");
}

section("A playback URL is signed and expires, whatever the bucket also answers to");
{
  /*
    `signedGet` returned `${publicBase}/${key}` whenever a custom domain was
    configured — unsigned, no expiry, and the requested lifetime dropped on the
    floor. The reasoning was that a custom domain serves objects unsigned
    anyway, so a signature would be noise.

    It is not noise, because of who this URL is handed to. `publisher.ts` gives
    it to Meta with the comment "signed by the object store, short-lived, and
    long enough to outlive Meta's own fetch and transcode". On
    R2-with-a-custom-domain it was neither: a permanent, unauthenticated URL to
    somebody's finished video, living in a third party's logs and every proxy
    in between, for good.

    And it changed with no code change and no error — setting
    `OBJECT_STORE_PROVIDER=r2` with `R2_PUBLIC_BASE`, the documented migration
    path, was the whole trigger.
  */
  const withDomain = store.objectStoreFrom({}, {
    provider: "r2",
    bucket: "videos",
    r2: {
      endpoint: "https://acc.r2.cloudflarestorage.com",
      accessKeyId: "AK",
      secretAccessKey: "SK",
      publicBase: "https://files.example.test",
    },
  });

  const url = await withDomain.signedGet("u/p/source.mp4", 900);
  check("it carries a signature", /X-Amz-Signature=/.test(url), url.slice(0, 120));
  check("and an expiry", /X-Amz-Expires=900/.test(url), url.slice(0, 160));
  check(
    "rather than a bare public path that never stops working",
    !url.startsWith("https://files.example.test"),
    url.slice(0, 120),
  );

  // And the fact stays reportable: a bucket that also answers unsigned is a
  // bucket configuration question, and the deploy audit is where it belongs.
  const facts = await withDomain.facts();
  check("while the audit still knows the bucket answers unsigned too", facts?.publicReads === true);
}

section("Misconfiguration fails at the deploy, not at a customer's upload");
{
  let threw = false;
  try {
    store.objectStoreFrom({ OBJECT_STORE_PROVIDER: "r2" }, {});
  } catch {
    threw = true;
  }
  check("r2 selected with no keys refuses to construct", threw);

  const byDefault = store.objectStoreFrom(
    { SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" },
    {},
  );
  check(
    "and a deployment that has never heard of this package still gets Supabase",
    byDefault.provider === "supabase",
    byDefault.provider,
  );
}

section("An empty listing means empty, and a failed one says so");
{
  /*
    The one place in this package where swallowing a failure is a lie.

    Every other metadata call answers `null` and has a caller that renders "not
    known" and carries on. `list` has two callers that cannot: the API's
    deletion sweep, which reads an empty listing as "there is nothing left of
    this project" and reports the customer's bytes gone, and the health probe,
    whose entire output is whether a credential was *rejected* or a host never
    answered. An empty array says neither of those things, so a request that
    failed has to arrive as an error carrying its status.

    Both drivers are held to it, because a caller that works on one and not the
    other means the seam is in the wrong place.
  */
  const realFetch = globalThis.fetch;
  const calls = [];
  /** Answers every request the same way, and records what was asked. */
  const answerWith = (make) => {
    globalThis.fetch = async (url, init = {}) => {
      let body = null;
      try {
        body = init.body ? JSON.parse(init.body) : null;
      } catch {
        body = null;
      }
      calls.push({ url: String(url), body });
      return make(calls.length);
    };
  };
  const page = (rows) =>
    new Response(JSON.stringify(rows.map((name) => ({ name, id: name, metadata: { size: 1 } }))), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const xml = (keys, truncated = false) =>
    new Response(
      `<ListBucketResult>${keys.map((k) => `<Contents><Key>${k}</Key><Size>1</Size></Contents>`).join("")}` +
        `<IsTruncated>${truncated}</IsTruncated>${truncated ? "<NextContinuationToken>t</NextContinuationToken>" : ""}` +
        `</ListBucketResult>`,
      { status: 200, headers: { "content-type": "application/xml" } },
    );

  try {
    // ── A page is a page, on request ─────────────────────────────────────────
    calls.length = 0;
    answerWith(() => page(Array.from({ length: 100 }, (_, i) => `f${i}.mp4`)));
    const onePage = await supabase.list("u/p", { limit: 100 });
    check("Supabase returns the page it was asked for", onePage.length === 100, String(onePage.length));
    check(
      "and stops there rather than draining, which is what the sweep needs",
      calls.length === 1,
      `${calls.length} requests`,
    );
    check("the page size is the one the caller named", calls[0]?.body?.limit === 100, JSON.stringify(calls[0]?.body));
    check("and the key is the full path, not the leaf name", onePage[0]?.key === "u/p/f0.mp4", onePage[0]?.key);

    calls.length = 0;
    answerWith(() => xml(["u/p/a.mp4", "u/p/b.mp4"]));
    const r2Page = await r2.list("u/p", { limit: 100 });
    check("R2 returns one page too", r2Page.length === 2, String(r2Page.length));
    check("in one request", calls.length === 1, `${calls.length} requests`);
    check(
      "asking the store for that many keys and no more",
      new URL(calls[0].url).searchParams.get("max-keys") === "100",
      calls[0]?.url,
    );

    // ── Without a limit it still drains ──────────────────────────────────────
    calls.length = 0;
    answerWith((n) => (n === 1 ? page(Array.from({ length: 100 }, (_, i) => `f${i}.mp4`)) : page(["last.mp4"])));
    const drained = await supabase.list("u/p");
    check("a listing with no limit still drains every page", drained.length === 101, String(drained.length));

    calls.length = 0;
    answerWith((n) => (n === 1 ? xml(["u/p/a.mp4"], true) : xml(["u/p/b.mp4"])));
    check("and so does R2, by its continuation token", (await r2.list("u/p")).length === 2);

    // ── Empty is an answer ───────────────────────────────────────────────────
    answerWith(() => page([]));
    check("an empty page is an empty list, not an error", (await supabase.list("u/p")).length === 0);
    answerWith(() => xml([]));
    check("on R2 as well", (await r2.list("u/p")).length === 0);

    // ── A refusal keeps its status ───────────────────────────────────────────
    const failure = async (store_, make) => {
      answerWith(make);
      try {
        await store_.list("u/p", { limit: 10 });
        return "no error";
      } catch (error) {
        return error;
      }
    };

    for (const [name, driver] of [["Supabase", supabase], ["R2", r2]]) {
      const rejected = await failure(driver, () => new Response("no", { status: 401 }));
      check(
        `${name} turns a rejected credential into an error, not an empty page`,
        rejected instanceof store.ObjectStoreError && rejected.status === 401,
        String(rejected),
      );
      const broken = await failure(driver, () => new Response("no", { status: 503 }));
      check(
        `${name} keeps the status of a host that is having a moment`,
        broken instanceof store.ObjectStoreError && broken.status === 503,
        String(broken),
      );
      /*
        No answer at all — a timeout, a refused connection, a DNS failure. The
        status is null rather than a number, because "we do not know" is the
        thing the health page has to be able to say.
      */
      const silent = await failure(driver, () => {
        throw new TypeError("fetch failed");
      });
      check(
        `${name} says it does not know when nothing answered`,
        silent instanceof store.ObjectStoreError && silent.status === null,
        String(silent),
      );
    }
  } finally {
    globalThis.fetch = realFetch;
  }
}

section("Copying says so out loud rather than doing nothing");
{
  /*
    R2's copy needs a signed `x-amz-copy-source` header, which a query-string
    signer cannot produce. The alternative to throwing is a copy that returns
    successfully and copies nothing — leaving a duplicated project whose files
    still belong to the original, which is the exact shape of bug this codebase
    keeps finding: nothing fails and the product is silently wrong.
  */
  let message = "";
  await r2.copy("u/p/a.mp4", "u/q/a.mp4").catch((error) => {
    message = String(error.message);
  });
  check("R2 copy throws", message.length > 0);
  check("and the message says what is missing", /x-amz-copy-source/.test(message), message.slice(0, 60));
}

section("Every call to somebody else's server comes back, one way or another");
{
  /*
    `fetch` in Node has no timeout of any kind.

    That is not a detail — it is the difference between a slow provider and a
    stopped product. `remove()` is awaited from inside the worker's render
    loop: the retention sweep runs there, before the claim, and the clips path
    removes the tail of a previous set mid-render. A provider that accepts the
    connection and then goes quiet was a queue that stopped — no claims, no
    heartbeat, and `/healthz` still answering 200, because it reports whether
    the process is up rather than whether it is doing anything. The `try/catch`
    around the clips call is no help at all: a promise that never settles is
    not an error.

    Two checks, because "bounded" is two separate claims.

    First, that the bound is real: `list` is the one call that takes its
    timeout as an argument, so it can be made to prove in a tenth of a second
    what the others do in fifteen — a hung host becomes an error rather than
    an await that never returns.

    Second, that every other call goes through the same machinery, seen from
    the only place a caller can see it: whether an `AbortSignal` arrived with
    the request. `head`, `remove`, `copy` and `facts` are asked for real and
    the signals are counted. This is the check that goes red if a new method is
    added with a bare `fetch`, which is how `remove` and `copy` came to be
    unbounded in the first place — they were written beside calls that were.
  */
  const realFetch = globalThis.fetch;
  const seen = [];
  try {
    // A host that accepts the connection and says nothing, ever.
    globalThis.fetch = (url, init = {}) =>
      new Promise((_resolve, reject) => {
        seen.push({ url: String(url), signal: init.signal ?? null });
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });

    for (const [name, driver] of [["Supabase", supabase], ["R2", r2]]) {
      const began = Date.now();
      const outcome = await driver
        .list("u/p", { limit: 10, timeoutMs: 100 })
        .then(() => "answered", (error) => error);
      const elapsed = Date.now() - began;
      check(
        `${name} gives up on a host that went quiet`,
        outcome instanceof Error && elapsed < 5_000,
        `${String(outcome)} after ${elapsed}ms`,
      );
      check(
        `and says it does not know, rather than that the credential was refused`,
        outcome instanceof store.ObjectStoreError && outcome.status === null,
        String(outcome),
      );
    }

    /*
      And now the rest of the surface, one method at a time.

      Each is called with a timeout it will not reach inside this test, so what
      is being measured is not that it returns — it is what it handed to
      `fetch` on the way out. A call with no signal is a call that can wait for
      ever.
    */
    for (const [name, driver] of [["Supabase", supabase], ["R2", r2]]) {
      const bare = [];
      for (const [method, run] of [
        ["head", () => driver.head("u/p/a.mp4")],
        ["remove", () => driver.remove(["u/p/a.mp4"])],
        ["copy", () => driver.copy("u/p/a.mp4", "u/q/a.mp4")],
        ["facts", () => driver.facts()],
      ]) {
        const before = seen.length;
        // Started, not awaited: these have fifteen-second bounds and the point
        // is what they sent, which they send immediately.
        void Promise.resolve().then(run).catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 25));
        const made = seen.slice(before);
        // A method with nothing to ask — R2's `facts`, `copy` where the signer
        // cannot produce the header — is bounded by not going out at all.
        if (made.length === 0) continue;
        if (made.some((call) => !call.signal)) bare.push(method);
      }
      check(
        `${name} puts a deadline on every metadata call it makes`,
        bare.length === 0,
        `${bare.join(", ")} — Node's fetch waits for ever, and remove() is awaited inside the render loop`,
      );
    }
  } finally {
    globalThis.fetch = realFetch;
  }
}

section("Multipart, which is what lets a two-hour podcast leave the browser at all");
{
  /*
    `signedPut` is one URL and one PUT — right up to a few hundred megabytes
    and wrong for what this product is being built to take. A two-hour podcast
    is about seven gigabytes, and a single request that starts again from zero
    when a train enters a tunnel is not an upload.

    Today the large-file path is Supabase's `tus` endpoint, reached by the
    browser with the person's own session, and that is the one piece that makes
    changing storage provider a rewrite. This is its equivalent on the other
    side of that change.
  */
  const http = await import("node:http");
  const calls = [];
  let failComplete = false;
  const s3 = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://fake");
    const body = await new Promise((resolve) => {
      let text = "";
      req.on("data", (c) => { text += c; });
      req.on("end", () => resolve(text));
    });
    calls.push({ method: req.method, path: url.pathname, query: url.search, body });
    if (url.searchParams.has("uploads")) {
      res.writeHead(200, { "content-type": "application/xml" });
      res.end("<InitiateMultipartUploadResult><UploadId>up-123</UploadId></InitiateMultipartUploadResult>");
      return;
    }
    if (req.method === "POST" && url.searchParams.get("uploadId")) {
      res.writeHead(200, { "content-type": "application/xml" });
      // A 200 with an error inside is how S3 refuses this particular call.
      res.end(failComplete
        ? "<Error><Code>InvalidPart</Code></Error>"
        : "<CompleteMultipartUploadResult><ETag>\"final\"</ETag></CompleteMultipartUploadResult>");
      return;
    }
    res.writeHead(204).end();
  });
  await new Promise((r) => s3.listen(0, "127.0.0.1", r));
  const near = store.objectStoreFrom({}, {
    provider: "r2",
    bucket: "videos",
    r2: { endpoint: `http://127.0.0.1:${s3.address().port}`, accessKeyId: "AK", secretAccessKey: "SK" },
  });

  const GB = 1024 * 1024 * 1024;
  const begun = await near.beginMultipart("u/p/source.mp4", {
    expiresInSeconds: 6 * 3600,
    totalBytes: 7 * GB,
    parts: 140,
    contentType: "video/mp4",
  });

  check("it opens an upload with the provider", calls[0]?.method === "POST" && /[?&]uploads(=|&|$)/.test(calls[0].query), JSON.stringify(calls[0]));
  check("and reports the id the provider chose", begun.uploadId === "up-123", String(begun?.uploadId));
  check("one signed URL per part", begun.parts.length === 140, String(begun.parts.length));
  check("numbered from one, in order", begun.parts[0].partNumber === 1 && begun.parts[139].partNumber === 140);
  check(
    "each part carries its own number and the upload id",
    begun.parts.every((part) => part.url.includes(`partNumber=${part.partNumber}`) && part.url.includes("uploadId=up-123")),
  );
  check("and none of them carries our secret", begun.parts.every((part) => !part.url.includes("SK")));
  check("they are signed, not merely addressed", begun.parts.every((part) => /X-Amz-Signature=/.test(part.url)));
  check("the window covers the whole upload rather than one part", new Date(begun.expiresAt).getTime() - Date.now() > 5 * 3600 * 1000);

  /*
    The floor that fails at the worst possible moment.

    Every part but the last must be at least 5 MiB. An undersized part in the
    middle is accepted on upload and refused at assembly with `EntityTooSmall`
    — after every byte has been sent. So it is refused here, before a single
    URL is signed.
  */
  let refused = "";
  await near.beginMultipart("u/p/small.mp4", { expiresInSeconds: 600, totalBytes: 10 * 1024 * 1024, parts: 40 })
    .catch((e) => { refused = e.message; });
  check("parts below the provider's floor are refused before anything is signed", /minimum/.test(refused), refused.slice(0, 120));
  check("and the message names both numbers", /262144/.test(refused) && /5242880/.test(refused), refused.slice(0, 160));

  let tooMany = "";
  await near.beginMultipart("u/p/many.mp4", { expiresInSeconds: 600, totalBytes: 900 * GB, parts: 20000 })
    .catch((e) => { tooMany = e.message; });
  check("and so is a part count past what S3 accepts", /at most 10000 parts/.test(tooMany), tooMany.slice(0, 120));

  // Completion.
  calls.length = 0;
  await near.completeMultipart("u/p/source.mp4", "up-123", [
    { partNumber: 3, etag: '"c"' },
    { partNumber: 1, etag: '"a"' },
    { partNumber: 2, etag: '"b"' },
  ]);
  const done = calls[0];
  check("completing posts the part list", done?.method === "POST" && /uploadId=up-123/.test(done.query), JSON.stringify(done?.query));
  check(
    "in ascending order, because the browser reports parts as they finish and S3 assembles in the order it is given",
    order(done.body, "<PartNumber>1<", "<PartNumber>2<").ok &&
      order(done.body, "<PartNumber>2<", "<PartNumber>3<").ok,
    done.body,
  );
  check("carrying each provider etag", done.body.includes("&quot;a&quot;"), done.body);

  // An etag is the one value here that came back through a browser.
  calls.length = 0;
  await near.completeMultipart("u/p/source.mp4", "up-123", [{ partNumber: 1, etag: '"a"<Part><PartNumber>9' }]);
  check(
    "and an etag cannot write XML into our own request",
    !/<PartNumber>9<\/PartNumber>/.test(calls[0].body) && calls[0].body.includes("&lt;Part&gt;"),
    calls[0].body,
  );

  let noParts = "";
  await near.completeMultipart("u/p/source.mp4", "up-123", []).catch((e) => { noParts = e.message; });
  check("completing with no parts is refused", /no parts/.test(noParts), noParts);

  /*
    The failure that arrives as a success.

    CompleteMultipartUpload streams its response while it assembles, so the
    status line is written before the outcome is known and a real failure comes
    back as an `<Error>` document under a 200. Reading only the status would
    report a finished upload for an object that does not exist — and the next
    thing to touch it is a render.
  */
  failComplete = true;
  let hidden = "";
  await near.completeMultipart("u/p/source.mp4", "up-123", [{ partNumber: 1, etag: '"a"' }])
    .catch((e) => { hidden = e.message; });
  check("a 200 carrying an error is read as a failure", /InvalidPart/.test(hidden), hidden);
  failComplete = false;

  calls.length = 0;
  await near.abortMultipart("u/p/source.mp4", "up-123");
  check("aborting throws the parts away", calls[0]?.method === "DELETE" && /uploadId=up-123/.test(calls[0].query), JSON.stringify(calls[0]));

  /*
    And Supabase says no, which is the whole shape of the seam: the caller keeps
    the tus path it already has, and switches by configuration rather than by a
    rewrite the day the provider changes.
  */
  check("Supabase has no multipart we can sign, and says so with null", (await supabase.beginMultipart("u/p/x.mp4", { expiresInSeconds: 60, totalBytes: 10, parts: 1 })) === null);

  await new Promise((r) => s3.close(r));
}

section("A store with no ceiling is not a store we failed to ask");
{
  /*
    The one place where `null` meant two different things.

    `storage-limits.ts` reads the bucket's own `file_size_limit` and falls back
    to `FALLBACK_UPLOAD_BYTES` when it cannot get one. R2 has no bucket
    metadata at all, so its `facts()` returns `fileSizeLimit: null`
    deliberately — "there is no ceiling here" — and that fell straight into the
    same branch as "Storage did not answer". The fallback is fifty megabytes,
    labelled in its own comment as *Supabase's free-plan per-object ceiling*.

    So the migration whose entire economic case is larger files would have
    landed, and the product would have gone on refusing anything over 50 MB,
    naming a limit that does not exist on the provider actually in use, with
    every suite in this repository green. Nothing throws. Nothing logs. The
    only symptom is a customer being told their file is too big.

    Both answers are checked, because a fix that returns the large number
    unconditionally would pass a check for the first and quietly accept an
    upload that dies at the end of itself on the second.
  */
  const limits = await import(build("artifacts/api-server/src/lib/storage-limits.ts", "limits.mjs"));

  const saved = { ...process.env };
  const setEnv = (vars) => {
    for (const key of ["OBJECT_STORE_PROVIDER", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
      delete process.env[key];
    }
    Object.assign(process.env, vars);
    limits.forgetStorageLimit();
  };

  setEnv({
    OBJECT_STORE_PROVIDER: "r2",
    R2_ENDPOINT: "https://acc.r2.cloudflarestorage.com",
    R2_ACCESS_KEY_ID: "AK",
    R2_SECRET_ACCESS_KEY: "SK",
  });
  const onR2 = await limits.effectiveUploadLimitBytes();
  check(
    "on a store that names no limit, the ceiling is ours and not the free plan's",
    onR2 === limits.UNCAPPED_STORE_BYTES && onR2 > limits.FALLBACK_UPLOAD_BYTES,
    `${onR2} vs fallback ${limits.FALLBACK_UPLOAD_BYTES}`,
  );
  const said = await limits.storeCeiling();
  check("and the store is recorded as having answered", said.answered === true && said.bytes === null, JSON.stringify(said));

  // Nothing configured at all: `objectStoreFrom` throws, which is the "we could
  // not ask" case, and the conservative number is the right one there.
  setEnv({});
  const blind = await limits.effectiveUploadLimitBytes();
  check(
    "with nothing to ask, the conservative fallback still answers",
    blind === limits.FALLBACK_UPLOAD_BYTES,
    String(blind),
  );
  check("and it is not recorded as an answer", (await limits.storeCeiling()).answered === false);

  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  limits.forgetStorageLimit();
}

await rm(buildDir, { recursive: true, force: true });
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
console.log("The seam holds on both sides.");
