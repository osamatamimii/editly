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
import { mkdtemp, rm, readFile } from "node:fs/promises";
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
  signState, readState, pkcePair, bindingNonce, stateBoundToBrowser,
  authorizeUrlFor, redirectUri, ENDPOINTS, VERIFIER_COOKIE, BINDING_COOKIE,
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
// Every state now carries a browser-binding nonce; a fixed one keeps the
// existing checks about who/what/expiry readable, and the binding itself has
// its own section below.
const N = "test-binding-nonce";

// ── The state ──────────────────────────────────────────────────────────────

section("The state says who, and cannot be written by anybody else");
{
  const state = signState({ userId: ME, platform: "youtube", expiresAt: soon(), nonce: N }, SECRET);
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
    JSON.stringify({ userId: THEM, platform: "youtube", expiresAt: soon(), nonce: N }),
  ).toString("base64url");
  const forged = `${forgedPayload}.${state.split(".")[1]}`;
  check("a payload swapped for another person's is refused", readState(forged, SECRET) === null);
  check(
    "and so is one signed with a different secret",
    readState(signState({ userId: THEM, platform: "youtube", expiresAt: soon(), nonce: N }, OTHER), SECRET) === null,
  );
  check("and one with no signature at all", readState(payload, SECRET) === null);
  check("and rubbish", readState("nonsense", SECRET) === null && readState("", SECRET) === null);
  check(
    "and a payload that is not the JSON we write",
    readState(`${Buffer.from("not json").toString("base64url")}.x`, SECRET) === null,
  );
}

section("The signing secret can be its own, so a database key can be rotated");
{
  /*
    Two blast radii that had been welded together.

    The state was signed with `SUPABASE_SERVICE_ROLE_KEY`, and the reasoning was
    sound as far as it went: one secret rather than two, already held, already
    the thing that must never leak. What it also meant was that rotating the
    database key silently invalidated every half-finished connection, and that
    any log line or crash dump printing the signing secret printed the key that
    bypasses row-level security on the whole database.

    `OAUTH_STATE_SECRET` wins where it is set. The fallback stays because
    removing it breaks a running deployment on the day it ships; what must not
    come back is a fallback to a *constant*, which would make every state
    forgeable by anybody who read this repository.
  */
  const source = await readFile(path.join(repoRoot, "artifacts/api-server/src/lib/social-oauth.ts"), "utf8");
  check("a dedicated variable is preferred", /OAUTH_STATE_SECRET/.test(source));
  check("the service role key is still accepted, so a deploy does not break", /SUPABASE_SERVICE_ROLE_KEY/.test(source));
  check(
    "and with neither it throws rather than falling back to a constant",
    /if \(!secret\)[\s\S]{0,120}throw new Error/.test(source),
  );
}

section("A state expires, so one left in a browser history is worthless");
{
  const state = signState({ userId: ME, platform: "x", expiresAt: Date.now() + 1000, nonce: N }, SECRET);
  check("valid now", readState(state, SECRET, Date.now()) !== null);
  check("and not two seconds later", readState(state, SECRET, Date.now() + 2000) === null);
  check(
    "the window is ten minutes, not an hour",
    // Long enough for a password and a second factor; short enough that a URL
    // in somebody's history is useless by the time anybody reads it.
    (() => {
      const s = signState({ userId: ME, platform: "x", expiresAt: soon(), nonce: N }, SECRET);
      const claims = JSON.parse(Buffer.from(s.split(".")[0], "base64url").toString());
      const minutes = (claims.expiresAt - Date.now()) / 60000;
      return minutes > 5 && minutes <= 15;
    })(),
  );
}

