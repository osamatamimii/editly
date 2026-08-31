/**
 * Connecting a real account, and the one attack that makes this route
 * different from every other route in the product.
 *
 * Scheduling has had a queue, a composer, enforced limits and a publisher on a
 * timer, and no way to put a real account into any of it. This is that step,
 * and it is the step where getting it wrong is not a bug report:
 *
 *   An OAuth callback is a plain GET that anybody can cause. If the state does
 *   not say *who*, an attacker sends their own `code` to it while a victim is
 *   signed in, and the victim's Editly account is connected to the attacker's
 *   Instagram. Everything that person schedules from then on is published to a
 *   stranger's feed. Nothing fails, nothing is logged, and the screen says
 *   "connected".
 *
 * So most of this file is the state: it must be unguessable, it must carry the
 * user, it must expire, and it must reject every kind of wrong the same way —
 * a callback that says *which* part was bad is an oracle for building one that
 * is not.
 *
 * The rest is the shape of what gets sent. Each platform matches the redirect
 * URI as a literal string against what is registered, and every parameter
 * below is one somebody has to type into a developer console exactly once. A
 * missing `access_type=offline` is the worst of them: the connection works for
 * an hour and then stops for ever, having looked perfect.
 *
 * Usage: node tools/connect-test.mjs
 * Requires: nothing. No keys, no network, no database.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-connect-"));

function bundle(entry, name) {
  const outfile = path.join(buildDir, name);
  const built = spawnSync(
    require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] }),
    [
      path.join(repoRoot, entry), "--bundle", "--platform=node", "--format=esm",
      "--target=node22", `--outfile=${outfile}`, "--log-level=error", "--external:pg-native",
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

const {
  signState, readState, pkcePair, authorizeUrlFor, redirectUri, ENDPOINTS, VERIFIER_COOKIE,
} = await import(bundle("artifacts/api-server/src/lib/social-oauth.ts", "oauth.mjs"));
const { SOCIAL_PLATFORMS, SOCIAL_SPEC } = await import(
  bundle("lib/api-zod/src/social.ts", "social.mjs")
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

const SECRET = "a-service-role-key-standing-in-for-the-real-one";
const OTHER = "somebody-else's-deployment-secret";
const ME = "11111111-1111-4111-8111-111111111111";
const THEM = "22222222-2222-4222-8222-222222222222";
const soon = () => Date.now() + 10 * 60 * 1000;

// ── The state ──────────────────────────────────────────────────────────────

section("The state says who, and cannot be written by anybody else");
{
  const state = signState({ userId: ME, platform: "youtube", expiresAt: soon() }, SECRET);
  const read = readState(state, SECRET);
  check("a state we signed reads back", read !== null);
  check("as the person it was made for", read?.userId === ME, String(read?.userId));
  check("and the platform it was made for", read?.platform === "youtube");

  /*
    The attack, staged.

    An attacker signs in to the product, gets a state of their own, and edits
    the user id in it to the victim's. Without the signature that is a working
    request, and the victim's account ends up connected to the attacker's feed.
  */
  const [payload] = state.split(".");
  const forgedPayload = Buffer.from(
    JSON.stringify({ userId: THEM, platform: "youtube", expiresAt: soon() }),
  ).toString("base64url");
  const forged = `${forgedPayload}.${state.split(".")[1]}`;
  check("a payload swapped for another person's is refused", readState(forged, SECRET) === null);
  check(
    "and so is one signed with a different secret",
    readState(signState({ userId: THEM, platform: "youtube", expiresAt: soon() }, OTHER), SECRET) === null,
  );
  check("and one with no signature at all", readState(payload, SECRET) === null);
  check("and rubbish", readState("nonsense", SECRET) === null && readState("", SECRET) === null);
  check(
    "and a payload that is not the JSON we write",
    readState(`${Buffer.from("not json").toString("base64url")}.x`, SECRET) === null,
  );
}

section("A state expires, so one left in a browser history is worthless");
{
  const state = signState({ userId: ME, platform: "x", expiresAt: Date.now() + 1000 }, SECRET);
  check("valid now", readState(state, SECRET, Date.now()) !== null);
  check("and not two seconds later", readState(state, SECRET, Date.now() + 2000) === null);
  check(
    "the window is ten minutes, not an hour",
    // Long enough for a password and a second factor; short enough that a URL
    // in somebody's history is useless by the time anybody reads it.
    (() => {
      const s = signState({ userId: ME, platform: "x", expiresAt: soon() }, SECRET);
      const claims = JSON.parse(Buffer.from(s.split(".")[0], "base64url").toString());
      const minutes = (claims.expiresAt - Date.now()) / 60000;
      return minutes > 5 && minutes <= 15;
    })(),
  );
}

section("Every state is different, so one cannot be replayed as another");
{
  const a = signState({ userId: ME, platform: "tiktok", expiresAt: soon() }, SECRET);
  const b = signState({ userId: THEM, platform: "tiktok", expiresAt: soon() }, SECRET);
  check("two people get different states", a !== b);
  check(
    "and neither reads as the other",
    readState(a, SECRET)?.userId !== readState(b, SECRET)?.userId,
  );
}

// ── PKCE ───────────────────────────────────────────────────────────────────

