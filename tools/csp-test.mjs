/**
 * The Content Security Policy, in a browser, under the policy.
 *
 * This suite exists because of what was found in `vercel.json`: the header was
 * `Content-Security-Policy-Report-Only`, and it carried no `report-uri` and no
 * `report-to`. Both halves at once. Report-Only means it blocked nothing, by
 * design; no reporting endpoint means it told nobody, ever. It occupied the
 * place a security control occupies, passed every review that reads header
 * names, and did nothing at all for as long as it existed.
 *
 * Making it enforcing is the fix, and it is also the dangerous kind of change:
 * a policy one token too tight breaks the app *in a browser*, which is the one
 * place none of this repository's other suites look. The symptom is a white
 * page. Nothing throws, nothing is logged, the deploy is green, and the theme
 * script that decides light or dark before the first paint simply does not run.
 *
 * So reading the policy is not the test. The test is:
 *
 *   1. the header is enforcing, has somewhere to report to, and its script-src
 *      contains no 'unsafe-inline' and no hash that is not a real script;
 *   2. the hashes are recomputed here from the page, and the *built* page's
 *      inline scripts are byte-identical to the source's, because the hash is
 *      over bytes and a build step that touches one character silently blocks
 *      it;
 *   3. the built site is served over http with exactly the headers `vercel.json`
 *      ships, opened in Chromium, and asked whether anything was blocked and
 *      whether the two before-paint scripts actually ran;
 *   4. and then the same page is served again under a policy with the hashes
 *      removed, to prove every check in (3) can go red. A green check that
 *      cannot fail is the thing this whole suite is about.
 *
 * (4) is also the only end-to-end proof of the endpoint: the report Chromium
 * sends is fed to the real `violationFrom` from `routes/csp-report.ts`, so the
 * parser is checked against a browser's actual body rather than a body written
 * here from the specification.
 *
 * Usage: node tools/csp-test.mjs
 * Requires: the built site at <repo root>/dist. Run `pnpm run vercel:build`.
 */
