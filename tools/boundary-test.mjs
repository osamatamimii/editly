/**
 * Did the white screen actually go away.
 *
 * There was no error boundary anywhere in this app, so one exception thrown
 * while React rendered unmounted the whole tree and left a blank document.
 * Nothing was logged, because nothing on our side was involved, and nothing
 * distinguished "the app is broken" from "they closed the tab".
 *
 * A suite that read the source and found the words `ErrorBoundary` would prove
 * none of that. So this one **runs a real browser**: it mounts the real
 * component around a component that really throws, and reads what is on the
 * screen afterwards. A boundary that is imported and never wired, or wired and
 * rendering nothing, fails here and passes any check that reads a file.
 *
 * Three things it is built to catch:
 *
 *   **Coverage that looks like coverage.** A React boundary catches what is
 *   thrown during render and nothing else — not an event handler, not a timer,
 *   not a promise nobody awaited. In an app that spends its life waiting on
 *   uploads those are the common case, so both are triggered here and both
 *   have to be reported. And the rejection must *not* blank the screen: a
 *   failed background fetch is not a reason to unmount somebody's editor.
 *
 *   **A crash reporter that leaks.** The report is the message, the component
 *   and the pathname. A query string is where an OAuth code lives, so the page
 *   is loaded with one and the body is checked for it. So are the headers: no
 *   cookie, no Authorization.
 *
 *   **A public endpoint that trusts its input.** It is open by design, so a
 *   hostile body is the ordinary case rather than the exotic one: newlines
 *   that would forge a second log entry, a full URL where a path belongs,
 *   fields far past their ceiling.
 *
 * Usage: node tools/boundary-test.mjs
 * Requires: a browser Playwright can drive. No keys, no network, no database.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();

/*
  The scratch directories live inside the packages rather than in /tmp.

  Not a preference: esbuild resolves an import from the file that wrote it, and
  a bundle in /tmp has no `node_modules` above it, so `express` and `react`
  cannot be found from there. Both are cleaned up at the end, and neither is a
  path anything else in the repository reads.
*/
const buildDir = await mkdtemp(path.join(repoRoot, "artifacts/api-server/.boundary-"));
const appDir = await mkdtemp(path.join(repoRoot, "artifacts/editly/.boundary-"));

/*
  Placeholders, not credentials.

  The route imports the rate limiter, which imports the auth middleware, which
  refuses to load without a project URL to fetch a key set from. None of that is
  what is being tested here and none of it is ever called, but a module that
  throws at import is a module that cannot be imported at all — so the two names
  it looks for are given values that are obviously not secrets.
*/
/*
  And they are removed even when this file throws.

  A scratch directory inside a package is a directory that turns up in
  `git status` and, eventually, inside somebody's patch. The tidy-up at the
  bottom only runs when everything passed, which is exactly the case where it
  does not matter.
*/
process.on("exit", () => {
  for (const dir of [buildDir, appDir]) {
    try {
      require("node:fs").rmSync(dir, { recursive: true, force: true });
    } catch {
      /* nothing to do at exit but leave it */
    }
  }
});

process.env.SUPABASE_URL ??= "http://127.0.0.1:1/not-a-real-project";
process.env.SUPABASE_ANON_KEY ??= "anon-key-for-tests";
process.env.DATABASE_URL ??= "postgresql://postgres@127.0.0.1:1/none";

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

const esbuild = require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] });

// ── What the server keeps ───────────────────────────────────────────────────

