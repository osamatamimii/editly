/**
 * The X upload, driven end to end against an API that answers like X.
 *
 * No credentials exist for this and none can be got here, so the question is
 * the same one `publish-tiktok-test.mjs` asks: what can be proved honestly
 * without one. Four things, and each is a way the first real attempt would
 * otherwise fail as a mystery rather than as a sentence.
 *
 * **The two ceilings.** 280 characters and 140 seconds are the tightest limits
 * of any platform here, and 281 characters is a refusal of the whole post
 * rather than a trim. The caption is built by a pure function and checked
 * exactly, including the part that is a judgement rather than arithmetic:
 * hashtags come off before the sentence does.
 *
 * **The refusal we make ourselves.** A video over 140 seconds is stopped before
 * a byte moves. The check is that it *is* stopped, that the sentence carries
 * both numbers, and — the part worth writing a test for — that a clip which is
 * merely unmeasurable is not refused. Turning "ffprobe did not answer" into
 * "your video is too long" would be inventing a reason, which is the failure
 * this repository is built against wearing a helpful face.
 *
 * **Finalized is not ready.** X transcodes after FINALIZE and reports
 * `processing_info.state`. Posting a media id that is still `pending` produces
 * a tweet whose video does not play: accepted by X, recorded as published by
 * us, broken to everyone who sees it. So the fake here answers `pending` first
 * and `succeeded` second, and the suite asserts the post did not go out until
 * the second answer — and separately that a *missing* `processing_info`, which
 * is X's way of saying no processing was needed, is not read as "not ready".
 *
 * **And the reason is read out of the body.** A refusal from X carries its
 * words in `errors[].message` or in a problem document's `detail`. Reporting
 * the status code alone turns "your app lost a scope" and "that video is too
 * long" into the same sentence.
 *
 * What this cannot prove is that X's documentation matches X. It is written so
 * the first real attempt fails legibly rather than silently.
 *
 * Usage: node tools/publish-x-test.mjs
 * Requires: nothing.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-x-"));

function build(source, name) {
  const outfile = path.join(buildDir, name);
  const built = spawnSync(
    require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/worker"] }),
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

const x = await import(build("artifacts/worker/src/publish-x.ts", "x.mjs"));
const {
  captionFor, chunkRanges, mediaIdFrom, readProcessing, reasonFrom, publishToX,
  CAPTION_LIMIT, MAX_SECONDS, CHUNK_BYTES,
} = x;

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

const scratch = await mkdtemp(path.join(tmpdir(), "editly-x-file-"));

// ── The ceilings ────────────────────────────────────────────────────────────

section("280 characters, and what gives way first");
{
  check("the limit is X's, not a round number", CAPTION_LIMIT === 280, String(CAPTION_LIMIT));

  const short = captionFor("A short thought", ["editly", "video"]);
  check("a short post keeps its hashtags", short === "A short thought\n\n#editly #video", JSON.stringify(short));
  check("and a bare tag is given its hash", captionFor("x", ["editly"]).includes("#editly"), "");
  check("a tag that already has one does not get two", !captionFor("x", ["#editly"]).includes("##"), "");

  /*
    The judgement, not the arithmetic.

    At this ceiling a block of hashtags can be a third of the post. The person
    wrote the sentence and picked the tags off a list, so the tags go first —
    one at a time, because dropping all of them when one would have done is
    throwing away something they chose.
  */
  const long = "word ".repeat(52).trim(); // 259 characters
  const withTags = captionFor(long, ["one", "two", "three"]);
  check("the sentence survives whole when the tags can be dropped", withTags.startsWith(long), JSON.stringify(withTags.slice(0, 40)));
  check("and it is inside the limit", withTags.length <= CAPTION_LIMIT, String(withTags.length));
  check(
    "tags come off one at a time rather than all at once",
    captionFor("word ".repeat(50).trim(), ["a", "b", "c"]).includes("#a"),
    captionFor("word ".repeat(50).trim(), ["a", "b", "c"]),
  );

  const huge = "z".repeat(400);
  const cut = captionFor(huge, []);
  check("a post with no room left is trimmed, not refused", cut.length <= CAPTION_LIMIT, String(cut.length));
  check("and says it was trimmed", cut.endsWith("…"), cut.slice(-5));

  // Trimmed at a word, because the last thing on somebody's post should not be
  // half of one.
  const wordy = `${"alpha ".repeat(60)}omega`;
  const trimmed = captionFor(wordy, []);
  check("the cut lands on a word boundary", !/\balph…$/.test(trimmed) && trimmed.endsWith("…"), trimmed.slice(-12));
}

