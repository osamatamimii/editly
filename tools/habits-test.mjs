/**
 * What the product remembers about how somebody works, and the one thing it
 * must never do with it.
 *
 * Osama asked for this in the same breath as uploadable fonts: «ان يحفظ الai
 * مدخلات المستخدم المعتادة و اسلوبه». Somebody who has made forty vertical
 * cuts with karaoke captions should not type "vertical, karaoke captions" for
 * the forty-first — the product's whole promise is one sentence, and a
 * sentence that re-states everything you always want is not one sentence.
 *
 * Which makes this the most dangerous feature in the product, and the reason
 * for most of what is below. Every other mistake here is visible: a render
 * fails, a caption is the wrong size, a button does nothing. This one adds
 * something to a person's video that they did not ask for, in a render that
 * succeeds, in a video that looks fine — and they find out when it is posted.
 *
 * So the suite is mostly about restraint:
 *
 *   - A habit needs four renders and seven in ten. Three is one busy project.
 *   - The denominator is renders that *could* have shown it, never the total,
 *     or the more varied somebody's work is the less this knows about any of
 *     it.
 *   - "no captions" is a decision about captions. The one sentence where
 *     somebody is explicit is the one where being overridden is worst.
 *   - Nothing is invented: habits are added to a plan, never made into one.
 *   - And every fill is said out loud, because a memory that quietly changes
 *     what you get is indistinguishable from a bug.
 *
 * Usage: node tools/habits-test.mjs
 * Requires: nothing. The arithmetic is pure and the parser is pure.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-habits-"));

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

const { habitsIn, applyHabits } = await import(bundle("artifacts/api-server/src/lib/habits.ts", "habits.mjs"));
const { planFromText } = await import(bundle("artifacts/api-server/src/lib/plan-from-text.ts", "plan.mjs"));

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

// ── Fixtures ────────────────────────────────────────────────────────────────

const captions = (extra = {}) => ({
  type: "autoCaptions", style: "karaoke-box", animation: "karaoke", dropFillers: true, ...extra,
});
const vertical = { type: "formatForPlatform", platform: "tiktok" };
const silence = { type: "removeSilence", thresholdDb: -32, minSilenceMs: 500, paddingMs: 80 };
const plan = (...operations) => ({ version: 1, operations });

/** The usual week: the same edit, made many times. */
const habitual = (n) => Array.from({ length: n }, () => plan(vertical, captions(), silence));

const found = (habits, key) => habits.find((h) => h.key === key);

// ── What counts as a habit ─────────────────────────────────────────────────

section("Three of something is not how somebody works");
{
  check("one render teaches nothing", habitsIn(habitual(1)).length === 0);
  check("nor do three", habitsIn(habitual(3)).length === 0, JSON.stringify(habitsIn(habitual(3))));
  const four = habitsIn(habitual(4));
  check("four is a way of working", four.length > 0, JSON.stringify(four.map((h) => h.key)));
  check("and it is the platform they keep choosing", found(four, "platform")?.value === "tiktok");
  check("and the caption style", found(four, "captionStyle")?.value === "karaoke-box");
}

section("Half the time is two ways of working, not one");
{
  /*
    Six of one and four of the other. Somebody who does it 60% of the time is
    somebody with two habits, and picking their more common one for them is
    not knowing them better — it is deciding for them, on the sentence where
    they said nothing, which is when it is hardest to notice.
  */
  const mixed = [
    ...Array.from({ length: 6 }, () => plan(vertical, captions())),
    ...Array.from({ length: 4 }, () => plan(vertical, captions({ style: "bold-white", animation: "pop" }))),
  ];
  const habits = habitsIn(mixed);
  check("a 60/40 split is not a habit", found(habits, "captionStyle") === undefined,
    JSON.stringify(found(habits, "captionStyle")));
  check(
    "but the thing they did every single time still is",
    found(habits, "platform")?.value === "tiktok",
  );
  const strong = [
    ...Array.from({ length: 8 }, () => plan(captions())),
    ...Array.from({ length: 2 }, () => plan(captions({ style: "bold-white" }))),
  ];
  check("eight in ten is", found(habitsIn(strong), "captionStyle")?.value === "karaoke-box");
}

section("The denominator is what could have shown it");
{
  /*
    The bug this rule prevents: somebody captions every video they caption, and
    also does twelve reframe-only jobs. Counting those twelve as evidence
    against a caption *style* would mean the more different kinds of work
    somebody does, the less the product knows about any of it — which is
    backwards, because breadth is not doubt.
  */
  const mixed = [
    ...Array.from({ length: 5 }, () => plan(vertical, captions())),
    ...Array.from({ length: 12 }, () => plan(vertical)),
  ];
  const habits = habitsIn(mixed);
  check(
    "a style is read from the renders that had captions, not from all of them",
    found(habits, "captionStyle")?.value === "karaoke-box",
    JSON.stringify(found(habits, "captionStyle")),
  );
  check(
    "and the evidence is reported honestly: five of five, not five of seventeen",
    found(habits, "captionStyle")?.times === 5 && found(habits, "captionStyle")?.outOf === 5,
    JSON.stringify(found(habits, "captionStyle")),
  );
  check(
    "while whether to caption at all counts every render, because every one could have",
    // Five in seventeen is not a habit of captioning, and the rule that says so
    // is the denominator: this is the one question where a plan without the
    // operation is a person choosing not to have it. What comes out either way
    // must not be a habit of *having* them.
    found(habits, "captions")?.value !== "yes",
    JSON.stringify(found(habits, "captions")),
  );
}

// ── The sentence always wins ───────────────────────────────────────────────

