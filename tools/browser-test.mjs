/**
 * The browser half, in a browser.
 *
 * Everything else in this folder tests code that runs on a server. This tests
 * the code that runs on a phone, and it was the last untested thing in the
 * repository — which is awkward, because it is also where the most expensive
 * failure lives. A render that fails is a render the person can start again. An
 * upload that fails at 90% on a train is where they close the tab.
 *
 * `video-storage.ts` is a state machine spoken in tus: create an upload, ask
 * the *server* where it got to, send the next chunk at that offset, remember
 * the URL across a reload. None of that can be checked by reading it, and none
 * of it can be checked with mocks either — a mock of "the server's offset is
 * the one that counts" is a mock of the only thing worth testing. So this runs
 * the real module in a real Chromium against a real HTTP server that speaks
 * tus, and makes that server misbehave in the ways the network actually does:
 * an upload the server has forgotten, an offset that is not where the client
 * thought it was, a connection dropped mid-chunk.
 *
 * The poster-frame checks decode a real video whose first second is black,
 * because that is the file this code exists for. A dashboard of black
 * rectangles looks exactly like a broken app.
 *
 * Usage: node tools/browser-test.mjs
 * Requires: ffmpeg on PATH. Chromium is found automatically.
 */
import http from "node:http";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const workDir = await mkdtemp(path.join(tmpdir(), "editly-browser-"));
const PORT = 4123;
const ORIGIN = `http://127.0.0.1:${PORT}`;

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
const section = (title) => console.log(`\n${title}`);

// ─── A video whose first second is black ─────────────────────────────────────

const fixture = path.join(workDir, "fixture.webm");
{
  // VP8 rather than H.264 on purpose: the codec is not what is under test, and
  // a Chromium build without proprietary codecs would fail every poster check
  // for a reason that has nothing to do with this repository.
  const made = spawnSync(
    "ffmpeg",
    [
      "-y", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=black:s=480x270:r=15:d=1.2",
      "-f", "lavfi", "-i", "testsrc=s=480x270:r=15:d=3",
      "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]",
      "-map", "[v]", "-c:v", "libvpx", "-b:v", "400k", "-deadline", "realtime",
      fixture,
    ],
    { encoding: "utf8" },
  );
  if (made.status !== 0 || !existsSync(fixture)) {
    console.error("could not build the fixture clip\n", made.stderr?.slice(0, 400));
    process.exit(1);
  }
}

// ─── The module under test, bundled for a browser ────────────────────────────

/**
 * The entry lives inside the frontend package rather than in the temp
 * directory, because Node resolution is relative to the importing file: an
 * entry in /tmp finds a *different* copy of React than `video-storage.ts` does,
 * and two Reacts in one bundle means every hook reads its dispatcher as null.
 * The failure looks like a bug in the hook.
 */
const entryDir = path.join(repoRoot, "artifacts/editly/.browser-test");
const entry = path.join(entryDir, "entry.ts");
await mkdir(entryDir, { recursive: true });
await writeFile(
  entry,
  `import * as storage from "${repoRoot}/artifacts/editly/src/lib/video-storage";
   import * as checkout from "${repoRoot}/artifacts/editly/src/lib/checkout";
   import * as oauth from "${repoRoot}/artifacts/editly/src/lib/oauth";
   import * as load from "${repoRoot}/artifacts/editly/src/lib/load-state";
   import * as play from "${repoRoot}/artifacts/editly/src/lib/playability";
   import * as pending from "${repoRoot}/artifacts/editly/src/lib/pending-upload";
   import { createElement } from "react";
   import { createRoot } from "react-dom/client";
   (window as any).VS = storage;
   (window as any).CO = checkout;
   (window as any).OA = oauth;
   (window as any).LS = load;
   (window as any).PB = play;
   (window as any).PU = pending;
   (window as any).React = { createElement, createRoot };
  `,
);

const bundle = path.join(workDir, "bundle.js");
const built = spawnSync(
  require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] }),
  [
    entry,
    "--bundle", "--format=esm", "--target=es2022", "--log-level=error",
    `--outfile=${bundle}`,
    // The whole env object, rather than each key: the module reads
    // `import.meta.env.VITE_MAX_UPLOAD_BYTES` through Number(), and a partial
    // define would leave that reading from undefined.
    `--define:import.meta.env=${JSON.stringify({
      VITE_SUPABASE_URL: ORIGIN,
      VITE_SUPABASE_ANON_KEY: "anon-key-for-tests",
      VITE_MAX_UPLOAD_BYTES: String(8 * 1024 * 1024),
    })}`,
    "--define:process.env.NODE_ENV=\"production\"",
  ],
  { stdio: "inherit", cwd: path.join(repoRoot, "artifacts/editly") },
);
if (built.status !== 0) {
  console.error("could not bundle the frontend modules");
  process.exit(1);
}

// ─── A Storage that can misbehave ────────────────────────────────────────────

/**
 * State the tests reach into directly. This server lives in the same process as
 * the assertions on purpose: "the server forgot this upload" is a server-side
 * fact, and expressing it as a variable rather than a control endpoint keeps
 * each scenario one line at the top of its section.
 */
const storage = {
  log: [],
  uploads: new Map(),
  /** Set to a status to make the next single-shot POST fail with it. */
  failSingleWith: null,
  /** Pretend the server has never heard of the upload URL it handed out. */
  forgetUploads: false,
  /** Answer HEAD with an offset of our choosing, whatever was received. */
  claimOffset: null,
  /**
   * Drop the connection on this many PATCHes.
   *
   * More than one, because Chromium silently retries a request whose reused
   * keep-alive socket closed before any response arrived — so dropping exactly
   * one chunk tests the browser's retry logic rather than ours, and passes for
   * the wrong reason.
   */
  dropChunks: 0,
  /** Hold each PATCH open this long before answering, so a cancel has a moment
   *  to land. Localhost is otherwise faster than any human. */
  chunkDelayMs: 0,
  reset() {
    this.log = [];
    this.uploads.clear();
    this.failSingleWith = null;
    this.forgetUploads = false;
    this.claimOffset = null;
    this.dropChunks = 0;
    this.chunkDelayMs = 0;
  },
};

const page = `<!doctype html><meta charset="utf-8"><title>t</title>
<body><script type="module" src="/bundle.js"></script></body>`;

/**
 * Counts the bytes, and says whether the client stayed to the end. A request the
 * browser abandoned mid-body must not be recorded as a chunk that arrived —
 * that would make "cancel" look like it committed the bytes anyway.
 */
const readBody = (req) =>
  new Promise((resolve) => {
    let total = 0;
    let settled = false;
    const settle = (complete) => {
      if (settled) return;
      settled = true;
      resolve({ bytes: total, complete });
    };
    req.on("data", (c) => {
      total += c.length;
    });
    req.on("end", () => settle(true));
    req.on("error", () => settle(false));
    req.on("aborted", () => settle(false));
    req.on("close", () => settle(false));
  });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  const p = url.pathname;
  storage.log.push({ method: req.method, path: p });

  if (p === "/" ) return res.writeHead(200, { "content-type": "text/html" }).end(page);
  if (p === "/bundle.js")
    return res.writeHead(200, { "content-type": "text/javascript" }).end(readFileSync(bundle));
  if (p === "/fixture.webm")
    return res.writeHead(200, { "content-type": "video/webm" }).end(readFileSync(fixture));

  // A file that really cannot be decoded: the right content type, the wrong
  // bytes entirely. This is what the "will not play" notice exists for.
  if (p === "/nonsense.mp4")
    return res
      .writeHead(200, { "content-type": "video/mp4" })
      .end(Buffer.from("this is not a video, it is a sentence about one"));

  // A request that is answered by nobody, ever. The element sits in
  // NETWORK_LOADING with readyState 0 and no error — which is the exact state
  // the old fifteen-second timer read as "this file will not play".
  if (p === "/never-answers.mp4") {
    res.writeHead(200, { "content-type": "video/mp4" });
    return; // deliberately never ended
  }

  // Supabase's auth settings probe, used by the OAuth module.
  if (p === "/auth/v1/settings")
    return res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ external: { google: true, apple: false } }));

  // Signing an object key for playback.
  if (p.startsWith("/storage/v1/object/sign/")) {
    const key = p.slice("/storage/v1/object/sign/videos/".length);
    return res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ signedURL: `/object/sign/videos/${key}?token=signed-for-test` }));
  }

  // ── tus ──
  if (p === "/storage/v1/upload/resumable" && req.method === "POST") {
    await readBody(req);
    const id = `u${storage.uploads.size + 1}`;
    storage.uploads.set(id, { offset: 0, length: Number(req.headers["upload-length"]) });
    return res
      .writeHead(201, { location: `${ORIGIN}/storage/v1/upload/resumable/${id}` })
      .end();
  }
  if (p.startsWith("/storage/v1/upload/resumable/")) {
    const id = p.split("/").pop();
    const upload = storage.uploads.get(id);

    if (req.method === "HEAD") {
      if (storage.forgetUploads || !upload) return res.writeHead(404).end();
      const offset = storage.claimOffset ?? upload.offset;
      return res.writeHead(200, { "upload-offset": String(offset) }).end();
    }
    if (req.method === "PATCH") {
      if (!upload) return res.writeHead(404).end();
      if (storage.dropChunks > 0) {
        storage.dropChunks -= 1;
        return req.socket.destroy();
      }
      const { bytes: received, complete } = await readBody(req);
      if (!complete) return;
      if (storage.chunkDelayMs > 0) {
        await new Promise((r) => setTimeout(r, storage.chunkDelayMs));
      }
      if (res.writableEnded || res.destroyed) return;
      const stated = Number(req.headers["upload-offset"]);
      upload.patches = [...(upload.patches ?? []), { at: stated, bytes: received }];
      upload.offset = stated + received;
      return res.writeHead(204, { "upload-offset": String(upload.offset) }).end();
    }
  }

  // ── single-shot ──
  if (p.startsWith("/storage/v1/object/videos/") && req.method === "POST") {
    const { bytes } = await readBody(req);
    if (storage.failSingleWith) {
      const status = storage.failSingleWith;
      storage.failSingleWith = null;
      return res
        .writeHead(status, { "content-type": "application/json" })
        .end(JSON.stringify({ message: "the object exceeded the maximum allowed size" }));
    }
    storage.log[storage.log.length - 1].bytes = bytes;
    storage.log[storage.log.length - 1].key = p.slice("/storage/v1/object/videos/".length);
    return res.writeHead(200, { "content-type": "application/json" }).end("{}");
  }

  res.writeHead(404).end();
});
await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

// ─── A real browser ──────────────────────────────────────────────────────────

const { chromium } = require(
  require.resolve("playwright", {
    paths: [`${process.env.HOME}/.npm-global/lib/node_modules`, repoRoot],
  }),
);

/**
 * Where the browser is.
 *
 * A pinned path when the environment provides one — some sandboxes preinstall
 * Chromium and forbid the download — and otherwise Playwright's own, which is
 * what a CI runner has after `playwright install chromium`. Falling back rather
 * than requiring the pinned path means this suite runs in both places; failing
 * to find either is an error rather than a skip, because a browser suite that
 * quietly does not run is worse than one that is missing.
 */
