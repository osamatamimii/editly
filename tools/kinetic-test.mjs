/**
 * Captions that arrive with the voice, measured in drawn pixels.
 *
 * The motion engine in `motion.ts` is the best thing in this renderer — a page
 * paused and seeked frame by frame, so the same scene renders to the same bytes
 * twice — and it serves `motionTitle` and nothing else. The caption, which is
 * what appears in almost every video this product makes, went through libass
 * with a fade and nothing more.
 *
 * Routing captions through that engine is the obvious idea and it is wrong:
 * four screenshots per output frame over a whole video is thousands of page
 * paints for something libass draws for free in the same filter pass. So this
 * is done in ASS, and ASS is a format with opinions — which is why almost every
 * check below renders the file rather than reading it.
 *
 * ## The two findings that shaped the design, both from measurement
 *
 * **An `\alpha` override splits the layout run**, exactly as `\kf` does. In a
 * 720-wide probe the first word of an Arabic sentence lit up at the *left* end
 * of the line: every word shaped correctly and the sentence backwards. So the
 * runs are laid down in reverse for a right-to-left line, and this suite checks
 * that they still are.
 *
 * **The scale pop widens the line**, by about the popped word's share of it:
 * measured at 394 drawn pixels becoming 400 in a 488-pixel band. `WrapStyle: 2`
 * means libass does no wrapping of its own and `wrapToLayout` fills that band
 * at 100%, so on a line filled to the last pixel that five per cent goes past
 * the margin the layout reserved. The pop is therefore conditional on measured
 * headroom, and the last section is where that is checked.
 *
 * Usage: node tools/kinetic-test.mjs
 * Requires: ffmpeg with libass, and the caption faces on the machine.
 */
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-kinetic-"));
const at = (name) => path.join(buildDir, name);

function bundle(entry, name) {
  const outfile = at(name);
  const built = spawnSync(
    require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/worker"] }),
    [
      path.join(repoRoot, entry),
      "--bundle", "--platform=node", "--format=esm", "--target=node22",
      `--outfile=${outfile}`, "--log-level=error",
    ],
    { stdio: "inherit" },
  );
  if (built.status !== 0) process.exit(1);
  return pathToFileURL(outfile).href;
}

const ffmpegMod = await import(bundle("artifacts/worker/src/ffmpeg.ts", "ffmpeg.mjs"));
const layoutMod = await import(bundle("artifacts/worker/src/caption-layout.ts", "layout.mjs"));
const captionsMod = await import(bundle("artifacts/worker/src/captions.ts", "captions.mjs"));

const { writeSubtitleFile, wrapToLayout, POP_SCALE } = ffmpegMod;
const { captionLayout, widthInCaps, CAPTION_FACES } = layoutMod;
const { emphasisScore, emphasisPoints, EMPHASIS_MIN_SCORE, medianOf } = captionsMod;

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

const FRAME = { width: 720, height: 1280 };
const LAYOUT = captionLayout(FRAME, "tiktok");

function ff(args) {
  const run = spawnSync("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", ...args], {
    encoding: "utf8",
  });
  if (run.status !== 0) {
    console.error(run.stderr);
    throw new Error("ffmpeg failed");
  }
}

/** Write the cue's subtitle file and hand back its text. */
async function assFor(cue, animation, style = "bold-white") {
  const file = at(`k-${Math.random().toString(36).slice(2, 8)}.ass`);
  await writeSubtitleFile(file, wrapToLayout([cue], LAYOUT), style, animation, FRAME, LAYOUT);
  return { file, text: await readFile(file, "utf8") };
}

/**
 * What is lit, and where, read straight out of ffmpeg as raw pixels.
 *
 * No PNG and no image library: one `rawvideo` frame is the same bytes with
 * nothing in between to disagree about gamma or palette, and it keeps this
 * suite's dependencies at ffmpeg alone — which every render suite here already
 * needs.
 *
 * The whole frame, pixel by pixel, rather than a squeezed column. Averaging a
 * row across the frame turns a line of short letters into a number under the
 * floor, and a measurement that is noisy toward "found a bug" is worse than no
 * measurement: it teaches whoever reads it to ignore it.
 */
