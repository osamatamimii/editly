/**
 * A sentence in, a video out, and the promise matching what happened.
 *
 * The product is three pieces in a line: a sentence becomes a plan, the plan
 * becomes a video, and a reply tells the person what to expect. Each piece is
 * covered — planner-test proves the first, render- and combination-test prove
 * the second — and *nothing covered the line*. A plan the matcher really emits
 * could have named something the renderer quietly drops, and every suite would
 * still be green while the reply promised it.
 *
 * Two properties, and the second is the one this product is built on.
 *
 *   1. Every plan the matcher produces from a real sentence renders.
 *
 *   2. **No operation vanishes silently.** For every operation in the plan the
 *      notes either say it happened or say why it did not. That is what makes
 *      "I'll cut the dead air and caption it" checkable rather than decorative:
 *      the reply is generated from the operations, so an operation that leaves
 *      no trace in the notes is a sentence the customer read and a thing that
 *      never happened.
 *
 * The table below is the interesting part. It is the list of what each
 * operation owes the person afterwards, and it is deliberately explicit: a
 * generic "some note mentions something" check would pass on any prose at all.
 *
 * Usage: node tools/promise-test.mjs
 * Requires: ffmpeg and ffprobe on PATH.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-promise-"));

const bundle = (source, name, pkg) => {
  const out = path.join(buildDir, name);
  const built = spawnSync(
    require.resolve("esbuild/bin/esbuild", { paths: [pkg] }),
    [
      path.join(repoRoot, source),
      "--bundle", "--platform=node", "--format=esm", "--target=node22",
      `--outfile=${out}`, "--log-level=error",
    ],
    { stdio: "inherit" },
  );
  if (built.status !== 0) {
    console.error(`could not bundle ${source}`);
    process.exit(1);
  }
  return out;
};

const { renderPlan } = await import(pathToFileURL(bundle("artifacts/worker/src/ffmpeg.ts", "ffmpeg.mjs", "artifacts/worker")).href);
const { planFromText, replyFor } = await import(
  pathToFileURL(bundle("artifacts/api-server/src/lib/plan-from-text.ts", "plan.mjs", "artifacts/api-server")).href
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

const scratch = () => mkdtemp(path.join(tmpdir(), "editly-p-"));
const workDir = await scratch();

/**
 * What each operation owes the person once the render is done.
 *
 * Both branches are listed on purpose. "It happened" and "here is why it did
 * not" are equally acceptable answers; silence is the only unacceptable one.
 */
const OWED = {
  removeSilence: /removed [\d.]+s of silence|no silence found to remove|no audio track/,
  extractHighlight: /strongest [\d.]+s|could not hear the words in this clip|the stretch you named won/,
  extractRange: /kept [\d.]+s to [\d.]+s|shorter than a fifth of a second/,
  coldOpen: /opens on|could not find a moment strong enough/,
  fade: /faded in/,
  transition: /dissolved between the cuts|joined the cuts|wipe|slid|flash|too short to put a transition|no cuts in this edit|plays out of order|too many to overlap/i,
  formatForPlatform: /reframed to \d+x\d+/,
  burnCaptions: /burned \d+ captions/,
  watermark: /watermarked/,
  kenBurns: /slow push to/,
  // Both branches again: the punches are placed from the speech, so an edit
  // whose emphasis did not survive the cut legitimately has none — and says so.
  zoomPunch: /punch-in|no punch survived the cut/,
  normalizeLoudness: /levelled to/,
  grade: /warmed the picture|cooled the picture|graded it cinematic|took the colour out|pushed the contrast|colour pushed|colour pulled/,
  addMusic: /laid music under|skipped the music/,
  insertBRoll: /cut to b-roll|skipped an overlay|dropped an overlay/,
  overlayImage: /laid an image over|skipped an (image )?overlay|dropped an overlay/,
  motionTitle: /rendered \d+ title|could not render the titles|dropped a title/,
  // Three branches, and the second two matter as much as the first: an edit
  // with nothing to accent and a build with no sound files both come out as a
  // note, never as a failure, because a flourish must not fail paid work.
  soundEffects: /laid \d+ sound effect|left the sound effects out|could not find the sound effect files/,
};

/**
 * Two operations never reach the renderer, and neither is an omission.
 *
 * `autoCaptions` is resolved earlier, in enrich, into burnCaptions with real
 * cues — or dropped there with a note of its own when there is no transcript.
 * `extractClips` produces several files and is handled a layer above this one.
 * Listing them here rather than leaving them out of the table is the
 * difference between "we thought about it" and "we forgot".
 */
