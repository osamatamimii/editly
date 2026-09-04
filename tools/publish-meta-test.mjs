/**
 * Instagram Reels and Facebook Pages, driven against a Graph that answers like
 * Graph.
 *
 * ## The finding this suite exists around
 *
 * The connected account cannot be posted to. `identityFor` stores what `/me`
 * returns when somebody connects a Meta account — a **Facebook user** — and
 * neither Instagram nor Facebook will accept a post to that. A Reel goes to an
 * *Instagram Business account*, reached through a *Page*; a Facebook video goes
 * to a *Page*, with the **Page's own token** and not the user's.
 *
 * Nothing about that is visible until the first real post, where it arrives as
 * a permissions error about an object id that looks perfectly reasonable. So
 * the resolution happens at send time, and the checks below are mostly about
 * *which token* is on *which call* — the part that reads correct and is wrong.
 *
 * ## And the second one: uploaded is not posted
 *
 * A Reel container is created, and then Meta fetches the video from our link
 * and transcodes it on its own schedule. Publishing before it says `FINISHED`
 * answers with something that reads like a permissions problem — sending
 * somebody to check their permissions over a video that was merely still
 * uploading.
 *
 * Usage: node tools/publish-meta-test.mjs
 * Requires: nothing.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-meta-"));

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

const meta = await import(build("artifacts/worker/src/publish-meta.ts", "meta.mjs"));
const { publishToInstagram, publishToFacebook, pageFor, instagramAccountFor, captionFor } = meta;

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

const USER_TOKEN = "USER-TOKEN-AAA";
const PAGE_TOKEN = "PAGE-TOKEN-BBB";
const VIDEO_URL = "https://storage.test/signed/post.mp4?token=abc";

/** A Graph that behaves like Graph, including answering 200 with an error in it. */
function fakeGraph(script = {}) {
  const calls = [];
  let polls = 0;
  const doFetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const body = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : null;
    calls.push({
      path: parsed.pathname,
      method: init.method ?? "GET",
      query: Object.fromEntries(parsed.searchParams),
      body,
    });
    const json = (payload, status = 200) =>
      new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

    if (parsed.pathname.endsWith("/me/accounts")) {
      if (script.noPages) return json({ data: [] });
      return json({ data: [{ id: "page_1", name: "Studio", access_token: PAGE_TOKEN }] });
    }
    if (parsed.pathname === "/v21.0/page_1" ) {
      if (script.noInstagram) return json({ id: "page_1" });
      return json({ id: "page_1", instagram_business_account: { id: "ig_9" } });
    }
    if (parsed.pathname === "/v21.0/ig_9/media") {
      if (script.containerError) {
        // 200 with an error inside, which is how Graph refuses.
        return json({ error: { message: "bad", error_user_msg: script.containerError } });
      }
      return json({ id: "container_5" });
    }
    if (parsed.pathname === "/v21.0/container_5") {
      polls += 1;
      if (script.containerFails) return json({ status_code: "ERROR", status: script.containerFails });
      if (polls < (script.pollsBeforeReady ?? 1)) return json({ status_code: "IN_PROGRESS" });
      return json({ status_code: "FINISHED" });
    }
    if (parsed.pathname === "/v21.0/ig_9/media_publish") return json({ id: "reel_77" });
    // The permalink read that follows a publish. `media_publish` returns a
    // numeric media id and Instagram's /reel/ path takes a shortcode, so the
    // link has to be asked for rather than assembled — see publish-meta.ts.
    if (parsed.pathname === "/v21.0/reel_77") {
      if (script.noPermalink) return json({ id: "reel_77" });
      if (script.permalinkFails) return json({ error: { message: "nope" } }, 500);
      return json({ id: "reel_77", permalink: "https://www.instagram.com/reel/AbC123xyz/" });
    }
    if (parsed.pathname === "/v21.0/page_1/videos") return json({ id: "vid_88" });
    throw new Error(`unexpected call to ${url}`);
  };
  return { doFetch, calls };
}

const NEVER_WAITS = { sleep: async () => {}, now: () => 0 };

// ── The account that cannot be posted to ────────────────────────────────────