function ink(rgb, width, height) {
  let lit = 0, accent = 0, x0 = width, x1 = -1;
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const i = (width * y + x) * 3;
      const r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
      if (r + g + b <= 240) continue;
      lit += 1;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      // The emphasis colour for bold-white is yellow: red and green high, blue low.
      if (r > 180 && g > 140 && b < 110) accent += 1;
    }
  }
  return { lit, accent, x0: x1 < 0 ? 0 : x0, x1, width: x1 < 0 ? 0 : x1 - x0 };
}

/** Render one subtitle file and measure the frame at each of these seconds. */
function frames(file, seconds) {
  const source = at(`src-${Math.random().toString(36).slice(2, 8)}.mp4`);
  ff(["-f", "lavfi", "-i", `color=c=black:s=${FRAME.width}x${FRAME.height}:d=4:r=25`,
      "-vf", `subtitles=${file.replace(/[\\:']/g, "\\$&")}`, "-frames:v", "100", source]);
  return seconds.map((s) => {
    /*
      A source long enough to hold every sample. Seeking past the end writes an
      empty frame, which measures as a caption that drew nothing — the same
      false pass this whole file exists to remove — so a short read throws.
    */
    const run = spawnSync(
      "ffmpeg",
      ["-hide_banner", "-nostdin", "-v", "error", "-ss", String(s), "-i", source,
       "-vf", "format=rgb24", "-frames:v", "1", "-f", "rawvideo", "-"],
      { maxBuffer: 1 << 28 },
    );
    if (run.status !== 0 || run.stdout.length < FRAME.width * FRAME.height * 3) {
      throw new Error(`no frame at ${s}s (${run.stdout.length} bytes)`);
    }
    return ink(run.stdout, FRAME.width, FRAME.height);
  });
}

/** A cue whose words are evenly spaced, so the reveal times are predictable. */
function cueOf(words, { startMs = 0, endMs = 3000, each = 500 } = {}) {
  return {
    startMs,
    endMs,
    text: words.join(" "),
    words: words.map((text, i) => ({
      startMs: startMs + i * each,
      endMs: startMs + i * each + each - 60,
      text,
    })),
  };
}

// ── One rule, two readers ───────────────────────────────────────────────────

section("The stressed word is chosen by the same rule the punch-in uses");
{
  /*
    Two readers of this signal now: a punch-in lands on a stressed word, and the
    caption draws that word larger. Two implementations of "which word matters"
    would give a video where the picture punches on one word while the caption
    emphasises another — which reads as the software not understanding the
    sentence, and which no test of either half alone would catch.
  */
  const typical = 300;
  const ordinary = emphasisScore({ startMs: 1000, endMs: 1300 }, { startMs: 700, endMs: 1000 }, typical);
  check("an ordinary word in flow scores about 1", Math.abs(ordinary - 1) < 0.01, ordinary.toFixed(2));
  check("and is below the threshold", ordinary < EMPHASIS_MIN_SCORE);

  const held = emphasisScore({ startMs: 1000, endMs: 1900 }, { startMs: 700, endMs: 1000 }, typical);
  check("a word held three times as long scores 3", Math.abs(held - 3) < 0.01, held.toFixed(2));

  const afterPause = emphasisScore({ startMs: 1800, endMs: 2100 }, { startMs: 700, endMs: 1000 }, typical);
  check("a word after a long pause clears the threshold too", afterPause >= EMPHASIS_MIN_SCORE, afterPause.toFixed(2));

  /*
    Capped, so one enormous gap cannot make an ordinary word the loudest thing
    in the video. A pause is evidence up to a point and then it is just a pause.
  */
  const hugePause = emphasisScore({ startMs: 60_000, endMs: 60_300 }, { startMs: 700, endMs: 1000 }, typical);
  check("and a pause of a minute counts no more than one of 800ms", Math.abs(hugePause - afterPause) < 0.01);

  check("a zero-length word scores nothing", emphasisScore({ startMs: 5, endMs: 5 }, undefined, typical) === 0);
  check("and so does a word with no pace to judge against", emphasisScore({ startMs: 0, endMs: 300 }, undefined, 0) === 0);

  // The punch-in reader still answers what it answered, through the shared rule.
  const transcript = {
    segments: [{
      words: [
        { startMs: 0, endMs: 300, text: "one", filler: false },
        { startMs: 320, endMs: 620, text: "two", filler: false },
        { startMs: 640, endMs: 940, text: "three", filler: false },
        { startMs: 960, endMs: 1900, text: "FOUR", filler: false },
        { startMs: 1920, endMs: 2220, text: "five", filler: false },
      ],
    }],
  };
  check("the punch reader still finds the held word", emphasisPoints(transcript).includes(0.96), JSON.stringify(emphasisPoints(transcript)));
  check("median is the middle value", medianOf([1, 100, 2]) === 2);
}

