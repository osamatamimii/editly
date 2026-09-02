/**
 * Snapchat refuses, and the refusal is the thing being checked.
 *
 * This is the odd suite in the set, because what it guards is a *decision* and
 * not a client. Snap has no API that posts to a personal account — the nearest
 * one is allowlist-only, needs a business organisation, and only reads profile
 * statistics — so the sixth publisher is a named refusal rather than an upload.
 * `publish-snapchat.ts` carries what was checked and why.
 *
 * A decision with no test decays in a way nobody notices. Three things can go
 * wrong here and none of them fails anything on its own:
 *
 * **The refusal stops being reachable.** Snapchat is in the uploader table
 * precisely so the sentence is *named* rather than falling through to the
 * generic "cannot send to X yet" that a platform nobody has looked at would
 * produce. Someone tidying an entry that appears to do nothing removes the
 * difference between "not built" and "cannot be built", and the screen goes on
 * saying something true and useless.
 *
 * **The refusal stops saying why.** "Nothing was posted" is not actionable. The
 * point of this sentence is that somebody reads it and stops planning a posting
 * schedule around Snapchat, which needs the *reason* and the fact that it is
 * not theirs to fix.
 *
 * **Snapchat quietly leaves the product.** The connection, the composer, its
 * caption and duration limits and its token exchange are all built. The rule
 * here is that what is on the screen and not yet built stays and gets built
 * towards — so the check is that all of that is still standing, and that the
 * day Snap opens an API the only missing piece is one function.
 *
 * Usage: node tools/publish-snapchat-test.mjs
 * Requires: nothing.
 */
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-snap-"));

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

const snap = await import(build("artifacts/worker/src/publish-snapchat.ts", "snap.mjs"));
const { publishToSnapchat, SNAPCHAT_REFUSAL } = snap;
const social = await import(build("lib/api-zod/src/social.ts", "social.mjs"));
const { SOCIAL_SPEC, SOCIAL_LABEL } = social;

const read = (file) => readFile(path.join(repoRoot, file), "utf8");

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

section("It refuses, every time, without touching anything");
{
  let error = null;
  try {
    await publishToSnapchat({
      videoUrl: "https://example.invalid/video.mp4",
      caption: "hello",
      hashtags: [],
      accessToken: "token",
    });
  } catch (e) {
    error = e;
  }
  check("a send comes back as a refusal", error !== null, "");
  check("and it is a publish refusal, so the publisher reports it as the platform's", error?.constructor?.name === "PublishError", error?.constructor?.name ?? "");
  check("with the sentence the file exports", error?.message === SNAPCHAT_REFUSAL, error?.message ?? "");
}

section("And the sentence is one somebody can act on");
{
  /*
    "Nothing was posted" alone is not actionable. What this sentence has to
    carry is that the block is Snap's and not theirs — because the decision it
    changes is whether to go on scheduling Snapchat posts at all.
  */
  check("it says nothing was posted", /nothing was posted/i.test(SNAPCHAT_REFUSAL), "");
  check("it says why, in Snap's terms and not ours", /allowlist|business|organisation/i.test(SNAPCHAT_REFUSAL), "");
  check(
    "it says this one is not theirs to fix",
    /nothing you can change/i.test(SNAPCHAT_REFUSAL),
    SNAPCHAT_REFUSAL,
  );
  check("and it says what is kept", /connection|schedule/i.test(SNAPCHAT_REFUSAL), "");
  // It is read on a screen, and this repository's own browser check refuses an
  // em dash in anything a customer reads.
  check("no em dash, like every other sentence a customer sees", !SNAPCHAT_REFUSAL.includes("—"), "");
  check("and it is short enough to be read", SNAPCHAT_REFUSAL.length < 400, String(SNAPCHAT_REFUSAL.length));
}

section("The refusal is on the ordinary path, not a special case");
{
  const publisher = await read("artifacts/worker/src/publisher.ts");
  /*
    In the table rather than left out of it. A platform with no entry falls
    through to "Editly cannot send to Snapchat yet", which is the sentence a
    platform nobody has looked at also gets — and the difference between "not
    built" and "cannot be built" is the whole content of this point.
  */
  check("Snapchat has an uploader entry", /snapchat:\s*\{\s*takes:\s*"url",\s*send:\s*publishToSnapchat\s*\}/.test(publisher), "");
  check("the module is imported", /publishToSnapchat.*publish-snapchat/s.test(publisher), "");
  /*
    And it takes a link rather than the bytes, so the refusal arrives without a
    finished render having been downloaded for it. Signing a URL is one call;
    downloading the master is minutes and megabytes for an answer we already
    know.
  */
  check("and it takes a link, so nothing is downloaded to be refused", !/snapchat:\s*\{\s*takes:\s*"file"/.test(publisher), "");
}

section("Snapchat has not quietly left the product");
{
  /*
    The rule in this repository is that what is on the screen and not yet built
    stays, and is built towards. Everything below already exists; the day Snap
    opens an API the missing piece is one function.
  */
  check("it is still a platform with a label", SOCIAL_LABEL.snapchat === "Snapchat", "");
  check("its limits are still enforced while somebody types", SOCIAL_SPEC.snapchat.captionLimit > 0, "");
  check("and its duration ceiling is still there", SOCIAL_SPEC.snapchat.maxDurationSeconds > 0, "");

  const token = await read("artifacts/worker/src/social-token.ts");
  check("its token exchange is still known", /snapchat:\s*"https:\/\/accounts\.snapchat\.com/.test(token), "");

  const processors = await read("lib/api-zod/src/processors.ts");
  check("and the hosts are still disclosed", processors.includes("accounts.snapchat.com"), "");
}

section("What was checked is written down, not remembered");
{
  /*
    The finding is the deliverable here, and a finding nobody can re-read is a
    finding that gets re-discovered by somebody spending a day on it. The file
    has to carry the three blocks, because any one of them alone would be worth
    waiting out and all three together are not.
  */
  const source = await read("artifacts/worker/src/publish-snapchat.ts");
  check("the file says it is allowlist only", /allowlist/i.test(source), "");
  check("that it needs a business organisation", /Business Account|Organization/i.test(source), "");
  check("and that the nearest API only reads", /read\b/i.test(source), "");
  check("it says what would replace it", /If Snap ships a content API|would replace/i.test(source), "");
}

await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
console.log("A refusal that names its reason, and everything around it still standing.");
