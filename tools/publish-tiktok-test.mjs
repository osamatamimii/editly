/**
 * The TikTok upload, driven end to end against an API that answers like TikTok.
 *
 * No credentials exist for this and none can be got here, so the question is
 * what a suite can honestly prove without one. Two things, and they are the two
 * that decide whether the first real attempt works or produces a mystery:
 *
 * **The arithmetic.** TikTok's chunk rules are not obvious — a floor division,
 * a remainder that rides on the last chunk rather than becoming one, and two
 * bounds that have to hold at once. Getting it wrong produces an upload TikTok
 * accepts and then fails to assemble, hours later, with a message about the
 * video rather than about the chunks. It is a pure function, so it is checked
 * exactly.
 *
 * **The envelope.** Every TikTok response carries an `error` object and a
 * successful one has `error.code === "ok"`. A refusal arrives as **HTTP 200**
 * with a different code inside. A client that reads `response.ok` marks a post
 * published that never existed — nothing throws, nothing logs. So the fake here
 * answers 200 to everything and puts the truth in the envelope, which is the
 * one behaviour a mock of the happy path would never catch.
 *
 * What this cannot prove is that TikTok's documentation matches TikTok. It is
 * written so the first real attempt fails legibly rather than silently.
 *
 * Usage: node tools/publish-tiktok-test.mjs
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
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-tiktok-"));

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

const tiktok = await import(build("artifacts/worker/src/publish-tiktok.ts", "tiktok.mjs"));
const {
  chunkPlan, captionFor, choosePrivacy, publishToTikTok,
  MIN_CHUNK_BYTES, MAX_CHUNK_BYTES, MAX_CHUNKS,
} = tiktok;

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

// ── The arithmetic ──────────────────────────────────────────────────────────

section("The file is cut up the way TikTok says, not the way it looks like it should be");
{
  const small = chunkPlan(1_000_000);
  check("a file under the minimum chunk is one chunk of its own size", small.totalChunks === 1 && small.chunkSize === 1_000_000);
  check("and its range covers every byte", small.ranges[0].start === 0 && small.ranges[0].end === 999_999);

  /*
    The obvious mistake is `ceil`, which makes a small final chunk. TikTok wants
    the remainder on the *last* chunk instead, so a 12MB file is two chunks and
    not three, and the second is 7MB.
  */
  const twelve = chunkPlan(12 * 1024 * 1024);
  check("a 12MB file is two chunks, not three", twelve.totalChunks === 2, String(twelve.totalChunks));
  check("and the leftover rides on the last one", twelve.ranges[1].end - twelve.ranges[1].start + 1 === 7 * 1024 * 1024,
    String(twelve.ranges[1].end - twelve.ranges[1].start + 1));

  const exact = chunkPlan(3 * MIN_CHUNK_BYTES);
  check("an exact multiple divides evenly", exact.totalChunks === 3);
  check("and every chunk is the declared size", exact.ranges.every((r) => r.end - r.start + 1 === MIN_CHUNK_BYTES));

  for (const bytes of [MIN_CHUNK_BYTES, MIN_CHUNK_BYTES + 1, 100 * 1024 * 1024, 3_000_000_000, 40_000_000_000]) {
    const plan = chunkPlan(bytes);
    const covered = plan.ranges.reduce((sum, r) => sum + (r.end - r.start + 1), 0);
    check(`every byte of ${bytes} is in exactly one chunk`, covered === bytes, `${covered} covered`);
    check(
      `and ${bytes} stays inside both of TikTok's bounds`,
      plan.totalChunks <= MAX_CHUNKS && plan.chunkSize <= MAX_CHUNK_BYTES,
      `${plan.totalChunks} chunks of ${plan.chunkSize}`,
    );
    check(
      `with no gaps or overlaps at ${bytes}`,
      plan.ranges.every((r, i) => (i === 0 ? r.start === 0 : r.start === plan.ranges[i - 1].end + 1)),
    );
  }

  let threw = false;
  try { chunkPlan(0); } catch { threw = true; }
  check("an empty file is refused rather than uploaded as nothing", threw);
}