// ── The file ────────────────────────────────────────────────────────────────

section("Each word gets its own reveal, on the cue's own clock");
{
  const { text } = await assFor(cueOf(["one", "two", "three", "four"]), "kinetic");
  const event = text.split("[Events]")[1];
  const reveals = [...event.matchAll(/\\alpha&HFF&\\t\((\d+),(\d+),\\alpha&H00&/g)];
  check("one reveal per word", reveals.length === 4, String(reveals.length));
  check(
    "and each is timed to when that word is spoken",
    reveals.map((m) => Number(m[1])).join(",") === "0,500,1000,1500",
    reveals.map((m) => m[1]).join(","),
  );
  check("the reveal is a step, not a fade", reveals.every((m) => Number(m[2]) - Number(m[1]) === 1));
  check("no fade in, because the words bring themselves in", /\\fad\(0,60\)/.test(event));
  check("no unescaped braces leak into the text", !/[^\\]\{[^\\]/.test(event));

  /*
    A cue that starts at 40s has words whose timings are on the source clock,
    and `\t` measures from the line's own start. Getting this wrong is invisible
    in a test that starts every cue at zero, and in a real video it means every
    caption after the first reveals all its words instantly.
  */
  const later = await assFor(cueOf(["one", "two"], { startMs: 40_000, endMs: 42_000 }), "kinetic");
  const offsets = [...later.text.split("[Events]")[1].matchAll(/\\t\((\d+),\d+,\\alpha&H00&/g)].map((m) => m[1]);
  check("times are relative to the line, not to the video", offsets.join(",") === "0,500", offsets.join(","));
}

section("One word per cue is emphasised, and only when it earns it");
{
  const stressed = cueOf(["a", "quiet", "line", "here"]);
  // The third word is held three times as long as the others.
  stressed.words[2] = { startMs: 1000, endMs: 2320, text: "line" };
  const { text } = await assFor(stressed, "kinetic");
  const event = text.split("[Events]")[1];
  check("the accent colour is set once", (event.match(/\\c&H00E5FF&/g) ?? []).length === 1, String((event.match(/\\c&H00E5FF&/g) ?? []).length));
  check("on the held word", /\\c&H00E5FF&\)/.test(event) || /line/.test(event));
  check("and it pops and settles back to 100", /\\fscx115\\fscy115\)/.test(event) && /\\fscx100\\fscy100\)/.test(event));

  const flat = await assFor(cueOf(["all", "of", "these", "are", "even"]), "kinetic");
  /*
    Flat delivery gets no emphasis at all rather than an arbitrary word, which
    is the same rule the punch-in lives by: emphasis on ordinary speech is the
    tell of an automatic edit.
  */
  check("a flatly-read line gets none", !/\\c&H00E5FF&/.test(flat.text.split("[Events]")[1]));

  const yellow = await assFor(stressed, "kinetic", "bold-yellow");
  check(
    "and on a yellow caption the accent is white, because yellow on yellow is not emphasis",
    /\\c&HFFFFFF&/.test(yellow.text.split("[Events]")[1]),
  );
}

