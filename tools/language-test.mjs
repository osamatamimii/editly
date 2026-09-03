/**
 * The document says what language it is in, and it is telling the truth.
 *
 * This is a suite about one bug and the class it belongs to.
 *
 * `index.html` declared `lang="ar" dir="rtl"`, because the product's default
 * language is Arabic and the landing page is written in it. The landing page
 * sets its own `lang`/`dir` on its wrapper, so it was always right.
 * Everything behind the login screen is written in English and set nothing, so
 * it inherited `rtl` from the root and laid English out right to left.
 *
 * What that looks like, measured on a real Chromium at 390px on `/account`:
 *
 *   - the back chevron on the right, pointing away from where it goes
 *   - "Uploading doesn't spend them." rendered ".Uploading doesn't spend them"
 *   - the price rendered "9/month$" instead of "$9/month"
 *
 * The bidi algorithm doing exactly what it was told: a trailing full stop and a
 * leading currency symbol are neutral characters, and in a right-to-left
 * paragraph they go to the other end. Every English sentence on every
 * signed-in screen, and the dollar sign on every price, for every customer.
 *
 * Nothing failed. No error, no log line, no test. It reads as carelessness
 * rather than as a bug, on the screen where somebody decides whether to pay.
 *
 * So the rule this file holds is narrow and checkable: **the document declares
 * the language of the screen it is showing.** A route whose copy exists in both
 * languages declares the person's preference. Every other route declares
 * English, because English is what is on it. A route joins the first group on
 * the commit that translates it, and this suite refuses a member that still has
 * bare English in it.
 *
 * Usage: node tools/language-test.mjs
 * Requires: a built `dist/` (pnpm run vercel:build) and a Chromium.
 */
import http from "node:http";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-language-"));
const dist = path.join(repoRoot, "dist");

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
const read = (file) => readFileSync(path.join(repoRoot, file), "utf8");

if (!existsSync(path.join(dist, "index.html"))) {
  console.error("No dist/. Run: pnpm run vercel:build");
  process.exit(1);
}

// ─── The seam, read from the module that owns it ─────────────────────────────

const outfile = path.join(buildDir, "language.mjs");
{
  const built = spawnSync(
    require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] }),
    [
      // The pure half. `language.tsx` is the provider and needs React and a
      // router; `language-routes.ts` is the list and the storage key, which is
      // all this suite reads, and it bundles into plain Node.
      path.join(repoRoot, "artifacts/editly/src/lib/language-routes.ts"),
      "--bundle", "--platform=node", "--format=esm", "--target=node22",
      "--log-level=error",
      `--outfile=${outfile}`,
    ],
    { stdio: "inherit" },
  );
  if (built.status !== 0) process.exit(1);
}
const { BILINGUAL, isBilingualRoute, LANGUAGE_KEY } = await import(pathToFileURL(outfile).href);

section("The list of translated screens says what it means");
{
  check("there is a list at all", Array.isArray(BILINGUAL) && BILINGUAL.length > 0, JSON.stringify(BILINGUAL));
  check("the landing page is on it", isBilingualRoute("/"));
  check("the first-run screen is on it", isBilingualRoute("/onboarding"));

  /*
    The product is on it now, which is what changed. When this file was written
    the list was three routes and the interesting check was everything that was
    *not* on it; the app is written in both languages now, so the interesting
    check is that the screens somebody spends their day on are.

    The prefixed ones are the reason `isBilingualRoute` exists at all: a project
    and an export are one screen each at a hundred addresses.
  */
  for (const route of ["/login", "/dashboard", "/account", "/clips", "/scheduled", "/admin"]) {
    check(`${route} is claimed as translated`, isBilingualRoute(route));
  }
  check("and a project under its id", isBilingualRoute("/project/8f2c-1"));
  check("and an export under its id", isBilingualRoute("/export/8f2c-1"));

  /*
    And the two that are not, which is the whole reason this stayed a list of
    what *is* translated rather than a list of exceptions. A privacy policy
    translated by whoever was translating the buttons is a liability with a
    language toggle on it; these declare English until a lawyer has written the
    Arabic.
  */
  for (const route of ["/privacy", "/terms"]) {
    check(`${route} is not claimed as translated`, !isBilingualRoute(route));
  }
  /*
    Nor is an address nobody wrote a screen for. The 404 answers there and it
    *is* translated — it sets `lang` and `dir` on its own wrapper, because it
    has no path this list could name. Claiming the path instead would claim
    every mistyped URL in the product.
  */
  check("nor is a path with no screen behind it", !isBilingualRoute("/nothing-here"));
  {
    const notFound = read("artifacts/editly/src/pages/not-found.tsx");
    check(
      "and the 404 declares its own language instead",
      /lang=\{language\}/.test(notFound) && /dir=\{directionOf\(language\)\}/.test(notFound),
      "not-found.tsx must set lang and dir on its own wrapper",
    );
  }
}