section("The caption carries its hashtags and stops at the ceiling");
{
  check("hashtags go on the end", captionFor("Hello", ["one", "#two"]).endsWith("#one #two"));
  check("and a bare word gets its hash", captionFor("Hello", ["one"]).includes("#one"));
  check("nothing is added when there are none", captionFor("Hello", []) === "Hello");
  const long = captionFor("word ".repeat(1000), [], 100);
  check("a long caption is trimmed to the ceiling", long.length <= 100, String(long.length));
  check("it says it was cut", long.endsWith("…"), long.slice(-12));
  check("and the cut lands on a word boundary", /\bword…$/.test(long), long.slice(-12));
}

section("A post that nobody could see is refused, not recorded as published");
{
  check("public is taken when it is offered", choosePrivacy(["SELF_ONLY", "PUBLIC_TO_EVERYONE"]) === "PUBLIC_TO_EVERYONE");
  /*
    An app that has not passed TikTok's audit is offered `SELF_ONLY` and nothing
    else, and TikTok would accept the post. Publishing it would mark a row
    `published` for a video visible to its author alone — the person finds out
    from an audience that never saw it, which is worse than a post that did not
    go out.
  */
  check("and nothing is chosen when only private is on offer", choosePrivacy(["SELF_ONLY"]) === null);
  check("nor when the list is empty", choosePrivacy([]) === null);
}

// ── The whole flow ──────────────────────────────────────────────────────────

const work = await mkdtemp(path.join(tmpdir(), "editly-tiktok-file-"));
const file = path.join(work, "post.mp4");
await writeFile(file, Buffer.alloc(1_500_000, 7));

/**
 * A TikTok that answers like TikTok: 200 to everything, with the truth inside.
 */
function fakeTikTok(script = {}) {
  const calls = [];
  const privacy = script.privacy ?? ["PUBLIC_TO_EVERYONE", "SELF_ONLY"];
  let polls = 0;
  const doFetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body });
    const json = (payload) => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });

    if (String(url).endsWith("/creator_info/query/")) {
      if (script.creatorError) return json({ error: { code: script.creatorError, message: "no" } });
      return json({ data: { privacy_level_options: privacy }, error: { code: "ok" } });
    }
    if (String(url).endsWith("/video/init/")) {
      if (script.initError) return json({ error: { code: script.initError, message: "the app is not allowed to do that" } });
      return json({ data: { publish_id: "pub_1", upload_url: "https://upload.tiktok.test/put" }, error: { code: "ok" } });
    }
    if (String(url).startsWith("https://upload.tiktok.test")) {
      return new Response(null, { status: script.chunkStatus ?? 200 });
    }
    if (String(url).endsWith("/status/fetch/")) {
      polls += 1;
      if (script.statusFailed) {
        return json({ data: { status: "FAILED", fail_reason: script.statusFailed }, error: { code: "ok" } });
      }
      if (polls < (script.pollsBeforeDone ?? 1)) {
        return json({ data: { status: "PROCESSING_UPLOAD" }, error: { code: "ok" } });
      }
      return json({ data: { status: "PUBLISH_COMPLETE", publicaly_available_post_id: ["7300"] }, error: { code: "ok" } });
    }
    throw new Error(`unexpected call to ${url}`);
  };
  return { doFetch, calls };
}

const NEVER_WAITS = { sleep: async () => {}, now: () => 0 };

section("A whole post, from creator info to a published id");
{
  const { doFetch, calls } = fakeTikTok();
  const landed = await publishToTikTok({
    file, caption: "The best bit", hashtags: ["editly"], accessToken: "SECRET-TOKEN-XYZ", fetchImpl: doFetch, ...NEVER_WAITS,
  });
  check("it comes back with the post's id", landed.externalPostId === "7300", landed.externalPostId);
  check("and a link to it", landed.externalUrl === "https://www.tiktok.com/video/7300", landed.externalUrl);

  const order = calls.map((c) => c.url.replace("https://open.tiktokapis.com/v2", "").replace("https://upload.tiktok.test/put", "PUT"));
  check(
    "asked before it posted",
    order[0] === "/post/publish/creator_info/query/" && order[1] === "/post/publish/video/init/",
    order.join(" → "),
  );
  const put = calls.find((c) => c.method === "PUT");
  check("the file went up in one piece", Boolean(put) && put.headers["Content-Range"] === "bytes 0-1499999/1500000",
    put?.headers?.["Content-Range"]);
  check("with a length that matches the range", put.headers["Content-Length"] === "1500000");
  /*
    A token in a URL is a token in every proxy log between here and TikTok. The
    first version of this check used "tok" as the fixture's token, which is a
    substring of "tiktok" — a check that could only ever fail, dressed as one
    that could only ever pass.
  */
  check("and the token never rode in a URL", calls.every((c) => !c.url.includes("SECRET-TOKEN-XYZ")));
}