function findChromium() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (root && existsSync(root)) {
    const dir = readdirSync(root).find((d) => /^chromium-\d+$/.test(d));
    if (dir) {
      const candidate = path.join(root, dir, "chrome-linux", "chrome");
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined; // Playwright resolves its own download.
}

const browser = await chromium.launch({
  ...(findChromium() ? { executablePath: findChromium() } : {}),
  args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
});
const browserPage = await browser.newPage();
const consoleErrors = [];
browserPage.on("pageerror", (error) => consoleErrors.push(String(error)));
await browserPage.goto(ORIGIN, { waitUntil: "load" });
await browserPage.waitForFunction("window.VS !== undefined", null, { timeout: 15_000 });

const run = (fn, arg) => browserPage.evaluate(fn, arg);

check("the frontend modules load in a browser at all", consoleErrors.length === 0, consoleErrors.join(" | "));

// ─── Which path an upload takes ──────────────────────────────────────────────

section("A small file goes in one request; anything worth resuming is resumed");
{
  storage.reset();
  const key = await run(async () => {
    const file = new File([new Uint8Array(1024 * 512)], "clip.mp4", { type: "video/mp4" });
    return window.VS.uploadProjectVideo({
      file,
      userId: "user-1",
      projectId: "proj-1",
      accessToken: "token",
    }).done;
  });

  const posts = storage.log.filter((l) => l.path.startsWith("/storage/v1/object/videos/"));
  check("half a megabyte is a single POST", posts.length === 1, JSON.stringify(storage.log));
  check("nothing resumable was created for it", !storage.log.some((l) => l.path.includes("/upload/resumable")));
  check("all of the bytes went", posts[0]?.bytes === 1024 * 512, String(posts[0]?.bytes));
  check(
    "and the key is the user's own folder, so the storage policy can see whose it is",
    key === "user-1/proj-1/source.mp4",
    key,
  );
}

section("The extension follows the file, and falls back to what the browser called it");
{
  storage.reset();
  const keys = await run(async () => {
    const upload = (name, type) =>
      window.VS.uploadProjectVideo({
        file: new File([new Uint8Array(16)], name, { type }),
        userId: "u",
        projectId: "p",
        accessToken: "t",
      }).done;
    return [
      await upload("holiday.MOV", "video/quicktime"),
      await upload("recording", "video/webm"),
      await upload("no-clue", ""),
    ];
  });

  check("an uppercase extension is not a different extension", keys[0] === "u/p/source.mov", keys[0]);
  check("a name with no extension takes one from the type", keys[1] === "u/p/source.webm", keys[1]);
  check("and an unknown type is stored as mp4 rather than as nothing", keys[2] === "u/p/source.mp4", keys[2]);
}

// ─── tus, and whose offset counts ────────────────────────────────────────────

section("A large file is chunked, and the server decides where each chunk goes");
{
  storage.reset();
  const SEVEN_MB = 7 * 1024 * 1024;
  const progress = await run(async (size) => {
    const seen = [];
    await window.VS.uploadProjectVideo({
      file: new File([new Uint8Array(size)], "big.mp4", { type: "video/mp4" }),
      userId: "u",
      projectId: "p",
      accessToken: "t",
      onProgress: (percent) => seen.push(percent),
    }).done;
    return seen;
  }, SEVEN_MB);

  const upload = [...storage.uploads.values()][0];
  check("an upload was created", storage.uploads.size === 1, String(storage.uploads.size));
  check("it went in two chunks", upload?.patches?.length === 2, JSON.stringify(upload?.patches));
  check("the first starts at zero", upload?.patches?.[0]?.at === 0, JSON.stringify(upload?.patches?.[0]));
  check(
    "the second starts where the server said the first ended",
    upload?.patches?.[1]?.at === upload?.patches?.[0]?.bytes,
    JSON.stringify(upload?.patches),
  );
  check("and every byte arrived exactly once", upload?.offset === SEVEN_MB, String(upload?.offset));

  check("progress was reported while it ran", progress.length > 2, JSON.stringify(progress));
  check(
    "it never says 100 before the bytes are committed",
    progress.slice(0, -1).every((p) => p < 100),
    JSON.stringify(progress),
  );
  check("and it does say 100 once they are", progress[progress.length - 1] === 100, JSON.stringify(progress));
}

section("The offset is the server's answer, not ours");
{
  storage.reset();
  // The server has already received four megabytes of this file — from a
  // previous run of the same upload, which is what resuming *is*. A client that
  // trusts its own bookkeeping instead of asking would send chunk one again and
  // corrupt the object.
  const FOUR_MB = 4 * 1024 * 1024;
  const NINE_MB = 9 * 1024 * 1024;
  storage.uploads.set("u1", { offset: FOUR_MB, length: NINE_MB });
  await run(
    async ({ size, origin }) => {
      const file = new File([new Uint8Array(size)], "resumed.mp4", { type: "video/mp4" });
      // Stand in for what a previous page load left behind.
      localStorage.setItem(
        `editly:upload:u/p/source.mp4:${file.size}:${file.lastModified}`,
        `${origin}/storage/v1/upload/resumable/u1`,
      );
      return window.VS.uploadProjectVideo({
        file,
        userId: "u",
        projectId: "p",
        accessToken: "t",
      }).done;
    },
    { size: NINE_MB, origin: ORIGIN },
  );

  // The upload the page thinks it is resuming into.
  const upload = storage.uploads.get("u1");
  check("it resumed into the existing upload rather than making a new one", storage.uploads.size === 1);
  check(
    "no new upload was created",
    !storage.log.some((l) => l.path === "/storage/v1/upload/resumable" && l.method === "POST"),
    JSON.stringify(storage.log.filter((l) => l.method === "POST")),
  );
  check("it asked where it had got to", storage.log.some((l) => l.method === "HEAD"));
  check(
    "and started from there, not from zero",
    upload?.patches?.[0]?.at === FOUR_MB,
    JSON.stringify(upload?.patches),
  );
  check("the remaining bytes are the ones that were missing", upload?.offset === NINE_MB, String(upload?.offset));
}

section("An upload the server has forgotten is started again, not patched into");
{
  storage.reset();
  storage.forgetUploads = true;
  const result = await run(
    async ({ origin }) => {
      const file = new File([new Uint8Array(7 * 1024 * 1024)], "stale.mp4", { type: "video/mp4" });
      const memory = `editly:upload:u/p/source.mp4:${file.size}:${file.lastModified}`;
      localStorage.setItem(memory, `${origin}/storage/v1/upload/resumable/gone-forever`);
      const key = await window.VS.uploadProjectVideo({
        file,
        userId: "u",
        projectId: "p",
        accessToken: "t",
      }).done;
      return { key, remembered: localStorage.getItem(memory) };
    },
    { origin: ORIGIN },
  );

  check("the upload still succeeds", result.key === "u/p/source.mp4", JSON.stringify(result));
  check(
    "by creating a fresh one",
    storage.log.some((l) => l.method === "POST" && l.path === "/storage/v1/upload/resumable"),
  );
  check("nothing was PATCHed at a URL the server does not know", !storage.log.some((l) => l.path.includes("gone-forever") && l.method === "PATCH"));
  check("and the dead URL is no longer remembered", result.remembered === null, String(result.remembered));
}

section("A different file at the same path is a different upload");
{
  storage.reset();
  const memories = await run(async () => {
    const a = new File([new Uint8Array(7 * 1024 * 1024)], "take-1.mp4", { type: "video/mp4" });
    const b = new File([new Uint8Array(7 * 1024 * 1024 + 5)], "take-2.mp4", { type: "video/mp4" });
    localStorage.clear();
    await window.VS.uploadProjectVideo({ file: a, userId: "u", projectId: "p", accessToken: "t" }).done;
    const afterA = Object.keys(localStorage).length;
    await window.VS.uploadProjectVideo({ file: b, userId: "u", projectId: "p", accessToken: "t" }).done;
    return { afterA, afterB: Object.keys(localStorage).length, uploads: null };
  });

  check("neither run leaves a half-finished upload remembered", memories.afterA === 0 && memories.afterB === 0, JSON.stringify(memories));
  check(
    "and the second take got its own upload rather than appending onto the first",
    storage.uploads.size === 2,
    String(storage.uploads.size),
  );
  const [first, second] = [...storage.uploads.values()];
  check("each holds only its own bytes", first.offset === 7 * 1024 * 1024 && second.offset === 7 * 1024 * 1024 + 5, `${first.offset} / ${second.offset}`);
}

// ─── Stopping ────────────────────────────────────────────────────────────────

section("Cancelling stops the transfer and says so");
{
  storage.reset();
  storage.chunkDelayMs = 1500;
  const result = await run(async () => {
    const handle = window.VS.uploadProjectVideo({
      file: new File([new Uint8Array(12 * 1024 * 1024)], "long.mp4", { type: "video/mp4" }),
      userId: "u",
      projectId: "p",
      accessToken: "t",
    });
    // Let the first chunk get underway, then stop.
    await new Promise((r) => setTimeout(r, 60));
    handle.cancel();
    try {
      await handle.done;
      return { rejected: false };
    } catch (error) {
      return {
        rejected: true,
        isUploadError: error instanceof window.VS.UploadError,
        message: String(error.message),
      };
    }
  });

  check("the promise rejects rather than hanging", result.rejected, JSON.stringify(result));
  check("with the module's own error type, so callers can tell it apart", result.isUploadError === true);
  check("and a message about cancelling, not a network failure", /cancelled/i.test(result.message ?? ""), result.message);

  const patched = [...storage.uploads.values()][0]?.offset ?? 0;
  check("the whole file did not go up anyway", patched < 12 * 1024 * 1024, String(patched));
}

section("A dropped connection is an error the person can act on");
{
  storage.reset();
  storage.dropChunks = 4;
  await run(() => localStorage.clear());
  const result = await run(async () => {
    try {
      await window.VS.uploadProjectVideo({
        file: new File([new Uint8Array(7 * 1024 * 1024)], "flaky.mp4", { type: "video/mp4" }),
        userId: "u",
        projectId: "p",
        accessToken: "t",
      }).done;
      return { rejected: false };
    } catch (error) {
      return { rejected: true, message: String(error.message), isUploadError: error instanceof window.VS.UploadError };
    }
  });

  check("it rejects", result.rejected, JSON.stringify(result));
  check("as an UploadError", result.isUploadError === true);
  check("mentioning the network rather than a status code", /network/i.test(result.message ?? ""), result.message);

  const remembered = await run(() => Object.keys(localStorage).filter((k) => k.startsWith("editly:upload:")));
  check(
    "and the upload URL is kept, so the next attempt resumes instead of restarting",
    remembered.length === 1 && remembered[0].includes(`:${7 * 1024 * 1024}:`),
    JSON.stringify(remembered),
  );
  await run(() => localStorage.clear());
}

section("A file the storage plan will not take is refused in words");
{
  storage.reset();
  storage.failSingleWith = 413;
  const message = await run(async () => {
    try {
      await window.VS.uploadProjectVideo({
        file: new File([new Uint8Array(1024)], "small-but-refused.mp4", { type: "video/mp4" }),
        userId: "u",
        projectId: "p",
        accessToken: "t",
      }).done;
      return null;
    } catch (error) {
      return String(error.message);
    }
  });

  check("the person is told what the limit is", /8\.0 MB/.test(message ?? ""), message);
  check("rather than a status code", !/413/.test(message ?? ""), message);
}

section("A reference clip is capped before the network is touched");
{
  storage.reset();
  const result = await run(async () => {
    try {
      await window.VS.uploadReferenceVideo({
        file: new File([new Uint8Array(26 * 1024 * 1024)], "whole-episode.mp4", { type: "video/mp4" }),
        userId: "u",
        projectId: "p",
        accessToken: "t",
      });
      return { threw: false };
    } catch (error) {
      return { threw: true, message: String(error.message) };
    }
  });

  check("an oversized reference is refused", result.threw, JSON.stringify(result));
  check("nothing was uploaded first", storage.log.filter((l) => l.path.includes("/object/videos/")).length === 0, JSON.stringify(storage.log));
  check("the message says how big it was", /26\.0 MB/.test(result.message ?? ""), result.message);
  check("and why the cap exists rather than just stating it", /first couple of minutes/.test(result.message ?? ""), result.message);
}

// ─── Reading a file the browser can decode ───────────────────────────────────

section("What the browser already knows about a file, before it is uploaded");
{
  const facts = await run(async () => {
    const response = await fetch("/fixture.webm");
    const file = new File([await response.blob()], "fixture.webm", { type: "video/webm" });
    return window.VS.readVideoFacts(file);
  });

  check("the duration is read", facts.duration > 3.5 && facts.duration < 5, JSON.stringify(facts));
  check("and the dimensions", facts.width === 480 && facts.height === 270, JSON.stringify(facts));
}

section("The poster frame is not the black one at the start");
{
  const poster = await run(async () => {
    const response = await fetch("/fixture.webm");
    const file = new File([await response.blob()], "fixture.webm", { type: "video/webm" });
    const blob = await window.VS.captureThumbnail(file);

    // Decode what was actually captured and measure it, rather than trusting
    // that a blob came back at all.
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let sum = 0;
    let count = 0;
    for (let i = 0; i < data.length; i += 4 * 40) {
      sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      count += 1;
    }
    return { type: blob.type, size: blob.size, width: bitmap.width, height: bitmap.height, mean: sum / count };
  });

  check("a JPEG comes back", poster.type === "image/jpeg", poster.type);
  check("with bytes in it", poster.size > 1000, String(poster.size));
  check("scaled for a card rather than stored at source size", Math.max(poster.width, poster.height) <= 640, `${poster.width}x${poster.height}`);
  check("the aspect ratio is kept", Math.abs(poster.width / poster.height - 480 / 270) < 0.02, `${poster.width}x${poster.height}`);
  check(
    "and the frame is not the black second the clip opens on",
    poster.mean > 30,
    `mean luma ${poster.mean?.toFixed(1)}`,
  );
}

section("A poster can also be taken from a clip already in storage");
{
  const poster = await run(() => window.VS.captureFrameFrom("/fixture.webm").then((b) => ({ type: b.type, size: b.size })));
  check("from a URL, for a project whose poster went missing", poster.type === "image/jpeg" && poster.size > 1000, JSON.stringify(poster));
}

// ─── Playing it back ─────────────────────────────────────────────────────────

section("An object key is signed before it is played; a URL is left alone");
{
  const results = await run(async () => {
    const { createElement, createRoot } = window.React;
    const observed = [];

    function Probe({ value }) {
      const state = window.VS.usePlayableVideo(value);
      observed.push({ value, ...state });
      return null;
    }

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    const render = (value) =>
      new Promise((resolve) => {
        root.render(createElement(Probe, { value }));
        setTimeout(resolve, 400);
      });

    await render("user-1/proj-1/source.mp4");
    await render("https://cdn.example.com/legacy.mp4");
    await render("blob:http://localhost/dead-object-url");
    await render(null);
    return observed;
  });

  const latest = (value) => [...results].reverse().find((r) => r.value === value);

  const signed = latest("user-1/proj-1/source.mp4");
  check("a storage key becomes a signed URL", /token=signed-for-test/.test(signed?.url ?? ""), JSON.stringify(signed));

  const absolute = latest("https://cdn.example.com/legacy.mp4");
  check("an absolute URL is passed through untouched", absolute?.url === "https://cdn.example.com/legacy.mp4", JSON.stringify(absolute));
  check("and is not reported as still resolving", absolute?.isResolving === false, JSON.stringify(absolute));

  const dead = latest("blob:http://localhost/dead-object-url");
  check(
    "a blob: URL from the old fake upload is dropped rather than handed to a player that cannot open it",
    dead?.url === null,
    JSON.stringify(dead),
  );

  check("and nothing at all resolves to nothing", latest(null)?.url === null);
}

// ─── The two smaller modules ─────────────────────────────────────────────────

section("Checkout cannot grant anything, and hands off to a page it cannot be blocked out of");
{
  // There is no third-party script here any more, so there is nothing to
  // intercept. `checkout.freemius.com/checkout.js` ends `})(jQuery);` — with
  // no global jQuery that argument throws before the function is entered, the
  // IIFE that assigns `FS.Checkout` never runs, and `window.FS` is left
  // holding only `Logger`. Every "did it load?" check passes and the next line
  // reads `undefined`. That is the whole of "FS.Checkout is not a constructor".
  //
  // What is tested instead is the handoff: which URL, in which tab, and
  // whether a purchase can be lost between the two.
  const opened = await run(async () => {
    const calls = [];
    const handles = [];
    const realOpen = window.open;
    window.open = (url, target) => {
      calls.push({ url, target });
      const handle = { opener: { real: true }, closed: false };
      handles.push(handle);
      return handle;
    };
    let purchased = 0;
    try {
      await window.CO.openCheckout(
        { productId: "36845", publicKey: "pk_test", plans: { pro: "61100" }, currentPlan: "free" },
        {
          plan: "pro",
          billingCycle: "annual",
          email: "osama@example.com",
          onPurchase: () => { purchased += 1; },
        },
      );
    } finally {
      window.open = realOpen;
    }
    return { calls, purchased, openerSevered: handles.every((h) => h.opener === null) };
  });

  check("exactly one window is opened", opened.calls.length === 1, String(opened.calls.length));
  check("in a new tab, so the app is still there afterwards", opened.calls[0]?.target === "_blank", String(opened.calls[0]?.target));

  const url = new URL(opened.calls[0]?.url ?? "https://example.invalid");
  check("at Freemius, not at us", url.host === "checkout.freemius.com", url.host);
  check("the product and plan being bought", url.pathname === "/product/36845/plan/61100/", url.pathname);
  check("the billing cycle asked for, not a default", url.searchParams.get("billing_cycle") === "annual", url.search);
  check(
    "and the email prefilled, because the webhook matches a payment by it",
    url.searchParams.get("user_email") === "osama@example.com",
    url.search,
  );
  check("the checkout cannot reach back into the app", opened.openerSevered);
  check("the app is told to refresh the plan", opened.purchased === 1, String(opened.purchased));

  const noEmail = await run(async () => {
    let seen = null;
    const realOpen = window.open;
    window.open = (u) => { seen = u; return { opener: null }; };
    try {
      await window.CO.openCheckout(
        { productId: "36845", publicKey: "pk", plans: { studio: "61102" }, currentPlan: "free" },
        { plan: "studio", billingCycle: "monthly" },
      );
    } finally {
      window.open = realOpen;
    }
    return seen;
  });
  check(
    "and no email is sent when there is none, rather than an empty one",
    !noEmail.includes("user_email"),
    noEmail,
  );

  const refused = await run(async () => {
    let calls = 0;
    const realOpen = window.open;
    window.open = () => { calls += 1; return { opener: null }; };
    let message = null;
    try {
      await window.CO.openCheckout(
        { productId: "36845", publicKey: "pk", plans: { creator: "61099" }, currentPlan: "free" },
        { plan: "pro", billingCycle: "monthly" },
      );
    } catch (error) {
      message = String(error.message);
    } finally {
      window.open = realOpen;
    }
    return { message, calls };
  });
  check(
    "a tier with no plan id is refused by name, and opens nothing",
    /pro plan is not set up/.test(refused.message ?? "") && refused.calls === 0,
    `${refused.message} / ${refused.calls}`,
  );
}

section("Sign-in buttons are shown for providers that are actually switched on");
{
  const providers = await run(() => window.OA.enabledProviders().then((s) => [...s]));
  check("Google is enabled in this project", providers.includes("google"), JSON.stringify(providers));
  check("Apple is not, so its button is not offered", !providers.includes("apple"), JSON.stringify(providers));

  const message = await run(() => new window.OA.ProviderNotEnabledError("apple").message);
  check(
    "and a provider that is off explains itself rather than surfacing an API error",
    /Apple sign-in is not switched on/.test(message),
    message,
  );
}

section("An empty account and a broken one are different sentences");
{
  // The whole of 12 August in one function. Every screen knew two states,
  // loading and loaded; a failed query is neither, and its undefined data
  // rendered as an empty list. The person's projects were all still there.
  const states = await run(() => {
    const { loadState } = window.LS;
    const empty = (list) => list.length === 0;
    return {
      loading: loadState({ data: undefined, isLoading: true, isError: false }, empty),
      failed: loadState({ data: undefined, isLoading: false, isError: true }, empty),
      empty: loadState({ data: [], isLoading: false, isError: false }, empty),
      ready: loadState({ data: [{ id: "p1" }], isLoading: false, isError: false }, empty),
      // No data, not loading, no error flag — the shape the outage took.
      nothingAtAll: loadState({ data: undefined, isLoading: false, isError: false }, empty),
      // A background refetch that failed while data is on screen. Replacing a
      // working screen with an error because a poll missed is worse than the
      // staleness.
      staleButPresent: loadState({ data: [{ id: "p1" }], isLoading: false, isError: true }, empty),
      // Something that cannot be empty, only present or not.
      scalarReady: loadState({ data: { plan: "free" }, isLoading: false, isError: false }),
      scalarFailed: loadState({ data: undefined, isLoading: false, isError: true }),
      // A stale link to a project that really is gone. If every failure claimed
      // the thing was missing we would be back where we started; if none could,
      // a dead link would report our servers as unwell.
      missing: loadState({ data: undefined, isLoading: false, isError: true, error: { status: 404 } }),
      missingNested: loadState({
        data: undefined, isLoading: false, isError: true, error: { response: { status: 404 } },
      }),
      serverError: loadState({ data: undefined, isLoading: false, isError: true, error: { status: 500 } }),
    };
  });

  check("loading is loading", states.loading === "loading", states.loading);
  check("an empty list is empty", states.empty === "empty", states.empty);
  check("a list with something in it is ready", states.ready === "ready", states.ready);
  check("a failed read is failed, not empty", states.failed === "failed", states.failed);
  check(
    "and so is no data with nothing to explain it — which is exactly what an outage looks like",
    states.nothingAtAll === "failed",
    states.nothingAtAll,
  );
  check(
    "a failed refetch over data already on screen keeps the screen",
    states.staleButPresent === "ready",
    states.staleButPresent,
  );
  check("a scalar that arrived is ready", states.scalarReady === "ready", states.scalarReady);
  check("a scalar that did not is failed", states.scalarFailed === "failed", states.scalarFailed);
  check("a 404 is missing, not broken", states.missing === "missing", states.missing);
  check("however the client wraps the status", states.missingNested === "missing", states.missingNested);
  check("and a 500 is broken, not missing", states.serverError === "failed", states.serverError);

  const copy = await run(() => window.LS.COULD_NOT_LOAD);
  check(
    "the message says the work is safe, because the first fear is that it is gone",
    /work is safe/i.test(copy),
    copy,
  );
  check("and that it is our fault, not something they did", /on our side/i.test(copy), copy);
}

section("The operations console stays an operations console");
{
  // A source check, and a boundary rather than a bug. The console exists to
  // answer "is the platform healthy" and "why did that render fail", and both
  // are metadata questions. The moment it can play somebody's footage it stops
  // being a tool for running the product and becomes a way to watch the people
  // using it — and that change would arrive as one innocent-looking line.
  const { readFileSync } = await import("node:fs");
  const admin = readFileSync(path.join(repoRoot, "artifacts/editly/src/pages/admin.tsx"), "utf8");

  check(
    "it never renders a player",
    !/<video|<audio|signedVideoUrl|createSignedUrl/.test(admin),
    "a player appeared on the admin page",
  );
  check(
    "and never links into anyone's storage",
    !/storage\/v1|videoPath|storagePath|outputPath/.test(admin),
    "a storage path appeared on the admin page",
  );
  // This check used to read "it writes nothing", which was true of the first
  // version and is deliberately false of this one. What replaced it is the
  // boundary that actually still holds: the console may do the four named
  // things and nothing else, and it may not reach for a general-purpose write.
  const ALLOWED_WRITES = ["useRequeueJob", "useGrantMinutes", "useSetSuspended", "useSetPlanByHand"];
  const writeHooks = (admin.match(/use[A-Z][A-Za-z]*/g) ?? []).filter((name) =>
    /^use(Requeue|Grant|Set|Delete|Create|Update)/.test(name),
  );
  const unexpected = writeHooks.filter((name) => !ALLOWED_WRITES.includes(name) && name !== "useState");
  check(
    "it writes only through the four named actions",
    unexpected.length === 0,
    unexpected.join(", "),
  );
  check(
    "and never deletes anything — suspension stops renders, it does not destroy work",
    !/useDelete|method:\s*"DELETE"/.test(admin),
    "a delete appeared on the admin page",
  );
  /**
   * And the sentences on it read in the direction they were written in.
   *
   * The render notes are the one thing on this page written as prose, and they
   * are written in the language the job was asked in — so an Arabic customer's
   * notes arrive here in Arabic. Every other place in this product that draws a
   * sentence carries `dir="auto"`; a console added later is exactly where that
   * rule quietly stops applying.
   */
  check(
    "the render notes read in the direction of their own language",
    /notes[\s\S]{0,400}?dir="auto"/.test(admin),
    "the one column of prose on this page has no direction",
  );

  // The reason is what makes the log worth keeping. A button that can fire
  // without one is a row in the log that says nothing.
  check(
    "no action can fire without a reason typed first",
    /const canAct = reason\.trim\(\)\.length >= 6/.test(admin) &&
      (admin.match(/disabled=\{!canAct/g) ?? []).length >= 3,
    String((admin.match(/disabled=\{!canAct/g) ?? []).length),
  );
  check(
    "and it decides nothing about who may see it — the server does",
    !/isAdmin|ADMIN_USER_IDS|allowlist\s*=/.test(admin),
    "a client-side admin check appeared, which is a curtain and not a door",
  );

  // The waiting list is addresses belonging to people who have no account, so
  // it is the one table here whose contents nobody outside this page should
  // ever see. Reading it is the console's alone — asserted on the route it
  // calls, because a section that quietly fetched from somewhere public would
  // look identical on screen.
  check(
    "the waiting list is read through the console's own route",
    /useListWaitlist/.test(admin) && !/\/api\/waitlist(?!\?)/.test(admin),
    "the console reads the waiting list from somewhere other than /api/admin/waitlist",
  );
  check(
    "and it shows where each person came from, so two promises can be told apart",
    /entry\.source/.test(admin),
    "the source column is missing",
  );

  const dashboard = readFileSync(path.join(repoRoot, "artifacts/editly/src/pages/dashboard.tsx"), "utf8");
  check(
    "the link to it is shown only because the server answered, not because the client decided",
    /useGetAdminOverview/.test(dashboard) && /adminQuery\.isSuccess/.test(dashboard),
    "the operations link is gated on something other than the server's answer",
  );
}

section("No screen can render an empty state without handling a failed one");
{
  // A source check, deliberately. What went wrong was not a bug in a function —
  // it was four screens each independently treating "no data" as "no work", and
  // the only thing that catches the fifth is a rule about all of them.
  const { readFileSync, readdirSync } = await import("node:fs");
  const pagesDir = path.join(repoRoot, "artifacts/editly/src/pages");
  const offenders = [];
  for (const file of readdirSync(pagesDir).filter((f) => f.endsWith(".tsx"))) {
    const source = readFileSync(path.join(pagesDir, file), "utf8");
    const rendersEmptiness = /length === 0|!data|not found/i.test(source);
    const readsFromTheApi = /use(Get|List)[A-Z]/.test(source);
    if (!rendersEmptiness || !readsFromTheApi) continue;
    if (!/loadState|LoadFailed/.test(source)) offenders.push(file);
  }
  check(
    "every page that reads from the API and can show nothing goes through loadState",
    offenders.length === 0,
    offenders.join(", "),
  );

  const dashboard = readFileSync(path.join(pagesDir, "dashboard.tsx"), "utf8");
  check(
    "the dashboard checks for failure before it says the account is empty",
    dashboard.indexOf('projectsState === "failed"') < dashboard.indexOf('projectsState === "empty"'),
    "the empty branch comes first, which is the bug",
  );
  check(
    "and a stat tile that could not be read does not print a zero",
    /statsState === "failed"/.test(dashboard) &&
      dashboard.match(/statsState === "failed"/g).length === 3,
    String(dashboard.match(/statsState === "failed"/g)?.length),
  );

  // Matched on the rendered text rather than the phrase anywhere in the file:
  // the first version of this check was satisfied by a code comment explaining
  // the rule, which is a test that passes because someone wrote about it.
  const rendered = />Project not found</;
  for (const file of ["project-editor.tsx", "export.tsx"]) {
    const source = readFileSync(path.join(pagesDir, file), "utf8");
    check(
      `${file} does not say a project was not found when the read simply failed`,
      source.search(/projectState === "failed"/) < source.search(rendered),
      "the not-found branch comes first",
    );
  }
}

section("A video that is still arriving is not a video that will not play");
{
  // The other half of the same mistake as 12 August, in the player this time:
  // one measurement, taken once, turned into a permanent statement about the
  // person's file. On the live app the element was mid-load — networkState 2,
  // readyState 0, error null, the signed URL answering 206 with video/mp4 —
  // and the product had already told its owner the footage was unplayable,
  // with no way to take it back.
  const verdicts = await run(() => {
    const { playbackVerdict, NETWORK_IDLE, NETWORK_LOADING, NETWORK_NO_SOURCE, PLAYBACK_CEILING_MS } = window.PB;
    const facts = (readyState, networkState, error = null) => ({ readyState, networkState, error });
    return {
      noElementYet: playbackVerdict(null, 0),
      earlyLoad: playbackVerdict(facts(0, NETWORK_LOADING), 1_000),
      theLivePage: playbackVerdict(facts(0, NETWORK_LOADING), 20_000),
      decoded: playbackVerdict(facts(1, NETWORK_LOADING), 40_000),
      noSource: playbackVerdict(facts(0, NETWORK_NO_SOURCE), 200),
      errored: playbackVerdict(facts(0, NETWORK_LOADING, { code: 4 }), 200),
      brokeAfterMetadata: playbackVerdict(facts(2, NETWORK_IDLE, { code: 3 }), 5_000),
      atTheCeiling: playbackVerdict(facts(0, NETWORK_LOADING), PLAYBACK_CEILING_MS),
      ceiling: PLAYBACK_CEILING_MS,
    };
  });

  check("no element yet is not a broken element", verdicts.noElementYet === "pending", verdicts.noElementYet);
  check("a load that has just started is pending", verdicts.earlyLoad === "pending", verdicts.earlyLoad);
  check(
    "and is still pending at twenty seconds — the state the live app called unplayable",
    verdicts.theLivePage === "pending",
    verdicts.theLivePage,
  );
  check(
    "metadata decoded means it plays, however long it took to get there",
    verdicts.decoded === "playable",
    verdicts.decoded,
  );
  check(
    "a source the browser has exhausted fails at once, without waiting out a timer",
    verdicts.noSource === "failed",
    verdicts.noSource,
  );
  check("the element's own error is believed", verdicts.errored === "failed", verdicts.errored);
  check(
    "including one raised after metadata, which is a stuck picture rather than a good one",
    verdicts.brokeAfterMetadata === "failed",
    verdicts.brokeAfterMetadata,
  );
  check("and silence for the whole ceiling is a failure at last", verdicts.atTheCeiling === "failed", verdicts.atTheCeiling);
  check(
    "which is longer than the fifteen seconds that produced the false alarm",
    verdicts.ceiling > 15_000,
    String(verdicts.ceiling),
  );

  // The same function against real elements, because the point is what Chromium
  // actually reports, not what this file assumes it reports.
  const real = await run(async () => {
    const { playbackVerdict } = window.PB;
    const watch = (src, limitMs) =>
      new Promise((resolve) => {
        const el = document.createElement("video");
        el.preload = "metadata";
        el.muted = true;
        el.src = src;
        document.body.appendChild(el);
        const started = Date.now();
        const timer = setInterval(() => {
          const elapsed = Date.now() - started;
          const verdict = playbackVerdict(el, elapsed);
          if (verdict === "pending" && elapsed < limitMs) return;
          clearInterval(timer);
          const seen = { verdict, elapsed, networkState: el.networkState, readyState: el.readyState };
          el.removeAttribute("src");
          el.load();
          el.remove();
          resolve(seen);
        }, 50);
      });
    return {
      good: await watch("/fixture.webm", 15_000),
      nonsense: await watch("/nonsense.mp4", 15_000),
      hanging: await watch("/never-answers.mp4", 4_000),
    };
  });

  check("a real clip is called playable", real.good.verdict === "playable", JSON.stringify(real.good));
  check(
    "and quickly — a person does not sit through a timer for a file that works",
    real.good.elapsed < 5_000,
    JSON.stringify(real.good),
  );
  check(
    "bytes that are not a video at all are called failed",
    real.nonsense.verdict === "failed",
    JSON.stringify(real.nonsense),
  );
  check(
    "without waiting for the ceiling, because the browser already knows",
    real.nonsense.elapsed < 10_000,
    JSON.stringify(real.nonsense),
  );
  check(
    "a request nobody answers stays pending rather than becoming an accusation",
    real.hanging.verdict === "pending",
    JSON.stringify(real.hanging),
  );

  // And the editor has to actually use it. A correct function nobody calls is
  // how the first version of this bug survived.
  const editor = readFileSync(path.join(repoRoot, "artifacts/editly/src/pages/project-editor.tsx"), "utf8");
  check("the editor asks playbackVerdict rather than reading readyState itself", /playbackVerdict\(/.test(editor));
  check(
    "and asks repeatedly, rather than once and forever",
    /setInterval\(/.test(editor) && !/STALL_MS/.test(editor),
    "the single-shot timer is still there",
  );
  check(
    "metadata arriving clears a verdict already on screen",
    /onLoadedMetadata=\{[\s\S]{0,400}?setPlaybackFailed\(false\)/.test(editor),
  );
}

section("The spinner names the thing it is actually waiting for");
{
  // The bar read "100% · 252 KB of 252 KB" under a heading that said
  // "Uploading Video…" — for as long as thirty seconds, while two best-effort
  // extras finished. The bytes were already committed and the row in the
  // database already named the file. Nothing was uploading.
  const editor = readFileSync(path.join(repoRoot, "artifacts/editly/src/pages/project-editor.tsx"), "utf8");
  const doneAt = editor.indexOf("await handle.done");
  const finishingAt = editor.indexOf('setUploadPhase("finishing")');
  const factsAt = editor.indexOf("Promise.all([facts, poster])");

  check("the upload has a phase, not just an on/off", finishingAt !== -1);
  check("it turns over once the bytes are committed", doneAt !== -1 && finishingAt > doneAt, `${doneAt} / ${finishingAt}`);
  check(
    "before the two best-effort extras are waited on, not after them",
    finishingAt < factsAt,
    `${finishingAt} / ${factsAt}`,
  );
  check(
    "the heading stops claiming an upload is running",
    /uploadPhase === "finishing" \? "Finishing up/.test(editor),
  );
  check(
    "and says the video is stored, since that is the fact the person wants",
    /Your video is stored\./.test(editor),
  );
  check(
    "the transfer can no longer be cancelled once it has landed",
    editor.slice(doneAt, factsAt).includes("cancelUploadRef.current = null"),
  );
}

section("A read that failed does not hide a sign-in button");
{
  // The catch below this line was reasoned about and correct: a network hiccup
  // shows both buttons, because the click itself reports honestly if a provider
  // turns out to be off. The line above it did the opposite for a failure that
  // is exactly as uninformative — a 500 or a 429 from Supabase's settings
  // endpoint became an empty Set, which is indistinguishable from "this project
  // has no providers enabled".
  //
  // Hiding those buttons is not a neutral act. Somebody who created their
  // account with "Continue with Google" has no password. A login page with only
  // an email form tells them their account is gone, and reloading does not
  // help, because the endpoint is still returning 500s.
  for (const status of [500, 429, 502, 401]) {
    await browserPage.route("**/auth/v1/settings", (route) =>
      route.fulfill({ status, contentType: "application/json", body: "{}" }),
    );
    const providers = await run(() => window.OA.enabledProviders().then((s) => [...s]));
    check(
      `a ${status} from the settings endpoint leaves the buttons up`,
      providers.includes("google") && providers.includes("apple"),
      JSON.stringify(providers),
    );
    await browserPage.unroute("**/auth/v1/settings");
  }

  // And an answer that really is an answer is still obeyed — the point is not
  // to show everything always, it is to distinguish "off" from "we could not
  // ask".
  await browserPage.route("**/auth/v1/settings", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ external: { google: true, apple: false } }),
    }),
  );
  const real = await run(() => window.OA.enabledProviders().then((s) => [...s]));
  check("a provider that is genuinely off is still hidden", !real.includes("apple"), JSON.stringify(real));
  check("and one that is on is still shown", real.includes("google"), JSON.stringify(real));
  await browserPage.unroute("**/auth/v1/settings");
}

/**
 * The half of the redirect that comes back carrying a refusal.
 *
 * `signInWithProvider` reports what goes wrong *before* the browser leaves.
 * Everything that goes wrong after it leaves comes back the only way OAuth can
 * answer: as `error` and `error_description` on the URL it returns to. That URL
 * is `/dashboard`, where there is no session, so the router redirects to
 * `/login` — and the redirect drops the query and the hash with it.
 *
 * So the person clicked "Continue with Google", disappeared for two seconds,
 * and arrived back at an empty sign-in form with **nothing anywhere saying
 * why**. A wrong redirect URL, a provider switched on with bad credentials,
 * Supabase's own "Database error saving new user" — all of them looked exactly
 * like a button that does nothing. And this is the failure most likely to
 * happen on the very first day the provider is switched on.
 *
 * Run in a real browser against a real History API, because the whole thing is
 * one interaction between a URL, `history.replaceState`, and a router that
 * throws the URL away.
 */
section("A sign-in that failed on the way back says what happened");
{
  const at = (url) =>
    run((u) => {
      window.history.replaceState(null, "", u);
      const captured = window.OA.captureOAuthError();
      return { captured, url: window.location.href, taken: window.OA.takeOAuthError(), again: window.OA.takeOAuthError() };
    }, url);

  const q = await at("/?error=server_error&error_description=Database+error+saving+new+user");
  check(
    "a provider's own words survive the redirect that drops the URL",
    q.captured === "Database error saving new user",
    JSON.stringify(q),
  );
  check("and are taken off the URL, so a reload does not repeat them", !/error/.test(q.url), q.url);
  check("read once by the screen that shows them", q.taken === "Database error saving new user", JSON.stringify(q.taken));
  check("and not a second time", q.again === null, JSON.stringify(q.again));

  // Supabase's implicit flow answers in the fragment, not the query. A reader
  // that only knows one of the two is a reader that works in half the cases.
  const h = await at("/#error=server_error&error_description=Unable+to+exchange+external+code");
  check(
    "an error in the fragment is read as well as one in the query",
    h.captured === "Unable to exchange external code",
    JSON.stringify(h),
  );

  const cancelled = await at("/?error=access_denied&error_description=The+user+denied+the+request");
  check(
    "cancelling reads as cancelling, not as a failure",
    cancelled.captured === "Sign-in was cancelled.",
    JSON.stringify(cancelled.captured),
  );

  const bare = await at("/?error=invalid_request");
  check(
    "and a code with no sentence still says something",
    bare.captured === "Sign-in failed (invalid_request).",
    JSON.stringify(bare.captured),
  );

  /**
   * The control, and the inverse bug.
   *
   * A *successful* callback comes back with `access_token` in the fragment, and
   * the Supabase client reads that fragment itself to establish the session.
   * A reader that stripped it would turn every successful Google sign-in into a
   * silent failure — the same bug this section exists to end, inverted and
   * worse. So the untouched case is asserted, byte for byte.
   */
  const success = await at("/#access_token=abc123&token_type=bearer&expires_in=3600");
  check("a successful callback is not read as an error", success.captured === null, JSON.stringify(success.captured));
  check(
    "and its fragment is left exactly as it arrived, because the session is in it",
    success.url.endsWith("#access_token=abc123&token_type=bearer&expires_in=3600"),
    success.url,
  );

  // And a URL that is not a callback at all. This product links to `/#pricing`
  // from a toast, and a reader that rebuilt every fragment it saw would rewrite
  // that to `#pricing=` — a key-value parser given something that was never a
  // key-value pair. The rule the early return encodes is narrower than "clean
  // the URL": *touch nothing unless there is an error on it.*
  const anchor = await at("/#pricing");
  check("a plain anchor is not a callback and is left alone", anchor.url.endsWith("/#pricing"), anchor.url);

  const alongside = await at("/?next=%2Fdashboard&error=server_error&error_description=Nope");
  check(
    "stripping the error leaves everything else on the URL alone",
    /next=%2Fdashboard/.test(alongside.url) && !/error/.test(alongside.url),
    alongside.url,
  );

  await run(() => window.history.replaceState(null, "", "/"));

  /**
   * And it is read early enough to survive.
   *
   * The whole design is an ordering: the reason arrives on `/dashboard`, the
   * router redirects to `/login`, and the redirect drops the URL. Read at
   * start-up it survives; read from the login screen's own mount it is already
   * gone — and the two are indistinguishable in every test that does not check
   * *where* the call sits.
   */
  const { readFileSync: readSource } = await import("node:fs");
  const main = readSource(path.join(repoRoot, "artifacts/editly/src/main.tsx"), "utf8");
  const login = readSource(path.join(repoRoot, "artifacts/editly/src/pages/login.tsx"), "utf8");
  check(
    "the reason is taken off the URL before anything renders",
    main.indexOf("captureOAuthError()") > 0 &&
      main.indexOf("captureOAuthError()") < main.indexOf("createRoot(document"),
    "reading it after the router has run reads a URL the router already discarded",
  );
  check(
    "and the sign-in screen shows it",
    /takeOAuthError\(\)/.test(login) && /setError\(said\)/.test(login),
    "captured and never displayed is the same silence with extra steps",
  );
}

section("A 404 is an answer, and the screens that need to act on one can");
{
  const verdicts = await run(() => ({
    plain: window.LS.isNotFound({ status: 404 }),
    nested: window.LS.isNotFound({ response: { status: 404 } }),
    serverError: window.LS.isNotFound({ status: 500 }),
    nothing: window.LS.isNotFound(undefined),
  }));
  check("a 404 is recognised", verdicts.plain === true);
  check("however the client wraps it", verdicts.nested === true);
  check("a 500 is not", verdicts.serverError === false);
  check("and neither is nothing at all", verdicts.nothing === false);
}

section("The pricing page says nothing about your plan until it has been told");
{
  // The one screen where the negative fact costs the customer money. This file
  // read `subscription?.plan ?? "free"` in three places, with no loading branch
  // and no failed branch, so for the few hundred milliseconds before the query
  // resolved — and for the whole of an outage, and for anyone whose token had
  // just rotated — a Pro subscriber saw three cards reading "Get Creator",
  // "Get Pro", "Get Studio" with no Current Plan marker anywhere. Clicking the
  // plan they already pay for opened a Freemius checkout for it, because the
  // downgrade comparison was against "free" too.
  const home = readFileSync(path.join(repoRoot, "artifacts/editly/src/pages/home.tsx"), "utf8");

  check(
    "the page knows whether it has been told",
    /const planKnown = /.test(home),
    "nothing distinguishes an unread subscription from a free one",
  );
  // Comments stripped first: the reason this line exists is written above it,
  // and a check satisfied or defeated by prose is not a check.
  const homeCode = home.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const fallbacks = homeCode.match(/subscription\?\.plan \?\? "free"/g) ?? [];
  check(
    "the free-plan fallback survives in exactly one place, not three",
    fallbacks.length === 1,
    `${fallbacks.length} occurrences`,
  );
  check(
    "and that place is the one definition everything else reads through",
    /const currentPlan = \(subscription\?\.plan \?\? "free"\)/.test(homeCode),
  );
  check(
    "the Current Plan marker waits for the answer",
    /const isCurrent = planKnown &&/.test(home),
  );
  check(
    "so does the downgrade test, which is what decides between a local switch and a checkout",
    /const isDowngrade = planKnown &&/.test(home),
  );
  check(
    "the buttons are not clickable before then",
    /disabled=\{!planKnown \|\|/.test(home),
  );
  check(
    "and they say what they are waiting for rather than offering a plan",
    /Checking your plan/.test(home),
  );
  check(
    "the handler refuses to act on a plan it has not read, even if a click gets through",
    /if \(!planKnown\) return;/.test(home),
  );
}

section("The landing page's feature list keeps up with what is actually built");
{
  // "What it does today" is kept honest by hand — everything on it works, and
  // what is not built stays off it. That honesty cuts both ways: a feature
  // that shipped and never made the list is the page understating the product.
  const home = readFileSync(path.join(repoRoot, "artifacts/editly/src/pages/home.tsx"), "utf8");
  check(
    "clips are on the list now that they exist",
    /cut into separate clips/i.test(home),
    "the clips feature shipped but the landing page does not mention it",
  );
  // The claim, not the sentence. Pinning the exact prose makes this a check on
  // the copywriter rather than on the product: it went red the moment the line
  // was rewritten to say the same thing better, which teaches people to edit
  // the test to match the page — the opposite of what it is for.
  check(
    "and the line sells the titles, which is what makes them worth having",
    /titled by (its speaker's own words|what the speaker actually said)/i.test(home),
    "the clips line must say the titles come from the speaker, not from a template",
  );
  // This used to read `{ label: "Transitions", dimmed: false }` — the literal
  // shape of a row in the old array. That pinned the check to a data structure
  // rather than to the claim, so redrawing the grid broke it while the page was
  // saying exactly the right thing. The claim is what matters: transitions ship,
  // so the cell for them must be present and must not be sold as future work.
  check(
    "the transitions cell is on the grid, because the fade ships",
    /label: "Transitions"/.test(home),
    "the fade shipped but the grid does not show a transitions cell at all",
  );
  check(
    "and nothing on the grid is marked as not built yet",
    !/(dimmed: true|coming soon|not yet|soon\b)/i.test(
      home.slice(home.indexOf('label: "B-roll"'), home.indexOf('label: "Transitions"') + 400),
    ),
    "a cell in the feature grid is presented as future work",
  );
  // Every cell is drawn, not written. A grid of words on a page selling a video
  // tool was the emptiest thing on it; each cell carries its own artwork now,
  // and a cell that loses it falls back to being a label again silently.
  const gridCells = home.slice(home.indexOf('label: "B-roll"'), home.indexOf("].map((cell"));
  check(
    "every cell in the grid draws the thing it names",
    (gridCells.match(/art: \(/g) ?? []).length === (gridCells.match(/label: "/g) ?? []).length,
    "a feature-grid cell has a label but no artwork",
  );
}

section("The shaders are still inside their template literals");
{
  /*
   * A backtick in a GLSL comment ends the JavaScript string the shader lives
   * in, and the failure is a parse error two hundred lines away that names a
   * word from the comment. It has happened twice in this file now, both times
   * while writing a note about a uniform, because backticks around an
   * identifier is how every other comment in this repository is written.
   *
   * Cheaper to make impossible than to keep recognising.
   */
  const orb = readFileSync(path.join(repoRoot, "artifacts/editly/src/components/voice/orb.tsx"), "utf8");
  const shaders = [...orb.matchAll(/const (VERT|FRAG) = `([\s\S]*?)`;/g)];
  check("the shader sources are found at all", shaders.length === 2, String(shaders.length));
  for (const [, name, body] of shaders) {
    check(`${name} carries no backtick that would close its own string`, !body.includes("\u0060"), name);
    // ...and it must still be GLSL, not an empty string that parses fine.
    check(`${name} is a real shader`, /void main\s*\(/.test(body), name);
  }
}

section("The console's idea of 'too long ago' is the server's");
{
  /*
   * The admin console decides whether to believe an `online` it was handed, by
   * comparing the age of the heartbeat against a threshold. The server decides
   * whether to send that `online` at all, by comparing the same age against the
   * same threshold. Two copies of one number, in two packages that deploy
   * separately — the client cannot import the constant without making the API a
   * build dependency of the web app for a single integer.
   *
   * So they are written out twice on purpose, and held together here. Drift is
   * silent and the symptom is absurd: raise one and the console starts calling
   * every worker "unclear"; raise the other and it goes back to reassuring
   * people about a machine that stopped.
   */
  const health = readFileSync(path.join(repoRoot, "artifacts/api-server/src/lib/queue-health.ts"), "utf8");
  const admin = readFileSync(path.join(repoRoot, "artifacts/editly/src/pages/admin.tsx"), "utf8");

  const serverMs = /WORKER_OFFLINE_AFTER_MS\s*=\s*([^;]+);/.exec(health)?.[1];
  const clientSeconds = /WORKER_OFFLINE_AFTER_SECONDS\s*=\s*(\d+)/.exec(admin)?.[1];
  check("the server states a threshold", Boolean(serverMs), String(serverMs));
  check("and the console states one too", Boolean(clientSeconds), String(clientSeconds));

  // eslint-disable-next-line no-new-func -- a literal arithmetic expression from our own source
  const serverValue = serverMs ? Number(new Function(`return (${serverMs})`)()) : NaN;
  check(
    "and they are the same length of time",
    serverValue / 1000 === Number(clientSeconds),
    `server ${serverValue / 1000}s vs console ${clientSeconds}s`,
  );
}

section("Every door that creates a project is counted through the same one");
{
  /*
   * A budget per endpoint is not a budget.
   *
   * `POST /projects` has been rate-limited under `createProject` since the
   * limiter existed. `POST /projects/:id/clips/:clipId/open` creates a project
   * row *and* copies a video file, and had no limiter at all — so the loop the
   * `createProject` window exists to stop just went through the other door,
   * and cost storage on the way. Both share one name and one window now, which
   * is the only arrangement that means anything: separate budgets are added
   * together by anyone alternating between them.
   *
   * Checked by finding every route that inserts into `projectsTable` rather
   * than by naming the two we know about, so a third door fails this the day
   * it is written.
   */
  const routeDir = path.join(repoRoot, "artifacts/api-server/src/routes");
  const creators = [];
  for (const file of readdirSync(routeDir).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(path.join(routeDir, file), "utf8");
    if (!/\.insert\(projectsTable\)/.test(src)) continue;
    // Every `router.post(...)` handler in the file, with its body up to the
    // next route registration.
    const parts = src.split(/router\.(?:post|put|patch)\(/).slice(1);
    for (const part of parts) {
      if (!/\.insert\(projectsTable\)/.test(part)) continue;
      const pathLiteral = /^\s*"([^"]+)"/.exec(part)?.[1] ?? "(unknown)";
      const head = part.slice(0, 400);
      creators.push({ file, route: pathLiteral, limited: /rateLimit\(LIMITS\.createProject\)/.test(head) });
    }
  }
  check("there are project-creating routes to check", creators.length >= 2, JSON.stringify(creators));
  const unlimited = creators.filter((c) => !c.limited);
  check(
    "and every one of them is counted against the same createProject window",
    unlimited.length === 0,
    unlimited.map((c) => `${c.file} ${c.route}`).join(", "),
  );
}

section("The em dash is out of the product's writing, and stays out");
{
  /*
   * Asked for directly: "ازل — من المنصة".
   *
   * The reason it needs a check rather than one pass over the files is that it
   * is a habit, not a bug. The character is a comfortable thing to reach for
   * mid-sentence, it will keep arriving in every new string anyone writes, and
   * one em dash in a product whose other 150 sentences have none reads worse
   * than a page that always had them.
   *
   * Only real text is read. Comments keep their dashes: the writing in this
   * repo's comments is for whoever is reading the code, not for a customer,
   * and rewriting them would be busywork against the wrong audience. So the
   * scan parses each file and looks at string literals, template pieces and
   * JSX text — never at what the compiler throws away.
   */
  const ts = require("typescript");
  /*
   * Every package, found rather than listed.
   *
   * This was three hardcoded paths under `artifacts/`, and it missed one:
   * `lib/api-client-react` builds the sentence a person reads when any API call
   * fails, and it was still joining a title to a detail with an em dash. A
   * check that names its own scope will always be narrower than the codebase
   * eventually is — so the scope is derived, and a package added tomorrow is
   * inside it the day it appears.
   */
  const roots = [];
  for (const group of ["artifacts", "lib"]) {
    const base = path.join(repoRoot, group);
    if (!existsSync(base)) continue;
    for (const pkg of readdirSync(base, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      const src = path.join(group, pkg.name, "src");
      if (existsSync(path.join(repoRoot, src))) roots.push(src);
    }
  }
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "dist" || entry.name === "generated") continue;
        walk(full);
      }
      // Generated clients and build output are not this repo's writing.
      else if (/\.tsx?$/.test(entry.name)) files.push(full);
    }
  };
  for (const r of roots) walk(path.join(repoRoot, r));
  check("there is product source to read", files.length > 20, String(files.length));

  const found = [];
  const TEXT = new Set([
    ts.SyntaxKind.StringLiteral,
    ts.SyntaxKind.NoSubstitutionTemplateLiteral,
    ts.SyntaxKind.TemplateHead,
    ts.SyntaxKind.TemplateMiddle,
    ts.SyntaxKind.TemplateTail,
    ts.SyntaxKind.JsxText,
  ]);
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    if (!src.includes("\u2014")) continue;
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    /*
     * A shader is code that happens to live in a string.
     *
     * This guard's rule is "a string literal is text a customer reads", which
     * is true of every string in this product except the two GLSL sources in
     * the voice orb: their comments explain uniforms to whoever maintains the
     * shader, and nobody has ever read one in the app. Recognised by their own
     * first line rather than by filename, so the exemption cannot quietly widen
     * to cover a real sentence.
     */
    const isShader = (text) => /^\s*[`"']?#version\s/.test(text);
    const visit = (node) => {
      const text = src.slice(node.getStart(), node.getEnd());
      if (TEXT.has(node.kind) && !isShader(text) && text.includes("\u2014")) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
        found.push(`${path.relative(repoRoot, file)}:${line + 1}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  check(
    "no sentence a customer can read contains an em dash",
    found.length === 0,
    found.slice(0, 12).join(", ") + (found.length > 12 ? ` and ${found.length - 12} more` : ""),
  );
}

section("A render that finished is a project that changed");
{
  // The page rewarded the person who stayed and watched with the worse
  // experience. The bar reached 100%, the progress block disappeared, and Noah
  // posted "Here's what I did" with the worker's notes — while the cached
  // project was still the copy fetched before the render started. So the player
  // was pointed at the *original* upload, the header pill still said
  // `processing`, and the "AI Edited" badge never arrived. They pressed play,
  // watched their raw take with every um still in it under a message claiming
  // the silences were cut, and reported that the edit did nothing.
  const editor = readFileSync(path.join(repoRoot, "artifacts/editly/src/pages/project-editor.tsx"), "utf8");
  const exportPage = readFileSync(path.join(repoRoot, "artifacts/editly/src/pages/export.tsx"), "utf8");

  check(
    "export.tsx refetches the project when the render settles",
    /status === 'done'[\s\S]{0,400}?invalidateQueries\(\{ queryKey: getGetProjectQueryKey/.test(exportPage),
  );
  check(
    "and now the editor does too, which is the screen people actually watch",
    /renderJob\?\.status[\s\S]{0,900}?invalidateQueries\(\{ queryKey: getGetProjectQueryKey\(id\) \}\)/.test(editor),
    "nothing invalidates the project when the job settles",
  );
  check(
    "for a failure as well as a success, because a failed render also changes the row",
    /status !== "done" && status !== "failed"/.test(editor),
  );
  check(
    "once per settled job rather than on every poll",
    /settledJobRef/.test(editor),
  );
}

section("An export nobody on this tab started is still an export");
{
  // `isExporting` is a local boolean that resets on every mount, and it gated
  // the status query — so reloading the page, or stepping back to the editor
  // and returning, made a render that was genuinely running invisible. The
  // person saw the platform picker and a live "Render & Export" button;
  // clicking it hit the server's 409, which this screen had no branch for, so
  // they were told the export failed to start while it was being rendered.
  const exportPage = readFileSync(path.join(repoRoot, "artifacts/editly/src/pages/export.tsx"), "utf8");

  check(
    "the status is asked for on every visit, not only when this tab started one",
    /enabled: !!id,/.test(exportPage),
  );
  check(
    "a 404 is not retried, because 'never exported' is an answer",
    /isNotFound\(error\) \? false/.test(exportPage),
  );
  check(
    "a render the server reports is treated as running whoever started it",
    /const isRunning = isExporting \|\| exportStatus\?\.status === 'pending'/.test(exportPage),
  );
  check(
    "and the picker is not offered while we are still finding out",
    /currentStatus === 'loading'/.test(exportPage),
  );
  check(
    "a 409 says 'already rendering' rather than 'could not start'",
    /status === 409[\s\S]{0,300}?Already rendering/.test(exportPage),
  );
  check(
    "and keeps the running state instead of resetting it",
    /if \(status === 409\) \{[\s\S]{0,200}?setIsExporting\(true\)/.test(exportPage),
  );
  check(
    "the policy refusals are shown in the server's own words, as the editor does",
    /Not enough minutes left/.test(exportPage) && /too long for this plan/.test(exportPage),
  );
  check(
    "a URL still being signed is not reported as a missing video",
    /isSigning/.test(exportPage) && /isResolving: playbackResolving/.test(exportPage),
  );
  check(
    "and a preview that failed says the video is safe rather than that there is none",
    /could not load the preview/i.test(exportPage) && /stored safely/.test(exportPage),
  );
}

section("A video dropped on the dashboard becomes a project that uploads itself");
{
  // The handoff is a File in module memory, claimed exactly once. The claim
  // *is* the double-run guard — React mounts effects twice in dev, and the
  // second take finding nothing is what stops a second upload of the same
  // bytes.
  const handoff = await run(() => {
    const { stashPendingUpload, takePendingUpload } = window.PU;
    const file = new File(["x"], "take.mp4", { type: "video/mp4" });
    stashPendingUpload("p1", file);
    const first = takePendingUpload("p1");
    const second = takePendingUpload("p1");
    const other = takePendingUpload("never-stashed");
    return { firstName: first?.name ?? null, second, other };
  });
  check("the stashed file comes back once", handoff.firstName === "take.mp4", String(handoff.firstName));
  check("and only once — the claim deletes it", handoff.second === null, String(handoff.second));
  check("a project nothing was stashed for gets nothing", handoff.other === null, String(handoff.other));

  const titles = await run(() => {
    const { titleFromFilename } = window.PU;
    return {
      cleaned: titleFromFilename("my-viral-short_v2.FINAL.mp4"),
      plain: titleFromFilename("Interview.mov"),
      hostile: titleFromFilename("....mp4"),
      long: titleFromFilename(`${"a".repeat(200)}.mp4`).length,
    };
  });
  check(
    "the filename's separators become spaces",
    titles.cleaned === "my viral short v2 FINAL",
    titles.cleaned,
  );
  check("a plain name just loses its extension", titles.plain === "Interview", titles.plain);
  check("a name that cleans away to nothing still names the project", titles.hostile === "New video", titles.hostile);
  check("and a novel of a filename is capped", titles.long <= 80, String(titles.long));

  // Source checks for the two ends of the handoff — ordering bugs here would
  // not throw, they would misfile someone's video.
  const { readFileSync: readSrc } = await import("node:fs");
  const dashboardSrc = readSrc(path.join(repoRoot, "artifacts/editly/src/pages/dashboard.tsx"), "utf8");
  const editorSrc = readSrc(path.join(repoRoot, "artifacts/editly/src/pages/project-editor.tsx"), "utf8");

  check(
    "the dashboard stashes the file only after the project row exists",
    /await createProject\.mutateAsync[\s\S]{0,700}?stashPendingUpload/.test(dashboardSrc),
    "stash must follow a successful create, or a failed create strands the file",
  );
  check(
    "and vets the file the same way the editor would, before creating anything",
    dashboardSrc.indexOf("ACCEPTED_VIDEO_TYPES") < dashboardSrc.indexOf("createAndOpen(titleFromFilename"),
    "a rejected file should cost a toast, not an empty project",
  );
  check(
    "the editor refuses a stale stash when the project already has footage",
    /project\.videoPath \|\| isUploading\) return;[\s\S]{0,200}?takePendingUpload/.test(editorSrc),
    "a pending file must never overwrite an uploaded video",
  );
}

section("Every video plays where it was put");
{
  /*
   * `playsInline`, on every `<video>` in the product.
   *
   * Safari on iPhone treats a video element without it as a request for the
   * system player: pressing play throws the clip into fullscreen, hides the
   * editor and hands the person controls that are not ours — mid-edit, on the
   * screen this product is mostly used on.
   *
   * It is invisible everywhere it could be caught. Every desktop browser
   * ignores the attribute, and so does the headless Chromium that runs every
   * other check in this repo, so nothing here would ever have gone red. Two of
   * the five video elements were missing it and had been since they were
   * written; the person who found it was the owner, on his own phone.
   *
   * A source check rather than a rendered one, because the behaviour cannot be
   * reproduced in anything this suite can drive.
   */
  const { readdirSync: readDir, readFileSync: readSrc } = await import("node:fs");
  const searched = [];
  const walk = (dir) => {
    for (const entry of readDir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) searched.push(full);
    }
  };
  walk(path.join(repoRoot, "artifacts/editly/src"));

  /*
   * Comments first, and this is not fussiness: the first version of this check
   * went red on three files whose only `<video>` was inside a sentence
   * explaining why a video element cannot carry an Authorization header. A
   * check that reports prose as a defect gets muted, and a muted check is worse
   * than no check.
   */
  const withoutComments = (text) =>
    text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*)/.test(line))
      .join("\n");

  const offenders = [];
  let videoElements = 0;
  for (const file of searched) {
    const text = withoutComments(readSrc(file, "utf8"));
    // Each `<video` up to the end of its opening tag.
    for (const match of text.matchAll(/<video\b[\s\S]*?>/g)) {
      videoElements += 1;
      if (!/playsInline/.test(match[0])) {
        offenders.push(path.relative(repoRoot, file));
      }
    }
  }
  check("there are video elements to check", videoElements >= 4, String(videoElements));
  check(
    `all ${videoElements} video elements play inline rather than taking the screen`,
    offenders.length === 0,
    offenders.length ? `missing playsInline: ${[...new Set(offenders)].join(", ")}` : "",
  );
}

section("The editor fits a phone, which is where the owner will test it");
{
  // The editor lives inside h-screen + overflow-hidden. On a desktop the chat
  // is a fixed-width column beside the player; on a phone it stacks below —
  // and a stacked pane with no height of its own takes the height of its
  // content, which for a chat is unbounded. Flexbox settles that fight by
  // crushing the player to a sliver under an unscrollable wall of messages.
  // These are the three properties that keep the phone layout standing.
  const { readFileSync: readEditor } = await import("node:fs");
  const editorSrc = readEditor(path.join(repoRoot, "artifacts/editly/src/pages/project-editor.tsx"), "utf8");

  // The claim, not the literal — twice over, and for the reason written a few
  // lines down about the frame's minimum height. Both of these pinned an exact
  // run of Tailwind classes in source order, and both went red the day the
  // phone layout was improved rather than broken: the chat became a sheet whose
  // share depends on whether it is open, so its `basis` is now written by a
  // conditional and the classes are no longer adjacent. What has to stay true
  // is that the pane has *a* definite share below `lg` and gives it back above.
  const chatPane = editorSrc.slice(
    Math.max(0, editorSrc.indexOf('data-testid="chat-panel"') - 700),
    editorSrc.indexOf('data-testid="chat-panel"') + 200,
  );
  check(
    "the chat takes a definite share of the column on a phone, its natural width on a desktop",
    /basis-\[\d+%\]/.test(chatPane) && /lg:basis-auto/.test(chatPane) && /min-h-0/.test(chatPane),
    "the chat pane needs a definite mobile height or it eats the player",
  );
  check(
    "the player pane may shrink below its content, or stacking overflows the screen",
    /flex-1 min-h-0 flex flex-col relative/.test(editorSrc)
      && /overflow-y-auto lg:overflow-hidden/.test(editorSrc),
    "flex-1 + min-h-0 is what lets it share the column instead of overflowing it",
  );
  // And the sheet itself: an input you can always reach, a history you can
  // fold away. If the fold were to take the input with it, the phone would
  // have a video and no way to ask for anything.
  check(
    "the conversation folds away on a phone without taking the input with it",
    /data-testid="button-toggle-chat"/.test(editorSrc)
      && /hidden lg:block/.test(editorSrc)
      && editorSrc.indexOf('data-testid="input-chat"') > editorSrc.indexOf("hidden lg:block"),
    "folding the sheet must hide the history, not the way to talk to it",
  );
  // This check used to demand `overflow-hidden` at every width, and got it —
  // and the phone editor was a video a few pixels tall with the looks, the
  // clips, the file library and the reference uploader cut off below it and no
  // way to reach them. Hiding the overflow does not make the panels smaller; it
  // pays them their full content height out of the only child that will shrink,
  // which is the frame. Above `lg` there is room for all of it at once and the
  // hidden overflow is right. Below it, the column scrolls.
  check(
    "and it scrolls on a phone, where the panels below the frame do not fit",
    /overflow-y-auto lg:overflow-hidden/.test(editorSrc),
    "a hidden overflow at phone width is a panel nobody can reach",
  );
  // The claim, not the literal. This pinned `min-h-[240px] lg:min-h-0` and went
  // red the day the desktop minimum was raised on purpose — the frame was
  // sharing its height with four panels and came out 540x304 in a 992-wide
  // column, which is a small video in a video editor. What has to be true is
  // that the frame has a floor of its own at both widths rather than being left
  // to `flex-1`, which in a scrolling column means "whatever is left" and under
  // four panels is nothing. How tall that floor is belongs to the design, and
  // viewport-test measures what it produces.
  check(
    "the frame keeps a height of its own inside that scroller",
    /\bmin-h-\[[^\]]+\]/.test(editorSrc) && /\blg:min-h-(\[[^\]]+\]|0)/.test(editorSrc),
    "`flex-1` in a scrolling column means 'whatever is left', and under four panels that is nothing",
  );
  check(
    "the header's buttons drop their words on a phone rather than falling off the edge",
    (editorSrc.match(/className="hidden sm:inline"/g)?.length ?? 0) >= 2,
  );
  check(
    "and the title truncates instead of pushing them",
    /text-editor-title[\s\S]{0,80}?truncate|truncate min-w-0" data-testid="text-editor-title"/.test(editorSrc),
  );
}

section("Sizes are written the way a person reads them");
{
  const formatted = await run(() =>
    [0, 900, 1024, 1536, 50 * 1024 * 1024, 2.5 * 1024 * 1024 * 1024].map((n) => window.VS.formatBytes(n)),
  );
  check("bytes stay bytes", formatted[0] === "0 B" && formatted[1] === "900 B", JSON.stringify(formatted));
  check("kilobytes are whole", formatted[2] === "1 KB" && formatted[3] === "2 KB", JSON.stringify(formatted));
  check("megabytes get one decimal", formatted[4] === "50.0 MB", JSON.stringify(formatted));
  check("and gigabytes two", formatted[5] === "2.50 GB", JSON.stringify(formatted));
}

section("The waiting-list page signs somebody up, and says so when it cannot");
{
  /*
   * The page is the deliverable, so it is loaded and driven rather than read.
   * Its API is stubbed by route interception, which lets each answer the real
   * endpoint can give be played back in turn — including the two that have no
   * status code at all: a request that never leaves, and a server that is
   * simply not there. Those are the branches a form usually forgets, and they
   * are the ones that make somebody close the tab.
   */
  const pagePath = path.join(repoRoot, "artifacts/waitlist/index.html");
  check("the page exists where the deploy expects it", existsSync(pagePath));

  const html = readFileSync(pagePath, "utf8");
  check(
    "it carries the product's own mark rather than a second logo file",
    html.includes("M186.0 573.4"),
  );
  check(
    "and the product's own purple, not a colour picked again by eye",
    html.includes("255 100% 62%") && html.includes("259 100% 71%"),
  );
  check(
    "the email field is large enough that iOS does not zoom the page on focus",
    /input\[type="email"\][\s\S]*?font-size:\s*16px/.test(html),
  );

  const wl = await browser.newPage();
  const pageErrors = [];
  wl.on("pageerror", (error) => pageErrors.push(String(error)));

  let lastRequest = null;
  let reply = { status: 201, body: { joined: true, total: 42 } };
  await wl.route("**/api/waitlist", async (route) => {
    lastRequest = JSON.parse(route.request().postData() || "{}");
    if (reply === "abort") return route.abort("failed");
    await route.fulfill({
      status: reply.status,
      contentType: "application/json",
      body: JSON.stringify(reply.body ?? {}),
    });
  });

  await wl.goto("file://" + pagePath);

  // An address that is not one never reaches the network.
  await wl.fill("#email", "nope");
  await wl.click("#submit");
  check(
    "a malformed address is refused without a request",
    lastRequest === null && (await wl.textContent("#note")).includes("does not look like"),
    await wl.textContent("#note"),
  );

  await wl.fill("#email", "  Someone@Example.COM ");
  await wl.click("#submit");
  await wl.waitForSelector("#done", { state: "visible" });
  check("a good address is sent", lastRequest?.email?.trim().toLowerCase() === "someone@example.com", JSON.stringify(lastRequest));
  check("with the page it came from", lastRequest?.source === "editlyai.io", JSON.stringify(lastRequest));
  check("the form is replaced by the confirmation", await wl.isHidden("#join"));
  check(
    "and the count is shown as people waiting, never as a position",
    (await wl.textContent("#doneText")).includes("42") &&
      !/position|you are #|number \d+ in/i.test(await wl.textContent("#doneText")),
    await wl.textContent("#doneText"),
  );

  // Each failure says something different, because the advice is different.
  const answers = [
    { reply: { status: 429, body: { error: "slow down" } }, expect: /few minutes/i, name: "rate limited" },
    { reply: { status: 500, body: {} }, expect: /our side/i, name: "a server error" },
    { reply: "abort", expect: /connection/i, name: "no network at all" },
  ];
  for (const answer of answers) {
    await wl.reload();
    reply = answer.reply;
    await wl.fill("#email", "someone@example.com");
    await wl.click("#submit");
    await wl.waitForFunction(
      () => !document.getElementById("note").textContent.includes("Adding you"),
      { timeout: 5000 },
    );
    const said = await wl.textContent("#note");
    check(`${answer.name} is explained in words`, answer.expect.test(said), said);
    check(
      `and after ${answer.name} they can try again`,
      (await wl.isDisabled("#submit")) === false,
    );
    check(`${answer.name} does not show the confirmation`, await wl.isHidden("#done"));
  }

  check("nothing threw in the waiting-list page", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
  await wl.close();
}

check("nothing threw in the page while all that ran", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));


/**
 * Text in the person's own language is laid out in that language's direction.
 *
 * Nothing in this app carried a `dir` until now, which was survivable while
 * every word on screen was English. It is not survivable any more: the reply
 * answers in Arabic, the render notes come back in Arabic, and a clip is
 * titled with the speaker's own words — which have been Arabic since titles
 * shipped, so this was already wrong for real users before it was wrong for
 * the new work.
 *
 * `dir="auto"` rather than a page-level `dir="rtl"`: the chrome around the
 * text — the buttons, the tabs, the dates — is English and stays where it is.
 * Only the person's own words turn round, and only when they actually are
 * right-to-left. The browser decides that from the first strong character,
 * which is a better rule than anything we would write.
 */
section("The person's own words are laid out in their own direction");
{
  const page = await browser.newPage();
  await page.setContent(`
    <div id="ltr" dir="auto">Right — I'll cut out the silences and dead air.</div>
    <div id="rtl" dir="auto">تمام — سأقصّ الصمت والفراغات.</div>
    <div id="mixed" dir="auto">هذا ما فعلته.\nreframed to 1080x1920 for tiktok</div>
    <div id="digits" dir="auto">٥ أسرار</div>
    <div id="fixed">تمام — سأقصّ الصمت والفراغات.</div>
  `);
  const direction = (id) =>
    page.evaluate((sel) => getComputedStyle(document.querySelector(sel)).direction, `#${id}`);

  check("an English line stays left-to-right", (await direction("ltr")) === "ltr");
  check("an Arabic line turns round", (await direction("rtl")) === "rtl", await direction("rtl"));
  check(
    "a summary that opens in Arabic reads right-to-left, English lines and all",
    (await direction("mixed")) === "rtl",
    await direction("mixed"),
  );
  check("a title that starts with an Arabic digit still reads as Arabic", (await direction("digits")) === "rtl");
  // The control: without the attribute the same string lays out the wrong way,
  // so these checks are measuring `dir` and not the browser being clever.
  check("and without dir the same Arabic lays out left-to-right", (await direction("fixed")) === "ltr");
  await page.close();
}

/**
 * And the rule, over the places that actually carry those words.
 *
 * A list rather than a pattern, because "text that came from the person" is
 * not something a regex can recognise — but forgetting one of these is, and
 * the next person to render a title or a note will find their field named
 * here with the reason next to it.
 */
section("Every field that carries the person's words declares its direction");
{
  const { readFileSync } = await import("node:fs");
  const CARRIES_THEIR_WORDS = [
    ["pages/project-editor.tsx", "{msg.content}", "what they wrote, and what Noah answered"],
    ["pages/project-editor.tsx", "{project.title}", "a project named after their file"],
    ["pages/project-editor.tsx", "value={chatInput}", "the sentence they are typing right now"],
    ["pages/export.tsx", "{project.title}", "the same name, on the export screen"],
    ["pages/export.tsx", "{note}", "the render notes, which are in the language they asked in"],
    ["pages/dashboard.tsx", "{project.title}", "every card on the dashboard"],
    ["components/project-clips.tsx", "{clip.title}", "the speaker's own first words"],
    ["components/project-clips.tsx", "{clip.note}", "why that stretch was chosen"],
  ];

  for (const [file, expression, why] of CARRIES_THEIR_WORDS) {
    const source = readFileSync(path.join(repoRoot, "artifacts/editly/src", file), "utf8");

    /*
      Every place the expression appears, minus the ones that are an
      attribute's value rather than rendered text. `alt={project.title}` is read
      aloud, not laid out, and demanding a direction of it would be a check
      nobody could satisfy honestly — which is how a rule gets a meaningless
      `dir` added to shut it up.

      Two tells, and the second was added when the first was not enough. `=`
      immediately before the brace catches `alt={project.title}`. It does not
      catch `aria-label={`Delete ${project.title}`}`, where the character before
      is a `$` — so the occurrence is also treated as an attribute when it sits
      inside a quoted or backticked value, which is what an odd number of
      unescaped quotes between the opening `<` and here means.
    */
    const rendered = [];
    for (let at = source.indexOf(expression); at >= 0; at = source.indexOf(expression, at + 1)) {
      if (!expression.includes("=") && source[at - 1] === "=") continue;
      const sinceTag = source.slice(source.lastIndexOf("<", at), at);
      const quotes = (sinceTag.match(/(?<!\\)["`]/g) ?? []).length;
      if (quotes % 2 === 1) continue;
      rendered.push(at);
    }

    check(
      `${file} — ${why}`,
      rendered.length > 0 &&
        rendered.every((at) => /\bdir="auto"/.test(source.slice(source.lastIndexOf("<", at), at))),
      rendered.length === 0
        ? "the expression is gone; update this list"
        : rendered
            .filter((at) => !/\bdir="auto"/.test(source.slice(source.lastIndexOf("<", at), at)))
            .map((at) => source.slice(source.lastIndexOf("<", at), at).slice(0, 90).replace(/\s+/g, " "))
            .join(" | "),
    );
  }
}

// ─── Every link goes somewhere the router declares ───────────────────────────
//
// `navigate("/projects/" + id)` compiles, runs, and lands on Not Found, because
// the route is `/project/:id` — singular. Nothing fails: the request that
// created the row succeeded, the navigation succeeded, and the person is told
// the page does not exist. A typo in a string is not a type error and no test
// that renders one page can see it, so the check is the whole set at once:
// every internal path the app navigates to, against every path App.tsx routes.

section("Every internal link lands on a route this app declares");
{
  const { readFileSync, readdirSync, statSync } = await import("node:fs");
  const srcDir = path.join(repoRoot, "artifacts/editly/src");

  const files = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(name)) files.push(full);
    }
  })(srcDir);

  // What the router answers to, as a shape: `/project/:id` becomes `/project/*`.
  const app = readFileSync(path.join(srcDir, "App.tsx"), "utf8");
  const declared = new Set();
  for (const m of app.matchAll(/<Route\s+path="([^"]+)"/g)) {
    declared.add(m[1].replace(/:[A-Za-z0-9_]+/g, "*"));
  }
  check("the router declares routes this check can read", declared.size >= 5, [...declared].join(" "));

  // Every internal destination, from the three ways this app expresses one.
  const NAVIGATES = /(?:navigate|setLocation)\(\s*(?:`([^`]*)`|"([^"]*)")|href=(?:\{\s*`([^`]*)`\s*\}|"([^"]*)")/g;
  const wrong = [];
  for (const file of files) {
    if (file.endsWith("App.tsx")) continue;
    const source = readFileSync(file, "utf8");
    for (const m of source.matchAll(NAVIGATES)) {
      const raw = m[1] ?? m[2] ?? m[3] ?? m[4] ?? "";
      if (!raw.startsWith("/")) continue;           // external, anchor, or mailto
      if (raw.startsWith("/api/")) continue;         // not a page
      // An interpolated segment stands for whatever the route's parameter is.
      const shape = raw.replace(/\$\{[^}]*\}/g, "*").split("?")[0].split("#")[0];
      const normalised = shape.length > 1 ? shape.replace(/\/$/, "") : shape;
      if (!declared.has(normalised)) {
        wrong.push(`${path.relative(srcDir, file)}: ${raw} → ${normalised}`);
      }
    }
  }

  check("no link points at a path the router does not have", wrong.length === 0, wrong.join(" | "));
}

await browser.close();
server.close();
await rm(workDir, { recursive: true, force: true });
await rm(entryDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("The upload survives the network it actually runs on.");