section("140 seconds, refused by us before it is refused by them");
{
  const file = path.join(scratch, "clip.mp4");
  await writeFile(file, Buffer.alloc(1024));

  const neverCalled = async () => {
    throw new Error("nothing should have been sent");
  };

  let refused = null;
  try {
    await publishToX({
      file,
      caption: "hello",
      hashtags: [],
      accessToken: "t",
      fetchImpl: neverCalled,
      durationOf: async () => 180,
    });
  } catch (error) {
    refused = error;
  }
  check("a three-minute clip is stopped here", refused !== null, "");
  check("before anything is uploaded", refused?.message?.includes("Nothing was posted"), refused?.message ?? "");
  check(
    "and the sentence carries both numbers",
    refused?.message?.includes(String(MAX_SECONDS)) && refused?.message?.includes("180"),
    refused?.message ?? "",
  );

  /*
    And the case that matters more than the refusal: a clip nobody could
    measure is not refused. ffprobe failing is our problem, and answering it
    with "your video is too long" would be inventing a reason — the exact
    failure this file exists to prevent, wearing a helpful face.
  */
  const fake = fakeX();
  const landed = await publishToX({
    file,
    caption: "hello",
    hashtags: [],
    accessToken: "t",
    fetchImpl: fake.fetch,
    sleep: async () => {},
    now: fake.now,
    durationOf: async () => {
      throw new Error("ffprobe is not on this machine");
    },
  });
  check("a clip that could not be measured is still sent", landed.externalPostId === "1990", JSON.stringify(landed));

  // 140.0 exactly is inside the limit, and the half-second of slack is there
  // because a 140-second export measures 140.04 often enough to matter.
  const edge = fakeX();
  await publishToX({
    file, caption: "hi", hashtags: [], accessToken: "t",
    fetchImpl: edge.fetch, sleep: async () => {}, now: edge.now,
    durationOf: async () => 140.2,
  });
  check("a clip on the line is not refused for rounding", edge.calls.some((c) => c.url.includes("/2/tweets")), "");
}

// ── The chunks ──────────────────────────────────────────────────────────────

section("The file, cut into pieces X will take");
{
  check("a small file is one piece", chunkRanges(1000).length === 1, "");
  check("and that piece is exactly its own size", chunkRanges(1000)[0].end === 999, JSON.stringify(chunkRanges(1000)));

  const two = chunkRanges(CHUNK_BYTES + 1);
  check("a byte over one chunk is two pieces", two.length === 2, String(two.length));
  check("the second holds the one byte", two[1].start === CHUNK_BYTES && two[1].end === CHUNK_BYTES, JSON.stringify(two[1]));

  const exact = chunkRanges(CHUNK_BYTES * 3);
  check("an exact multiple does not add an empty piece", exact.length === 3, String(exact.length));

  const many = chunkRanges(CHUNK_BYTES * 4 + 17);
  check("every byte is covered exactly once", many.reduce((n, r) => n + (r.end - r.start + 1), 0) === CHUNK_BYTES * 4 + 17, "");
  check("the pieces are contiguous", many.every((r, i) => i === 0 || r.start === many[i - 1].end + 1), "");
  check("and numbered from zero", many.every((r, i) => r.index === i), "");
  check("no piece is over the ceiling", many.every((r) => r.end - r.start + 1 <= CHUNK_BYTES), "");

  let empty = null;
  try {
    chunkRanges(0);
  } catch (error) {
    empty = error;
  }
  check("an empty file is refused rather than uploaded as nothing", empty !== null, "");
}