import http from "node:http";
import { readFile, mkdtemp } from "node:fs/promises";
import { existsSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(repoRoot, "dist");
const sourceHtml = path.join(repoRoot, "artifacts/editly/index.html");
const PORT = 4417;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const REPORT_PATH = "/api/csp-report";

if (!existsSync(dist)) {
  console.error("dist/ is not built. Run `pnpm run vercel:build` from the repo root first.");
  process.exit(1);
}

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

// ── the real parser, from the route that will read these reports ─────────────

const buildDir = await mkdtemp(path.join(tmpdir(), "editly-csp-"));
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

/*
  The route pulls in the rate limiter, which pulls in the auth middleware,
  which refuses to load without a project to verify tokens against. Nothing
  here verifies a token; these are the values that let the module finish
  loading, and they point at a closed port so that anything which did try to
  reach out would fail loudly rather than quietly succeed.
*/
process.env.NODE_ENV ??= "production"; // else the logger asks for pino-pretty
process.env.SUPABASE_URL ??= "http://127.0.0.1:1/not-a-real-project";
process.env.SUPABASE_ANON_KEY ??= "anon-key-for-tests";
process.env.DATABASE_URL ??= "postgresql://postgres@127.0.0.1:1/none";

const { violationFrom, pageOf, blockedOrigin } = await import(
  bundle("artifacts/api-server/src/routes/csp-report.ts", "csp-report.mjs")
);

// ── the policy, as shipped ───────────────────────────────────────────────────

const vercel = JSON.parse(readFileSync(path.join(repoRoot, "vercel.json"), "utf8"));
const allHeaders = (vercel.headers ?? []).flatMap((entry) => entry.headers ?? []);
const enforcing = allHeaders.find((h) => h.key === "Content-Security-Policy");
const reportOnly = allHeaders.find((h) => h.key === "Content-Security-Policy-Report-Only");
/** Whatever policy is shipped, under either header. The rules are read from this. */
const shipped = enforcing ?? reportOnly;

/** `script-src 'self' 'sha256-…'` becomes `{ "script-src": ["'self'", "'sha256-…'"] }`. */
function directivesOf(policy) {
  const out = {};
  for (const part of String(policy ?? "").split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    out[tokens[0].toLowerCase()] = tokens.slice(1);
  }
  return out;
}

section("The header is a control and not a decoration");
{
  check("a Content-Security-Policy header is shipped at all", Boolean(enforcing?.value));
  check(
    "and it enforces, rather than reporting only",
    Boolean(enforcing) && !reportOnly,
    reportOnly ? "Content-Security-Policy-Report-Only is still here" : "",
  );

  /*
    The directives below are read from whichever header carries the policy,
    enforcing or not. Reading only the enforcing one would mean that renaming
    the header back to Report-Only turned every rule check green at once, by
    making them about a policy that is no longer there.
  */
  const d = directivesOf(shipped?.value);

  check("it has somewhere to send what it blocked", (d["report-uri"] ?? []).join(" ") === REPORT_PATH,
    (d["report-uri"] ?? []).join(" ") || "no report-uri");
  // The whole failure this replaces. A policy that blocks and reports nowhere
  // is the one shape that is worse than no policy: it breaks pages in silence.
  check(
    "the endpoint it reports to is a route this server mounts publicly",
    (() => {
      const routes = readFileSync(path.join(repoRoot, "artifacts/api-server/src/routes/index.ts"), "utf8");
      const mount = routes.indexOf("cspReportRouter)");
      const gate = routes.indexOf("router.use(requireAuth)");
      return mount > 0 && gate > 0 && mount < gate;
    })(),
    "csp-report must be mounted above requireAuth",
  );
  // And that the deployment routes it there. The endpoint can be mounted
  // perfectly and still answer the single-page app's index.html, in which case
  // every report is a 200 with an HTML body and nothing is ever recorded.
  check(
    "and the deployment routes that path to the server rather than to index.html",
    (vercel.rewrites ?? []).some(
      (r) => r.destination === "/api/index" && new RegExp(`^${r.source}$`).test(REPORT_PATH),
    ),
  );

  check("a page with no rule of its own falls back to this origin", (d["default-src"] ?? []).includes("'self'"));
  check("scripts may not be written inline", !(d["script-src"] ?? []).includes("'unsafe-inline'"));
  check("and may not be built out of strings", !(d["script-src"] ?? []).includes("'unsafe-eval'"));
  check(
    "script-src names no wildcard host",
    !(d["script-src"] ?? []).some((t) => t === "*" || t === "https:" || t.startsWith("*.")),
    (d["script-src"] ?? []).join(" "),
  );
  check("plugins are refused", (d["object-src"] ?? []).includes("'none'"));
  check("nobody may frame this app", (d["frame-ancestors"] ?? []).includes("'none'"));
  check("and it frames nobody", (d["frame-src"] ?? []).includes("'none'"));
  check("a <base> tag cannot move every relative URL elsewhere", (d["base-uri"] ?? []).includes("'self'"));
  check("a form cannot be made to post somewhere else", (d["form-action"] ?? []).includes("'self'"));

  // X-Frame-Options is the older half of frame-ancestors and still the only
  // one some corporate proxies read. Both, or the guarantee has a gap.
  check(
    "and the older header saying the same thing is still there",
    allHeaders.some((h) => h.key === "X-Frame-Options" && h.value === "DENY"),
  );
}

// ── the hashes ───────────────────────────────────────────────────────────────

/** Every inline `<script>` body, in document order. `src=` ones are not inline. */
function inlineScripts(html) {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}
const sha256 = (body) => `'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`;

section("The hashes are this page's, and this page is the one that ships");
{
  const source = readFileSync(sourceHtml, "utf8");
  const built = readFileSync(path.join(dist, "index.html"), "utf8");
  const sourceInline = inlineScripts(source);
  const builtInline = inlineScripts(built);
  const scriptSrc = directivesOf(shipped?.value)["script-src"] ?? [];
  const hashes = scriptSrc.filter((t) => t.startsWith("'sha256-"));

  check("the page still has inline scripts to hash", sourceInline.length > 0);
  check(
    "the build neither adds an inline script nor drops one",
    builtInline.length === sourceInline.length,
    `source ${sourceInline.length}, built ${builtInline.length}`,
  );
  /*
    Byte-identical, not equivalent. A hash is over bytes: a build step that
    reindents one line, or strips one comment, produces a script the policy has
    never heard of. It is then blocked, and the *only* visible symptom is that
    the theme decision does not happen and a returning visitor gets a black
    flash. This check is also the staleness guard on dist/, which is how a
    stale build was caught while this suite was being written.
  */
  for (const [i, body] of sourceInline.entries()) {
    check(
      `inline script ${i + 1} survives the build byte for byte`,
      builtInline[i] === body,
      builtInline[i] === undefined ? "missing from the build" : "the built copy differs",
    );
  }

  const wanted = sourceInline.map(sha256);
  for (const [i, want] of wanted.entries()) {
    check(`inline script ${i + 1} is allowed by its hash`, hashes.includes(want), want);
  }
  // The other direction, and the one nobody writes: a hash left behind after
  // the script it allowed was deleted or rewritten. It permits nothing, so
  // nothing fails, and it sits in the policy looking like a reason the page
  // works.
  for (const hash of hashes) {
    check(`the hash ${hash.slice(0, 24)}… still belongs to a script on the page`, wanted.includes(hash));
  }
  check("no inline script is allowed by anything other than a hash", hashes.length === wanted.length);
}

section("Every host the page reaches for is named in the policy");
{
  const source = readFileSync(sourceHtml, "utf8");
  const d = directivesOf(shipped?.value);
  const allows = (directive, url) => {
    const host = new URL(url).host;
    return (d[directive] ?? []).some((t) => {
      const bare = t.replace(/^https:\/\//, "");
      if (bare === host) return true;
      if (bare.startsWith("*.")) return host.endsWith(bare.slice(1));
      return false;
    });
  };
  const stylesheets = [...source.matchAll(/<link[^>]*rel=["']stylesheet["'][^>]*>/g)]
    .map((m) => m[0].match(/href=["'](https:\/\/[^"']+)["']/)?.[1])
    .filter(Boolean);
  check("the page loads a stylesheet from somewhere else at all", stylesheets.length > 0);
  for (const href of stylesheets) {
    check(`style-src allows ${new URL(href).host}`, allows("style-src", href), href.slice(0, 60));
  }
  // The font files the stylesheets then ask for are a *different* directive,
  // and the failure mode is the reason this is checked separately: allowing
  // the stylesheet and forbidding the faces gives a page that renders in the
  // fallback and reports nothing anybody looks at.
  for (const host of ["https://fonts.gstatic.com", "https://cdn.fontshare.com"]) {
    check(`font-src allows ${new URL(host).host}`, allows("font-src", host));
  }
}

// ── what a report becomes before it is written down ──────────────────────────

section("A report is cut to size here, not trusted from the sender");
{
  check(
    "an OAuth code in the page URL never reaches a log line",
    pageOf("https://app.editlyai.io/auth/callback?code=4/0AeanS0abc&state=xyz") === "/auth/callback",
    pageOf("https://app.editlyai.io/auth/callback?code=4/0AeanS0abc&state=xyz"),
  );
  check("a fragment goes the same way", pageOf("https://app.editlyai.io/settings#token=abc") === "/settings");
  check("a bare path is kept", pageOf("/dashboard") === "/dashboard");
  check("something that is not a URL becomes the root", pageOf("!!!") === "/");
  check("and neither is a number", pageOf(42) === "/");
  check("a very long path is cut", pageOf(`https://app.editlyai.io/${"a".repeat(4000)}`).length <= 201);

  check(
    "a blocked URL is reduced to its origin",
    blockedOrigin("https://evil.example.com/steal?session=abc") === "https://evil.example.com",
    blockedOrigin("https://evil.example.com/steal?session=abc"),
  );
  check("the browser's own answers are kept as they are", blockedOrigin("inline") === "inline");
  check("including eval", blockedOrigin("eval") === "eval");
  check("nothing at all is named as such", blockedOrigin("") === "unknown");
  check("and so is a URL that will not parse", blockedOrigin("https://") === "unknown");

  // A report that can put a newline into a log can write a second entry
  // underneath its own, and a log is read by eye at least as often as it is
  // parsed.
  const forged = violationFrom({
    "csp-report": {
      "effective-directive": "script-src\n2026-09-03 INFO everything is fine",
      "blocked-uri": "inline",
      "document-uri": "https://app.editlyai.io/",
    },
  });
  check("a directive cannot forge a second log line", !forged.directive.includes("\n"), JSON.stringify(forged.directive));

  const legacy = violationFrom({
    "csp-report": { "effective-directive": "script-src", "blocked-uri": "https://cdn.example.com/x.js", "document-uri": "https://app.editlyai.io/dashboard?q=1" },
  });
  check("the report-uri shape is read", legacy?.directive === "script-src", JSON.stringify(legacy));
  check("with its blocked origin", legacy?.blocked === "https://cdn.example.com");
  check("and its page without the query", legacy?.page === "/dashboard");

  const modern = violationFrom([
    { type: "csp-violation", body: { effectiveDirective: "img-src", blockedURL: "https://tracker.example/p.gif", documentURL: "https://app.editlyai.io/projects/1" } },
  ]);
  check("the Reporting API shape is read too", modern?.directive === "img-src", JSON.stringify(modern));
  check("in its own spelling of the fields", modern?.blocked === "https://tracker.example");

  const bare = violationFrom({ "violated-directive": "style-src", "blocked-uri": "inline", "document-uri": "https://app.editlyai.io/" });
  check("and so is a bare object with the older field name", bare?.directive === "style-src", JSON.stringify(bare));

  check("a body with no directive is not a report", violationFrom({ "csp-report": { "blocked-uri": "inline" } }) === null);
  check("nor is a string", violationFrom("script-src") === null);
  check("nor is null", violationFrom(null) === null);
  check("nor is an empty object", violationFrom({}) === null);
  check(
    "the script sample is never carried through",
    JSON.stringify(violationFrom({ "csp-report": { "effective-directive": "script-src", "script-sample": "const key = 'sk-live-secret'" } })).includes("sk-live") === false,
  );
}

// ── the built site, served with the headers it will really be served with ────

const types = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".json": "application/json",
  ".woff2": "font/woff2", ".woff": "font/woff", ".txt": "text/plain", ".xml": "application/xml",
};

/** Reports Chromium posted to the report-uri, exactly as it sent them. */
const posted = [];
/** Swapped between the real policy and the broken one for the negative control. */
let policy = enforcing?.value ?? "";

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  if (url.pathname === REPORT_PATH) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    posted.push({ contentType: req.headers["content-type"] ?? "", raw });
    res.writeHead(204).end();
    return;
  }
  // Vercel's own rewrite: anything that is not a file is the single page.
  let file = path.join(dist, decodeURIComponent(url.pathname));
  if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) {
    file = path.join(dist, "index.html");
  }
  try {
    const body = await readFile(file);
    // Every header from vercel.json, so the page is served the way it ships.
    const headers = { "Content-Type": types[path.extname(file)] ?? "application/octet-stream" };
    for (const h of allHeaders) {
      if (h.key === "Content-Security-Policy") headers[h.key] = policy;
      else if (h.key !== "Content-Security-Policy-Report-Only") headers[h.key] = h.value;
    }
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    res.writeHead(404).end("no");
  }
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const { chromium } = await import("playwright");
function findChromium() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined;
  for (const dir of require("node:fs").readdirSync(root)) {
    if (!/^chromium[-_]/.test(dir)) continue;
    const candidate = path.join(root, dir, "chrome-linux", "chrome");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}
const exe = findChromium();
const browser = await chromium.launch({
  ...(exe ? { executablePath: exe } : {}),
  args: ["--no-sandbox"],
});

/**
 * Open a path and report what the policy did to it.
 *
 * The listener is installed before the document's own scripts run, which is
 * the only place it can see a violation from the head. Playwright installs it
 * through the debugger rather than as a script in the page, so the policy
 * under test does not block the thing measuring it.
 */
async function open(pathname) {
  const page = await browser.newPage();
  const violations = [];
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      window.__cspViolations.push({
        directive: event.effectiveDirective || event.violatedDirective,
        blocked: event.blockedURI,
      });
    });
    /*
      The state before React exists, which is the only place these two scripts
      can be seen doing their job.

      Both of them set attributes that `ThemeProvider` and `LanguageProvider`
      also set on mount, so reading the document after the app has started
      cannot tell "the head script ran" from "React put it back" — and the
      whole point of the head scripts is that they run *before the first
      paint*, which is a claim about time rather than about a value.

      `readystatechange` to "interactive" is the hook: it fires when the
      document has finished parsing and before deferred module scripts execute,
      so it is after the two blocking head scripts and before the bundle. A
      snapshot taken there is theirs alone.
    */
    document.addEventListener("readystatechange", () => {
      if (document.readyState !== "interactive" || window.__beforeReact) return;
      window.__beforeReact = {
        classes: [...document.documentElement.classList],
        colorScheme: document.documentElement.style.colorScheme,
        lang: document.documentElement.lang,
        dir: document.documentElement.dir,
      };
    });
  });
  await page.goto(`${ORIGIN}${pathname}`, { waitUntil: "load" });
  // The report is sent out of band; give it a moment to arrive before asking.
  await page.waitForTimeout(600);
  const state = await page.evaluate(() => ({
    violations: window.__cspViolations ?? [],
    // Everything the head scripts had done before the bundle ran. Empty when
    // they were blocked, which is the case this suite exists for.
    before: window.__beforeReact ?? { classes: [], colorScheme: "", lang: "", dir: "" },
    /*
      Which files the browser actually went and got.

      A script the policy refuses is never fetched, so it never appears here.
      That makes resource timing the exact evidence for "the entry chunk was
      allowed", and it is evidence that does not depend on whether the app then
      boots: the bundle reads VITE_SUPABASE_URL, which is a build-time value
      this repository does not set in CI, so "did the app mount" is a question
      about the build and belongs to viewport-test rather than here.
    */
    fetched: performance.getEntriesByType("resource").map((e) => new URL(e.name).pathname),
  }));
  violations.push(...state.violations);
  await page.close();
  return state;
}

