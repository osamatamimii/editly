/**
 * A note is one sentence pinned to one moment, and this file is about the two
 * properties that make it worth having.
 *
 * **It survives the prompt.** The plan a render uses is the base plus the
 * notes, and the base is regenerated from scratch every time somebody types.
 * If a note could be destroyed by a later sentence, the feature would be a
 * trap: the one thing an editor must never do is lose an hour of somebody's
 * manual work because they asked for one more change.
 *
 * **It beats the plan where they disagree.** "Cut the silences" and "leave
 * this pause" are not a contradiction to be settled by whichever came last.
 * They compose — cut everywhere except here — and the field they compose in,
 * `removeSilence.protect`, already existed with one author. The whole risk of
 * this layer is a second author overwriting the first, which is the same bug
 * this repository has now found at three different depths.
 *
 * The anchor lives on the source clock, and that is checked too: a note placed
 * while watching a cut version, stored against the edit, points somewhere else
 * the moment anything earlier changes — silently, which is the worst way.
 */
import { mkdtemp } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-notes-"));

function build(source, name) {
  const outfile = path.join(buildDir, name);
  const built = spawnSync(
    require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] }),
    [
      path.join(repoRoot, source),
      "--bundle", "--platform=node", "--format=esm", "--target=node22",
      "--external:pg", `--outfile=${outfile}`, "--log-level=error",
    ],
    { stdio: "inherit" },
  );
  if (built.status !== 0) process.exit(1);
  return pathToFileURL(outfile).href;
}

const { applyNotes, verbOf, snapAnchor, KEEP_PADDING_MS } =
  await import(build("artifacts/api-server/src/lib/notes.ts", "notes.mjs"));
const { EditPlan } = await import(build("lib/api-zod/src/index.ts", "zod.mjs"));