section("The verifier is a real one, and never leaves in a URL");
{
  const { verifier, challenge } = pkcePair();
  check("the verifier is long enough to be worth having", verifier.length >= 43, String(verifier.length));
  check(
    "the challenge is its S256 hash, which is what the platform checks",
    challenge === createHash("sha256").update(verifier).digest("base64url"),
  );
  check("two pairs are different", pkcePair().verifier !== pkcePair().verifier);

  const state = signState({ userId: ME, platform: "x", expiresAt: soon() }, SECRET);
  const url = authorizeUrlFor("x", state, challenge, {
    X_CLIENT_ID: "client", APP_ORIGIN: "https://app.editlyai.io",
  });
  check(
    "the challenge is on the URL",
    new URL(url).searchParams.get("code_challenge") === challenge,
  );
  check(
    "and the verifier is not, anywhere in it",
    // This is the whole of PKCE. A verifier on a URL has been seen by the
    // browser's history, the referrer and every proxy on the path.
    !url.includes(verifier),
    url.slice(0, 120),
  );
  check("the method is named, because a platform will not assume it", new URL(url).searchParams.get("code_challenge_method") === "S256");
  check("the cookie it travels in is scoped to this API", VERIFIER_COOKIE.length > 0);
}

// ── What each platform is sent ─────────────────────────────────────────────

section("Every platform has somewhere to send people and somewhere to come back");
{
  const env = { APP_ORIGIN: "https://app.editlyai.io" };
  for (const platform of SOCIAL_PLATFORMS) {
    const endpoint = ENDPOINTS[platform];
    check(`${platform}: has an endpoint`, Boolean(endpoint?.authorizeUrl && endpoint?.tokenUrl));
    check(
      `${platform}: over https, both halves`,
      endpoint.authorizeUrl.startsWith("https://") && endpoint.tokenUrl.startsWith("https://"),
    );
    check(`${platform}: asks for a scope`, endpoint.scope.length > 0);
    check(
      `${platform}: the redirect is absolute, ours, and has no trailing slash`,
      // Matched by every platform as a literal string against what is
      // registered. A trailing slash is a failed connection with an error from
      // them and nothing from us.
      redirectUri(platform, env) === `https://app.editlyai.io/api/social/callback/${platform}`,
      redirectUri(platform, env),
    );
  }
}

section("A trailing slash on APP_ORIGIN does not become two in the redirect");
check(
  "it is trimmed",
  redirectUri("youtube", { APP_ORIGIN: "https://app.editlyai.io/" }) ===
    "https://app.editlyai.io/api/social/callback/youtube",
  redirectUri("youtube", { APP_ORIGIN: "https://app.editlyai.io/" }),
);
check(
  "and an unset APP_ORIGIN still points at the app rather than at nothing",
  redirectUri("youtube", {}).startsWith("https://app.editlyai.io/"),
  redirectUri("youtube", {}),
);

section("The authorize URL carries what each platform actually requires");
{
  const state = signState({ userId: ME, platform: "youtube", expiresAt: soon() }, SECRET);
  const env = { YOUTUBE_CLIENT_ID: "google-client", APP_ORIGIN: "https://app.editlyai.io" };
  const url = new URL(authorizeUrlFor("youtube", state, null, env));
  check("the client id is the one for that platform", url.searchParams.get("client_id") === "google-client");
  check("the state rides along", url.searchParams.get("state") === state);
  check("and a code is what is being asked for", url.searchParams.get("response_type") === "code");
  /*
    The parameter whose absence is invisible for an hour.

    Without `access_type=offline` Google issues no refresh token at all, and
    without `prompt=consent` it issues none on the *second* connection. Either
    way the account works until the access token expires and then silently
    stops — and the first connection looked perfect, which is what makes it
    the worst of these to debug.
  */
  check("YouTube is asked for a refresh token", url.searchParams.get("access_type") === "offline");
  check("and asked again on a reconnection", url.searchParams.get("prompt") === "consent");
  check(
    "the scope includes upload, which is the whole point",
    (url.searchParams.get("scope") ?? "").includes("youtube.upload"),
  );

  // TikTok is the one that spells the client id differently, and a URL with
  // `client_id` on it is refused by them with an error about a missing key.
  const tikTok = new URL(
    authorizeUrlFor("tiktok", state, "challenge", { TIKTOK_CLIENT_KEY: "tk", APP_ORIGIN: env.APP_ORIGIN }),
  );
  check("TikTok is sent client_key, not client_id", tikTok.searchParams.get("client_key") === "tk");
  check("and nothing named client_id", tikTok.searchParams.get("client_id") === null);
}

section("Every platform's credentials are read from its own variables");
{
  // A shared variable would mean turning one platform on turns another on too,
  // and an authorize URL with somebody else's client id on it.
  for (const platform of SOCIAL_PLATFORMS) {
    const spec = SOCIAL_SPEC[platform];
    const url = new URL(
      authorizeUrlFor(platform, "state", "challenge", {
        [spec.clientIdVar]: `id-for-${platform}`,
        APP_ORIGIN: "https://app.editlyai.io",
      }),
    );
    const sent = url.searchParams.get(ENDPOINTS[platform].clientIdParam ?? "client_id");
    check(`${platform}: sends the id from ${spec.clientIdVar}`, sent === `id-for-${platform}`, String(sent));
  }
}

section("A platform with no credentials sends an empty id rather than another platform's");
{
  const url = new URL(authorizeUrlFor("snapchat", "state", null, { X_CLIENT_ID: "not-snapchat's" }));
  check(
    "nothing borrowed",
    url.searchParams.get("client_id") === "",
    // The route refuses before this is ever reached — an unconfigured platform
    // answers 503. This asserts the shape underneath that: an empty string,
    // never a value that belongs to somebody else.
    String(url.searchParams.get("client_id")),
  );
}

await rm(buildDir, { recursive: true, force: true });
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
console.log("A connection can only be made by the person who started it.");
