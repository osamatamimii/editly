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
   import { createElement } from "react";
   import { createRoot } from "react-dom/client";
   (window as any).VS = storage;
   (window as any).CO = checkout;
   (window as any).OA = oauth;
   (window as any).LS = load;
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

const chromiumDir = readdirSync("/opt/pw-browsers").find((d) => /^chromium-\d+$/.test(d));
const executablePath = `/opt/pw-browsers/${chromiumDir}/chrome-linux/chrome`;
const { chromium } = require(
  require.resolve("playwright", {
    paths: [`${process.env.HOME}/.npm-global/lib/node_modules`, repoRoot],
  }),
);
const browser = await chromium.launch({
  executablePath,
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

section("Checkout cannot grant anything, and says so when it cannot open");
{
  const results = await run(async () => {
    const config = { productId: "19012", publicKey: "pk_test", plans: { pro: "36845" }, currentPlan: "free" };
    let creatorError = null;
    try {
      await window.CO.openCheckout(config, { plan: "creator", billingCycle: "monthly" });
    } catch (error) {
      creatorError = String(error.message);
    }

    // The script is unreachable from this origin, which is exactly what an ad
    // blocker looks like from here.
    let proError = null;
    try {
      await window.CO.openCheckout(config, { plan: "pro", billingCycle: "monthly" });
    } catch (error) {
      proError = String(error.message);
    }
    let secondProError = null;
    try {
      await window.CO.openCheckout(config, { plan: "pro", billingCycle: "monthly" });
    } catch (error) {
      secondProError = String(error.message);
    }
    return { creatorError, proError, secondProError };
  });

  check(
    "a plan with no id configured is refused by name",
    /creator plan is not set up/.test(results.creatorError ?? ""),
    results.creatorError,
  );
  check("a checkout script that will not load is an error, not a hang", results.proError !== null, results.proError);
  check(
    "which blames the connection or a blocker, because that is what it usually is",
    /ad blocker/.test(results.proError ?? ""),
    results.proError,
  );
  check(
    "and a second click tries again rather than remembering the failure forever",
    results.secondProError !== null && results.secondProError === results.proError,
    `${results.proError} / ${results.secondProError}`,
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

  const copy = await run(() => window.LS.COULD_NOT_LOAD);
  check(
    "the message says the work is safe, because the first fear is that it is gone",
    /work is safe/i.test(copy),
    copy,
  );
  check("and that it is our fault, not something they did", /on our side/i.test(copy), copy);
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

check("nothing threw in the page while all that ran", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

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