let checks = 0;
let failures = 0;
const check = (name, ok, detail = "") => {
  checks += 1;
  if (ok) console.log(`  ✓ ${name}`);
  else { failures += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const section = (title) => console.log(`\n${title}`);

const SILENCE = { type: "removeSilence", thresholdDb: -34, minSilenceMs: 700, paddingMs: 120 };
const CAPTIONS = { type: "autoCaptions", style: "bold-white" };

section("A sentence is read for what it asks, in either language");
{
  check("English keep", verbOf("leave this pause") === "keep");
  check("English don't cut", verbOf("don't cut here") === "keep");
  check("Arabic keep", verbOf("خلي هاي الوقفة") === "keep");
  check("Arabic don't cut", verbOf("لا تقص هون") === "keep");
  check("English punch", verbOf("zoom in here") === "punch");
  check("Arabic punch", verbOf("قرّب هنا") === "punch");
  // Both said in one note: keep wins, because losing a pause is unrecoverable
  // and losing a push-in is visible.
  check("both in one sentence resolves to keep", verbOf("keep this and push in on it") === "keep");
  check("a sentence with no verb this layer knows is null", verbOf("this bit is my favourite") === null);
}

section("The anchor is moved onto a word boundary, never into the middle of one");
{
  const words = [{ startMs: 1000, endMs: 1400 }, { startMs: 1600, endMs: 2200 }, { startMs: 3000, endMs: 3500 }];
  check("a click inside a word snaps to its nearer edge", snapAnchor(1750, words) === 1600, String(snapAnchor(1750, words)));
  check("a click just past a word snaps back to its end", snapAnchor(2300, words) === 2200, String(snapAnchor(2300, words)));
  check("a click in a gap takes the nearest edge either side", snapAnchor(2700, words) === 3000, String(snapAnchor(2700, words)));
  // Nearest *boundary*, not nearest start: a note at the end of a sentence is
  // usually about the pause after it, and snapping back to the word's start
  // would move the protection off the thing being pointed at.
  check("and it is boundaries, not starts", snapAnchor(1450, words) === 1400, String(snapAnchor(1450, words)));
  check("with no transcript the anchor is used as given", snapAnchor(1750, []) === 1750);
  check("and never goes negative", snapAnchor(-5, []) === 0);
}

section("A note narrows the plan rather than replacing anything in it");
{
  const { operations, applied, unread } = applyNotes([SILENCE, CAPTIONS], [{ sourceMs: 5000, text: "leave this pause" }]);
  check("every operation the base produced is still there", operations.length === 2, String(operations.length));
  check("captions are untouched", JSON.stringify(operations[1]) === JSON.stringify(CAPTIONS));
  const silence = operations.find((o) => o.type === "removeSilence");
  check("the cut still happens", Boolean(silence));
  check("but not through the moment marked", silence.protect?.length === 1, JSON.stringify(silence.protect));
  check(
    "protected either side of the anchor, because the beat is the point and not the word",
    silence.protect[0].startMs === 5000 - KEEP_PADDING_MS && silence.protect[0].endMs === 5000 + KEEP_PADDING_MS,
    JSON.stringify(silence.protect[0]),
  );
  check("and it is reported as applied", applied.length === 1 && applied[0].verb === "keep");
  check("with nothing unread", unread.length === 0);
  check("the result is still a valid plan", EditPlan.safeParse({ version: 1, operations }).success);
}

section("Two authors of one field, and neither erases the other");
{
  // The worker's scene reader writes to `protect` from what it saw on screen.
  // A person's note writes to the same field. This is the bug that had to not
  // happen, at the layer where it would have happened.
  const watched = { ...SILENCE, protect: [{ startMs: 20000, endMs: 22000 }] };
  const { operations } = applyNotes([watched], [{ sourceMs: 5000, text: "keep this" }]);
  const silence = operations[0];
  check("what the model protected is still protected", silence.protect.some((r) => r.startMs === 20000), JSON.stringify(silence.protect));
  check("and what the person protected is too", silence.protect.some((r) => r.startMs === 5000 - KEEP_PADDING_MS), JSON.stringify(silence.protect));
  check("both, not one", silence.protect.length === 2, String(silence.protect.length));
}

section("A push-in with nowhere to land is given somewhere to land");
{
  const { operations } = applyNotes([CAPTIONS], [{ sourceMs: 8000, text: "zoom in here" }]);
  const punch = operations.find((o) => o.type === "zoomPunch");
  check("a zoomPunch is added", Boolean(punch), JSON.stringify(operations));
  check("holding exactly the moment marked", punch.at.length === 1 && punch.at[0] === 8, JSON.stringify(punch?.at));
  check("and the plan still validates", EditPlan.safeParse({ version: 1, operations }).success);

  // Where the base already punches, the note joins the list rather than
  // replacing it — the same union rule, on the other field.
  const chosen = { type: "zoomPunch", at: [2, 4], amount: 0.12, holdMs: 1200, on: "emphasis" };
  const merged = applyNotes([chosen], [{ sourceMs: 8000, text: "قرّب هنا" }]).operations[0];
  check("an existing zoomPunch keeps its own moments", merged.at.includes(2) && merged.at.includes(4), JSON.stringify(merged.at));
  check("and gains the marked one", merged.at.includes(8), JSON.stringify(merged.at));
}

section("A keep with nothing to protect against is dormant, not lost");
{
  // The plan does not cut silence this time, so the note narrows nothing. It
  // is still applied and still stored, and becomes live the day a prompt asks
  // for the silences to go. That persistence is the reason notes are rows.
  const { operations, applied, unread } = applyNotes([CAPTIONS], [{ sourceMs: 5000, text: "leave this in" }]);
  check("the plan is unchanged", operations.length === 1 && operations[0].type === "autoCaptions");
  check("the note is still understood", applied.length === 1 && applied[0].verb === "keep");
  check("and not reported as unreadable", unread.length === 0);
}

section("A note nothing here understands is reported, never dropped");
{
  const { applied, unread } = applyNotes([SILENCE], [
    { sourceMs: 1000, text: "keep this" },
    { sourceMs: 2000, text: "make this bit funnier" },
  ]);
  check("the one with a verb is applied", applied.length === 1);
  check("the other is handed back rather than swallowed", unread.length === 1 && unread[0].sourceMs === 2000, JSON.stringify(unread));
}

section("Every anchor that reaches a plan is on the source clock");
{
  /*
   * The property, stated as a test rather than as a comment.
   *
   * `zoomPunch.at` and `removeSilence.protect` are both documented as source
   * seconds and source milliseconds. A note is stored in source milliseconds.
   * If a conversion ever crept in between the two — an "edited clock" helper
   * applied on the way through — a note would land somewhere else the moment
   * anything earlier in the video was cut, with no error anywhere.
   */
  const notes = [{ sourceMs: 12345, text: "keep this" }, { sourceMs: 30000, text: "zoom in here" }];
  const { operations } = applyNotes([SILENCE], notes);
  const silence = operations.find((o) => o.type === "removeSilence");
  const punch = operations.find((o) => o.type === "zoomPunch");
  check("the keep sits around its own source millisecond", silence.protect[0].startMs === 12345 - KEEP_PADDING_MS, JSON.stringify(silence.protect));
  check("the punch sits on its own source second", punch.at[0] === 30, JSON.stringify(punch.at));
}

section("The words are read from the fields the worker actually wrote");
{
  /*
   * The bug this section exists for shipped, and nothing failed.
   *
   * `snapAnchor` is fed from `transcripts.segments`, which is jsonb — so a
   * reader asking for `word.start` on rows that hold `word.startMs` gets
   * `undefined`, skips every word, and returns an empty list. An empty list is
   * indistinguishable from a project nobody has transcribed yet, and the
   * documented fallback for that is "use the anchor as given". So every snap
   * quietly stopped snapping, every response stayed a 200, and every test that
   * passed its own fixture in kept passing.
   *
   * Fixtures cannot catch this: the fixture is written by the same hand as the
   * reader, so both are wrong together. Only the writer's own type can, which
   * is what this reads.
   */
  const types = readFileSync(path.join(repoRoot, "artifacts/worker/src/providers/types.ts"), "utf8");
  const word = types.slice(types.indexOf("export interface TranscriptWord"));
  const fields = new Set([...word.slice(0, word.indexOf("}")).matchAll(/^\s{2}(\w+)[?]?:/gm)].map((m) => m[1]));
  check("the worker writes startMs, endMs and text", ["startMs", "endMs", "text"].every((f) => fields.has(f)), [...fields].join(","));
  check("and never start or end", !fields.has("start") && !fields.has("end"));

  for (const reader of ["artifacts/api-server/src/lib/notes-store.ts", "artifacts/api-server/src/routes/notes.ts"]) {
    const source = readFileSync(path.join(repoRoot, reader), "utf8");
    // Only the lines that actually pick a field off a transcript word.
    const reads = [...source.matchAll(/\bword\.(\w+)/g)].map((m) => m[1]);
    check(`${path.basename(reader)} reads at least one word field`, reads.length > 0);
    check(
      `${path.basename(reader)} reads only fields the worker writes`,
      reads.every((field) => fields.has(field)),
      reads.filter((field) => !fields.has(field)).join(","),
    );
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) { console.log(`${failures} FAILED`); process.exit(1); }
console.log("A note survives the next sentence, and wins where it is more specific.");