// ── The envelope ────────────────────────────────────────────────────────────

section("A refusal is read out of the body, not off the status line");
{
  check(
    "a v2 error array gives its message",
    reasonFrom({ errors: [{ message: "Your app is not permitted to post" }] }, 403) === "Your app is not permitted to post",
    "",
  );
  check(
    "a problem document gives its detail",
    reasonFrom({ title: "Unauthorized", detail: "The token has expired" }, 401) === "The token has expired",
    "",
  );
  check(
    "and a body with nothing in it still names the status",
    reasonFrom({}, 500).includes("500"),
    reasonFrom({}, 500),
  );
}

section("The media id, whichever way X spells it");
{
  check("the command endpoint's spelling", mediaIdFrom({ media_id_string: "77" }) === "77", "");
  check("the newer endpoint's spelling", mediaIdFrom({ data: { id: "88" } }) === "88", "");
  /*
    Both are in X's own current documentation, and reading only one would work
    until the day it did not — reported as "returned no media id" against an
    upload that was fine.
  */
  check("and nothing at all is nothing, not a crash", mediaIdFrom({}) === null, "");
}

section("Finalized is not ready");
{
  check("no processing_info means there was none to do", readProcessing({}).done === true, "");
  check("pending is not done", readProcessing({ processing_info: { state: "pending" } }).done === false, "");
  check("in_progress is not done", readProcessing({ processing_info: { state: "in_progress" } }).done === false, "");
  check("succeeded is done and did not fail", (() => {
    const s = readProcessing({ processing_info: { state: "succeeded" } });
    return s.done && s.failed === null;
  })(), "");
  const failed = readProcessing({ processing_info: { state: "failed", error: { message: "InvalidMedia" } } });
  check("failed is done and carries X's reason", failed.done && failed.failed === "InvalidMedia", JSON.stringify(failed));
  check(
    "and X's own retry interval is used when it gives one",
    readProcessing({ processing_info: { state: "pending", check_after_secs: 12 } }).checkAfterMs === 12_000,
    "",
  );
  check(
    "with a fallback when it does not",
    readProcessing({ processing_info: { state: "pending" } }).checkAfterMs > 0,
    "",
  );
}

// ── The whole flow ──────────────────────────────────────────────────────────

/**
 * An API that answers like X: INIT, one 204 per APPEND, a FINALIZE that is
 * still pending, a STATUS that succeeds, and a tweet.
 */
function fakeX(options = {}) {
  const calls = [];
  let statusAsks = 0;
  let clock = 0;
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  return {
    calls,
    now: () => (clock += 1000),
    fetch: async (url, init = {}) => {
      const href = String(url);
      const body = init.body;
      const command =
        body instanceof URLSearchParams
          ? body.get("command")
          : typeof FormData !== "undefined" && body instanceof FormData
            ? body.get("command")
            : href.includes("command=STATUS")
              ? "STATUS"
              : null;
      calls.push({ url: href, command, method: init.method ?? "GET" });

      if (href.includes("/2/tweets")) {
        if (options.tweetFails) return json({ errors: [{ message: options.tweetFails }] }, 403);
        return json({ data: { id: "1990" } });
      }
      if (command === "INIT") return json({ data: { id: "media-1" } });
      if (command === "APPEND") return new Response(null, { status: 204 });
      if (command === "FINALIZE") {
        return json({ data: { processing_info: { state: "pending", check_after_secs: 1 } } });
      }
      if (command === "STATUS") {
        statusAsks += 1;
        if (options.processingFails && statusAsks >= 2) {
          return json({ data: { processing_info: { state: "failed", error: { message: options.processingFails } } } });
        }
        const state = statusAsks >= 2 ? "succeeded" : "pending";
        return json({ data: { processing_info: { state, check_after_secs: 1 } } });
      }
      return json({ errors: [{ message: `nothing here answers ${href}` }] }, 404);
    },
  };
}

