/**
 * The Shopify surface, checked where it can actually be wrong.
 *
 * Almost none of this integration is about video. It is signatures, a domain
 * that gets interpolated into a URL carrying a credential, and an identity that
 * has to share a column with a completely different identity system without
 * either being able to become the other. Those are the parts that fail
 * catastrophically rather than visibly, and they are what this file is about.
 *
 * Three kinds of check, in order of how much they prove:
 *
 * **Arithmetic and parsing**, which is most of it, and where every security
 * property lives. A shop domain that passes when it should not is a token
 * delivered to whoever chose the string; a session token accepted with
 * `alg: none` is an app anybody can be.
 *
 * **Against a real socket**, for the two calls this makes to Shopify. A client
 * that composes the right request and posts it to the wrong place, or reads the
 * throttle numbers and sleeps anyway, is a client that passes every unit test.
 *
 * **Through the real Express app**, for the webhooks. They are public
 * endpoints that erase a merchant's data, mounted above the authentication
 * middleware, with their bodies deliberately left unparsed — four things that
 * are each correct in isolation and are only correct together, and the only way
 * to know they are together is to drive an HTTP request through the actual
 * stack.
 *
 * Usage: node tools/shopify-test.mjs
 * Requires: a database (see tools/lib/test-db.mjs). No network, no Shopify.
 */
import http from "node:http";
import path from "node:path";
import { createHmac, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { resolveTestDatabaseUrl } from "./lib/test-db.mjs";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-shopify-"));

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

const domain = await import(build("artifacts/api-server/src/lib/shopify/domain.ts", "domain.mjs"));
const hmac = await import(build("artifacts/api-server/src/lib/shopify/hmac.ts", "hmac.mjs"));
const sessions = await import(build("artifacts/api-server/src/lib/shopify/session-token.ts", "session.mjs"));
const product = await import(build("artifacts/api-server/src/lib/shopify/product.ts", "product.mjs"));
const admin = await import(build("artifacts/api-server/src/lib/shopify/admin.ts", "admin.mjs"));
const zod = await import(build("lib/api-zod/src/index.ts", "zod.mjs"));

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

const SECRET = "shpss_test_secret_value";
const CLIENT_ID = "test-client-id";
const SHOP = "demo-store.myshopify.com";

// ── The domain ──────────────────────────────────────────────────────────────

section("A shop domain, and nothing that merely looks like one");
{
  check("an ordinary shop passes", domain.isShopDomain(SHOP));
  check("and one with digits and hyphens", domain.isShopDomain("my-shop-2.myshopify.com"));

  /*
    The whole reason this is a whitelist. Every string below ends in
    `.myshopify.com` and none of them is a shop — and the next line of code
    after this validator builds `https://<value>/admin/...` and sends the
    access token to it.
  */
  for (const impostor of [
    "evil.com.myshopify.com",
    "shop.evil.com",
    "shop.myshopify.com.evil.com",
    "shop.myshopify.com/../evil",
    "shop@evil.com.myshopify.com",
    "shop.myshopify.com:8080",
    "MYSHOP.myshopify.com",
    ".myshopify.com",
    "myshopify.com",
    "",
  ]) {
    check(`"${impostor}" is refused`, !domain.isShopDomain(impostor));
  }
  check("and so is a value that is not a string", !domain.isShopDomain(null) && !domain.isShopDomain(12));

  check("a header's casing and spacing are cleaned before it is judged", domain.asShopDomain("  DEMO-Store.MyShopify.com ") === SHOP);
  check("but cleaning cannot rescue an impostor", domain.asShopDomain(" EVIL.com.myshopify.com ") === null);
}

section("A shop is an account, and can never be a person's");
{
  const id = domain.accountIdForShop(SHOP);
  check("it is a uuid", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id), id);
  check("the same shop gets the same id every time", domain.accountIdForShop(SHOP) === id);
  check("and a different shop a different one", domain.accountIdForShop("other.myshopify.com") !== id);

  /*
    The property the whole two-doors design rests on. Supabase issues version 4;
    this mints version 5. They share one column, and no sign-in can ever be
    handed an id this function can produce — so a handler that resolved the
    wrong principal would find no rows rather than somebody else's.
  */
  check("its version nibble is 5, which no Supabase id can be", id[14] === "5", id);
  check("and its variant is RFC 4122", "89ab".includes(id[19]), id);
  let collisions = 0;
  for (let i = 0; i < 500; i += 1) if (domain.accountIdForShop(`shop-${i}.myshopify.com`)[14] !== "5") collisions += 1;
  check("across five hundred shops, every id is still a version 5", collisions === 0, `${collisions}`);
}