section("Uploaded is not posted");
{
  /*
    TikTok assembles the video after the last chunk, and that is where a file it
    cannot process fails — after every byte was accepted. Returning at the end
    of the upload would mark published a post TikTok is about to reject.
  */
  const { doFetch, calls } = fakeTikTok({ pollsBeforeDone: 3 });
  await publishToTikTok({ file, caption: "x", hashtags: [], accessToken: "SECRET-TOKEN-XYZ", fetchImpl: doFetch, ...NEVER_WAITS });
  check("it waits for the platform to finish", calls.filter((c) => c.url.endsWith("/status/fetch/")).length === 3);

  const failing = fakeTikTok({ statusFailed: "video too long" });
  let message = "";
  await publishToTikTok({ file, caption: "x", hashtags: [], accessToken: "SECRET-TOKEN-XYZ", fetchImpl: failing.doFetch, ...NEVER_WAITS })
    .catch((e) => { message = e.message; });
  check("a video refused at assembly is a failure", /could not process/.test(message), message);
  check("and it carries the platform's own reason", /video too long/.test(message), message);
}

section("A 200 that means no is read as no");
{
  /*
    The whole reason the envelope is read before the status. Every response here
    is HTTP 200; a client that trusted `response.ok` would sail through both of
    these and record a post that does not exist.
  */
  let message = "";
  await publishToTikTok({
    file, caption: "x", hashtags: [], accessToken: "SECRET-TOKEN-XYZ",
    fetchImpl: fakeTikTok({ initError: "scope_not_authorized" }).doFetch, ...NEVER_WAITS,
  }).catch((e) => { message = e.message; });
  check("a refusal inside a 200 throws", /scope_not_authorized/.test(message), message);
  check("and keeps the code somebody can search for", message.startsWith("scope_not_authorized:"), message);

  let second = "";
  await publishToTikTok({
    file, caption: "x", hashtags: [], accessToken: "SECRET-TOKEN-XYZ",
    fetchImpl: fakeTikTok({ creatorError: "access_token_invalid" }).doFetch, ...NEVER_WAITS,
  }).catch((e) => { second = e.message; });
  check("and it is read on the very first call too", /access_token_invalid/.test(second), second);
}

section("Only-private is refused with a sentence, not posted");
{
  let message = "";
  const fake = fakeTikTok({ privacy: ["SELF_ONLY"] });
  await publishToTikTok({
    file, caption: "x", hashtags: [], accessToken: "SECRET-TOKEN-XYZ", fetchImpl: fake.doFetch, ...NEVER_WAITS,
  }).catch((e) => { message = e.message; });
  check("it refuses", /nobody but you can see it/.test(message), message);
  check("it says nothing was posted", /Nothing was posted/.test(message));
  check("and it says what would lift it", /review/.test(message), message);
  check("and it never reached the upload", !fake.calls.some((c) => c.url.endsWith("/video/init/")));
}

section("A chunk the platform refuses says which one");
{
  let message = "";
  await publishToTikTok({
    file, caption: "x", hashtags: [], accessToken: "SECRET-TOKEN-XYZ",
    fetchImpl: fakeTikTok({ chunkStatus: 413 }).doFetch, ...NEVER_WAITS,
  }).catch((e) => { message = e.message; });
  check("the failure names the part and the status", /part 1 of 1 with 413/.test(message), message);
}

await rm(work, { recursive: true, force: true });
await rm(buildDir, { recursive: true, force: true });
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
console.log("A TikTok post goes out public, or does not go out and says why.");