section("A hostile report becomes something a log can hold");
{
  const outfile = path.join(buildDir, "client-errors.mjs");
  const built = spawnSync(
    esbuild,
    [
      path.join(repoRoot, "artifacts/api-server/src/routes/client-errors.ts"),
      "--bundle", "--platform=node", "--format=esm", "--target=node22",
      // Dependencies stay as imports: bundling express into ESM turns its own
      // `require("tty")` into a throw, and none of it is what is being tested.
      "--packages=external",
      `--outfile=${outfile}`, "--log-level=error",
    ],
    { stdio: "inherit" },
  );
  if (built.status !== 0) process.exit(1);
  const { crashFrom, pathOnly } = await import(pathToFileURL(outfile).href);

  const ordinary = crashFrom({
    kind: "render",
    message: "Cannot read properties of undefined",
    component: "ProjectEditor",
    path: "/project/abc",
    reference: "A1B2C3",
  });
  check("an ordinary report survives intact", ordinary?.message === "Cannot read properties of undefined");
  check("with the component that threw", ordinary?.component === "ProjectEditor");
  check("and the reference somebody can quote", ordinary?.reference === "A1B2C3");

  /*
    The one that matters most on a public endpoint. A log is read by eye as
    often as it is parsed, and a report that can put a newline in it can write
    a second entry underneath its own that nobody wrote.
  */
  const forged = crashFrom({ message: 'oops"}\n{"level":50,"msg":"database on fire' });
  check(
    "a report cannot forge a second log line",
    forged !== null && !forged.message.includes("\n"),
    JSON.stringify(forged?.message),
  );

  check("a message that is only whitespace is not a report", crashFrom({ message: "   " }) === null);
  check("and neither is no message at all", crashFrom({ component: "X" }) === null);
  check("nor a body that is not an object", crashFrom("hello") === null && crashFrom(null) === null);

  const long = crashFrom({ message: "x".repeat(5000), component: "y".repeat(5000) });
  check("fields are cut on the server, not trusted from the browser", long.message.length === 300 && long.component.length === 300);

  const madeUp = crashFrom({ message: "m", kind: "somethingElse" });
  check("a kind nobody defined is read as a render crash", madeUp.kind === "render", madeUp.kind);

  /*
    The path is where a secret would ride in. An OAuth failure puts a code in
    the query string, and a crash reporter is the last thing that should copy
    one into a log.
  */
  check("a query string never reaches the log", pathOnly("/login?code=SECRET&state=X") === "/login");
  check("nor does a fragment", pathOnly("/project/1#token=SECRET") === "/project/1");
  check("a full URL is reduced to its path", pathOnly("https://evil.test/x?y=1").startsWith("/"));
  check("and something that is not a path at all becomes one", pathOnly(42) === "/");
}

// ── The route, over HTTP ────────────────────────────────────────────────────

section("The endpoint answers the same thing to everybody");
{
  const serverFile = path.join(buildDir, "server.mjs");
  await writeFile(
    serverFile,
    `import express from "express";\n` +
      `import router from ${JSON.stringify(pathToFileURL(path.join(buildDir, "client-errors.mjs")).href)};\n` +
      `const app = express();\napp.use(express.json());\napp.use("/api", router);\n` +
      `app.listen(4319, "127.0.0.1", () => console.log("listening"));\n`,
  );
  const { spawn } = await import("node:child_process");
  const child = spawn("node", [serverFile], {
    cwd: repoRoot,
    env: { ...process.env, NODE_ENV: "production", LOG_LEVEL: "warn" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const said = [];
  child.stdout.on("data", (d) => said.push(...String(d).split("\n").filter(Boolean)));
  child.stderr.on("data", (d) => said.push(...String(d).split("\n").filter(Boolean)));
  const up = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 10_000);
    const watch = setInterval(() => {
      if (said.some((l) => l.includes("listening"))) {
        clearInterval(watch);
        clearTimeout(timer);
        resolve(true);
      }
    }, 100);
  });
  check("the route mounts and listens", up, said.slice(-3).join(" | "));

  const post = (body) =>
    fetch("http://127.0.0.1:4319/api/client-errors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  if (up) {
    const good = await post({ message: "Cannot read properties of undefined", path: "/login?code=SECRET" });
    check("a real report is taken", good.status === 204, String(good.status));
    const junk = await post({ nothing: true });
    /*
      The same answer to a report it threw away. An endpoint that distinguishes
      them is a probe: with no token in front of it, a different status code is
      the one bit of information a stranger could ask it for repeatedly.
    */
    check("and so is a report it discarded", junk.status === 204, String(junk.status));

    await new Promise((r) => setTimeout(r, 300));
    const logged = said.filter((l) => l.includes("a browser reported a crash"));
    check("the good one reached the log", logged.length === 1, `${logged.length} lines`);
    check(
      "the discarded one did not",
      logged.length === 1,
      "an endpoint that logs everything it is sent is a log anybody can fill",
    );
    check(
      "and the secret in the query string is nowhere in it",
      !said.some((l) => l.includes("SECRET")),
      said.filter((l) => l.includes("SECRET")).join(" | "),
    );
  }
  child.kill("SIGKILL");
}