section("The Page behind the connected user is found, and its own token used");
{
  const { doFetch, calls } = fakeGraph();
  const page = await pageFor(USER_TOKEN, doFetch);
  check("the Page is resolved from the user's token", page.id === "page_1", page.id);
  check("and it comes back with a token of its own", page.token === PAGE_TOKEN, page.token);
  check("which is not the user's", page.token !== USER_TOKEN);
  check("asked with the user's token, since that is all we have", calls[0].query.access_token === USER_TOKEN);

  const noPages = fakeGraph({ noPages: true });
  let message = "";
  await pageFor(USER_TOKEN, noPages.doFetch).catch((e) => { message = e.message; });
  check("an account with no Page is refused with a sentence", /manages no Page/.test(message), message);
  check("and it says nothing was posted", /Nothing was posted/.test(message));

  const noIg = fakeGraph({ noInstagram: true });
  let second = "";
  await instagramAccountFor({ id: "page_1", token: PAGE_TOKEN, name: "Studio" }, noIg.doFetch)
    .catch((e) => { second = e.message; });
  check("a Page with no Instagram linked is refused by name", /No Instagram account is linked to Studio/.test(second), second);
  check("and it says what to do about it", /Link one in Meta's settings/.test(second));
}

// ── The Reel ────────────────────────────────────────────────────────────────

section("A Reel: container, wait, publish");
{
  const { doFetch, calls } = fakeGraph({ pollsBeforeReady: 3 });
  const landed = await publishToInstagram({
    videoUrl: VIDEO_URL, caption: "The best bit", hashtags: ["editly"],
    accessToken: USER_TOKEN, fetchImpl: doFetch, ...NEVER_WAITS,
  });
  check("it comes back with the post id", landed.externalPostId === "reel_77", landed.externalPostId);
  check(
    "and a link Instagram gave us, rather than one assembled from the media id",
    landed.externalUrl === "https://www.instagram.com/reel/AbC123xyz/",
    landed.externalUrl,
  );

  const order = calls.map((c) => `${c.method} ${c.path.replace("/v21.0", "")}`);
  check(
    "in the order Meta requires",
    order.join(" → ") ===
      "GET /me/accounts → GET /page_1 → POST /ig_9/media → GET /container_5 → GET /container_5 → GET /container_5 → POST /ig_9/media_publish → GET /reel_77",
    order.join(" → "),
  );

  /*
    A link we could not get is a field left null, never a link that 404s.

    The URL used to be assembled: `https://www.instagram.com/reel/${id}/` with
    the numeric media id `media_publish` returns. Instagram's /reel/ path takes
    a shortcode, so every "View post" link this product ever wrote for a Reel
    landed on "this page isn't available" — and nothing failed anywhere. The
    post went out, the row said published, and the only person who found out
    was the customer, on their own post.
  */
  {
    const quiet = fakeGraph({ noPermalink: true });
    const landedQuiet = await publishToInstagram({
      videoUrl: VIDEO_URL, caption: "x", hashtags: [],
      accessToken: USER_TOKEN, fetchImpl: quiet.doFetch, ...NEVER_WAITS,
    });
    check("a permalink Meta does not return leaves the link null", landedQuiet.externalUrl === null, String(landedQuiet.externalUrl));
    check("and the post id is still there to find it by", landedQuiet.externalPostId === "reel_77");

    const broken = fakeGraph({ permalinkFails: true });
    const landedBroken = await publishToInstagram({
      videoUrl: VIDEO_URL, caption: "x", hashtags: [],
      accessToken: USER_TOKEN, fetchImpl: broken.doFetch, ...NEVER_WAITS,
    });
    check("a permalink read that fails does not fail the publish", landedBroken.externalPostId === "reel_77");
    check("it just has no link", landedBroken.externalUrl === null, String(landedBroken.externalUrl));
  }

  /*
    The check this file exists for. Every call after the first must carry the
    **Page's** token: a user token on the container call is the failure that
    reads as a permissions problem and is really an account-shape problem.
  */
  const afterFirst = calls.slice(1);
  check(
    "every call after the first carries the Page's token, not the user's",
    afterFirst.every((c) => (c.body?.access_token ?? c.query.access_token) === PAGE_TOKEN),
    afterFirst.map((c) => (c.body?.access_token ?? c.query.access_token)).join(", "),
  );

  const container = calls.find((c) => c.path.endsWith("/ig_9/media"));
  check("the container names the video's link", container.body.video_url === VIDEO_URL);
  check("and asks for a Reel", container.body.media_type === "REELS");
  /*
    A Reel that appears only in the Reels tab is invisible to the followers who
    look at a profile, which is not what scheduling a post means.
  */
  check("shared to the feed as well as the Reels tab", container.body.share_to_feed === "true");
  check("the caption carries the hashtags", container.body.caption.includes("#editly"));

  /*
    A caption in a query string is a caption in every proxy log between here and
    Meta — somebody's words, and sometimes their name, written where nobody
    chose. So the writes are bodies.
  */
  check(
    "and nothing that carries somebody's words goes in a URL",
    calls.filter((c) => c.method === "POST").every((c) => Object.keys(c.query).length === 0),
  );
}

section("Uploaded is not posted");
{
  /*
    Publishing an `IN_PROGRESS` container answers with something that reads like
    a permissions problem, sending somebody to check their permissions over a
    video that was merely still uploading.
  */
  const { doFetch, calls } = fakeGraph({ pollsBeforeReady: 4 });
  await publishToInstagram({
    videoUrl: VIDEO_URL, caption: "x", hashtags: [], accessToken: USER_TOKEN, fetchImpl: doFetch, ...NEVER_WAITS,
  });
  const polls = calls.filter((c) => c.path === "/v21.0/container_5").length;
  check("it waits until the container is finished", polls === 4, String(polls));
  check(
    "and only then publishes",
    calls.findIndex((c) => c.path.endsWith("/media_publish")) > calls.map((c) => c.path).lastIndexOf("/v21.0/container_5"),
  );

  let message = "";
  await publishToInstagram({
    videoUrl: VIDEO_URL, caption: "x", hashtags: [], accessToken: USER_TOKEN,
    fetchImpl: fakeGraph({ containerFails: "The video format is not supported" }).doFetch, ...NEVER_WAITS,
  }).catch((e) => { message = e.message; });
  check("a container that errors is a failure", /could not process the video/.test(message), message);
  check("carrying Meta's own words", /format is not supported/.test(message), message);
}

section("A 200 with an error in it is read as an error");
{
  let message = "";
  await publishToInstagram({
    videoUrl: VIDEO_URL, caption: "x", hashtags: [], accessToken: USER_TOKEN,
    fetchImpl: fakeGraph({ containerError: "This account is not eligible to publish Reels" }).doFetch, ...NEVER_WAITS,
  }).catch((e) => { message = e.message; });
  /*
    Graph refuses with HTTP 200 and an `error` object. And `error_user_msg` is
    Meta's own sentence written for the person rather than for the developer —
    better than anything we would put in its place.
  */
  check("it throws", message.length > 0);
  check("with the sentence Meta wrote for the person", message === "This account is not eligible to publish Reels", message);
}

// ── The Page video ──────────────────────────────────────────────────────────

section("A Facebook video goes to the Page, with the Page's token");
{
  const { doFetch, calls } = fakeGraph();
  const landed = await publishToFacebook({
    videoUrl: VIDEO_URL, caption: "Hello", hashtags: ["editly"], accessToken: USER_TOKEN, fetchImpl: doFetch,
  });
  check("it comes back with the video id", landed.externalPostId === "vid_88", landed.externalPostId);
  const post = calls.find((c) => c.path.endsWith("/page_1/videos"));
  check("posted to the Page and not to the user", Boolean(post));
  check("with the Page's token", post.body.access_token === PAGE_TOKEN, post.body.access_token);
  check("the link is the description", post.body.file_url === VIDEO_URL);
  check("and the caption is on it", post.body.description.includes("#editly"));
  /*
    Two calls, not four. Facebook needs no container and no wait, and a poll
    loop copied across from Instagram would be a loop over an endpoint that
    never changes.
  */
  check("and it takes two calls, because there is nothing to wait for", calls.length === 2, String(calls.length));
}

section("The caption respects each platform's ceiling");
{
  check("Instagram's is 2200", captionFor("a".repeat(3000), []).length === 2200, String(captionFor("a".repeat(3000), []).length));
  const long = captionFor("word ".repeat(500), [], 60);
  check("a trim says it was trimmed", long.endsWith("…"));
  check("and lands on a word", /\bword…$/.test(long), long.slice(-10));
}

await rm(buildDir, { recursive: true, force: true });
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
console.log("A Reel reaches the account it was meant for, or says which piece is missing.");
