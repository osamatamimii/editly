/**
 * The first screen, held to the parser it is teaching people to use.
 *
 * Ten renders exist in production and one account made all of them. That is not
 * a marketing number: it is the measured cost of a first screen that hands
 * somebody a "New Project" button and a sentence telling them to "tell Editly
 * what you want done with it" — without one example of what that sentence looks
 * like, on a product whose entire value is in the sentence.
 *
 * ## What this file exists to prevent
 *
 * Copy on a first-run screen drifts from the parser the moment either one
 * changes, and the failure is the worst one this product has: **the first thing
 * a new person ever asks for comes back refused.** Nothing about that is
 * visible in a screenshot or a typecheck, and nobody who hits it files a bug —
 * they close the tab.
 *
 * So every suggested sentence is run through the **real** `planFromText`, in
 * both languages, and has to produce operations. Not a mock of it, and not the
 * model planner either: the model is better and needs a key, and the keyword
 * parser is what answers when there is none. A suggestion that only works on a
 * configured deployment is a suggestion that fails silently on one that is not.
 *
 * Usage: node tools/onboarding-test.mjs
 * Requires: nothing.
 */
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { order } from "./lib/order.mjs";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-onboarding-"));

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

const { planFromText } = await import(build("artifacts/api-server/src/lib/plan-from-text.ts", "plan.mjs"));
const firstRun = await import(build("artifacts/editly/src/lib/first-run.ts", "first-run.mjs"));
const { SUGGESTIONS } = firstRun;

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

// ── The promise the screen makes ────────────────────────────────────────────

section("Every sentence on the first screen actually does something");
{
  check("there are suggestions", SUGGESTIONS.length >= 4, String(SUGGESTIONS.length));
  check(
    "each has a name and a sentence in both languages",
    SUGGESTIONS.every(
      (s) => s.label.en && s.label.ar && s.sentence.en.length > 10 && s.sentence.ar.length > 8,
    ),
  );
  check("and the ids are unique", new Set(SUGGESTIONS.map((s) => s.id)).size === SUGGESTIONS.length);

  for (const suggestion of SUGGESTIONS) {
    for (const language of ["en", "ar"]) {
      const plan = planFromText(suggestion.sentence[language], {});
      const types = plan.operations.map((o) => o.type);
      /*
        Two, not one.

        One operation is the floor for "the sentence parsed at all"; two is the
        floor for "this was worth suggesting". A first-run example that produces
        a single caption pass teaches somebody that this product does one thing.
      */
      check(
        `${suggestion.id} (${language}) produces a real edit`,
        types.length >= 2,
        types.join(", ") || "nothing at all",
      );
    }
  }
}

section("...and the two languages are written, not translated");
{
  /*
    The parser reads two languages and they are not the same shape. "Pull out
    the strongest 30 seconds" matches; «أعطني أقوى 30 ثانية» does not — the
    Arabic highlight patterns want «أفضل جزء» or «أقوى لقطة», not a count of
    seconds. That gap is real and lives where the patterns live; what must not
    happen is this screen papering over it by suggesting a phrase that comes
    back refused, which is what the per-language check above prevents.

    This check states the property that made the catalogue bilingual by
    construction rather than by translation.
  */
  check(
    "no Arabic sentence is a transliteration of its English one",
    SUGGESTIONS.every((s) => !/[a-z]{4}/i.test(s.sentence.ar)),
    SUGGESTIONS.filter((s) => /[a-z]{4}/i.test(s.sentence.ar)).map((s) => s.id).join(", "),
  );
  check(
    "and the known gap is not suggested to anybody",
    SUGGESTIONS.every((s) => planFromText(s.sentence.ar, {}).operations.length >= 2),
  );

  /*
    The three checks that were here read `preferredLanguage`, which guessed the
    language from `navigator.languages`. It is gone, and so are they.

    The product has one answer to "which language is this person in" now, in
    `lib/language.tsx`, and it deliberately does not ask the browser: phones in
    this product's first market are very often set to English, so reading the
    browser turns "Arabic first" into "English for nearly everyone". Two
    functions answering that question differently is the drift this repository
    keeps paying for.

    What replaces them is the check below: this screen reads the shared
    preference rather than keeping one of its own.
  */
  const screen = await readFile(path.join(repoRoot, "artifacts/editly/src/pages/onboarding.tsx"), "utf8");
  // Comments stripped: the file explains the removal right where it happened,
  // and a check that reads the explanation as the offence punishes writing it.
  const screenCode = screen.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("the first-run screen reads the product's language", /useLanguage\(\)/.test(screenCode));
  check(
    "rather than guessing at it from the browser",
    !/navigator\.languages/.test(screenCode),
    "a guess here and a preference elsewhere is two answers to one question",
  );
  check(
    "and its switch writes that preference, so it outlives the screen",
    /const setLanguage = choose;/.test(screen),
  );
}

// ── The screen ──────────────────────────────────────────────────────────────