// ── The signatures ──────────────────────────────────────────────────────────

const sign = (body, secret = SECRET) => createHmac("sha256", secret).update(body).digest("base64");

section("A webhook is its signature, or it is a stranger with the URL");
{
  const body = Buffer.from(JSON.stringify({ shop_domain: SHOP }), "utf8");
  check("a correctly signed body passes", hmac.verifyWebhook(body, sign(body), SECRET));
  check("a body changed after signing does not", !hmac.verifyWebhook(Buffer.from(`${body}x`), sign(body), SECRET));
  check("nor one signed with another secret", !hmac.verifyWebhook(body, sign(body, "someone-elses"), SECRET));
  check("nor one with no signature at all", !hmac.verifyWebhook(body, undefined, SECRET));
  check("nor an empty header", !hmac.verifyWebhook(body, "", SECRET));
  /*
    A signature of the wrong length must return false rather than throw:
    `timingSafeEqual` throws on a length mismatch, and a throw inside a verifier
    is an exception path that one caller eventually treats as "not verified" and
    another as a 500.
  */
  check("a short signature is refused rather than thrown at", hmac.verifyWebhook(body, "AAAA", SECRET) === false);
  check("and a server with no secret configured verifies nothing", !hmac.verifyWebhook(body, sign(body), undefined));
}

section("And a signed query is a different shape with a different trap");
{
  const query = { shop: SHOP, timestamp: "1788000000", host: "abc" };
  const message = Object.keys(query).sort().map((k) => `${k}=${query[k]}`).join("&");
  const good = createHmac("sha256", SECRET).update(message, "utf8").digest("hex");

  check("a correct one passes", hmac.verifyQuery({ ...query, hmac: good }, SECRET));
  /*
    The parameters arrive in whatever order the platform felt like. A verifier
    that trusts that order rejects every genuine request, which is a total
    failure that looks like a configuration problem.
  */
  check("the order they arrived in does not matter", hmac.verifyQuery({ hmac: good, host: "abc", timestamp: "1788000000", shop: SHOP }, SECRET));
  check("changing a parameter breaks it", !hmac.verifyQuery({ ...query, shop: "other.myshopify.com", hmac: good }, SECRET));
  check("and no hmac at all is not a pass", !hmac.verifyQuery(query, SECRET));
}

// ── The session token ───────────────────────────────────────────────────────

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

function makeToken(overrides = {}, { secret = SECRET, header = { alg: "HS256", typ: "JWT" } } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: `https://${SHOP}/admin`,
    dest: `https://${SHOP}`,
    aud: CLIENT_ID,
    sub: "9001",
    exp: now + 60,
    nbf: now - 5,
    iat: now,
    ...overrides,
  };
  const head = b64(header);
  const body = b64(payload);
  const signature = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${signature}`;
}

const verify = (token, now) => sessions.verifySessionToken(token, { clientId: CLIENT_ID, secret: SECRET, ...(now ? { now } : {}) });

section("The ID token is the entire authentication for the embedded app");
{
  const ok = verify(makeToken());
  check("a real one names its shop", ok.ok && ok.token.shop === SHOP, JSON.stringify(ok));
  check("and the staff member who is using it", ok.ok && ok.token.userId === "9001");

  /*
    The four holes, each of which is a complete bypass.

    A verifier that reads `alg` and obeys it accepts a token anybody can write.
    Without `aud`, a token minted for any other app on the platform is valid
    here. Without `exp`, one captured token is a permanent key. And a token
    naming two different shops is not a token to reason about, whichever claim
    you would have believed.
  */
  const unsigned = `${b64({ alg: "none", typ: "JWT" })}.${b64({ iss: `https://${SHOP}/admin`, dest: `https://${SHOP}`, aud: CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 60 })}.`;
  check("an unsigned token is refused", !verify(unsigned).ok, JSON.stringify(verify(unsigned)));
  check("so is one signed with somebody else's secret", !verify(makeToken({}, { secret: "not-ours" })).ok);
  check("so is one minted for a different app", !verify(makeToken({ aud: "another-app" })).ok);

  const expired = makeToken({ exp: Math.floor(Date.now() / 1000) - 600, nbf: Math.floor(Date.now() / 1000) - 700 });
  check("an expired token is refused", !verify(expired).ok, JSON.stringify(verify(expired)));
  check("and one that is not valid yet", !verify(makeToken({ nbf: Math.floor(Date.now() / 1000) + 600 })).ok);

  check(
    "a token naming two different shops is refused",
    !verify(makeToken({ iss: "https://other.myshopify.com/admin" })).ok,
  );
  check("and one whose shop is not a shop domain", !verify(makeToken({ dest: "https://evil.com" })).ok);

  /*
    A clock thirty seconds fast must not reject every request from a correctly
    working app — a failure with no symptom anybody could describe. Leeway
    enough for drift, far too little to make a captured token useful.
  */
  const fresh = makeToken();
  check("a minute of clock drift is tolerated", verify(fresh, Date.now() + 30_000).ok);
  check("but ten minutes is not", !verify(fresh, Date.now() + 600_000).ok);

  check("nonsense is refused rather than thrown at", !verify("not.a.token").ok && !verify("").ok && !verify(null).ok);
  check("and an unconfigured app authenticates nobody", !sessions.verifySessionToken(fresh, { clientId: undefined, secret: undefined }).ok);
}

// ── The product ─────────────────────────────────────────────────────────────

const cdn = (name) => `https://cdn.shopify.com/s/files/1/0001/${name}.jpg?v=1`;

