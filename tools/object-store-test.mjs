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

await rm(buildDir, { recursive: true, force: true });
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
console.log("The seam holds on both sides.");