section("Every screen claimed as translated actually is");
{
  /*
    A route on the list declares the person's language. If its copy is English
    and the person reads Arabic, the document says Arabic over English text and
    we are back where we started, with the list making it look deliberate.

    So each member is read for bare English: text between JSX tags, long enough
    not to be a symbol or a number.
  */
  const FILES = {
    "/": "artifacts/editly/src/pages/home.tsx",
    "/login": "artifacts/editly/src/pages/login.tsx",
    "/reset-password": "artifacts/editly/src/pages/reset-password.tsx",
    "/unsubscribe": "artifacts/editly/src/pages/unsubscribe.tsx",
    "/onboarding": "artifacts/editly/src/pages/onboarding.tsx",
    "/dashboard": "artifacts/editly/src/pages/dashboard.tsx",
    "/project": "artifacts/editly/src/pages/project-editor.tsx",
    "/export": "artifacts/editly/src/pages/export.tsx",
    "/clips": "artifacts/editly/src/pages/clips.tsx",
    "/scheduled": "artifacts/editly/src/pages/scheduled.tsx",
    "/account": "artifacts/editly/src/pages/account.tsx",
    "/admin": "artifacts/editly/src/pages/admin.tsx",
  };

  for (const route of BILINGUAL) {
    const file = FILES[route];
    check(`${route} has a file this check knows about`, Boolean(file), "add it to FILES above");
    if (!file) continue;

    const source = read(file);
    const rendered = [...source.matchAll(/>\s*([A-Za-z][A-Za-z ,.'’!?:%-]{14,})\s*</g)].map((m) => m[1].trim());
    check(
      `${route} renders no bare English`,
      rendered.length === 0,
      rendered.slice(0, 4).join(" | "),
    );
    // Either it draws from a pair table, or it picks a side per string. Both
    // are real; a screen doing neither is not translated.
    check(
      `${route} chooses its words by language`,
      /useLanguage\(/.test(source) && (/\bt\(/.test(source) || /say\(/.test(source)),
      "no language-aware string selection in the file",
    );
  }

  /*
    And the components those screens are built from, which is where most of the
    sentences actually live. A page can pass the check above with every word it
    renders coming out of a panel that is still English: the account screen is
    four components and a heading.

    Read from the folder rather than from a list here, so a component added next
    month is held to the same rule without anybody remembering to add it. The
    exceptions are named and each is a decision: a wordmark, a generated
    picture, five brand paths, a sparkline, a rolling number. Nothing in any of
    them is a sentence.
  */
  const componentDir = path.join(repoRoot, "artifacts/editly/src/components");
  const DRAWS_RATHER_THAN_SAYS = new Set([
    "logo.tsx", "project-art.tsx", "platform-mark.tsx", "sparkline.tsx",
    "rolling-number.tsx", "pending-detail.tsx",
  ]);
  const speaking = readdirSync(componentDir)
    .filter((name) => name.endsWith(".tsx") && !DRAWS_RATHER_THAN_SAYS.has(name));

  check("there are components to check", speaking.length > 10, String(speaking.length));
  for (const name of speaking) {
    const source = read(`artifacts/editly/src/components/${name}`);
    const rendered = [...source.matchAll(/>\s*([A-Za-z][A-Za-z ,.'’!?:%-]{14,})\s*</g)].map((m) => m[1].trim());
    check(
      `components/${name} renders no bare English`,
      rendered.length === 0,
      rendered.slice(0, 3).join(" | "),
    );
  }
}

section("The pre-paint copy of the list has not drifted from the real one");
{
  /*
    `index.html` decides the direction before React exists, because by the time
    the bundle has parsed the browser has painted, and a signed-in screen would
    show one frame of English laid out right to left. There is no module system
    in that script, so the route list is duplicated by hand — which is fine
    exactly as long as something compares the two.
  */
  const html = read("artifacts/editly/index.html");
  check(
    "the inline script decides the language",
    /var bilingual = /.test(html),
    "no `var bilingual =` in index.html",
  );
  /*
    The list itself, read as an array rather than out of the middle of an
    expression. It was three routes and one boolean when this check was
    written; it is a dozen routes and a `.some` now, and a regex that stops at
    the first semicolon was reading the first half of a loop body.
  */
  const inline = html.match(/var routes = (\[[^\]]*\])/)?.[1] ?? "";
  check("and reads its route list from an array", inline.length > 0, "no `var routes = [...]` in index.html");

  for (const route of BILINGUAL) {
    check(`${route} appears in the pre-paint copy`, inline.includes(`"${route}"`), inline);
  }
  // And nothing extra, which would be the drift running the other way.
  const named = [...inline.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  check(
    "and the pre-paint copy claims nothing the module does not",
    named.every((route) => BILINGUAL.includes(route)),
    `${named.filter((r) => !BILINGUAL.includes(r)).join(", ")} is in index.html only`,
  );
  check(
    "and neither list has an entry the other lacks",
    named.length === BILINGUAL.length,
    `${named.length} in index.html, ${BILINGUAL.length} in the module`,
  );

  check("both halves read the same storage key", html.includes(LANGUAGE_KEY), LANGUAGE_KEY);
  check(
    "and the old landing-page key is still read, so a returning visitor keeps their choice",
    html.includes("editly:landing-language") &&
      read("artifacts/editly/src/lib/language-routes.ts").includes("editly:landing-language"),
  );
}

// ─── And in a browser, which is the only place bidi is real ─────────────────

const types = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".json": "application/json", ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png",
  ".webp": "image/webp", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".txt": "text/plain",
  ".xml": "application/xml",
};
const server = http.createServer(async (req, res) => {
  let file = path.join(dist, decodeURIComponent(req.url.split("?")[0].split("#")[0]));
  if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(dist, "index.html");
  try {
    res.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  } catch {
    res.writeHead(404).end("no");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

function findChromium() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (root && existsSync(root)) {
    const dir = readdirSync(root).find((d) => /^chromium-\d+$/.test(d));
    if (dir) {
      const candidate = path.join(root, dir, "chrome-linux", "chrome");
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}
const { chromium } = require(require.resolve("playwright", { paths: [repoRoot] }));
const browser = await chromium.launch({
  ...(findChromium() ? { executablePath: findChromium() } : {}),
  args: ["--no-sandbox"],
});

/**
 * The Supabase project the bundle was built against.
 *
 * Read out of the built JavaScript rather than written here, because the
 * planted session key is `sb-<ref>-auth-token` and a ref that does not match
 * the one compiled into the bundle means no session, a redirect to /login, and
 * a suite that quietly checks the login screen instead of the account screen.
 */
const PROJECT_REF = (() => {
  const assets = path.join(dist, "assets");
  const sources = existsSync(assets)
    ? readdirSync(assets).filter((f) => f.endsWith(".js")).map((f) => readFileSync(path.join(assets, f), "utf8"))
    : [];
  for (const source of sources) {
    const found = source.match(/https:\/\/([a-z0-9]{16,})\.supabase\.co/);
    if (found) return found[1];
  }
  return null;
})();

async function open(url, { signedIn = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.route("**/*.supabase.co/**", (route) => {
    const at = new URL(route.request().url()).pathname;
    if (at.startsWith("/auth/v1/settings")) return route.fulfill({ json: { external: { google: true } } });
    if (at.startsWith("/auth/v1/user")) {
      return route.fulfill({ json: { id: "11111111-1111-4111-8111-111111111111", email: "t@e.test", user_metadata: {} } });
    }
    return route.fulfill({ json: {} });
  });
  await ctx.route(`${ORIGIN}/api/**`, (route) => route.fulfill({ json: {} }));
  if (signedIn) {
    await ctx.addInitScript((ref) => {
      const session = {
        access_token: "h.e.s", token_type: "bearer", expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: "r",
        user: {
          id: "11111111-1111-4111-8111-111111111111", aud: "authenticated", role: "authenticated",
          email: "t@e.test", app_metadata: { provider: "email" }, user_metadata: {},
          created_at: "2026-01-01T00:00:00.000Z",
        },
      };
      try { localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(session)); } catch { /* private mode */ }
    }, PROJECT_REF);
  }
  const page = await ctx.newPage();
  await page.goto(ORIGIN + url, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  return { ctx, page };
}

const declared = (page) =>
  page.evaluate(() => ({
    lang: document.documentElement.lang,
    dir: document.documentElement.dir,
    computed: getComputedStyle(document.body).direction,
  }));

section("An English screen is laid out left to right, whatever the landing page is in");
{
  check("the built bundle names a Supabase project, so a session can be planted", PROJECT_REF !== null);
  /*
    The privacy policy, and it is the right screen for this now.

    This used to be `/account`, because the account screen was English and this
    check is about English text under an Arabic document. The account screen is
    written in both languages now; the legal pages are the two that are not, and
    they are the two where being wrong about the words is a legal matter rather
    than a typographic one. So the bidi assertion moved to them, unchanged.

    Public, so no session has to be planted for it, which is one fewer thing
    between this check and the thing it is checking.
  */
  const { ctx, page } = await open("/privacy", { signedIn: false });
  const said = await declared(page);
  check("the document says English", said.lang === "en", JSON.stringify(said));
  check("and lays out left to right", said.dir === "ltr" && said.computed === "ltr", JSON.stringify(said));

  /*
    The symptom itself, not a proxy for it.

    In a right-to-left paragraph the bidi algorithm moves a trailing full stop
    to the front and a leading currency symbol to the back. The rendered text
    is the same string either way — `innerText` cannot see it — so what is
    measured is the direction of the element that holds the sentence, which is
    what decides where those characters land.
  */
  const paragraphs = await page.evaluate(() =>
    [...document.querySelectorAll("p")]
      .filter((el) => /^[\x20-\x7e]+$/.test(el.textContent ?? "") && (el.textContent ?? "").length > 20)
      .map((el) => getComputedStyle(el).direction),
  );
  check("there are English paragraphs on the screen to check", paragraphs.length > 0, String(paragraphs.length));
  check(
    "and every one of them flows the way it is written",
    paragraphs.every((direction) => direction === "ltr"),
    `${paragraphs.filter((d) => d !== "ltr").length} of ${paragraphs.length} run right to left`,
  );
  await ctx.close();
}

section("A screen that is written in Arabic still says so");
{
  const { ctx, page } = await open("/", { signedIn: false });
  const said = await declared(page);
  check("the landing page declares Arabic", said.lang === "ar", JSON.stringify(said));
  check("and lays out right to left", said.dir === "rtl", JSON.stringify(said));
  await ctx.close();
}

section("A choice made on the landing page is the same choice inside the product");
{
  /*
    The preference used to live under the landing page's own key, in a hook only
    that page could reach. So somebody who read the marketing in English, signed
    up, and came back was asked again — and the first-run screen, which had its
    own guess from `navigator.languages`, could disagree with both.
  */
  // Signed in, because `/onboarding` is behind the gate: without a session it
  // redirects to `/login`, which is English, and every assertion below would
  // pass while checking the wrong screen.
  const { ctx, page } = await open("/?lang=en", { signedIn: true });
  const landing = await declared(page);
  check("a link can ask for English", landing.lang === "en", JSON.stringify(landing));

  await page.evaluate((key) => localStorage.setItem(key, "en"), LANGUAGE_KEY);
  await page.goto(`${ORIGIN}/onboarding`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  check("the first-run screen is the one being looked at", new URL(page.url()).pathname === "/onboarding", page.url());
  const first = await declared(page);
  check("and it is in the same language", first.lang === "en", JSON.stringify(first));

  await page.evaluate((key) => localStorage.setItem(key, "ar"), LANGUAGE_KEY);
  await page.goto(`${ORIGIN}/onboarding`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  const arabic = await declared(page);
  check("switching switches it", arabic.lang === "ar" && arabic.dir === "rtl", JSON.stringify(arabic));

  /*
    And the product follows, which it did not when this suite was written.

    This check used to assert the opposite: `/account` kept saying English
    because English was what was on it, and declaring Arabic over English copy
    is the bug this whole file is about. The account screen is written in both
    languages now, so the honest assertion is the other one — and it is the same
    rule, applied to a screen that has since been translated.
  */
  await page.goto(`${ORIGIN}/account`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  const account = await declared(page);
  check(
    "and the account screen follows it now that it is written in both",
    account.lang === "ar" && account.dir === "rtl",
    JSON.stringify(account),
  );

  /*
    The two that still do not, and must not. A privacy policy that declares
    Arabic while being written in English is the original bug on the one screen
    where being wrong about the words is a legal matter rather than a
    typographic one.
  */
  await page.goto(`${ORIGIN}/privacy`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  const privacy = await declared(page);
  check(
    "while the privacy policy keeps saying English, because it is",
    privacy.lang === "en",
    "these need a lawyer, not a copy table",
  );
  await ctx.close();
}

await browser.close();
server.close();
await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("The document is in the language it is written in.");
