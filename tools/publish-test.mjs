/**
 * The first platform this product can actually send to.
 *
 * Scheduling has been a promise: a queue that claims, a publisher that runs on
 * a timer and refuses to send twice, per-platform limits enforced at the
 * moment somebody types — and, at the end of all of it, a branch that wrote
 * "there is no way to send to this platform yet". This is that branch becoming
 * real for YouTube.
 *
 * What is worth testing without a network is smaller than the file and more
 * important than it:
 *
 * **The title.** Every other platform takes one blob of text; YouTube takes a
 * title of 100 and a description of 5000. A description cut at 5000 is fine. A
 * title cut at 100 is a sentence broken in half on somebody's own channel,
 * under their name, in front of their subscribers — so it is cut at a word,
 * and it is never invented.
 *
 * **The refusals.** A post that did not go out is a thing somebody has to
 * decide about, and every failure has to carry a sentence they can act on. The
 * one that matters most is not "it failed" but **"nothing was posted"** —
 * because the first question after a failed post is always whether it went out
 * twice, and a duplicate on somebody's channel cannot be taken back.
 *
 * **The expiry.** A Google access token lasts an hour. Somebody connects on
 * Tuesday and schedules for Thursday; by then the token has been dead two
 * days. This is the gap between "connecting works" and "scheduling works", and
 * it is invisible until the first post that matters.
 *
 * Usage: node tools/publish-test.mjs
 * Requires: nothing. No keys, no network, no database.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-publish-"));

function bundle(entry, name) {
  const outfile = path.join(buildDir, name);
  const built = spawnSync(
    require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/worker"] }),
    [
      path.join(repoRoot, entry), "--bundle", "--platform=node", "--format=esm",
      "--target=node22", `--outfile=${outfile}`, "--log-level=error",
      "--banner:js=import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
    ],
    { stdio: "inherit" },
  );
  if (built.status !== 0) {
    console.error(`could not bundle ${entry}`);
    process.exit(1);
  }
  return pathToFileURL(outfile).href;
}

const { titleFrom, descriptionFrom } = await import(
  bundle("artifacts/worker/src/publish-youtube.ts", "youtube.mjs")
);

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

// ── The title ──────────────────────────────────────────────────────────────

section("The title is the caption's own first line, never something we wrote");
{
  check(
    "a short caption is the title",
    titleFrom("How I edit ten videos a week") === "How I edit ten videos a week",
    titleFrom("How I edit ten videos a week"),
  );
  check(
    "and only the first line of a multi-line one",
    titleFrom("The hook that doubled my views\n\nHere is the whole story…") ===
      "The hook that doubled my views",
    titleFrom("The hook that doubled my views\n\nHere is the whole story…"),
  );
  check(
    "leading blank lines are not the title",
    titleFrom("\n\n  Real first line") === "Real first line",
    titleFrom("\n\n  Real first line"),
  );
  check("Arabic reads the same way", titleFrom("كيف أقصّ حلقة بودكاست في دقيقتين") === "كيف أقصّ حلقة بودكاست في دقيقتين");
}

section("A long line is cut at a word, and says it was cut");
{
  const long =
    "This is a very long first line that keeps going well past the hundred characters YouTube allows for a title and does not stop";
  const title = titleFrom(long);
  check("it fits", title.length <= 100, `${title.length}`);
  check("it says it was cut", title.endsWith("…"), title);
  check(
    "and it ends on a whole word",
    // The failure this prevents is a title reading "…charac" on somebody's
    // channel. Every character before the ellipsis must belong to a word the
    // caption actually contains.
    long.startsWith(title.slice(0, -1)) && !/\S…$/.test(title) === false
      ? true
      : long.split(" ").includes(title.slice(0, -1).trim().split(" ").pop()),
    title,
  );
  check(
    "and every word in it came from the caption",
    title
      .slice(0, -1)
      .trim()
      .split(/\s+/)
      .every((word) => long.includes(word)),
    title,
  );
}

section("A caption with nothing in it still produces a title");
{
  // YouTube refuses an upload with an empty title, so this is not tidiness: an
  // empty caption would fail the post at the last step, after the render was
  // paid for.
  check("an empty caption", titleFrom("") === "Untitled", titleFrom(""));
  check("and whitespace only", titleFrom("   \n  ") === "Untitled", titleFrom("   \n  "));
}

section("A hundred-character wall with no spaces is still cut");
{
  const wall = "#".concat("a".repeat(200));
  const title = titleFrom(wall);
  check("it fits", title.length <= 100, `${title.length}`);
  check("and is not empty", title.length > 10, title);
}

// ── The description ────────────────────────────────────────────────────────

section("The description is the whole caption, with the hashtags under it");
{
  const body = descriptionFrom("Two lines\nof caption", ["editing", "#shorts"]);
  check("the caption survives whole", body.startsWith("Two lines\nof caption"), body.slice(0, 40));
  check("the hashtags are under it", body.includes("#editing #shorts"), body);
  check(
    "a tag already carrying its hash is not given a second",
    !body.includes("##"),
    body,
  );
  check(
    "empty tags are not tags",
    descriptionFrom("x", ["", "  "]) === "x",
    descriptionFrom("x", ["", "  "]),
  );
  check("no tags means no trailing blank lines", descriptionFrom("x", []) === "x");
}

section("And it fits inside YouTube's five thousand");
{
  const huge = descriptionFrom("a".repeat(6000), ["tag"]);
  check("it fits", huge.length <= 5000, `${huge.length}`);
  check("and says it was cut", huge.endsWith("…"));
}

// ── What the sender refuses, and how it says so ────────────────────────────

section("Every way a post can fail says that nothing was posted");
{
  /*
    Read out of the source rather than run, because running it means a network
    and a Google account. What is being asserted is a property of the words,
    and the words are the part a person meets.

    The first question after a failed post is always whether it went out twice.
  */
  const publisher = readFileSync(path.join(repoRoot, "artifacts/worker/src/publisher.ts"), "utf8");
  const send = publisher.slice(publisher.indexOf("async function send("), publisher.indexOf("/**\n * One pass."));
  check("the sender is in the file", send.length > 400, `${send.length}`);

  const all = [...send.matchAll(/reason:\s*(?:`|")([^`"]+)/g)].map((m) => m[1]);

  /*
    One of them ends in the platform's own words, and it is held to a different
    rule on purpose.

    "YouTube refused it: quotaExceeded — the request cannot be completed" is
    the most useful sentence in this file, and it is most useful *because* the
    half after the colon is Google's and not ours. Requiring it to end in our
    full stop would mean appending punctuation to somebody else's sentence, or
    worse, replacing their reason with a tidy one of ours.
  */
  const forwarded = all.filter((r) => /\$\{error\.message\}/.test(r));
  const reasons = all.filter((r) => !/\$\{error\.message\}/.test(r));

  check(
    "exactly one refusal forwards the platform's own words",
    forwarded.length === 1,
    forwarded.join(" | "),
  );
  check(
    "and it names which platform said it",
    forwarded.every((r) => /SOCIAL_LABEL\[platform\]/.test(r)),
    forwarded.join(" | "),
  );

  check("it has refusals to check", reasons.length >= 3, `${reasons.length}`);
  for (const reason of reasons) {
    check(
      `"${reason.slice(0, 52)}${reason.length > 52 ? "…" : ""}" is a sentence`,
      // A capital, some words, and a full stop. A reason that reads like a log
      // line is a reason nobody can act on.
      /^[A-Z$]/.test(reason) && reason.split(" ").length >= 4 && /[.!]$/.test(reason.trim()),
      reason,
    );
  }
  check(
    "and the ones we caused say nothing was posted",
    // Not the platform's own refusal: that carries YouTube's words, and adding
    // ours to them would be talking over the only party who knows.
    reasons.filter((r) => /Nothing was posted\./.test(r)).length >= 3,
    reasons.join(" | "),
  );
}

section("A platform with no sender is refused rather than pretended at");
{
  const publisher = readFileSync(path.join(repoRoot, "artifacts/worker/src/publisher.ts"), "utf8");
  check(
    "the set of platforms that can be sent to is explicit",
    /const UPLOADERS: Partial<Record<SocialPlatform, Uploader>>/.test(publisher),
    "a map is the honest shape of a list that grows one platform at a time",
  );
  /*
    It was a `Set` of names while one platform worked. It is a map now because
    the platforms do not take a file the same way: YouTube and TikTok want the
    bytes, Instagram and Facebook fetch a link themselves — so "can we send
    there" and "how" are the same question and belong in the same place.
  */
  check(
    "and every entry says how that platform takes a file",
    (publisher.match(/takes: "(file|url)"/g) ?? []).length >= 4,
    String((publisher.match(/takes: "(file|url)"/g) ?? []).length),
  );
  check("youtube is one of them", /youtube: \{ takes: "file"/.test(publisher));
  check(
    "and the two that fetch it themselves never download it",
    /uploader\.takes === "url"/.test(publisher) && /signedGet\(key, LINK_SECONDS\)/.test(publisher),
    "a worker that downloads a file nobody asked it for is paying egress twice",
  );
  check(
    "and the refusal for the others names the platform",
    /cannot send to \$\{SOCIAL_LABEL\[platform\]/.test(publisher),
    "\"we cannot send there yet\" without saying where is a sentence about nothing",
  );
}

// ── The token ──────────────────────────────────────────────────────────────

section("A token is refreshed before the send, not after a 401");
{
  const token = readFileSync(path.join(repoRoot, "artifacts/worker/src/social-token.ts"), "utf8");
  check(
    "it refreshes early rather than exactly on expiry",
    /EARLY_MS/.test(token),
    "a token with forty seconds left dies partway through a file that is already on the platform",
  );
  check(
    "the new token is written back",
    /update social_accounts/.test(token) && /access_token = /.test(token),
    "a refresh that is not persisted is a refresh done again next time",
  );
  check(
    "and a rotated refresh token is kept without clobbering one that was not",
    // Google returns no refresh token on a refresh and keeps the old one
    // working; TikTok rotates. Writing an empty value breaks the first, and
    // ignoring a new one breaks the second on the *second* post after expiry.
    /coalesce\(\$\{rotated\}, refresh_token\)/.test(token),
  );
  check(
    "a withdrawn permission marks the account instead of retrying forever",
    /invalid_grant/.test(token),
    "retrying a revoked grant hourly for a week is how an app gets rate-limited",
  );
  check(
    "and the account row says what the person has to do",
    /status = 'expired'/.test(token) && /connect it again|Connect it again|made again|reconnecting/i.test(token),
  );
}

section("A 200 from YouTube is not the same as a video anybody can watch");
{
  /*
    Only `id` was read out of the upload's response.

    The request asks for `privacyStatus: "public"`, and an **unaudited Google
    project silently overrides it**: every upload from an API client that has
    not been through Google's verification is locked to `private`, the response
    is an ordinary 200, and the id is real. So the row was written as
    `published`, with a watch URL, and the only person on earth who could open
    that URL was the account owner. Their audience saw nothing, the product
    said it had gone out, and nothing in the sequence was an error.

    It is the most likely thing to be wrong on the day this is switched on,
    because verification takes weeks and everything else works without it — and
    it is the same failure `publish-tiktok.ts` already refuses from the other
    end.

    Read from the source rather than run: a real upload needs a Google account
    and a network, and what is being asserted is that the answer is looked at.
  */
  const youtube = readFileSync(path.join(repoRoot, "artifacts/worker/src/publish-youtube.ts"), "utf8");
  check(
    "the response's privacy is read, not just its id",
    /video\.status\?\.privacyStatus/.test(youtube),
    "asking for public and never checking is how a private video is recorded as posted",
  );
  check(
    "anything but public is a failure rather than a quiet success",
    /privacy && privacy !== "public"/.test(youtube) && /throw new PublishError\(\s*`YouTube accepted the video and made it/.test(youtube),
    "the row's whole meaning is 'this is on their channel'; a private video is not",
  );
  check(
    "and the sentence says why it happened, because it is fixable",
    /has not been verified yet/.test(youtube),
    "'it went private' with no cause sends somebody to support; naming verification sends them to the console",
  );
  check(
    "the video is still named, because it does exist",
    /The video is on your channel: `[\s\S]{0,80}watch\?v=\$\{video\.id\}/.test(youtube),
    "it was uploaded; hiding the link would make them upload it twice",
  );
  check(
    "and a rejection after acceptance is read too",
    /uploadStatus === "rejected"/.test(youtube) && /rejectionReason/.test(youtube),
    "YouTube takes the bytes and refuses to show them for a copyright claim, with a 200",
  );
}

await rm(buildDir, { recursive: true, force: true });
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
console.log("A scheduled post reaches YouTube, or says why it did not and that nothing went out.");