section("A post goes out, and only after the video is ready");
{
  const file = path.join(scratch, "post.mp4");
  await writeFile(file, Buffer.alloc(CHUNK_BYTES + 2048, 7));

  const fake = fakeX();
  const landed = await publishToX({
    file,
    caption: "Made with one sentence",
    hashtags: ["editly"],
    accessToken: "token",
    fetchImpl: fake.fetch,
    sleep: async () => {},
    now: fake.now,
    durationOf: async () => 30,
  });

  check("it comes back with the post's own id", landed.externalPostId === "1990", JSON.stringify(landed));
  check("and a link somebody can open", landed.externalUrl.includes("/status/1990"), landed.externalUrl);

  const commands = fake.calls.map((c) => c.command ?? (c.url.includes("/2/tweets") ? "TWEET" : "?"));
  check("it initialised once", commands.filter((c) => c === "INIT").length === 1, JSON.stringify(commands));
  check(
    "sent one part per chunk",
    commands.filter((c) => c === "APPEND").length === chunkRanges(CHUNK_BYTES + 2048).length,
    JSON.stringify(commands),
  );
  check("finalised once", commands.filter((c) => c === "FINALIZE").length === 1, "");

  /*
    The order is the whole check. A tweet before the transcode finished is a
    post with a video that does not play, and it is accepted — so "did it post"
    proves nothing and "did it post *after*" proves everything.
  */
  const tweetAt = commands.indexOf("TWEET");
  const lastStatusAt = commands.lastIndexOf("STATUS");
  check("waited for the transcode before posting", lastStatusAt >= 0 && lastStatusAt < tweetAt, JSON.stringify(commands));
  check("and asked more than once, because the first answer was pending", commands.filter((c) => c === "STATUS").length >= 2, "");
}

section("And when something goes wrong, it says what");
{
  const file = path.join(scratch, "bad.mp4");
  await writeFile(file, Buffer.alloc(2048));

  const failing = fakeX({ processingFails: "InvalidMediaFormat" });
  let error = null;
  try {
    await publishToX({
      file, caption: "x", hashtags: [], accessToken: "t",
      fetchImpl: failing.fetch, sleep: async () => {}, now: failing.now,
      durationOf: async () => 10,
    });
  } catch (e) {
    error = e;
  }
  check("a transcode failure is X's words, not ours", error?.message?.includes("InvalidMediaFormat"), error?.message ?? "");
  check("and no post was made", !failing.calls.some((c) => c.url.includes("/2/tweets")), "");

  const refusing = fakeX({ tweetFails: "You are not permitted to create a Post" });
  let refusal = null;
  try {
    await publishToX({
      file, caption: "x", hashtags: [], accessToken: "t",
      fetchImpl: refusing.fetch, sleep: async () => {}, now: refusing.now,
      durationOf: async () => 10,
    });
  } catch (e) {
    refusal = e;
  }
  check("a refused post carries X's sentence", refusal?.message?.includes("not permitted"), refusal?.message ?? "");
}

section("The worker knows about it");
{
  /*
    Built and unreachable is a real failure in this repository's history, and
    for a publisher it is invisible: the account connects, the post schedules,
    and the send falls through to "cannot send to X yet" for a platform that
    now can.
  */
  const publisher = await import("node:fs/promises").then((fs) =>
    fs.readFile(path.join(repoRoot, "artifacts/worker/src/publisher.ts"), "utf8"),
  );
  check("X is in the uploader table", /x:\s*\{\s*takes:\s*"file",\s*send:\s*publishToX\s*\}/.test(publisher), "");
  check("and it takes the bytes, because X does not fetch", !/x:\s*\{\s*takes:\s*"url"/.test(publisher), "");

  const processors = await import("node:fs/promises").then((fs) =>
    fs.readFile(path.join(repoRoot, "lib/api-zod/src/processors.ts"), "utf8"),
  );
  // A host the code talks to and the privacy page does not name is a
  // disclosure gap, and `privacy-test` fails on it — but only if the host is
  // spelled the same way in both places.
  check("the host it actually calls is disclosed", processors.includes("api.x.com"), "");
}

await rm(scratch, { recursive: true, force: true });
await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
console.log("The upload is not the post, and the post waits for the video.");