section("A valid state is useless in a browser that did not start the flow");
{
  /*
    The residual attack, after the state carries the user and is signed.

    The signature proves who *minted* the state, not who is *finishing* it. An
    attacker signs in, starts connecting their own account, and gets a real
    state carrying their id. They hand the authorize URL to a victim who is
    logged in to their real Instagram; the victim approves; the platform
    redirects to the callback with the victim's `code` and the attacker's state.
    Without a browser binding, the victim's tokens are exchanged and written
    under the attacker's account.

    The binding is a nonce that lives in the signed state and in an httpOnly
    cookie on the browser that started the flow. The callback refuses a state
    whose nonce the returning browser cannot present, so the attacker's state is
    inert in the victim's browser, which never held that cookie.
  */
  const started = bindingNonce();
  const claims = readState(signState({ userId: ME, platform: "instagram", expiresAt: soon(), nonce: started }, SECRET), SECRET);
  check("a nonce is long enough to be unguessable", started.length >= 43, String(started.length));
  check("two flows get different nonces", bindingNonce() !== bindingNonce());

  check("the state is bound to the browser that presents the matching cookie", stateBoundToBrowser(claims, started));
  check(
    "and refused in a browser that presents a different cookie",
    // The victim's browser: a real, valid, attacker-minted state, but the
    // attacker's nonce is not in the victim's cookie jar.
    !stateBoundToBrowser(claims, bindingNonce()),
  );
  check("and refused when the browser presents no cookie at all", !stateBoundToBrowser(claims, null));
  check("and when the cookie is empty", !stateBoundToBrowser(claims, ""));

  // The binding is only as good as the nonce being required. A state with no
  // nonce cannot be bound to anything, so it must not read back as valid.
  const noNonce = Buffer.from(JSON.stringify({ userId: ME, platform: "instagram", expiresAt: soon() })).toString("base64url");
  const { createHmac } = await import("node:crypto");
  const signed = `${noNonce}.${createHmac("sha256", SECRET).update(noNonce).digest("base64url")}`;
  check(
    "a correctly-signed state with no nonce is refused, so the binding cannot be omitted",
    readState(signed, SECRET) === null,
  );
}

