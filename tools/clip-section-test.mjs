/**
 * The screen that takes clips out of a recording, and whether it says so.
 *
 * This section was being read as "where podcasts get edited". It is not: it
 * does one job on one kind of input, and an episode is edited in its own
 * project like anything else. Fixing that is mostly words — and words that do
 * not match behaviour are the thing this repository keeps finding, so half of
 * this suite is about the words and half is about the screen actually doing
 * what they now claim.
 *
 * Two rules are worth stating before the checks.
 *
 * **A section that only displays results is an archive, whatever its heading
 * says.** So the recordings a person can cut from have to be *on* the screen,
 * and picking one has to start the thing. A heading that promises an action the
 * page cannot perform is the same lie as a filter that reads correctly and does
 * nothing.
 *
 * **The sentence that starts it has to parse.** It is written into the editor,
 * and a request the keyword planner does not recognise produces an empty plan
 * and a refusal on a screen whose whole promise was one click. It is checked
 * here against the real planner, in both languages, for the same reason
 * `bilingual-test` checks the suggestions.
 *
 * Usage: node tools/clip-section-test.mjs
 * Requires: nothing. No browser, no keys, no database.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { order } from "./lib/order.mjs";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-clip-section-"));

/*
  Resolved from `artifacts/api-server`, which is where every suite in here finds
  esbuild: the front end does not depend on it, and a suite that could only run
  where one package happened to hoist a dev dependency is a suite that stops
  running the first time somebody prunes. `clip-shelves.ts` imports nothing, so
  bundling it needs none of the front end's aliases.
*/
function build(source, name, from = "artifacts/api-server") {
  const outfile = path.join(buildDir, name);
  const built = spawnSync(
    require.resolve("esbuild/bin/esbuild", { paths: [from] }),
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

const S = await import(build("artifacts/editly/src/lib/clip-shelves.ts", "shelves.mjs"));
const G = await import(build("artifacts/editly/src/lib/start-from-video.ts", "gate.mjs"));
const planner = await import(build("artifacts/api-server/src/lib/plan-from-text.ts", "planner.mjs"));

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

/* ── The one sentence the section is built on ──────────────────────────────── */

section("The request the screen writes for somebody has to be one the product understands");
{
  const source = read("artifacts/editly/src/lib/first-run.ts");
  const match = source.match(/export const CLIPS_REQUEST = \{\s*en: "([^"]+)",\s*ar: "([^"]+)",/);
  check("the sentence is written down once, where both screens can read it", match !== null, "CLIPS_REQUEST");

  for (const [language, sentence] of [["English", match?.[1]], ["Arabic", match?.[2]]]) {
    const plan = planner.planFromText(sentence ?? "", {});
    const types = (plan.operations ?? []).map((o) => o.type);
    check(
      `the ${language} sentence reaches the clips operation through the real planner`,
      types.includes("extractClips"),
      `${sentence} → ${types.join(",") || "nothing"}`,
    );
    check(
      `and is not refused in ${language}`,
      (plan.cannotYet ?? []).length === 0,
      JSON.stringify((plan.cannotYet ?? []).map((p) => p.en)),
    );
  }

  // The suggestion on the first-run screen is the same string, not a second
  // copy of it: two sentences that both have to parse are two that can drift,
  // and only one of them is under a check.
  check(
    "the first-run suggestion uses that same constant rather than repeating it",
    /id: "clips",[\s\S]{0,120}?sentence: CLIPS_REQUEST/.test(source),
    "a second copy is a copy that can stop parsing on its own",
  );
}

/* ── The door: adding an episode ──────────────────────────────────────────── */

section("A file is refused before a project row is made for it");
{
  /*
    No `accepted` list to pass in any more, and that is the fix.

    `videoRejection` took one and this suite supplied `["video/mp4",
    "video/quicktime", "video/webm"]` — the same three formats the two screens
    each kept a copy of, while the server's own table has taken nine for a long
    time, `.mkv` (OBS's default container) and `.m4v` among them. The list is
    derived from that table now, inside `isAcceptableVideo`, so there is
    nothing left for a caller to get wrong.
  */
  const gate = (file, ceilingBytes = 100 * 1024 * 1024) => G.videoRejection(file, { ceilingBytes });

  check("an mp4 goes through", gate({ type: "video/mp4", name: "ep14.mp4", size: 10 }) === null);
  check("a spreadsheet does not", gate({ type: "text/csv", name: "budget.csv", size: 10 }) === "type");
  check(
    "a .mov the browser could not name goes through on its extension, which is the normal case for it",
    gate({ type: "", name: "Episode 14.MOV", size: 10 }) === null,
  );
  check("a file over the plan's ceiling is refused", gate({ type: "video/mp4", name: "ep.mp4", size: 200 * 1024 * 1024 }) === "size");
  check(
    "and a ceiling that has not loaded yet refuses nothing, rather than everything for a second",
    gate({ type: "video/mp4", name: "ep.mp4", size: 200 * 1024 * 1024 }, 0) === null,
    "the subscription query answers late on a cold screen",
  );

  // The rule is one function and the words are two. Both screens have to let
  // the same files through; neither has to say no in the same sentence.
  const dashboard = read("artifacts/editly/src/pages/dashboard.tsx");
  const page = read("artifacts/editly/src/pages/clips.tsx");
  check("both screens gate through it", /videoRejection\(file, \{/.test(dashboard) && /videoRejection\(file, \{/.test(page));

  /*
    And the formats the server takes are the formats the browser offers.

    Both screens used to hand `videoRejection` a three-format list and set
    `accept` to the same three, so `.mkv` was not even offered by the file
    picker — a refusal the person never got to read because the file could not
    be chosen. `ACCEPTED_VIDEO_ACCEPT` names the media types *and* the
    extensions, because browsers disagree about what an `.mkv` is.
  */
  check(
    "a container the server takes is one the picker offers",
    gate({ type: "video/x-matroska", name: "stream.mkv", size: 10 }) === null,
    "OBS writes .mkv by default",
  );
  check("and .m4v, which is the same file with another name", gate({ type: "", name: "ep.m4v", size: 10 }) === null);
  check(
    "an iPhone photo is still refused, because the renderer cannot read it",
    gate({ type: "image/heic", name: "IMG_0421.HEIC", size: 10 }) === "type",
    "accepting it would move the failure to a render that dies while somebody watches",
  );
  /*
    Every screen with a video picker, not the one that was noticed.

    `clips.tsx` and `project-editor.tsx`'s first input were pointed at the
    shared list; `dashboard.tsx`, `onboarding.tsx` and the editor's *second*
    input kept the literal `video/mp4,video/quicktime,video/webm` — so the two
    doors most people come through offered three formats while the server took
    six, and an `.mkv` was greyed out in the picker with no message anywhere.
    A scan rather than a named list, so a screen added later is covered by it.
  */
  const withPickers = [
    "clips.tsx",
    "dashboard.tsx",
    "onboarding.tsx",
    "project-editor.tsx",
  ].map((name) => [name, read(`artifacts/editly/src/pages/${name}`)]);
  for (const [name, source] of withPickers) {
    const literal = source.match(/accept="[^"]*video\/[^"]*"/);
    check(
      `${name} takes its picker list from the one place it is written`,
      !literal,
      literal ? literal[0] : "no hardcoded accept",
    );
  }
  check(
    "and neither keeps a second copy of the rule",
    !/ACCEPTED_VIDEO_TYPES\.includes\(file\.type\)/.test(dashboard) && !/ACCEPTED_VIDEO_TYPES\.includes\(file\.type\)/.test(page),
    "a rule in two places is a rule that will disagree with itself",
  );
}

section("Adding an episode is the first thing on the screen");
{
  const page = read("artifacts/editly/src/pages/clips.tsx");
  const copy = read("artifacts/editly/src/lib/copy/clips.ts");

  check("the lead says what you add and what comes back", /أضف حلقة بودكاست هنا/.test(copy) && /Add a podcast episode here/.test(copy));
  check(
    "the door is named for what the person came to do, not for what the browser does",
    /addTitle: p\("أضف حلقة بودكاست", "Add a podcast episode"\)/.test(copy),
    "\"upload a file\" names the mechanism",
  );
  check("it takes a dropped file", /onDrop=\{\(e\) => \{/.test(page) && /dataTransfer\.files/.test(page));
  check("and a chosen one", /data-testid="clips-add-input"/.test(page));
  check(
    "the project is created before the file is stashed against it",
    order(page, "createProject.mutateAsync", "stashPendingUpload(project.id, file)").ok,
    "a failed create must not leave a file waiting for a project that was never made",
  );
  check(
    "and the request for clips is written into that project at the same moment",
    /stashPendingMessage\(project\.id, CLIPS_REQUEST\[said\]\)/.test(page),
    "the whole promise of the screen is that the episode and the request arrive together",
  );
  check(
    "the file input clears itself, so choosing the same file after a refusal fires again",
    /e\.target\.value = ""/.test(page),
  );
  check(
    "the recordings already here are offered second, and hidden when there are none",
    order(page, "clips-add-episode", "CLIPS.startTitle").ok && /recordings\.length > 0 \? \(/.test(page),
  );
}

/* ── Which recordings are offered ─────────────────────────────────────────── */

section("What the section offers to cut from");
{
  const projects = [
    { id: "short", duration: 42, videoPath: "u/short/v.mp4" },
    { id: "nine-minutes", duration: 9 * 60, videoPath: "u/nine/v.mp4" },
    { id: "two-hours", duration: 7182, videoPath: "u/two/v.mp4" },
    { id: "uploading", duration: 3600, videoPath: null },
    { id: "unmeasured", duration: null, videoPath: "u/un/v.mp4" },
  ];
  const offered = S.clippableRecordings(projects).map((p) => p.id);

  check("a forty-second file is not something you clip from", !offered.includes("short"), JSON.stringify(offered));
  check("nine minutes is", offered.includes("nine-minutes"), JSON.stringify(offered));
  check(
    "a recording whose file has not arrived is not offered, because the editor could only tell them to wait",
    !offered.includes("uploading"),
    JSON.stringify(offered),
  );
  check(
    "and neither is one whose length was never measured — an unknown is not a yes",
    !offered.includes("unmeasured"),
    JSON.stringify(offered),
  );
  check("the longest comes first", offered[0] === "two-hours", JSON.stringify(offered));

  const many = Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, duration: 1000 + i, videoPath: "u/p/v.mp4" }));
  check("it is a row, not a directory", S.clippableRecordings(many).length === S.MOST_OFFERED, String(S.clippableRecordings(many).length));

  check("no projects at all is an empty row rather than a crash", S.clippableRecordings(undefined).length === 0);
}

/* ── How the results are filed ────────────────────────────────────────────── */

section("What came out of which recording");
{
  const clip = (id, projectId, projectTitle, startSeconds) => ({ id, projectId, projectTitle, startSeconds });
  const library = [
    clip("c3", "ep14", "Episode 14", 900),
    clip("c1", "ep14", "Episode 14", 71),
    clip("c9", "walkthrough", "Store walkthrough", 12),
    clip("c2", "ep14", "Episode 14", 402),
  ];
  const shelves = S.shelvesFrom(library);

  check("one shelf per recording, not one per clip", shelves.length === 2, String(shelves.length));
  check(
    "in the order the library gave them, which is newest first",
    shelves.map((s) => s.projectId).join(",") === "ep14,walkthrough",
    shelves.map((s) => s.projectId).join(","),
  );
  check(
    "inside a shelf the clips run in the order they happen in the take",
    shelves[0].clips.map((c) => c.id).join(",") === "c1,c2,c3",
    shelves[0].clips.map((c) => c.id).join(","),
  );
  check("every clip is filed, none twice", shelves.flatMap((s) => s.clips).length === library.length);
  check("an empty library is no shelves rather than one empty one", S.shelvesFrom([]).length === 0);

  /*
    The shelves are built from the clips and not from the project list, and
    this is the reason. The library is capped: a recording whose clips all fell
    past the cap must not appear here at all, because a shelf drawn with nothing
    under it says, in the only way a screen can, that the recording produced
    nothing.
  */
  const capped = S.shelvesFrom(library.filter((c) => c.projectId === "ep14"));
  check(
    "a recording with nothing in the visible page gets no shelf, rather than an empty one",
    capped.every((shelf) => shelf.clips.length > 0) && !capped.some((s) => s.projectId === "walkthrough"),
    JSON.stringify(capped.map((s) => [s.projectId, s.clips.length])),
  );
}

/* ── And the words, which are what the request was actually about ─────────── */

section("The screen says which job it does");
{
  const copy = read("artifacts/editly/src/lib/copy/clips.ts");
  const page = read("artifacts/editly/src/pages/clips.tsx");
  const dashboard = read("artifacts/editly/src/pages/dashboard.tsx");

  check(
    "the title names the job rather than the pile on the shelf",
    /title: p\("استخراج المقاطع", "Clip extraction"\)/.test(copy),
    "\"Clips\" names what is on the screen; it does not tell somebody holding an episode whether they are in the right place",
  );
  check(
    "and the lead says what it is not, because that is what was being misread",
    /ليس تعديلًا للحلقة/.test(copy) && /not where the episode itself gets edited/.test(copy),
  );
  for (const [name, key] of [
    ["the door", "addTitle"],
    ["what happens after you drop a file", "addHint"],
    ["the shorter road for a recording already here", "startTitle"],
  ]) {
    const pair = copy.match(new RegExp(`${key}: p\\(\\s*"([^"]+)",\\s*"([^"]+)"`, "s")) ?? copy.match(new RegExp(`${key}: p\\("([^"]+)", "([^"]+)"\\)`));
    check(`${name} is written in both languages`, pair !== null && pair[1].length > 3 && pair[2].length > 3, key);
  }

  // Every one of these is a customer-facing string, and `browser-test` refuses
  // an em dash in one. Checked here too, where the file is, so the failure
  // names the line rather than a rendered page.
  const emDashed = [...copy.matchAll(/p\(\s*"([^"]*—[^"]*)"/g)].map((m) => m[1]);
  check("and none of them carries an em dash", emDashed.length === 0, emDashed.join(" | "));

  check(
    "the screen carries the action, so it is a section rather than a shelf",
    /data-testid="clips-start"/.test(page) && /stashPendingMessage\(projectId, CLIPS_REQUEST\[said\]\)/.test(page),
  );
  check(
    "the sentence is written into the editor and not sent for them",
    /stashPendingMessage/.test(page) && !/sendMessage|submit\(/.test(page),
    "a request that fires on arrival is one nobody read",
  );
  check(
    "the results are filed under the recording they came out of",
    /shelvesFrom\(clips\)/.test(page) && /data-testid=\{`clips-of-\$\{projectId\}`\}/.test(page),
  );
  check(
    "and the wrapper the browser suite looks for is still there, because that check is about the screen drawing at all",
    /data-testid="clips-grid"/.test(page),
  );
  check(
    "the dashboard's recordings point at the section that cuts them",
    /data-testid="link-clip-extraction"/.test(dashboard) && /podcastsToClips/.test(dashboard),
    "listing the episodes in one place and the extraction in another, with no link, made \"Clips\" a noun somebody had to guess was a verb",
  );
}

await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log("A heading that promises an action the page cannot perform is a filter that reads correctly and does nothing.");
  process.exit(1);
}
console.log("One section, one job, and the screen can do the job it names.");
