/**
 * The things that only ever fail on deploy day.
 *
 * The worker is the half of this product that does the work, and it has never
 * been deployed — it is waiting on secrets only the owner can set. Which means
 * the first run of `.github/workflows/deploy-worker.yml` will happen on a day
 * when somebody is trying to get the product working, and every mistake in it
 * will cost a round trip through a CI queue to discover.
 *
 * Most of those mistakes are not code. They are a secret named one thing in the
 * workflow and read as another in the worker; a path in the Dockerfile that no
 * longer matches what the build writes; an app name that differs by a hyphen. A
 * deploy that fails loudly is the good case. The bad case is the one this
 * repository has already lived through twice now: it succeeds, and quietly does
 * less than it says.
 *
 * None of this needs Docker, Fly, or a single credential. It reads the files
 * that will be executed and checks they agree with each other and with the code.
 *
 * Usage: node tools/deploy-test.mjs
 */
import { readFileSync, existsSync, readdirSync, mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = process.cwd();
const read = (p) => readFileSync(path.join(repoRoot, p), "utf8");

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

const workflow = read(".github/workflows/deploy-worker.yml");
const checksWorkflow = read(".github/workflows/checks.yml");
const dockerfile = read("artifacts/worker/Dockerfile");
const flyToml = read("artifacts/worker/fly.toml");
const buildScript = read("artifacts/worker/build.mjs");
const dockerignore = read(".dockerignore");

// ─── The names have to match on both sides ───────────────────────────────────

section("Every variable the worker reads is one the deploy actually sets");
{
  // Read out of the worker's own source rather than from a list here, because a
  // list here is the same forgetting one file further away.
  const workerSource = readdirSync(path.join(repoRoot, "artifacts/worker/src"), { recursive: true })
    .filter((f) => typeof f === "string" && f.endsWith(".ts"))
    .map((f) => read(path.join("artifacts/worker/src", f)))
    .join("\n");

  // The three ways this code actually reaches the environment. Matching only
  // `process.env["X"]` missed two of them — `requireEnv("SUPABASE_URL")` in
  // storage.ts and the `ProviderEnv` interface, which is literally the
  // declaration of what the provider layer reads — and a check that misses the
  // real patterns passes for the wrong reason. Sweeping every SCREAMING_SNAKE
  // name instead was worse: it dragged in ordinary constants like WORKER_ID and
  // demanded the deploy set them.
  const referenced = new Set([
    ...[...workerSource.matchAll(/process\.env\[["']([A-Z][A-Z0-9_]*)["']\]/g)].map((m) => m[1]),
    ...[...workerSource.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]),
    ...[...workerSource.matchAll(/requireEnv\(["']([A-Z][A-Z0-9_]*)["']\)/g)].map((m) => m[1]),
    ...[...(workerSource.match(/interface ProviderEnv \{[^}]*\}/s)?.[0] ?? "")
      .matchAll(/^\s*([A-Z][A-Z0-9_]*)\??:/gm)].map((m) => m[1]),
  ]);

  check("the worker reads some environment at all", referenced.size >= 4, JSON.stringify([...referenced]));

  // Two kinds are not the deploy's business. Tuning knobs with sane defaults —
  // the image sets what it needs and the code defaults the rest — and the
  // locations of binaries, which exist so a developer can point at a homebrew
  // ffmpeg and which the container has on PATH.
  const notSecrets = new Set([
    "NODE_ENV", "LOG_LEVEL", "POLL_INTERVAL_MS", "STALE_LOCK_MINUTES",
    // How long a provider gets to answer before the request is abandoned. A
    // knob, not a credential: the default exists so that a hung socket cannot
    // hold a render machine forever, and nobody has to set it for that.
    "PROVIDER_TIMEOUT_MS",
    "GEMINI_MEDIA_RESOLUTION", "TMPDIR",
    "DEEPGRAM_MODEL", "ELEVENLABS_MODEL", "GEMINI_MODEL",
    "FFMPEG_PATH", "FFPROBE_PATH", "PYTHON_PATH", "SUBJECT_SCRIPT",
    // Where the browser that draws the titles lives. The image sets it; a
    // developer points it at whatever Chromium they already have. A path, and
    // paths are the other thing on this list.
    "CHROMIUM_PATH",
  ]);

  const mustBeDeployed = [...referenced].filter((name) => !notSecrets.has(name)).sort();
  const missing = mustBeDeployed.filter((name) => !workflow.includes(name));

  check(
    "and the workflow knows about every one that carries a value",
    missing.length === 0,
    missing.join(", "),
  );

  // DATABASE_URL is read by lib/db, not by the worker's own source, and losing
  // it is the difference between a worker and a process that exits at import.
  check("including DATABASE_URL, which lives one package away", /DATABASE_URL/.test(workflow));

  for (const required of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "DATABASE_URL"]) {
    check(
      `${required} is pushed unconditionally, not behind a guard`,
      new RegExp(`^\\s*${required}="\\$${required}"`, "m").test(workflow),
      "it is optional in the script, which would deploy a worker that cannot start",
    );
  }

  // Anything the workflow sends that nothing reads is either a rename that went
  // half-done or a secret being handled for no reason.
  const sent = [...workflow.matchAll(/^\s+([A-Z][A-Z0-9_]*): \$\{\{ secrets\./gm)].map((m) => m[1]);
  const unread = sent.filter((name) => name !== "FLY_API_TOKEN" && !referenced.has(name) && name !== "DATABASE_URL");
  check("and nothing is pushed that nothing reads", unread.length === 0, unread.join(", "));
}

// ─── The step that runs on a machine nobody is watching ──────────────────────

section("The secrets step survives the case it was written for");
{
  // Optional keys are the *expected* state — the product is documented as
  // working without them. A `set -e` script that aborts when one is absent
  // fails the deploy for the configuration everybody starts with, and the error
  // would point at the last line that ran rather than at the guard.
  const step = workflow.split("Push runtime secrets")[1] ?? "";
  const body = step.slice(step.indexOf("run: |") + "run: |".length, step.indexOf("        env:"));
  const script = body
    .split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n");

  check("the step was found and is not empty", script.includes("flyctl secrets set"), script.slice(0, 120));

  const stubDir = mkdtempSync(path.join(tmpdir(), "editly-deploy-"));
  const record = path.join(stubDir, "called.txt");
  const stub = path.join(stubDir, "flyctl");
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" >> "${record}"\n`);
  chmodSync(stub, 0o755);

  const runScript = (env) =>
    spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: {
        PATH: `${stubDir}:${process.env.PATH}`,
        DATABASE_URL: "postgres://required",
        SUPABASE_URL: "https://required",
        SUPABASE_SERVICE_ROLE_KEY: "required",
        ...env,
      },
    });

  const bare = runScript({});
  check(
    "with no optional keys — the documented starting point — it succeeds",
    bare.status === 0,
    (bare.stderr || "").slice(0, 200),
  );
  const bareArgs = existsSync(record) ? readFileSync(record, "utf8") : "";
  check("and reaches flyctl", bareArgs.includes("secrets"), bareArgs.slice(0, 200));
  check(
    "sending the three the worker cannot run without",
    ["DATABASE_URL=", "SUPABASE_URL=", "SUPABASE_SERVICE_ROLE_KEY="].every((k) => bareArgs.includes(k)),
    bareArgs,
  );
  check(
    "and not an empty one, which would read as configured while behaving as absent",
    !/DEEPGRAM_API_KEY=\s*$/m.test(bareArgs) && !bareArgs.includes("DEEPGRAM_API_KEY="),
    bareArgs,
  );

  writeFileSync(record, "");
  const full = runScript({
    DEEPGRAM_API_KEY: "dg", ELEVENLABS_API_KEY: "el", GEMINI_API_KEY: "gm",
  });
  check("with every key present it also succeeds", full.status === 0, (full.stderr || "").slice(0, 200));
  const fullArgs = readFileSync(record, "utf8");
  for (const key of ["DEEPGRAM_API_KEY=dg", "ELEVENLABS_API_KEY=el", "GEMINI_API_KEY=gm"]) {
    check(`and passes ${key.split("=")[0]} through`, fullArgs.includes(key), fullArgs);
  }
  check(
    "staged rather than applied, so the deploy that follows is the thing that restarts it",
    fullArgs.includes("--stage"),
    fullArgs,
  );
}

// ─── The paths three files have to agree about ───────────────────────────────

section("The image runs the file the build writes");
{
  const outfile = buildScript.match(/outfile:\s*path\.join\(dir,\s*"([^"]+)"\)/)?.[1];
  check("the build names its output", outfile === "dist/index.mjs", String(outfile));

  const cmd = dockerfile.match(/^CMD \[(.+)\]$/m)?.[1] ?? "";
  check("and the image's CMD runs exactly that", cmd.includes('"dist/index.mjs"'), cmd);

  const process_ = flyToml.match(/^\s*worker = "(.+)"$/m)?.[1] ?? "";
  check("as does the process fly.toml defines", process_.includes("dist/index.mjs"), process_);
  check(
    "and the two commands are the same, so a local run is the deployed run",
    cmd.replace(/["\s]/g, "").split(",").join(" ").trim() === process_.replace(/\s+/g, " ").trim(),
    `${cmd} vs ${process_}`,
  );

  check(
    "the runtime stage copies the build's output and nothing else",
    /COPY --from=build \/repo\/artifacts\/worker\/dist \.\/dist/.test(dockerfile),
  );

  // The tracker is Python, so esbuild cannot bundle it, and `subject.ts`
  // resolves it beside the bundle. Losing it breaks nothing loudly — framing
  // just silently goes back to the centre of the frame for every clip.
  check(
    "the Python tracker is copied beside the bundle at build time",
    /copyFile\(/.test(buildScript) && /track-subject\.py/.test(buildScript),
  );
  check(
    "and the runtime has a Python to run it with",
    /python3/.test(dockerfile) && /opencv-python-headless/.test(dockerfile),
  );
  check(
    "with the face cascade proven at build time rather than on the first render",
    /CascadeClassifier/.test(dockerfile),
  );
}

section("The app the workflow talks to is the app fly.toml describes");
{
  const flyApp = flyToml.match(/^app = "(.+)"$/m)?.[1];
  const workflowApps = [...workflow.matchAll(/--app (\S+)/g)].map((m) => m[1]);
  const created = workflow.match(/flyctl apps create (\S+)/)?.[1];

  check("fly.toml names an app", typeof flyApp === "string" && flyApp.length > 0, String(flyApp));
  check(
    "and every --app in the workflow is that one",
    workflowApps.length > 0 && workflowApps.every((a) => a === flyApp),
    JSON.stringify(workflowApps),
  );
  check("as is the one it creates if missing", created === flyApp, String(created));
  check(
    "the config is deployed by path, since the workflow runs from the repo root",
    /--config artifacts\/worker\/fly\.toml/.test(workflow),
  );
}

section("The build context is the repo root, and does not carry the repo's build output");
{
  check(
    "the Dockerfile copies the whole workspace, because pnpm verifies the lockfile against every importer",
    /^COPY \. \.$/m.test(dockerfile),
  );
  for (const excluded of ["node_modules", "dist", ".git"]) {
    check(
      `.dockerignore keeps ${excluded} out of the context`,
      new RegExp(`^\\*?\\*?/?${excluded.replace(".", "\\.")}$`, "m").test(dockerignore),
    );
  }
  check(
    "the image enables corepack, since the install relies on the pinned pnpm",
    /corepack enable/.test(dockerfile),
  );
  check(
    "and the root package.json pins it",
    /"packageManager":\s*"pnpm@/.test(read("package.json")),
  );
}

/*
  The caption face ships as a file, and three places have to agree about it.

  Every Latin caption is drawn in Montserrat Black, and `caption-layout.ts`
  converts a cap height into a nominal size through a ratio measured from a
  *specific cut* of it. That is why the font is in the repository rather than
  installed from a package: an archive holds whatever revision it holds on the
  day an image is built, and a differently proportioned cut breaks nothing — it
  just renders every caption in the product at the wrong size.

  So the file has to exist, the image has to copy it, and the runner that
  measures captions in pixels has to install the same bytes. Any one of those
  three drifting is a green suite about a font production does not ship.
*/
section("The caption face is a file, and everything that draws with it uses that file");
{
  const font = "artifacts/worker/fonts/Montserrat-Black.otf";
  check("the font is in the repository", existsSync(path.join(repoRoot, font)));
  check(
    "the licence travels with it, because the OFL requires that",
    existsSync(path.join(repoRoot, "artifacts/worker/fonts/Montserrat-OFL.txt")),
  );
  check("the image copies it in", new RegExp(`COPY ${font.replace(/[/.]/g, "\\$&")}`).test(dockerfile));
  check(
    "and rebuilds the font cache, so the family resolves in the same layer",
    /fc-cache/.test(dockerfile),
  );
  check(
    "the image does not also install it from a package, which would be two fonts with one name",
    !/fonts-montserrat/.test(dockerfile),
  );
  check(
    "the suites measure the same file the image ships",
    new RegExp(font.replace(/[/.]/g, "\\$&")).test(read(".github/workflows/checks.yml")),
    // A runner carrying a package of the same name would measure a different
    // cut, and every caption check would be green about the wrong thing.
    "",
  );
  check(
    "and the image proves the face resolved, because a missing font draws the fallback in silence",
    /Montserrat Black measures exactly as DejaVu Sans/.test(dockerfile),
  );
}

section("A change that affects the worker triggers a deploy");
{
  // A path filter that misses a dependency is a worker running last month's
  // code with this month's database — and nothing says so.
  const paths = [...workflow.matchAll(/^\s+- "([^"]+)"$/gm)].map((m) => m[1]);
  check("the workflow filters on paths at all", paths.length > 0, JSON.stringify(paths));

  const covered = (dep) => paths.some((p) => dep.startsWith(p.replace(/\/\*\*$/, "")));
  const workspaceDeps = Object.keys(
    JSON.parse(read("artifacts/worker/package.json")).dependencies ?? {},
  ).filter((name) => name.startsWith("@workspace/"));

  check("the worker depends on workspace packages", workspaceDeps.length > 0, JSON.stringify(workspaceDeps));
  const uncovered = workspaceDeps
    .map((name) => `lib/${name.replace("@workspace/", "")}/`)
    .filter((dir) => !covered(dir));
  check(
    "and a change in any of them redeploys the worker",
    uncovered.length === 0,
    `${uncovered.join(", ")} — a change there would leave the worker running older code`,
  );
  check("as does a lockfile change", paths.includes("pnpm-lock.yaml"));
  check("and a change to the workflow itself", paths.some((p) => p.includes("deploy-worker.yml")));
  check(
    "it can also be run by hand, which is how the first deploy happens",
    /workflow_dispatch/.test(workflow),
  );
  check(
    "and two deploys never race",
    /concurrency:/.test(workflow) && /cancel-in-progress: false/.test(workflow),
  );
}

// ─── The checks that check nothing unless something runs them ────────────────

section("Every suite in tools/ is one CI actually runs");
{
  // A suite nobody runs is a suite that rots. This repository has already
  // watched that happen at every other level — a spec that drifted for months,
  // migrations nobody applied, a health check that returned a constant — and
  // the checks themselves are not exempt. Globbing the directory in the
  // workflow would make this check impossible, which is why they are listed.
  const suites = readdirSync(path.join(repoRoot, "tools"))
    .filter((f) => f.endsWith("-test.mjs"))
    .sort();

  check("there are suites to run", suites.length >= 15, String(suites.length));

  const unrun = suites.filter((f) => !checksWorkflow.includes(`tools/${f}`));
  check(
    "and CI runs every one of them",
    unrun.length === 0,
    `${unrun.join(", ")} — added and never wired in, which is a suite that exists and does nothing`,
  );

  const phantom = [...checksWorkflow.matchAll(/node tools\/(\S+\.mjs)/g)]
    .map((m) => m[1])
    .filter((f) => !existsSync(path.join(repoRoot, "tools", f)));
  check("and runs nothing that does not exist", phantom.length === 0, phantom.join(", "));

  // Renaming a suite is the usual way this breaks, and a workflow step that
  // silently succeeds on a missing file is how it stays broken.
  check(
    "each suite is its own step, so the one that fails is named",
    (checksWorkflow.match(/^ {6}- run: node tools\//gm) ?? []).length === suites.length,
    `${(checksWorkflow.match(/^ {6}- run: node tools\//gm) ?? []).length} steps for ${suites.length} suites`,
  );
}

section("CI has what the suites need");
{
  check("a Postgres of the major production runs", /image: postgres:16/.test(checksWorkflow));
  /**
   * And it builds the thing Vercel builds.
   *
   * `typecheck` proves the types agree; it does not prove the bundle can be
   * assembled. A vite plugin, an import that resolves for tsc and not for
   * esbuild, an asset path that exists only in dev — each passes every other
   * check in the file and fails at deploy. And a failed Vercel deploy is quiet
   * in the worst way: production keeps serving the previous commit, so `main`
   * is green, the dashboard says shipped, and the change is not live.
   */
  check(
    "and builds the deployable, not only the types",
    /pnpm run vercel:build/.test(checksWorkflow),
    "typecheck passing is not the bundle assembling, and the difference is only ever found at deploy",
  );
  check(
    "built by the migrations, not by drizzle-kit push",
    /pnpm run migrate/.test(checksWorkflow) && !/drizzle-kit push/.test(checksWorkflow),
  );
  // Three migrations name things only a managed Supabase provides. Without the
  // shim the very first one fails, and it reads as a broken migration rather
  // than a missing prerequisite.
  check(
    "with the Supabase stand-in applied first",
    checksWorkflow.indexOf("supabase-shim.sql") < checksWorkflow.indexOf("pnpm run migrate"),
    "the shim comes after the migrations, so the migrations cannot run",
  );
  check(
    "and it is the same file the schema suite uses, not a copy",
    /supabase-shim\.sql/.test(read("tools/schema-test.mjs")),
  );
  check(
    "psql stops on the first error rather than carrying on",
    /ON_ERROR_STOP=1/.test(checksWorkflow),
  );
  check("ffmpeg, for every render check", /\bffmpeg\b/.test(checksWorkflow));
  check(
    "the font drawtext names, without which the watermark renders as nothing at all",
    /fonts-dejavu-core/.test(checksWorkflow),
  );
  check(
    "OpenCV, so the tracking section runs instead of skipping itself",
    /python3-opencv/.test(checksWorkflow),
  );
  check("and a Chromium for the browser suite", /playwright install chromium/.test(checksWorkflow));

  // The browser suite resolves Playwright from the repository, so it has to be
  // declared there rather than assumed present on whoever's machine.
  const rootPackage = JSON.parse(read("package.json"));
  check(
    "Playwright is a declared dependency rather than a machine's happy accident",
    Boolean(rootPackage.devDependencies?.playwright),
    JSON.stringify(rootPackage.devDependencies),
  );

  check("it typechecks before it runs anything", /pnpm run typecheck/.test(checksWorkflow));
  check("and it runs on pull requests, not only on main", /pull_request/.test(checksWorkflow));
}

section("The waiting-list page can actually reach the API");
{
  // This page is the one part of the product served from a different origin
  // than the API it calls, which makes it the one part where a browser can
  // refuse the request for a reason no server log records. A CORS failure is
  // invisible from our side: the API never sees the call, the page shows its
  // "could not reach us" branch, and every sign-up is silently lost. So the
  // two ends are checked against each other here rather than trusted to stay
  // in step.
  const page = read("artifacts/waitlist/index.html");
  // The allowlist moved out of `app.ts` into its own module the day it was
  // first tested — a decision that can only be exercised by standing up Express
  // is a decision nobody exercises. This reads where it lives now.
  const app = read("artifacts/api-server/src/lib/allowed-origins.ts");

  const apiUrl = /var API = "([^"]+)"/.exec(page)?.[1] ?? "";
  check("the page names an absolute API endpoint", /^https:\/\/\S+\/api\/waitlist$/.test(apiUrl), apiUrl);

  // Not a *.vercel.app host. That hostname is derived from the project name,
  // so renaming the project in the dashboard — a thing with no other
  // consequence — would point this page at nothing, and the only symptom
  // would be a sign-up form that quietly stopped working.
  check(
    "on a domain we own rather than one the platform generated",
    /^https:\/\/[a-z0-9.-]*editlyai\.io\//.test(apiUrl),
    apiUrl,
  );

  // The origins the page is *served* from are what CORS actually turns on, and
  // they are not the same string as the one above.
  for (const origin of ["https://editlyai.io", "https://www.editlyai.io"]) {
    check(`the API allows ${origin} to call it`, app.includes(`"${origin}"`), "missing from the allowlist in lib/allowed-origins.ts");
  }

  // And the route it calls has to be the one that needs no bearer token: this
  // page has no session and never will.
  check(
    "the route it calls is the one public write there is",
    /\/api\/waitlist$/.test(apiUrl) && existsSync(path.join(repoRoot, "artifacts/api-server/src/routes/waitlist.ts")),
    apiUrl,
  );
}

/**
 * The thing that looks when nobody is looking.
 *
 * On 12 August the render worker stopped and the outage ran for two days. The
 * API was fine throughout — nothing was wrong with the API — so every check
 * anybody had read green while no render on the platform could start. The
 * watch workflow exists so that never depends on somebody choosing to look.
 *
 * A monitor is the easiest thing in a repository to break silently: rename the
 * field it reads and it passes forever, cheerfully, on a dead platform. So this
 * asserts the *join* — that the name the workflow greps for is the name the API
 * actually emits — rather than that the file exists.
 */
console.log("\nThe platform watches itself");
{
  const watch = read(".github/workflows/watch.yml");
  const health = read("artifacts/api-server/src/routes/health.ts");
  const contract = read("lib/api-zod/src/index.ts");

  check("there is a watch workflow", watch.length > 0);
  check(
    "it runs on a schedule rather than when somebody remembers",
    /on:[\s\S]*?schedule:[\s\S]*?cron:/.test(watch),
    "a monitor nobody triggers is a monitor nobody has",
  );
  /**
   * Read as minutes rather than as a spelling.
   *
   * The first version of this check matched a `slash-15` spelling literally,
   * which asserted
   * the *syntax somebody happened to write* rather than the property that
   * matters — and it went red the moment the schedule was offset off the
   * quarter hours for a real reason. A check that breaks when correct code is
   * rewritten is a check on the author, not on the product. So the minute field
   * is expanded and the widest gap between two runs is what gets asserted.
   */
  const minuteField = /cron:\s*"([^"]+?) \* \* \* \*"/.exec(watch)?.[1] ?? "";
  const minutes = minuteField.startsWith("*/")
    ? Array.from({ length: Math.ceil(60 / Number(minuteField.slice(2))) }, (_, i) => i * Number(minuteField.slice(2)))
    : minuteField.split(",").map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const widestGap = minutes.length
    ? Math.max(...minutes.map((m, i) => (i === 0 ? m + 60 - minutes[minutes.length - 1] : m - minutes[i - 1])))
    : Infinity;
  check(
    "often enough that nothing is dead for an afternoon",
    minutes.length > 0 && widestGap <= 60,
    `minutes ${JSON.stringify(minutes)} — widest gap ${widestGap}`,
  );
  /**
   * And a trigger that does not depend on GitHub's scheduler.
   *
   * The schedule is the one that matters and the one that could not be observed
   * working: four hours on the default branch with a quarter-hourly cron and
   * not a single run, while push-triggered workflows went through the whole
   * time. GitHub documents the schedule event as delayed under load and
   * promises nothing, so a monitor that hangs off it alone is a monitor that
   * may never have run — the exact silence it was built to end.
   *
   * So there is a second trigger, and it is one this repository has watched
   * work: every push runs Checks, and this runs when Checks finishes. It cannot
   * notice a quiet outage. It does mean every change to the product is followed
   * within the minute by an answer to whether a render machine is listening.
   */
  check(
    "and a trigger that does not depend on the scheduler at all",
    /workflow_run:/.test(watch) && /workflows:\s*\["Checks"\]/.test(watch),
    "a monitor with only a schedule is a monitor that may never have run",
  );
  /**
   * And off the quarter hours.
   *
   * GitHub runs scheduled workflows on a shared pool and drops or delays them
   * when it is busy, and the busiest minutes on that pool by a wide margin are
   * :00, :15, :30 and :45 — where every quarter-hour cron in the world lands.
   * A monitor
   * whose own schedule is quietly skipped is the failure it exists to catch,
   * one level up.
   */
  check(
    "and off the minutes every other repository asks for",
    minutes.every((m) => m % 15 !== 0),
    `minutes ${JSON.stringify(minutes)}`,
  );
  check("and by hand when somebody wants to ask now", /workflow_dispatch:/.test(watch));

  check(
    "it asks the deployment the product actually runs on",
    watch.includes("https://app.editlyai.io/api/healthz"),
    "a monitor pointed at the wrong host is a monitor of the wrong thing",
  );

  // The join, and the whole point of this section: the field the workflow reads
  // has to be the field the server sends. Rename one without the other and the
  // alert goes quiet rather than loud, which is the failure mode that matters.
  check(
    "it reads whether a render machine is listening",
    /\.worker\.online/.test(watch),
    "checking only that the API answers is checking the half that was never broken",
  );
  check(
    "and the server sends that field under that name",
    /worker:\s*await worker\(\)/.test(health) && /online:\s*z\.boolean\(\)/.test(contract),
    "the workflow greps for a name the API does not emit, so it would pass on a dead platform",
  );
  check(
    "it fails the run when the answer is no",
    /exit 1/.test(watch) && /::error::/.test(watch),
    "a monitor that notices and exits zero has noticed nothing",
  );
  // One failed request is a network, not an outage, and an alert that cries
  // wolf gets muted — which is the same as not having one.
  check(
    "and asks twice before it says so",
    /for attempt in 1 2/.test(watch),
    "a single-shot check turns every hiccup into an alarm",
  );
}

// ─── "Is Google on in production?" has to have an answer ────────────────────
section("What the health endpoint says about signing in");
{
  /*
   * Turning Google on is four steps across two dashboards, and every one of
   * them fails identically from the outside: you click "Continue with Google",
   * you go away, and you come back to a login form. So `/healthz` reports which
   * providers the project has enabled.
   *
   * The whole design of that answer is the `known` flag, and it is the only
   * part worth testing: "Supabase could not be asked" must never be reported as
   * "the providers are off". They send you to different places — one is a
   * network, the other is a credential — and only one of them is worth an
   * evening of re-entering a client secret that was already correct.
   */
  const { createServer } = await import("node:http");
  const { pathToFileURL } = await import("node:url");
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);

  const buildDir = mkdtempSync(path.join(tmpdir(), "editly-auth-providers-"));
  const outfile = path.join(buildDir, "auth-providers.mjs");
  const built = spawnSync(
    require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] }),
    [
      path.join(repoRoot, "artifacts/api-server/src/lib/auth-providers.ts"),
      "--bundle", "--platform=node", "--format=esm", "--target=node22",
      `--outfile=${outfile}`, "--log-level=error",
    ],
    { stdio: "inherit" },
  );
  check("the provider probe bundles", built.status === 0);

  if (built.status === 0) {
    const { authProviders, resetProviderCache } = await import(pathToFileURL(outfile).href);

    let reply = { status: 200, body: JSON.stringify({ external: { google: true, apple: false } }) };
    let asked = 0;
    const stub = createServer((req, res) => {
      asked += 1;
      res.writeHead(reply.status, { "Content-Type": "application/json" });
      res.end(reply.body);
    });
    await new Promise((r) => stub.listen(0, "127.0.0.1", r));
    process.env.SUPABASE_URL = `http://127.0.0.1:${stub.address().port}`;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-for-tests";

    resetProviderCache();
    const on = await authProviders();
    check("a provider that is on is reported on", on.google === true && on.known === true, JSON.stringify(on));
    check("and one that is off is reported off", on.apple === false, JSON.stringify(on));

    const askedOnce = asked;
    await authProviders();
    check(
      "the answer is cached, so a public endpoint is not a load generator",
      asked === askedOnce,
      `asked ${asked} times`,
    );

    reply = { status: 500, body: "nope" };
    resetProviderCache();
    const broken = await authProviders();
    check(
      "a failed probe says it does not know rather than saying they are off",
      broken.known === false,
      JSON.stringify(broken),
    );

    await new Promise((r) => stub.close(r));
    process.env.SUPABASE_URL = "http://127.0.0.1:1";
    resetProviderCache();
    const unreachable = await authProviders();
    check(
      "and so does a probe that cannot connect at all",
      unreachable.known === false,
      JSON.stringify(unreachable),
    );

    delete process.env.SUPABASE_URL;
    resetProviderCache();
    const unset = await authProviders();
    check(
      "an unconfigured server does not claim to know either",
      unset.known === false,
      JSON.stringify(unset),
    );
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("The deploy describes the worker that exists.");