const RESOLVED_ELSEWHERE = new Set(["autoCaptions", "extractClips"]);

// ── The clip ────────────────────────────────────────────────────────────────
//
// Long, evenly spaced bursts, so the silence cut leaves pieces a transition can
// actually cross. A clip whose pieces are too short would make half the table
// below pass on the refusal branch, which is a check that proves nothing.
const source = path.join(workDir, "source.mp4");
{
  const windows = [];
  for (let t = 0; t < 36; t += 6) windows.push(`between(t,${t},${t + 4})`);
  const gen = spawnSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=36",
    "-f", "lavfi", "-i", "sine=frequency=320:duration=36",
    "-filter_complex", `[1:a]volume='if(${windows.join("+")},1,0)':eval=frame[a]`,
    "-map", "0:v", "-map", "[a]",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source,
  ]);
  if (gen.status !== 0) {
    console.error("could not generate the test clip");
    process.exit(1);
  }
}

// Sentences somebody would actually type, in both languages the matcher reads.
const SENTENCES = [
  "cut the silences and make it vertical for tiktok",
  "tighten it up, dissolve between the cuts, and level the audio",
  "give me the strongest 30 seconds, captioned, vertical for TikTok",
  "start with the best bit and fade it in and out",
  "make it cinematic and cut the dead air",
  "keep just 0:06 to 0:22 and add a slow push",
  "make it black and white and punchy for youtube",
  "اقصّ الصمت وخليها عمودية للتيك توك",
  "ابدأ بالأقوى وذوّب القصّات",
  "cut the silences and put sound effects on the cuts",
];

console.log("\nEvery sentence a person types becomes a video");
const rendersFor = new Map();
{
  const broke = [];
  for (const sentence of SENTENCES) {
    const intent = planFromText(sentence, {});
    if (intent.operations.length === 0) {
      broke.push(`${sentence}: produced no operations at all`);
      continue;
    }
    try {
      const out = await renderPlan(source, { version: 1, operations: intent.operations }, { workDir: await scratch() });
      rendersFor.set(sentence, { intent, out });
    } catch (e) {
      broke.push(`${sentence}: ${String(e?.message ?? e).slice(0, 140)}`);
    }
  }
  check(`all ${SENTENCES.length} of them plan and render`, broke.length === 0, broke.join(" | "));
}

console.log("\nAnd nothing the reply promised goes missing from the render");
{
  const silent = [];
  const untabled = [];
  for (const [sentence, { intent, out }] of rendersFor) {
    for (const op of intent.operations) {
      if (RESOLVED_ELSEWHERE.has(op.type)) continue;
      const owed = OWED[op.type];
      if (!owed) {
        untabled.push(`${op.type} (from "${sentence}")`);
        continue;
      }
      if (!out.notes.some((note) => owed.test(note))) {
        silent.push(`"${sentence}" planned ${op.type} and the notes never mention it: ${JSON.stringify(out.notes)}`);
      }
    }
  }
  check(
    "every operation either happened or said why it did not",
    silent.length === 0,
    silent.slice(0, 2).join(" | "),
  );
  // An operation with no row in the table is not a pass, it is an operation
  // nobody has decided what it owes.
  check(
    "and every operation planned has a row saying what it owes",
    untabled.length === 0,
    [...new Set(untabled)].join(", "),
  );
}

console.log("\nThe reply is a promise, so it is read back against the file");
{
  // The strongest form of the claim, on the sentence that asks for the most.
  const sentence = "tighten it up, dissolve between the cuts, and level the audio";
  const { intent, out } = rendersFor.get(sentence) ?? {};
  check("the sentence produced a render to read", Boolean(out), sentence);
  if (out) {
    const reply = replyFor(intent, { hasVideo: true });
    check("the reply promises the cut", /cut out the silences/.test(reply), reply);
    check("and the notes show it happened", out.notes.some((n) => /removed [\d.]+s of silence/.test(n)), JSON.stringify(out.notes));
    check("the reply promises the dissolve", /dissolve between the cuts/.test(reply), reply);
    check("and the notes show that happened too", out.notes.some((n) => /dissolved between the cuts/.test(n)), JSON.stringify(out.notes));
    check("the reply promises the levelling", /level the audio/.test(reply), reply);
    check("and the notes show it", out.notes.some((n) => /levelled to/.test(n)), JSON.stringify(out.notes));
    check("and the reply promised nothing it did not plan", intent.cannotYet.length === 0, JSON.stringify(intent.cannotYet));
  }
}

await rm(workDir, { recursive: true, force: true });
await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("What the sentence promised is what the file contains.");