section("The app comes up under the policy it will actually be served under");
{
  posted.length = 0;
  const home = await open("/");
  check(
    "nothing on the landing page is blocked",
    home.violations.length === 0,
    JSON.stringify(home.violations),
  );
  /*
    The two checks this suite was built for. A blocked inline script is
    invisible: no error, no log, nothing on the network. The only evidence it
    ran is the thing it did, so that is what is asked for.
  */
  check(
    "the theme was decided before the first paint",
    home.before.classes.includes("dark") || home.before.classes.includes("light"),
    JSON.stringify(home.before),
  );
  check(
    "and written where the stylesheet reads it",
    home.before.colorScheme === "dark" || home.before.colorScheme === "light",
    home.before.colorScheme,
  );
  const entry = readFileSync(path.join(dist, "index.html"), "utf8").match(/<script[^>]*\bsrc="(\/assets\/[^"]+)"/)?.[1];
  check("the built page loads an entry chunk at all", Boolean(entry), String(entry));
  check(
    "and the policy let the browser go and get it",
    home.fetched.includes(entry),
    JSON.stringify(home.fetched.slice(0, 6)),
  );
  check("no violation was reported, because there was none", posted.length === 0, JSON.stringify(posted.slice(0, 1)));

  posted.length = 0;
  const inside = await open("/privacy");
  check("nothing behind the login screen is blocked either", inside.violations.length === 0, JSON.stringify(inside.violations));
  /*
    The second before-paint script, on the one route that proves it ran.

    The document opens `lang="ar" dir="rtl"` — the landing page's first frame —
    and this script's whole job is to correct that for a screen written in
    something else. The privacy policy is such a screen and is deliberately not
    on `BILINGUAL`, so "English, left to right" here is a value only that script
    could have produced by the time the document finished parsing.
  */
  check(
    "the language was decided before the first paint",
    inside.before.lang === "en" && inside.before.dir === "ltr",
    JSON.stringify(inside.before),
  );
}