const productNode = (over = {}) => ({
  id: "gid://shopify/Product/1",
  title: "Ceramic Pour-Over Kettle",
  priceRangeV2: { minVariantPrice: { amount: "34.00", currencyCode: "USD" } },
  media: {
    nodes: [
      { mediaContentType: "IMAGE", alt: "front", image: { url: cdn("front"), width: 2000, height: 2000 } },
      { mediaContentType: "IMAGE", alt: null, image: { url: cdn("side"), width: 1200, height: 1600 } },
      { mediaContentType: "VIDEO", id: "gid://shopify/Video/9" },
      { mediaContentType: "EXTERNAL_VIDEO", id: "gid://shopify/ExternalVideo/3" },
    ],
  },
  ...over,
});

section("A product page is already an edit, so its order is kept");
{
  const ad = product.readProduct(productNode());
  check("the photographs come out in the merchant's order", ad.images.map((i) => i.url.includes("front") ? "front" : "side").join(",") === "front,side", JSON.stringify(ad.images.map((i) => i.url)));
  check("the title is theirs", ad.title === "Ceramic Pour-Over Kettle");
  check("and the price is read with its currency", ad.price === "34.00 USD", String(ad.price));
  /*
    Counted, not ignored. A merchant whose product has a supplier video and who
    gets a slideshow of the stills has been given something worse than their
    page already had, and finding that out by watching it is the complaint this
    whole category collects.
  */
  check("a video on the product is counted so it can be said out loud", ad.videos === 1, String(ad.videos));
  check("and anything else is counted separately", ad.otherMedia === 1, String(ad.otherMedia));

  const bounded = new URL(ad.images[0].url);
  check("the CDN is asked for a bounded width", bounded.searchParams.get("width") === "1600", ad.images[0].url);
  check("and the rest of the url is left alone", bounded.searchParams.get("v") === "1");

  check("a product with no photographs is not an advertisement", product.readProduct(productNode({ media: { nodes: [] } })) === null);
  check("nor is a missing product", product.readProduct(null) === null && product.readProduct(undefined) === null);
  check("a product with no price gets none rather than a made-up one", product.readProduct(productNode({ priceRangeV2: { minVariantPrice: { amount: "0.00", currencyCode: "USD" } } })).price === null);

  const many = product.readProduct(productNode({
    media: { nodes: Array.from({ length: 40 }, (_, i) => ({ mediaContentType: "IMAGE", alt: null, image: { url: cdn(`p${i}`), width: 1200, height: 1600 } })) },
  }));
  check("and a catalogue photo dump is bounded before it is downloaded", many.images.length === product.MAX_IMAGES, String(many.images.length));

  // A row whose file is still transcoding has no URL yet. Early, not broken.
  const pending = product.readProduct(productNode({
    media: { nodes: [{ mediaContentType: "IMAGE", alt: null, image: null }, ...productNode().media.nodes] },
  }));
  check("a photo that has not finished uploading is skipped, not fatal", pending.images.length === 2, String(pending.images.length));
}