section("A sentence that mentions something decides it, including by saying no");
{
  const habits = habitsIn(habitual(8));
  for (const [asked, subject] of [
    ["no captions on this one, just cut the silence", "captions"],
    ["without subtitles please, make it vertical", "captions"],
    ["اقصص الصمت بدون ترجمة", "captions"],
    ["ما بدي كابشن، خليه عمودي", "captions"],
  ]) {
    const intent = planFromText(asked);
    check(`"${asked}" is a sentence about ${subject}`, intent.spoke.captions, JSON.stringify(intent.spoke));
    const { operations, applied } = applyHabits(intent.operations, habits, intent.spoke);
    check(
      "  and nothing adds captions to it",
      !operations.some((o) => o.type === "autoCaptions" || o.type === "burnCaptions"),
      JSON.stringify(operations.map((o) => o.type)),
    );
    check("  and the reply does not claim it did", !applied.some((a) => a.key === "captions"));
  }
}

section("Keeping the pauses is a decision about the pauses");
{
  const habits = habitsIn(habitual(8));
  for (const asked of ["caption it but keep the silence", "خلي الصمت وحط ترجمة"]) {
    const intent = planFromText(asked);
    check(`"${asked}" is a sentence about silence`, intent.spoke.silence, JSON.stringify(intent.spoke));
    const { operations } = applyHabits(intent.operations, habits, intent.spoke);
    check(
      "  and the dead air is left alone",
      !operations.some((o) => o.type === "removeSilence"),
      JSON.stringify(operations.map((o) => o.type)),
    );
  }
}

section("A sentence that says 16:9 is not silent about the frame");
{
  const habits = habitsIn(habitual(8));
  const intent = planFromText("keep it widescreen and caption it");
  check("the frame was spoken about", intent.spoke.platform, JSON.stringify(intent.spoke));
  const { operations } = applyHabits(intent.operations, habits, intent.spoke);
  const reframes = operations.filter((o) => o.type === "formatForPlatform");
  check(
    "so the usual vertical is not pushed onto it",
    !reframes.some((o) => o.platform === "tiktok"),
    JSON.stringify(reframes),
  );
}

// ── What it does do ────────────────────────────────────────────────────────

section("On a sentence that left them out, the usual things happen and are named");
{
  const habits = habitsIn(habitual(8));
  const intent = planFromText("cut it down to the good parts");
  const { operations, applied } = applyHabits(intent.operations, habits, intent.spoke);
  check(
    "the frame they always use is applied",
    operations.some((o) => o.type === "formatForPlatform" && o.platform === "tiktok"),
    JSON.stringify(operations.map((o) => o.type)),
  );
  check(
    "with the caption style and animation they always use",
    operations.some((o) => o.type === "autoCaptions" && o.style === "karaoke-box" && o.animation === "karaoke"),
    JSON.stringify(operations.filter((o) => o.type === "autoCaptions")),
  );
  check(
    "and every one of them is said out loud, because a silent memory is a bug",
    applied.length >= 2 && applied.every((a) => a.en.length > 10 && a.ar.length > 10),
    JSON.stringify(applied.map((a) => a.key)),
  );
  check(
    "in the voice the rest of the reply is written in, so the list reads as one sentence",
    // The reply is "I'll <these>, and <those>". A past-tense entry among
    // infinitives is how a list stops reading as a list.
    applied.every((a) => !/^(?:added|reframed|cut the dead air,? which was)/.test(a.en)),
    JSON.stringify(applied.map((a) => a.en)),
  );
}

section("The uploaded face somebody always uses comes with it");
{
  const withFont = Array.from({ length: 6 }, () =>
    plan(vertical, captions({ fontArabic: "b6a9c1f2-face", font: "anton" })),
  );
  const habits = habitsIn(withFont);
  check("the Arabic face is learned", found(habits, "arabicFont")?.value === "b6a9c1f2-face");
  const intent = planFromText("cut it down to the good parts");
  const { operations } = applyHabits(intent.operations, habits, intent.spoke);
  const op = operations.find((o) => o.type === "autoCaptions");
  check("and reaches the plan", op?.fontArabic === "b6a9c1f2-face", JSON.stringify(op));
  check("with the Latin one beside it", op?.font === "anton", JSON.stringify(op));
}

section("Nothing is invented out of nothing");
{
  const habits = habitsIn(habitual(8));
  /*
    A sentence that produced no operations is a sentence we did not
    understand. Answering it with somebody's usual edit would not be
    remembering them; it would be inventing a request and then doing it.
  */
  const { operations, applied } = applyHabits([], habits, { platform: false, captions: false, silence: false });
  check("an empty plan stays empty", operations.length === 0);
  check("and claims nothing", applied.length === 0);

  const noHabits = applyHabits([{ type: "kenBurns", to: 1.08 }], [], {
    platform: false, captions: false, silence: false,
  });
  check("a person with no history gets exactly what they asked for", noHabits.operations.length === 1);
  check("and is told nothing about habits they do not have", noHabits.applied.length === 0);
}

section("A plan that already has the thing is not given it twice");
{
  const habits = habitsIn(habitual(8));
  const intent = planFromText("make it vertical for tiktok with captions");
  const { operations } = applyHabits(intent.operations, habits, intent.spoke);
  check(
    "one reframe",
    operations.filter((o) => o.type === "formatForPlatform").length === 1,
    JSON.stringify(operations.map((o) => o.type)),
  );
  check(
    "and one caption track",
    operations.filter((o) => o.type === "autoCaptions").length === 1,
  );
}

await rm(buildDir, { recursive: true, force: true });
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
console.log("The product remembers how you work, and never over the sentence you just typed.");