section("A right-to-left line is laid down in reverse");
{
  /*
    Measured, not assumed. An override block carrying `\alpha` and `\t` starts a
    new layout run exactly as `\kf` does; libass reorders within a run and then
    sets the runs down left to right, so the first word of an Arabic sentence
    lit up at the left end of the line. Every word shaped perfectly, and the
    sentence backwards.
  */
  const { text } = await assFor(cueOf(["مرحبا", "بالعالم", "كله"]), "kinetic");
  const event = text.split("[Events]")[1];
  const order = [...event.matchAll(/\\alpha&H00&[^}]*\}⁨([^⁩]+)⁩/g)].map((m) => m[1]);
  check("the words are emitted last-first", order.join("|") === "كله|بالعالم|مرحبا", order.join("|"));
  const times = [...event.matchAll(/\\t\((\d+),\d+,\\alpha&H00&/g)].map((m) => Number(m[1]));
  check(
    "so their reveal times run backwards down the file",
    times.join(",") === "1000,500,0",
    times.join(","),
  );

  const latin = await assFor(cueOf(["one", "two", "three"]), "kinetic");
  const latinOrder = [...latin.text.split("[Events]")[1].matchAll(/\\alpha&H00&[^}]*\}⁨([^⁩]+)⁩/g)].map((m) => m[1]);
  check("a left-to-right line is not reversed", latinOrder.join("|") === "one|two|three", latinOrder.join("|"));
}

section("Without word timings it says so instead of pretending");
{
  const { text } = await assFor({ startMs: 0, endMs: 2000, text: "no words here" }, "kinetic");
  const event = text.split("[Events]")[1];
  /*
    A word cannot arrive when it is spoken if nobody said when it was spoken.
    The animation degrades to the whole caption popping in — a real animation,
    and not the one that was asked for — and the renderer writes a note saying
    which, because somebody who asked, did not get it, and was told they did
    has no way to find out why.
  */
  check("it falls back rather than emitting a broken reveal", !/\\alpha&HFF&/.test(event));
  check("and what it falls back to is the pop", /\\fscx70\\fscy70/.test(event));
}

// ── The pixels ──────────────────────────────────────────────────────────────

section("What libass actually draws");
{
  const cue = cueOf(["ONE", "TWO", "THREE"], { each: 600, endMs: 3000 });
  // The second word is held, so it is the one that earns the emphasis.
  cue.words[1] = { startMs: 600, endMs: 1700, text: "TWO" };
  const { file } = await assFor(cue, "kinetic");
  const [first, second, third, settled] = frames(file, [0.3, 0.9, 1.4, 2.6]);

  check("ink grows as the words arrive", first.lit < second.lit && second.lit < third.lit,
    `${first.lit} → ${second.lit} → ${third.lit}`);
  check("something is drawn from the first word onward", first.lit > 50, String(first.lit));
  check("the accent colour appears only once the held word does", first.accent === 0 && second.accent > 0,
    `${first.accent} then ${second.accent}`);

  /*
    The line's geometry is restored.

    The pop overshoots and settles back to exactly 100%, so once it is over the
    line occupies the box `wrapToLayout` measured — and the caption after the
    animation is the caption the layout checked against the platform's safe
    area. A pop that ended anywhere but 100% would leave every later caption
    fractionally wider than the block that was checked.
  */
  const popless = await assFor(cue, "pop");
  const [reference] = frames(popless.file, [2.6]);
  check(
    "and once the pop has settled the line is the width the layout planned",
    Math.abs(settled.width - reference.width) <= 4,
    `kinetic ${settled.width}px vs pop ${reference.width}px`,
  );
}