// ── and the proof that all of that can go red ────────────────────────────────

section("With the hashes taken out, every check above fails");
{
  policy = (enforcing?.value ?? "").replace(/'sha256-[^']+'\s*/g, "");
  posted.length = 0;
  const broken = await open("/");

  check("the browser blocks the inline scripts", broken.violations.length > 0, JSON.stringify(broken.violations));
  check(
    "and says which directive did it",
    broken.violations.every((v) => (v.directive ?? "").startsWith("script-src")),
    JSON.stringify(broken.violations.map((v) => v.directive)),
  );
  check(
    "the theme is not decided before the paint",
    !broken.before.classes.includes("dark") && !broken.before.classes.includes("light"),
    JSON.stringify(broken.before),
  );
  /*
    Which is the failure, said plainly: the app still mounts, React still sets
    the class a moment later, and what the person gets is a frame of the wrong
    theme with nothing logged anywhere on our side. That is the whole reason
    this suite measures the document *before* the bundle runs — after it, a
    blocked head script and a working one look identical.
  */
  check(
    "and nothing threw, which is why this was worth measuring",
    broken.violations.length > 0,
    JSON.stringify(broken.violations.map((v) => v.directive)),
  );

  // The endpoint, end to end, against a body a browser wrote rather than one
  // written here from the specification.
  check("the browser posted it to the report-uri", posted.length > 0);
  const first = posted[0];
  check(
    "as a content type the server's body parser accepts",
    /application\/(csp-report|reports\+json)/.test(first?.contentType ?? ""),
    first?.contentType,
  );
  /*
    Through the server's real body parsers, with the browser's real content
    type, because that is the step where this endpoint would have failed
    silently. `express.json()` matches `application/json` and nothing else; a
    browser sends a violation report as `application/csp-report`. Wired the
    obvious way, every report would have arrived with an empty body, been read
    as "no directive", and answered 204 - which is the same answer a report it
    accepted gets, so nothing anywhere would have looked wrong. The log would
    simply have stayed empty, which is indistinguishable from a policy that
    never fires.
  */
  const { bodyParsers } = await import(bundle("artifacts/api-server/src/lib/body-parsers.ts", "body-parsers.mjs"));
  const express = (await import(pathToFileURL(require.resolve("express", { paths: [path.join(repoRoot, "artifacts/api-server")] })).href)).default;

  async function bodyAfterParsing(handlers) {
    const app = express();
    for (const h of handlers) app.use(h);
    let seen;
    app.post(REPORT_PATH, (req, res) => { seen = req.body; res.status(204).end(); });
    const srv = app.listen(0, "127.0.0.1");
    await new Promise((r) => srv.once("listening", r));
    await fetch(`http://127.0.0.1:${srv.address().port}${REPORT_PATH}`, {
      method: "POST",
      headers: { "Content-Type": first?.contentType ?? "application/csp-report" },
      body: first?.raw ?? "{}",
    });
    await new Promise((r) => srv.close(r));
    return seen;
  }

  const throughServer = await bodyAfterParsing(bodyParsers());
  check(
    "the server's body parsers read a body sent as that content type",
    violationFrom(throughServer) !== null,
    JSON.stringify(throughServer),
  );
  // And the proof that the extra parser is doing the work, rather than being a
  // line that happens to sit beside one that already worked.
  const throughJsonOnly = await bodyAfterParsing([express.json()]);
  check(
    "and would not have, on express.json alone",
    violationFrom(throughJsonOnly) === null,
    JSON.stringify(throughJsonOnly),
  );

  const parsed = first ? violationFrom(JSON.parse(first.raw)) : null;
  check("and the route makes a violation out of it", parsed !== null, first?.raw?.slice(0, 200));
  check("naming script-src", (parsed?.directive ?? "").startsWith("script-src"), parsed?.directive);
  check("with the blocked resource as the browser's own word for it", parsed?.blocked === "inline", parsed?.blocked);
  check("and the page it happened on", parsed?.page === "/", parsed?.page);

  policy = enforcing?.value ?? "";
}

await browser.close();
await new Promise((r) => server.close(r));

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