section("A URL in a JSON response is not a promise about where it points");
{
  check("Shopify's CDN is allowed", product.isAllowedMediaUrl(cdn("a")));
  check("and their other hosts", product.isAllowedMediaUrl("https://x.shopifycdn.com/a.jpg"));
  /*
    This server holds the service role key and runs inside our infrastructure.
    The URLs come from Shopify's API, which is the argument for trusting them
    and not the argument for skipping the check.
  */
  for (const bad of [
    "http://cdn.shopify.com/a.jpg",
    "https://evil.com/a.jpg",
    "https://cdn.shopify.com.evil.com/a.jpg",
    "http://127.0.0.1:5432/a.jpg",
    "file:///etc/passwd",
    "https://localhost/a.jpg",
    "not a url",
  ]) {
    check(`"${bad}" is refused`, !product.isAllowedMediaUrl(bad));
  }

  const smuggled = product.readProduct(productNode({
    media: { nodes: [{ mediaContentType: "IMAGE", alt: null, image: { url: "https://evil.com/a.jpg", width: 10, height: 10 } }, ...productNode().media.nodes] },
  }));
  check("and one smuggled into a product's media never reaches the fetcher", smuggled.images.every((i) => i.url.includes("cdn.shopify.com")), JSON.stringify(smuggled.images.map((i) => i.url)));
}

section("The advertisement a merchant gets without saying anything");
{
  const ad = product.readProduct(productNode());
  const ids = ["a1", "a2"];
  const plan = product.planForProduct(ad, ids, { platform: "tiktok", targetSeconds: 15 });
  const types = plan.map((op) => op.type);

  check("it is built from the photographs", types.includes("stillsReel"));
  check("named by id, in their order", JSON.stringify(plan.find((o) => o.type === "stillsReel").assetIds) === JSON.stringify(ids));
  check("reframed for the platform asked for", plan.find((o) => o.type === "formatForPlatform").platform === "tiktok");
  /*
    Their words. A generated headline is the one thing in this plan that could
    be wrong about the product itself, and a merchant who reads a sentence they
    did not write about their own product stops trusting the rest of the video.
  */
  const title = plan.filter((o) => o.type === "motionTitle")[0];
  check("opening on the product's own name", title.text === ad.title, title.text);
  const price = plan.filter((o) => o.type === "motionTitle")[1];
  check("and closing on the price", price.text === "34.00 USD" && price.at > 10, JSON.stringify(price));

  const noPrice = product.planForProduct({ ...ad, price: null }, ids, { platform: "reels", targetSeconds: 15 });
  check("a product with no price gets no price card", noPrice.filter((o) => o.type === "motionTitle").length === 1);

  const short = product.planForProduct(ad, ids, { platform: "tiktok", targetSeconds: 6 });
  check("on a short reel the price does not land on top of the title", short.filter((o) => o.type === "motionTitle")[1].at >= 3.2);

  /*
    The plan is the contract, so it is checked against the contract rather than
    eyeballed. `EditPlan` caps a plan at twelve operations, and a plan built by
    us that the API would refuse is a failure nobody would see until a merchant
    pressed the button.
  */
  const parsed = zod.EditPlan.safeParse({ version: 1, operations: plan });
  check("and the whole plan is one the API would accept", parsed.success, JSON.stringify(parsed.error?.issues?.[0]));
}

// ── Against a real socket ───────────────────────────────────────────────────

async function fakeShopify(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res, body, seen.length);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { seen, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

const json = (res, status, value) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};

section("The token exchange is one request, and its answer is theirs");
{
  const shopify = await fakeShopify((_req, res) => json(res, 200, { access_token: "shpat_test", scope: "read_products" }));
  const result = await admin.exchangeToken(SHOP, "an-id-token", { clientId: CLIENT_ID, clientSecret: SECRET }, fetch, shopify.base);
  check("the token comes back", result.ok && result.accessToken === "shpat_test", JSON.stringify(result));
  check("with the scopes Shopify granted, not the ones we asked for", result.ok && result.scopes === "read_products");

  const sent = JSON.parse(shopify.seen[0].body);
  check("posted to the access-token endpoint", shopify.seen[0].url === "/admin/oauth/access_token", shopify.seen[0].url);
  check("as a token exchange", sent.grant_type === "urn:ietf:params:oauth:grant-type:token-exchange");
  /*
    Offline, deliberately. An online token expires with the staff member's
    session, and the work this app starts finishes minutes after the merchant
    has closed the tab.
  */
  check("asking for an offline token", sent.requested_token_type === "urn:shopify:params:oauth:token-type:offline-access-token");
  check("and carrying the id token as the subject", sent.subject_token === "an-id-token");
  await shopify.close();

  const refused = await fakeShopify((_req, res) => json(res, 400, { error: "invalid_subject_token" }));
  const bad = await admin.exchangeToken(SHOP, "stale", { clientId: CLIENT_ID, clientSecret: SECRET }, fetch, refused.base);
  check("a refusal is reported in their words, not ours", !bad.ok && bad.reason.includes("invalid_subject_token"), JSON.stringify(bad));
  await refused.close();

  const notAShop = await admin.exchangeToken("evil.com", "x", { clientId: CLIENT_ID, clientSecret: SECRET });
  check("and a domain that is not a shop never leaves the process", !notAShop.ok && notAShop.reason === "not a shop domain");
}