section("And the pop never pushes a line off the frame");
{
  /*
    The finding that made the pop conditional.

    `WrapStyle: 2` means libass does no wrapping of its own: a line wider than
    the frame runs off it. `wrapToLayout` guarantees every line fits **at
    100%**, and scaling one word to 115% widens the whole line — on a 720-wide
    probe the lit pixels went from x=10 to x=0 the instant the pop began. That
    is the exact failure `caption-layout.ts` exists to prevent, arriving through
    a door it does not watch.
  */
  const allowed = LAYOUT.usableWidth / LAYOUT.capHeight;
  check("the layout has a usable width to measure against", allowed > 0, String(allowed));

  /*
    A line grown until it fits at 100% and would not fit at the pop's scale.

    Three tokens rather than one, because a lone word is its own median:
    nothing is longer than typical when it is the only thing measured, so a
    one-word cue can never earn the emphasis this case is about. And grown a
    narrow character at a time, so the line lands in the band between the two
    thresholds instead of stepping over it.
  */
  const tokens = ["M", "M", "MM"];
  const join = () => tokens.join(" ");
  const caps = () => widthInCaps(join(), CAPTION_FACES.latin.widthScale);
  while (caps() * POP_SCALE < allowed && join().length < 400) tokens[0] += "i";

  check("the fixture fits the frame as it is", caps() <= allowed, `${caps().toFixed(1)} of ${allowed.toFixed(1)} caps`);
  check(
    "and would not fit if one word grew",
    caps() * POP_SCALE > allowed,
    `${(caps() * POP_SCALE).toFixed(1)} of ${allowed.toFixed(1)} caps`,
  );

  const tight = {
    startMs: 0, endMs: 3000, text: join(),
    words: [
      { startMs: 0, endMs: 300, text: tokens[0] },
      { startMs: 350, endMs: 650, text: tokens[1] },
      { startMs: 700, endMs: 1600, text: tokens[2] },
    ],
  };
  const { text, file } = await assFor(tight, "kinetic");
  const event = text.split("[Events]")[1];

  check("and the wrapper left it on one line", !/\\N/.test(event), "");
  check(
    "so it gets the colour and not the scale",
    /\\c&H00E5FF&/.test(event) && !/\\fscx115/.test(event),
    /\\fscx115/.test(event) ? "it popped anyway" : "no colour either",
  );

  /*
    The invariant, sampled while the scale is actually applied.

    Three corrections got this here, and the last one is worth more than the
    check. It first took frames at 0.1, 0.2, 0.35 and 1.0 — every one outside
    the 300ms the scale runs for — so deleting the guard left it green while
    the line grew. The stressed word reveals at 700ms, peaks at 841 and is back
    at 100% by 1001, so these three sit inside that window.

    Then the band, not the frame edge: `caption-layout.ts` promises the space
    between the margins, which is what keeps a caption clear of a username, and
    an edge check would pass on a caption sitting under one.

    And then the honest part. **Deleting the guard does not turn this check
    red**, and the reason is measured: one word of three grown by 15% widens the
    line by about 5%, from 394 drawn pixels to 400, and the fixture's own width
    estimate is conservative enough that 5% still lands inside 488. So this is
    an invariant, not a test of the guard — the guard is caught structurally,
    two checks above, and that one does go red when it is removed. Saying which
    check proves what is the difference between a suite and a decoration.
  */
  const samples = frames(file, [0.75, 0.85, 0.95]);
  const inside = (s) => s.x0 >= LAYOUT.marginL - 2 && s.x1 <= FRAME.width - LAYOUT.marginR + 2;
  check(
    "and stays inside the band the layout reserved",
    samples.every(inside),
    samples.map((s) => `${s.x0}..${s.x1}`).join(" ") + ` in ${LAYOUT.marginL}..${FRAME.width - LAYOUT.marginR}`,
  );

  // And the guard is a guard, not a coincidence: a short line still pops.
  const roomy = {
    startMs: 0, endMs: 3000, text: "and this one",
    words: [
      { startMs: 0, endMs: 300, text: "and" },
      { startMs: 350, endMs: 650, text: "this" },
      { startMs: 700, endMs: 1600, text: "one" },
    ],
  };
  const short = await assFor(roomy, "kinetic");
  check(
    "while a line with room keeps it",
    /\\fscx115/.test(short.text.split("[Events]")[1]),
  );
}

await rm(buildDir, { recursive: true, force: true });
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
console.log("The caption arrives with the voice, and stays inside its band.");