section("The screen can always be left, and never traps anybody");
{
  const page = await read("artifacts/editly/src/pages/onboarding.tsx");
  check("there is a skip", /data-testid="first-run-skip"/.test(page));
  check("and it is remembered", /skipFirstRun\(\)/.test(page));
  check("starting a project remembers it too", (page.match(/skipFirstRun\(\)/g) ?? []).length >= 2);

  /*
    Placed, never sent.

    The screen exists to teach that a sentence is the interface, and a sentence
    that fires on arrival is a sentence nobody read. If this ever starts a
    render itself, the screen has become a demo of the product rather than a
    use of it.
  */
  check(
    "the sentence is stashed for the editor, not rendered here",
    /stashPendingMessage/.test(page) && !/startRender|useStartRender/.test(page),
  );
  /*
    Both halves moved, and both for the same reason.

    `ACCEPTED_VIDEO_TYPES` became `isAcceptableVideo`: three doors each kept a
    copy of a three-format list while the server's table had taken nine, so
    this screen refused files the product would have stored.

    `uploadCeiling` became `servedCeiling`: the former folds "the server has
    not answered yet" into the build-time 50 MB, which is the *free* plan's
    number — on the first-run screen, where a customer who has just paid for
    Pro is most likely to be standing.
  */
  check(
    "a file is checked before a project row exists",
    /servedCeiling/.test(page) && /isAcceptableVideo/.test(page),
  );
  check("and a project can be started without one", !/disabled=\{!file/.test(page));
}

section("It is a route, behind the same door as everything else");
{
  const app = await read("artifacts/editly/src/App.tsx");
  check("the route exists", /path="\/onboarding"/.test(app));
  /*
    Behind `Protected`: this screen creates a project, so an unauthenticated
    visitor reaching it would get a create that 401s rather than a sign-in.
  */
  check("and it needs a session", /<Route path="\/onboarding">\s*<Protected component=\{Onboarding\} \/>/.test(app));
  check("it is lazy, like every other screen behind the front door", /lazy\(\(\) => import\("@\/pages\/onboarding"\)\)/.test(app));
}

section("The dashboard sends people there only when it is sure");
{
  const dashboard = await read("artifacts/editly/src/pages/dashboard.tsx");
  check("an empty account is redirected", /projectsState === "empty"[^)]*hasSkippedFirstRun/.test(dashboard));
  /*
    The whole reason `loadState` exists. A failed read also leaves `projects`
    undefined, and treating that as empty is how a total outage looked like an
    empty account for two days — here it would be worse than a wrong screen,
    because the first-run screen offers to create a project on top of a library
    the person already has and cannot see.
  */
  check(
    "and a failed read is never mistaken for an empty one",
    !/projectsState !== "loaded"/.test(dashboard) && !/!projects\?\.length[^;]*Redirect/.test(dashboard),
  );
  /*
    The skip flag is never the whole condition.

    Server truth first — a successful read of zero projects — and the browser's
    memory only after it. A redirect that turned on the flag alone would send
    somebody with a full library to a screen offering to make their first video,
    on any browser that had never stored it.
  */
  check(
    "the skip flag is only ever a second condition, not the first",
    /accountIsNew && !hasSkippedFirstRun/.test(dashboard) &&
      /projectsFailed = projectsState === "failed"/.test(dashboard),
    "",
  );
  /*
    And the order of these two comparisons is itself load-bearing:
    `browser-test` reads it out of the source to enforce "check for failure
    before you say the account is empty", a rule this page has been wrong about
    once already.
  */
  check(
    "with failure ruled out before emptiness, in the source and not only in the semantics",
    order(dashboard, 'projectsState === "failed"', 'projectsState === "empty"').ok,
  );
}

section("The editor fills the box and stops");
{
  const editor = await read("artifacts/editly/src/pages/project-editor.tsx");
  check("it claims the stashed sentence", /takePendingMessage/.test(editor));
  check(
    "puts it in the composer",
    /setChatInput\(\(current\) => \(current\.trim\(\) \? current : suggested\)\)/.test(editor),
  );
  /*
    Deletes on read, so a re-mount cannot refill a box somebody has just
    cleared — the same guard `takePendingUpload` needed for the same reason.
  */
  const stash = await read("artifacts/editly/src/lib/pending-upload.ts");
  check("and the stash deletes on read", /pendingMessages\.delete\(projectId\)/.test(stash));
}

section("Storage that throws does not take the dashboard with it");
{
  /*
    `localStorage` does not return null in some privacy modes — it throws on
    access. A first-run flag that crashes the dashboard is worse than a screen
    that shows twice, and this is read on the dashboard's render path.
  */
  const lib = await read("artifacts/editly/src/lib/first-run.ts");
  const reads = lib.split("export function hasSkippedFirstRun")[1] ?? "";
  const writes = lib.split("export function skipFirstRun")[1] ?? "";
  check("reading the flag is guarded", /try \{/.test(reads) && /catch/.test(reads));
  check("and writing it is too", /try \{/.test(writes) && /catch/.test(writes));
  check("a browser that refuses storage is treated as not having skipped", /return false;/.test(reads));
}

await rm(buildDir, { recursive: true, force: true });
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
console.log("The first sentence somebody types is one the product understands.");