// ── The screen ──────────────────────────────────────────────────────────────

section("A component that throws does not leave a white page");
{
  /*
    Resolved the way `browser-test` resolves it, including the global path some
    runners install into. A suite that silently skips the only part of itself
    that measures the screen is a suite that passes while the feature is gone,
    so a missing browser is a failure here rather than a note.
  */
  let chromium = null;
  try {
    ({ chromium } = require(
      require.resolve("playwright", {
        paths: [`${process.env.HOME}/.npm-global/lib/node_modules`, repoRoot],
      }),
    ));
  } catch {
    chromium = null;
  }
  if (!chromium) {
    console.log("  … Playwright is not installed, so the screen itself was not measured");
    check("a browser was available to measure the screen", false, "install playwright");
  } else {
    const entry = path.join(appDir, "crash-app.tsx");
    await writeFile(
      entry,
      `import { createRoot } from "react-dom/client";\n` +
        `import { useState, useEffect } from "react";\n` +
        `import { ErrorBoundary, watchForCrashes } from ${JSON.stringify(path.join(repoRoot, "artifacts/editly/src/components/error-boundary"))};\n` +
        `function Bomb({ armed }) {\n` +
        `  if (armed) throw new Error("the editor exploded");\n` +
        `  return <p data-testid="alive">the app is fine</p>;\n` +
        `}\n` +
        `function Harness() {\n` +
        `  const [armed, setArmed] = useState(false);\n` +
        `  useEffect(() => watchForCrashes(), []);\n` +
        `  return (\n` +
        `    <ErrorBoundary>\n` +
        `      <button data-testid="throw" onClick={() => setArmed(true)}>throw</button>\n` +
        `      <button data-testid="reject" onClick={() => { Promise.reject(new Error("a fetch gave up")); }}>reject</button>\n` +
        `      <Bomb armed={armed} />\n` +
        `    </ErrorBoundary>\n` +
        `  );\n` +
        `}\n` +
        `createRoot(document.getElementById("root")).render(<Harness />);\n`,
    );
    const bundle = path.join(appDir, "crash-app.js");
    const madeApp = spawnSync(
      esbuild,
      [
        entry, "--bundle", "--platform=browser", "--format=iife", "--target=es2020",
        "--jsx=automatic", `--outfile=${bundle}`, "--log-level=error",
      ],
      { cwd: path.join(repoRoot, "artifacts/editly"), stdio: "inherit" },
    );
    if (madeApp.status !== 0) {
      check("the harness builds against the real component", false, "esbuild refused it");
    } else {
      const reports = [];
      const server = http.createServer((req, res) => {
        if (req.url.startsWith("/api/client-errors")) {
          let body = "";
          req.on("data", (c) => (body += c));
          req.on("end", () => {
            reports.push({ headers: req.headers, body: (() => { try { return JSON.parse(body); } catch { return null; } })() });
            res.writeHead(204).end();
          });
          return;
        }
        if (req.url.endsWith(".js")) {
          res.writeHead(200, { "content-type": "text/javascript" });
          res.end(require("node:fs").readFileSync(bundle));
          return;
        }
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><html><body><div id="root"></div><script src="/crash-app.js"></script></body></html>`);
      });
      await new Promise((r) => server.listen(4320, "127.0.0.1", r));

      const exe = ["/opt/pw-browsers/chromium", process.env.CHROMIUM_PATH].find((p) => p && existsSync(p));
      const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), args: ["--no-sandbox"] });
      const page = await browser.newPage();
      // A query string, because that is where a secret would be.
      await page.goto("http://127.0.0.1:4320/project/abc?code=SECRET-CODE", { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-testid="alive"]');

      // ── The rejection first: it must report and must not blank the app ────
      await page.getByTestId("reject").click();
      await page.waitForTimeout(400);
      const rejection = reports.find((r) => r.body?.kind === "promise");
      check("an unhandled rejection is reported, which a boundary would never see", Boolean(rejection), JSON.stringify(reports.map((r) => r.body?.kind)));
      check("with what it was", /gave up/.test(rejection?.body?.message ?? ""), rejection?.body?.message);
      check(
        "and it does not blank the app, because a failed fetch is not a crash",
        (await page.getByTestId("alive").count()) === 1,
        "a boundary that unmounted on every rejection would be worse than the bug it fixed",
      );

      // ── Then the render throw ─────────────────────────────────────────────
      await page.getByTestId("throw").click();
      await page.waitForSelector('[data-testid="crash-screen"]', { timeout: 5000 }).catch(() => {});

      const text = (await page.locator("body").innerText()).replace(/\s+/g, " ").trim();
      check("the page is not blank", text.length > 20, JSON.stringify(text.slice(0, 80)));
      check("it says the screen stopped rather than nothing at all", /stopped working/i.test(text), text.slice(0, 100));
      check("it shows what actually broke", /the editor exploded/.test(text), text.slice(0, 160));
      check("there is a way to try again", (await page.getByTestId("crash-reload").count()) === 1);
      const shown = await page.getByTestId("crash-reference").innerText().catch(() => "");
      check("and a reference somebody can quote", /^[A-Z0-9]{4,8}$/.test(shown.trim()), shown);

      const crash = reports.find((r) => r.body?.kind === "render");
      check("the crash was reported to our own API", Boolean(crash), JSON.stringify(reports.map((r) => r.body?.kind)));
      check("naming the component that threw", /Bomb/.test(crash?.body?.component ?? ""), crash?.body?.component);
      check("with the same reference the person can see", crash?.body?.reference === shown.trim(), `${crash?.body?.reference} vs ${shown}`);
      check("and the path", crash?.body?.path === "/project/abc", crash?.body?.path);
      /*
        The whole privacy rule in one assertion: the page was loaded with a
        secret in its query string, and nothing about the report may contain it.
      */
      check(
        "no query string travels with a crash report",
        reports.every((r) => !JSON.stringify(r.body).includes("SECRET-CODE")),
        JSON.stringify(reports.map((r) => r.body?.path)),
      );
      check(
        "and the report carries no credential of the person's",
        reports.every((r) => !r.headers.cookie && !r.headers.authorization),
        JSON.stringify(reports.map((r) => Object.keys(r.headers))),
      );

      await browser.close();
      server.close();
    }
  }
}

// ── The wiring ──────────────────────────────────────────────────────────────

section("And it is wrapped around the real app, not only around the harness");
{
  const { readFileSync } = await import("node:fs");
  const app = readFileSync(path.join(repoRoot, "artifacts/editly/src/App.tsx"), "utf8");
  check("the app is inside a boundary", /<ErrorBoundary>/.test(app));
  /*
    Outside the providers, and that is the point of checking the order rather
    than the presence. A boundary *inside* the query client and the theme
    provider cannot catch a crash in either of them, and those are exactly the
    two that run on every screen.
  */
  check(
    "and the boundary is outside the providers, so it can catch them too",
    app.indexOf("<ErrorBoundary>") < app.indexOf("<QueryClientProvider"),
    "a boundary inside the providers cannot catch the providers",
  );
  check("and the two listeners a boundary cannot see are installed", /watchForCrashes\(\)/.test(app));
}

await rm(buildDir, { recursive: true, force: true });
await rm(appDir, { recursive: true, force: true });
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("A crash has a screen, a reference, and a line in our log.");