section("A throttled query is the API saying 'in a moment', not an error");
{
  const throttled = {
    errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
    extensions: { cost: { requestedQueryCost: 200, throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 50, restoreRate: 100 } } },
  };
  const waits = [];
  const shopify = await fakeShopify((_req, res, _body, nth) =>
    nth === 1 ? json(res, 200, throttled) : json(res, 200, { data: { product: { id: "gid://shopify/Product/1" } } }),
  );

  const result = await admin.adminGraphql(SHOP, "shpat_x", "query{}", {}, {
    base: shopify.base,
    sleep: async (ms) => { waits.push(ms); },
  });
  check("it is retried once and succeeds", result.ok, JSON.stringify(result));
  check("after waiting what the bucket said, not a guessed interval", waits[0] === 1500, JSON.stringify(waits));
  check("with the access token on every attempt", shopify.seen.every((r) => r.headers["x-shopify-access-token"] === "shpat_x"));
  check("and pinned to one API version", shopify.seen[0].url === `/admin/api/${admin.API_VERSION}/graphql.json`, shopify.seen[0].url);
  await shopify.close();

  const alwaysThrottled = await fakeShopify((_req, res) => json(res, 200, throttled));
  const gaveUp = await admin.adminGraphql(SHOP, "shpat_x", "query{}", {}, { base: alwaysThrottled.base, sleep: async () => {} });
  check("a shop that stays busy is told so rather than held open", !gaveUp.ok && gaveUp.retryable, JSON.stringify(gaveUp));
  check("and it stopped after two attempts", alwaysThrottled.seen.length === 2, String(alwaysThrottled.seen.length));
  await alwaysThrottled.close();

  const dead = await fakeShopify((_req, res) => json(res, 401, {}));
  const revoked = await admin.adminGraphql(SHOP, "shpat_old", "query{}", {}, { base: dead.base, sleep: async () => {} });
  /*
    A dead token is not a temporary problem, and telling them apart is what
    stops the app retrying forever against a shop that removed it.
  */
  check("a revoked token is final, not retryable", !revoked.ok && revoked.retryable === false && revoked.status === 401, JSON.stringify(revoked));
  await dead.close();

  const broken = await fakeShopify((_req, res) => json(res, 200, { errors: [{ message: "Field 'nope' doesn't exist" }] }));
  const wrong = await admin.adminGraphql(SHOP, "shpat_x", "query{}", {}, { base: broken.base, sleep: async () => {} });
  check("a query error comes back with the message", !wrong.ok && wrong.reason.includes("doesn't exist"), JSON.stringify(wrong));
  await broken.close();
}

// ── Through the real app ────────────────────────────────────────────────────

section("The webhooks, driven through the actual stack");
const ISSUER_PORT = 4599;
const API_PORT = 4598;
const ISSUER_BASE = `http://127.0.0.1:${ISSUER_PORT}`;

const storage = http.createServer((req, res) => {
  // Enough of Supabase Storage for `storageAdminConfigured` to be true and for
  // the deletion path to be the one production runs.
  if (req.url?.startsWith("/storage/v1/object/list/")) return json(res, 200, []);
  if (req.method === "DELETE") return json(res, 200, {});
  return json(res, 200, {});
});
await new Promise((r) => storage.listen(ISSUER_PORT, r));

process.env.SUPABASE_URL = ISSUER_BASE;
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-for-tests";
process.env.SHOPIFY_API_KEY = CLIENT_ID;
process.env.SHOPIFY_API_SECRET = SECRET;
await resolveTestDatabaseUrl();