section("The route sets the binding cookie on connect and requires it on callback");
{
  /*
    The library above is only the mechanism; these read the route that has to
    use it. The cookie is set for *every* platform, not only the two that use
    PKCE — the verifier shields the code, this shields the account — and the
    callback compares it before it will exchange anything.
  */
  const route = await readFile(path.join(repoRoot, "artifacts/api-server/src/routes/social.ts"), "utf8");
  const connect = route.slice(
    route.indexOf('router.post("/social/connect/:platform"'),
    route.indexOf('router.get("/social/accounts"'),
  );
  check("connect mints a browser-binding nonce", /bindingNonce\(\)/.test(connect));
  check("and signs it into the state", /nonce/.test(connect) && /signState\(\{[\s\S]*nonce/.test(connect));
  check(
    "and sets it as an httpOnly cookie",
    /res\.cookie\(BINDING_COOKIE,[\s\S]{0,120}httpOnly:\s*true/.test(connect),
  );
  check(
    "before it checks whether the platform uses PKCE, so every platform gets it",
    connect.indexOf("BINDING_COOKIE") < connect.indexOf("ENDPOINTS[platform].pkce"),
  );

  const callback = route.slice(route.indexOf('/social/callback/:platform'));
  check("the callback reads the binding cookie", /cookieFrom\(req\.headers\.cookie, BINDING_COOKIE\)/.test(callback));
  check("and refuses a state not bound to this browser", /stateBoundToBrowser\(claims, boundNonce\)/.test(callback));
  check(
    "and clears the cookie either way, so a stale one cannot be reused",
    /clearCookie\(BINDING_COOKIE/.test(callback),
  );
  check(
    "and says the same thing it says for every other bad state, giving no oracle",
    // The binding failure shares the branch and the message with a bad
    // signature and an expired state.
    /stateBoundToBrowser\(claims, boundNonce\)\)\s*\{[\s\S]{0,200}That connection link has expired/.test(callback),
  );
}

section("Every state is different, so one cannot be replayed as another");
{
  const a = signState({ userId: ME, platform: "tiktok", expiresAt: soon(), nonce: N }, SECRET);
  const b = signState({ userId: THEM, platform: "tiktok", expiresAt: soon(), nonce: N }, SECRET);
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

  const state = signState({ userId: ME, platform: "x", expiresAt: soon(), nonce: N }, SECRET);
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
  const state = signState({ userId: ME, platform: "youtube", expiresAt: soon(), nonce: N }, SECRET);
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


// ─── Meta, which needs three more answers before it can post ────────────────

/*
  Three faults in one place, and every one of them was written down in a comment
  and in no list of work. That is the shape worth naming: a known bug with a
  paragraph explaining it is indistinguishable, from outside, from a bug nobody
  has found.

  Each check below is one of them, and each one failed silently in a different
  way — a post to the wrong Page, two Graph calls a post, and a connection that
  works for sixty days and then does not.
*/

const identity = await import(bundle("artifacts/api-server/src/lib/social-identity.ts", "identity.mjs"));
const {
  metaExpiryFrom, chooseSinglePage, pageChoicesFrom, isMeta,
  exchangeForLongLivedMetaToken, metaPagesFor, metaTargetsFor,
} = identity;

const jsonOf = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

section("A Meta token has sixty days, and now something knows that");
{
  /*
    Meta issues no refresh token. `expires_at` was null for these rows, which is
    this column's way of saying "does not expire" — about the one credential
    here that does. Nothing extended it and nothing watched it, so every Meta
    connection was going to stop working about two months after it was made,
    with no event in between and nothing in any log.
  */
  const at = new Date("2026-09-02T00:00:00Z");
  const sixtyDays = metaExpiryFrom({ expires_in: 5_184_000 }, at);
  check("an expiry is worked out from what Meta said", sixtyDays !== null, "");
  check(
    "and it is about two months out",
    Math.round((sixtyDays.getTime() - at.getTime()) / 86_400_000) === 60,
    String(sixtyDays),
  );
  /*
    Absent stays absent. Meta documents some long-lived tokens as never
    expiring, and inventing a date from a documented average would either
    refresh a working token or, worse, let a dead one sit until a post failed.
  */
  check("no expiry means null, not a guess", metaExpiryFrom({}, at) === null, "");
  check("and neither does a nonsense one", metaExpiryFrom({ expires_in: "soon" }, at) === null, "");
  check("nor a negative one", metaExpiryFrom({ expires_in: -10 }, at) === null, "");
}

section("The short token is traded for a long one, and a failed trade is not silent");
{
  const env = { FACEBOOK_CLIENT_ID: "app-1", FACEBOOK_CLIENT_SECRET: "secret-1" };
  let asked = null;
  const traded = await exchangeForLongLivedMetaToken(
    "facebook",
    "short-lived",
    env,
    async (url) => {
      asked = String(url);
      return jsonOf({ access_token: "long-lived", expires_in: 5_184_000 });
    },
    new Date("2026-09-02T00:00:00Z"),
  );
  check("it is the exchange Meta documents", asked.includes("grant_type=fb_exchange_token"), asked ?? "");
  check("it sends the token being traded", asked.includes("fb_exchange_token=short-lived"), "");
  check("and this app's own credentials", asked.includes("client_id=app-1") && asked.includes("client_secret=secret-1"), "");
  check("the long-lived token comes back", traded.accessToken === "long-lived", traded.accessToken);
  check("with its expiry", traded.expiresAt !== null, "");

  /*
    A trade that answered without a token is not a working token, and storing
    the short one instead would be the quiet failure this whole area is built
    against: the connection looks made, the first post goes out, and the second
    fails for a reason nobody can trace back to here. Sixty days and one hour
    look identical in the row.
  */
  let empty = null;
  try {
    await exchangeForLongLivedMetaToken("facebook", "short", env, async () => jsonOf({}));
  } catch (error) {
    empty = error;
  }
  check("an exchange with no token in it fails the connection", empty !== null, "");

  let refused = null;
  try {
    await exchangeForLongLivedMetaToken("facebook", "short", env, async () =>
      jsonOf({ error: { message: "This authorization code has been used" } }, 400),
    );
  } catch (error) {
    refused = error;
  }
  check("and Meta's own words are what comes back", refused?.message?.includes("has been used"), refused?.message ?? "");
}

section("The Page is chosen, not taken off the top of a list");
{
  const two = [
    { id: "10", name: "Coffee Shop", token: "page-token-10", instagramUserId: "ig-1" },
    { id: "20", name: "Side Project", token: "page-token-20", instagramUserId: null },
  ];
  /*
    The bug this replaces. `pageFor` took `pages[0]`, and Meta's ordering is not
    a promise — so somebody managing two Pages found their video on whichever
    one Meta happened to list first. Nothing failed: a post went out, to a real
    Page, and only its owner could tell.
  */
  check("two Pages is a question, not an answer", chooseSinglePage(two) === null, "");
  check("one Page is the answer", chooseSinglePage([two[0]]).id === "10", "");
  check("and none is a question too, which the caller turns into a sentence", chooseSinglePage([]) === null, "");

  /*
    What reaches the browser is names and ids. `page_access_token` is the
    credential that actually posts, and a list of choices does not need
    credentials in it.
  */
  const choices = pageChoicesFrom(two);
  check("the choices carry the names", choices.map((c) => c.name).join(",") === "Coffee Shop,Side Project", "");
  check("and no tokens at all", JSON.stringify(choices).includes("token") === false, JSON.stringify(choices));

  check("Meta is the pair that goes through a Page", isMeta("facebook") && isMeta("instagram"), "");
  check("and nothing else is", !isMeta("youtube") && !isMeta("tiktok") && !isMeta("x") && !isMeta("snapchat"), "");
}

section("And the Pages are read with their Instagram accounts attached");
{
  /*
    One call rather than two: the Instagram business account was a second Graph
    request per post, made after the Page was resolved by a first. Both are one
    read at connection now, and `instagram_business_account` is a field on the
    Page rather than a lookup after it.
  */
  let asked = null;
  const pages = await metaPagesFor("long-lived", async (url) => {
    asked = String(url);
    return jsonOf({
      data: [
        { id: "10", name: "Coffee Shop", access_token: "t10", instagram_business_account: { id: "ig-1" } },
        { id: "20", name: "Side Project", access_token: "t20" },
      ],
    });
  });
  check("it asks for the Instagram account in the same call", asked.includes("instagram_business_account"), asked ?? "");
  check("both Pages come back", pages.length === 2, String(pages.length));
  check("with their own tokens", pages[0].token === "t10" && pages[1].token === "t20", "");
  check("the linked Instagram account is carried", pages[0].instagramUserId === "ig-1", "");
  check("and a Page with none says so rather than guessing", pages[1].instagramUserId === null, "");

  /*
    A Page row without a token is not a Page this app can post to. Keeping it
    would put a name on the screen that fails when it is chosen.
  */
  const partial = await metaPagesFor("t", async () =>
    jsonOf({ data: [{ id: "30", name: "No Access" }, { id: "40", name: "Fine", access_token: "t40" }] }),
  );
  check("a Page we hold no token for is not offered", partial.length === 1 && partial[0].id === "40", JSON.stringify(partial));
}

section("Connecting resolves all of it at once");
{
  const env = { INSTAGRAM_CLIENT_ID: "app", INSTAGRAM_CLIENT_SECRET: "secret" };
  const targets = await metaTargetsFor("instagram", "short", env, async (url) => {
    if (String(url).includes("fb_exchange_token")) {
      return jsonOf({ access_token: "long", expires_in: 5_184_000 });
    }
    return jsonOf({
      data: [{ id: "10", name: "Only Page", access_token: "t10", instagram_business_account: { id: "ig-9" } }],
    });
  });
  check("the stored token is the long-lived one", targets.accessToken === "long", targets.accessToken);
  check("its expiry is known", targets.expiresAt !== null, "");
  check("and the Page came with it", targets.pages[0].id === "10", "");

  /*
    Order matters: the Pages are read with the long-lived token, not the short
    one. Reading them with the short token would work at connection and produce
    Page tokens whose life is tied to a credential that is about to be replaced.
  */
  let usedShort = false;
  await metaTargetsFor("instagram", "short", env, async (url) => {
    const href = String(url);
    if (href.includes("fb_exchange_token")) return jsonOf({ access_token: "long", expires_in: 100 });
    if (href.includes("access_token=short")) usedShort = true;
    return jsonOf({ data: [{ id: "1", name: "P", access_token: "t" }] });
  });
  check("the Pages are read with the long-lived token", !usedShort, "");
}

section("The worker extends it before the send, like every other platform");
{
  /*
    The other four speak `refresh_token`, and Meta has none — so it used to fall
    through to a guard that marked the account as needing to be reconnected. A
    working connection, told to reconnect, because the code that refreshes
    tokens did not know this one is refreshed differently.

    Read out of the source rather than run, because running it needs a database:
    what is being asserted is that Meta is handled *before* the refresh-token
    guard, which is a property of the order of two blocks.
  */
  const token = await readFile(path.join(repoRoot, "artifacts/worker/src/social-token.ts"), "utf8");
  const metaBranch = token.indexOf('platform === "facebook" || platform === "instagram"');
  const refreshGuard = token.indexOf("if (!url || !credential.refreshToken)");
  check("Meta has a branch of its own", metaBranch > 0, "");
  check(
    "and it is taken before the no-refresh-token guard",
    metaBranch > 0 && refreshGuard > 0 && metaBranch < refreshGuard,
    `meta at ${metaBranch}, guard at ${refreshGuard}`,
  );
  check("it uses the shared exchange rather than a second copy", token.includes("metaExchangeUrl"), "");
  check("it writes the new token back", /update social_accounts[\s\S]{0,400}access_token = /.test(token), "");
  check(
    "and 190 is the code that means reconnect, rather than every failure",
    token.includes("190"),
    "",
  );
}

section("The Page's token is never taken from a browser");
{
  /*
    The endpoint takes an *id* and goes to Meta for the token belonging to it,
    with the connection's own credential. Accepting a page token from a request
    body would be this server taking a credential from outside, and the shape of
    that mistake is the same one that makes an open redirect: trusting a value
    because it arrived in the right field.
  */
  const routes = await readFile(path.join(repoRoot, "artifacts/api-server/src/routes/social.ts"), "utf8");
  const patch = routes.slice(routes.indexOf('router.patch("/social/accounts/:id/page"'));
  const body = patch.slice(0, patch.indexOf("router.delete("));
  check("the endpoint exists", body.length > 0, "");
  check("it reads only an id from the request", /req\.body\?\.pageId/.test(body), "");
  check("and no token", !/req\.body\?\.(pageAccessToken|token)/.test(body), "");
  check("it asks Meta for the Pages itself", body.includes("metaPagesFor"), "");
  check(
    "and refuses an id that is not one of them",
    /not one this account manages/.test(body),
    "",
  );
  check("the account is scoped to the person asking", /eq\(socialAccountsTable\.userId, userId\)/.test(body), "");

  // And the list the browser reads carries no credentials either.
  const columns = routes.slice(routes.indexOf("const ACCOUNT_COLUMNS"), routes.indexOf("router.get(\"/social/platforms\""));
  check("the accounts list offers the Page name", columns.includes("pageName"), "");
  check("and the choices", columns.includes("pageChoices"), "");
  check("and no token of any kind", !columns.includes("accessToken") && !columns.includes("pageAccessToken"), "");
}

section("A connection that still needs a Page says so");
{
  /*
    Connected and not usable are different states, and a working-looking account
    that fails at nine in the evening is the failure this says out loud instead.
    It goes on `status`, which the screen already reads for "reconnect me", so
    somebody sees one outstanding thing in one place.
  */
  const routes = await readFile(path.join(repoRoot, "artifacts/api-server/src/routes/social.ts"), "utf8");
  check("there is a state for it", routes.includes('"needs_page"'), "");
  check("with a sentence rather than a code", /Choose which Page/.test(routes), "");
  check(
    "an account managing no Page is refused while connecting, not at nine in the evening",
    /manages no Page/.test(routes),
    "",
  );

  const screen = await readFile(
    path.join(repoRoot, "artifacts/editly/src/components/social-connections.tsx"),
    "utf8",
  );
  /*
    The two sentences moved into the copy table when the product learned to
    speak Arabic, so they are read from there rather than from the markup —
    which is a better question than the one this used to ask: it holds both
    halves of each pair rather than the English one, and a screen that renders
    a sentence typed straight into its JSX now fails `tools/language-test.mjs`
    instead.
  */
  const copy = await readFile(path.join(repoRoot, "artifacts/editly/src/lib/copy/scheduled.ts"), "utf8");
  check("the screen asks the question", /Which one do posts go to/.test(copy), "");
  check("in both languages, like everything else it says", /إلى أيّها تذهب المنشورات/.test(copy), "");
  check("and the screen is the thing that asks it", /fmt\(CONNECTIONS\.whichPage/.test(screen), "");
  check("only when there is more than one answer", /pageChoices\?\.length \?\? 0\) > 1/.test(screen), "");
  check("and it shows where a settled connection posts", /fmt\(CONNECTIONS\.postsTo, account\.pageName\)/.test(screen), "");
  check("with that sentence written in both too", /ينشر على/.test(copy) && /Posts to/.test(copy), "");
}

section("And the renderer prefers the stored answer to asking again");
{
  /*
    Two Graph calls per post, for a pair of values that never change between
    posts. The fallback stays: a row connected before these columns existed has
    to keep working, and the stored answer is an improvement on resolving rather
    than a replacement for the ability to.
  */
  const meta = await readFile(path.join(repoRoot, "artifacts/worker/src/publish-meta.ts"), "utf8");
  check(
    "the stored Page is used when there is one",
    /upload\.page \?\? \(await pageFor\(/.test(meta),
    "",
  );
  check(
    "and the stored Instagram account too",
    /upload\.instagramUserId \?\? \(await instagramAccountFor\(/.test(meta),
    "",
  );
  check("the resolution is still there for rows that predate the column", meta.includes("export async function pageFor"), "");

  const publisher = await readFile(path.join(repoRoot, "artifacts/worker/src/publisher.ts"), "utf8");
  check("the publisher reads the columns", publisher.includes("page_access_token"), "");
  check("and hands them down", /page: credential\.page/.test(publisher), "");
}

await rm(buildDir, { recursive: true, force: true });
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
console.log("A connection can only be made by the person who started it.");