const built = spawnSync(process.execPath, ["artifacts/api-server/build-vercel.mjs"], {
  stdio: ["ignore", "ignore", "inherit"],
  env: { ...process.env },
});
if (built.status !== 0) {
  console.error("Bundle build failed; cannot drive the routes.");
  process.exit(1);
}

const bundle = require("../api/_bundle.js");
const server = http.createServer(bundle.default || bundle);
await new Promise((r) => server.listen(API_PORT, r));

async function webhook(topic, payload, { secret = SECRET, shop = SHOP } = {}) {
  const body = JSON.stringify(payload);
  return fetch(`http://127.0.0.1:${API_PORT}/api/shopify/webhooks/${topic}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Hmac-Sha256": createHmac("sha256", secret).update(body).digest("base64"),
      "X-Shopify-Shop-Domain": shop,
      "X-Shopify-Topic": topic.replace("/", "/"),
    },
    body,
  });
}

{
  for (const topic of ["customers/data_request", "customers/redact", "shop/redact", "app/uninstalled"]) {
    const forged = await webhook(topic, { shop_domain: SHOP }, { secret: "not-the-secret" });
    /*
      401, in as many words, and this is the check the whole section exists for.
      Shopify requires it for the compliance webhooks, and it is right beyond
      the letter: a 200 here is an endpoint that erases a shop on request, and
      silently dropping is an endpoint whose failures nobody can see.
    */
    check(`${topic}: a forged signature gets 401`, forged.status === 401, String(forged.status));
  }

  const ok = await webhook("customers/data_request", { shop_domain: SHOP });
  check("a signed data request is acknowledged", ok.status === 200, String(ok.status));
  check("and says plainly that nothing is held", (await ok.json()).holds === "nothing");

  const redacted = await webhook("customers/redact", { shop_domain: SHOP });
  check("a signed customer redaction is acknowledged", redacted.status === 200);

  /*
    The bodies must reach these handlers unparsed. Every check above passes
    against a verifier tested in isolation and fails against the deployed
    endpoint if `express.json()` gets there first — the digest of a
    re-serialised object is not the digest they signed. This is the only way to
    know the two files agree.
  */
  const withWhitespace = JSON.stringify({ shop_domain: SHOP, spaced: "  keep   me  " }, null, 2);
  const spaced = await fetch(`http://127.0.0.1:${API_PORT}/api/shopify/webhooks/app/uninstalled`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Hmac-Sha256": createHmac("sha256", SECRET).update(withWhitespace).digest("base64"),
      "X-Shopify-Shop-Domain": SHOP,
    },
    body: withWhitespace,
  });
  check("a body whose exact bytes matter survives the parsers", spaced.status === 200, String(spaced.status));

  const noShop = await fetch(`http://127.0.0.1:${API_PORT}/api/shopify/webhooks/shop/redact`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Hmac-Sha256": createHmac("sha256", SECRET).update("{}").digest("base64"),
    },
    body: "{}",
  });
  check("a signed webhook naming no shop is refused", noShop.status === 400, String(noShop.status));
}

section("And the merchant surface answers to one thing only");
{
  const call = (headers) =>
    fetch(`http://127.0.0.1:${API_PORT}/api/shopify/ads`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ productId: "gid://shopify/Product/1" }),
    });

  check("no token is 401", (await call({})).status === 401);
  check("somebody else's signature is 401", (await call({ Authorization: `Bearer ${makeToken({}, { secret: "not-ours" })}` })).status === 401);
  check("an expired token is 401", (await call({ Authorization: `Bearer ${makeToken({ exp: Math.floor(Date.now() / 1000) - 600 })}` })).status === 401);
  /*
    A Supabase token is not a Shopify token. The two doors share an account id
    and nothing else, and this is the check that they cannot be crossed: a
    valid signed-in user's bearer token is simply not a session token, and this
    surface says so.
  */
  check("and a Supabase bearer token is not a way in either", (await call({ Authorization: "Bearer eyJhbGciOiJFUzI1NiJ9.e30.x" })).status === 401);

  const good = { Authorization: `Bearer ${makeToken()}` };
  const notAProduct = await fetch(`http://127.0.0.1:${API_PORT}/api/shopify/ads`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...good },
    body: JSON.stringify({ productId: "gid://shopify/Collection/9" }),
  });
  check("a valid token still cannot ask about something that is not a product", notAProduct.status === 400, String(notAProduct.status));
}

server.close();
storage.close();
await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("A shop can ask for a video, and only a shop can.");
process.exit(0);
