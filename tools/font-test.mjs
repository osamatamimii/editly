/**
 * Every caption face draws what the catalogue says it draws.
 *
 * `lib/api-zod/src/fonts.ts` holds three numbers per face and each of them is a
 * way to be silently wrong.
 *
 * **The family.** A style row hands it to fontconfig. Get it wrong and nothing
 * fails: fontconfig substitutes, libass draws, the words are right, the timing
 * is right, and the font is not the one anybody chose. Measured, a style naming
 * a font that does not exist renders byte-identically to one naming DejaVu Sans.
 *
 * **The ratio.** ASS `Fontsize` is the *line height*, and how much of it a
 * letter occupies is a property of the face — from 0.31 to 0.57 across these
 * twelve. The layout picks a height in pixels and divides by this to get the
 * nominal size, so a face whose entry is wrong renders every caption in it at
 * the wrong size, on a face nobody complained about, with nothing failing.
 *
 * **The width scale.** How wide the face runs against the one the per-character
 * advance table was measured from. Anton and Bebas Neue are a little over half
 * of Montserrat's width per unit of height; Archivo Black is wider. Too small
 * and a line runs past the platform's safe area and the last word sits under
 * the username; too large and the caption wraps a third early. Neither fails.
 *
 * So this measures all three, by rendering through libass and counting drawn
 * pixels, against the exact files in `artifacts/worker/fonts/`. It is the same
 * question the image build asks — and it asks it here too, because a red build
 * is a slower place to find out than a red suite.
 *
 * And one thing the ratios cannot see: whether the face draws the shapes nobody
 * types. FriBidi rewrites Arabic to the legacy presentation forms and looks
 * those up in the cmap; five of the seven Arabic faces tried for this product
 * mapped none of the isolated ones, and one mapped none at all. On a system
 * with another Arabic font the letter comes from *that* one instead, at its
 * proportions, in the middle of a caption — which is worse than a box, because
 * it is legible.
 *
 * Usage: node tools/font-test.mjs [--resolve-only]
 * Requires: ffmpeg with libass, and the faces installed where fontconfig can
 * see them. No database, no keys, no network.
 */
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

const repoRoot = process.cwd();
const work = await mkdtemp(path.join(tmpdir(), "editly-fonts-"));

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

/*
  The catalogue, read as text.

  Not imported: it is TypeScript, this is a plain Node script, and bundling it
  through esbuild to read a table of twelve numbers is a build step in the way
  of a measurement. What matters is that the numbers come from the file the
  product ships rather than from a copy in here, and a strict parse gives that
  — with a count assertion so a parse that quietly reads nothing is a failure
  rather than a suite that checks zero faces and passes.
*/
const source = await readFile(path.join(repoRoot, "lib/api-zod/src/fonts.ts"), "utf8");
const FACES = [...source.matchAll(/\n\s{4}id:\s*"([^"]+)",[\s\S]*?script:\s*"(latin|arabic)",[\s\S]*?family:\s*"([^"]+)",\s*\n\s*file:\s*"([^"]+)",\s*\n\s*capRatio:\s*([0-9.]+),\s*\n\s*widthScale:\s*([0-9.]+),/g)].map(
  (m) => ({ id: m[1], script: m[2], family: m[3], file: m[4], capRatio: Number(m[5]), widthScale: Number(m[6]) }),
);

section("The catalogue is readable, and it is the file the product ships");
check("the parse found faces at all", FACES.length >= 12, `${FACES.length}`);
check(
  "at least six of each script, so neither language is an afterthought",
  /*
    A floor rather than parity, and the reason is Rubik.

    It covers both scripts and was listed for both — then a real Arabic word
    drew a box, because it has no lam-alef ligature glyph for plain alef and
    FriBidi asks for U+FEFB by codepoint. So it is a Latin face only, and the
    lists are seven and six.

    Making them equal again would have meant shipping a seventh Arabic face to
    satisfy a count, which is the wrong reason to ship a font. The rule that
    matters is the one below: a face is listed for a script only if it can draw
    a word in it.
  */
  FACES.filter((f) => f.script === "latin").length >= 6 &&
    FACES.filter((f) => f.script === "arabic").length >= 6,
  `${FACES.filter((f) => f.script === "latin").length} latin, ${FACES.filter((f) => f.script === "arabic").length} arabic`,
);
check(
  "every id is unique, because the picker and the plan address a face by it",
  new Set(FACES.map((f) => f.id)).size === FACES.length,
  FACES.map((f) => f.id).join(","),
);
if (FACES.length === 0) {
  console.log("\nnothing to measure: the parse above found no faces");
  process.exit(1);
}

section("Every face is a file in the repository, with its licence beside it");
for (const face of FACES) {
  const ttf = path.join(repoRoot, "artifacts/worker/fonts", face.file);
  check(`${face.family}: the file is committed`, existsSync(ttf), face.file);
  /*
    The licence, found by the file rather than by the id.

    A face listed under both scripts is two catalogue entries over one file,
    and one licence covers it. Keying this on the id asked for a second copy of
    the same OFL under a second name — which the licence does not require and
    which would be one more thing to keep in step.
  */
  const licences = [...new Set(FACES.filter((f) => f.file === face.file).map((f) => f.id))];
  check(
    `${face.file}: the OFL travels with it, because the licence requires that`,
    licences.some((id) => existsSync(path.join(repoRoot, "artifacts/worker/fonts", `${id}-OFL.txt`))),
    licences.map((id) => `${id}-OFL.txt`).join(" or "),
  );
}

// ── What libass draws ───────────────────────────────────────────────────────

const SIZE = 100;
const W = 500;
const H = 500;

/**
 * The height of the ink a face draws for some text, at nominal 100.
 *
 * Bold on, because the renderer's style rows are bold and a face that
 * fontconfig cannot satisfy gets synthesised weight, which changes the answer.
 * A measurement taken under different flags from the thing it describes is a
 * measurement of something else.
 */
function drawTo(family, text) {
  const ass = path.join(work, "m.ass");
  const png = path.join(work, "m.png");
  const rows = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    "WrapStyle: 2",
    "",
    "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,OutlineColour,BackColour,Bold,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    `Style: P,${family},${SIZE},&H00FFFFFF,&H00000000,&H00000000,-1,1,0,0,5,10,10,10,1`,
    "",
    "[Events]",
    "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
    `Dialogue: 0,0:00:00.00,0:00:01.00,P,,0,0,0,,{\\an5\\pos(${W / 2},${H / 2})}${text}`,
  ].join("\n");
  writeFileSync(ass, `${rows}\n`);
  spawnSync("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", `color=c=black:s=${W}x${H}:d=1`,
    "-vf", `subtitles=${ass}`, "-frames:v", "1", "-y", png,
  ]);
  return png;
}

function inkHeight(family, text) {
  return inkOf(family, text).h;
}

/**
 * Everything about the ink at once: how much of it, how big, and a signature.
 *
 * The signature is what lets a check ask "is this the same glyph" rather than
 * "is this about the same height", which is the difference between catching a
 * font that cannot draw لا and passing it. Two runs of the same `.notdef` box
 * produce the same three numbers to the pixel; two different glyphs do not.
 */
function inkOf(family, text) {
  const png = drawTo(family, text);
  const grey = spawnSync("ffmpeg", [
    "-v", "error", "-i", png, "-vf", "format=gray", "-frames:v", "1", "-f", "rawvideo", "-",
  ], { maxBuffer: 1 << 26 }).stdout;
  if (!grey || grey.length < W * H) return { ink: 0, w: 0, h: 0, signature: "none" };
  let ink = 0;
  let top = -1;
  let bottom = -1;
  let left = W;
  let right = -1;
  for (let y = 0; y < H; y += 1) {
    const row = y * W;
    for (let x = 0; x < W; x += 1) {
      if (grey[row + x] > 40) {
        ink += 1;
        if (top < 0) top = y;
        bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  const w = right < 0 ? 0 : right - left + 1;
  const h = top < 0 ? 0 : bottom - top + 1;
  return { ink, w, h, signature: `${ink}:${w}x${h}` };
}

/** The width of the ink, for the same text at the same size. */
function inkWidth(family, text) {
  const ass = path.join(work, "w.ass");
  const png = path.join(work, "w.png");
  const wide = 3600;
  const rows = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${wide}`,
    "PlayResY: 400",
    "WrapStyle: 2",
    "",
    "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,OutlineColour,BackColour,Bold,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    `Style: P,${family},${SIZE},&H00FFFFFF,&H00000000,&H00000000,-1,1,0,0,5,10,10,10,1`,
    "",
    "[Events]",
    "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
    `Dialogue: 0,0:00:00.00,0:00:01.00,P,,0,0,0,,{\\an5\\pos(${wide / 2},200)}${text}`,
  ].join("\n");
  writeFileSync(ass, `${rows}\n`);
  spawnSync("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", `color=c=black:s=${wide}x400:d=1`,
    "-vf", `subtitles=${ass}`, "-frames:v", "1", "-y", png,
  ]);
  const grey = spawnSync("ffmpeg", [
    "-v", "error", "-i", png, "-vf", "format=gray", "-frames:v", "1", "-f", "rawvideo", "-",
  ], { maxBuffer: 1 << 26 }).stdout;
  if (!grey) return 0;
  let left = wide;
  let right = -1;
  for (let y = 0; y < 400; y += 1) {
    const row = y * wide;
    for (let x = 0; x < wide; x += 1) {
      if (grey[row + x] > 40) {
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  return right < 0 ? 0 : right - left + 1;
}

const CAPS = "HANDLING";
const ALEFS = "ا".repeat(14);
const ISOLATED = "ﺍ".repeat(14);
const FSI = "⁦";
const PDI = "⁩";
const sampleFor = (face) => (face.script === "arabic" ? ALEFS : CAPS);

section("Every family resolves to the file this repository ships");
{
  // The tell is difference. A missing family is not an error — fontconfig
  // substitutes, and DejaVu draws perfectly legible Latin and Arabic.
  const fallback = { latin: inkHeight("DejaVu Sans", CAPS), arabic: inkHeight("DejaVu Sans", ALEFS) };
  for (const face of FACES) {
    const drawn = inkHeight(face.family, sampleFor(face));
    check(
      `${face.family}: draws, and not as the fallback`,
      drawn > 0 && drawn !== fallback[face.script],
      `${drawn} against DejaVu's ${fallback[face.script]}`,
    );
  }
}

if (process.argv.includes("--resolve-only")) {
  await rm(work, { recursive: true, force: true });
  console.log(`\n${checks - failures}/${checks} checks passed`);
  process.exit(failures > 0 ? 1 : 0);
}

section("Every ratio in the catalogue is the ratio the face actually draws");
for (const face of FACES) {
  const drawn = inkHeight(face.family, sampleFor(face)) / SIZE;
  check(
    `${face.family}: ${face.capRatio} in fonts.ts, ${drawn.toFixed(2)} on the frame`,
    Math.abs(drawn - face.capRatio) <= 0.04,
    // Wrong here means every caption in this face renders the wrong size, and
    // there is nothing else in the product that would notice.
    `${drawn.toFixed(3)} drawn against ${face.capRatio} declared`,
  );
}

section("Every width scale is the width the face actually runs at");
{
  const base = {
    latin: FACES.find((f) => f.id === "montserrat-black"),
    arabic: FACES.find((f) => f.id === "cairo-black"),
  };
  const SAMPLES = {
    latin: ["the quick brown fox jumps over a lazy dog", "NOBODY TELLS YOU THIS BUT IT CHANGES"],
    arabic: ["لكنه يغير كل شيء عن الطريقة التي تحرر بها", "محمد سعيد ابراهيم شمس"],
  };
  const perCap = (face, text) => inkWidth(face.family, text) / text.length / (face.capRatio * SIZE);
  const baseline = {
    latin: Math.max(...SAMPLES.latin.map((t) => perCap(base.latin, t))),
    arabic: Math.max(...SAMPLES.arabic.map((t) => perCap(base.arabic, t))),
  };
  for (const face of FACES) {
    const measured = Math.max(...SAMPLES[face.script].map((t) => perCap(face, t))) / baseline[face.script];
    check(
      `${face.family}: declared ${face.widthScale}, measures ${measured.toFixed(2)}`,
      // Declared is rounded *up* from measured on purpose: a scale that is too
      // small runs a line past the safe area, and a scale that is too large
      // costs a line break. Those two do not cost the same, so the check is
      // one-sided — never below what the face runs at, never more than a
      // quarter above it.
      face.widthScale >= measured - 0.02 && face.widthScale <= measured + 0.25,
      `${measured.toFixed(3)} measured against ${face.widthScale} declared`,
    );
  }
}

section("Every Arabic face draws a word, not just letters");
{
  /*
    The check that was missing, and the one that found the bug.

    Everything else here draws runs of one letter and measures a height, which
    is a fine way to ask "is this face installed and what size is it" and no
    way at all to ask "can it draw Arabic". Rubik passed every one of them and
    could not render لا — the commonest two letters in the language.

    The reason first written here was that Rubik has no lam-alef ligature glyph.
    It has one, for plain alef, in both its forms; what the file lacked was a
    codepoint pointing at it, because FriBidi asks for U+FEFB by codepoint and
    `facerepair.py` searched its GSUB under the wrong names. The wrong diagnosis
    does not weaken this check — it is the reason it exists, and it is the check
    that would have caught the mistake either way.

    So: one real sentence, containing initial, medial, final and isolated
    forms and the lam-alef ligature, measured against a row of boxes. A face
    that cannot draw it does not go in the list for that script, whatever else
    it can do.

    Boxes measured in the same face, because a `.notdef` box is a glyph of the
    font and its height is the font's.
  */
  for (const face of FACES.filter((f) => f.script === "arabic")) {
    /*
      Lam-alef, on its own, against the face's own box.

      A whole sentence does not work as the sample and it is worth saying why:
      one box among fifteen letters barely moves the height of the tallest ink,
      and the first version of this check passed Rubik with a box in the middle
      of it. Drawing the one shape in question, several times, and comparing it
      to the same face's `.notdef` is unambiguous — 61 against 62 for Rubik,
      30 against 38 for Cairo.

      Against the *face's own* box rather than a constant, because a box is a
      glyph of the font and its height is the font's.
    */
    const boxes = inkOf(face.family, "\uE000".repeat(3));
    const ligature = inkOf(face.family, "لا".repeat(3));
    check(
      `${face.family}: لا is a ligature and not a box`,
      // Difference, not a threshold. If the face has no U+FEFB glyph, FriBidi's
      // lam-alef codepoint resolves to `.notdef` and three of them render
      // *identically* to three boxes — same glyph, same advance, same pixels.
      // A height comparison is not enough: in Cairo the ligature and the box
      // happen to be the same height, and the first version of this check went
      // red on three correct fonts because of it.
      ligature.ink > 0 && ligature.signature !== boxes.signature,
      `lam-alef ${ligature.ink}px of ink at ${ligature.w}x${ligature.h}, a box ${boxes.ink} at ${boxes.w}x${boxes.h}`,
    );
    const sentence = inkHeight(face.family, "لا أحد يخبرك بهذا");
    check(
      `${face.family}: and a whole sentence draws`,
      sentence > 0,
      `${sentence}`,
    );
  }
}

section("Every Arabic face draws the letters that stand alone");
for (const face of FACES.filter((f) => f.script === "arabic")) {
  /*
    The legacy presentation forms, asked for directly.

    Alef, dal, thal, reh, zain and waw never join leftward, so the letter after
    any of them is isolated; an alef opening a word is isolated; a one-letter
    word is isolated. FriBidi rewrites each of those to U+FE8D and its
    siblings, and a modern face maps none of them — the isolated shape is the
    base glyph, and U+FE8D is a duplicate nobody should need.
  */
  const own = inkHeight(face.family, ALEFS);
  const isolated = inkHeight(face.family, ISOLATED);
  check(
    `${face.family}: an isolated alef draws like its own alef`,
    isolated > 0 && Math.abs(isolated - own) <= 4,
    `${isolated} against ${own} — a different number means the letter came from another font, or from none`,
  );
}

section("And the two invisible characters this renderer adds itself");
for (const face of FACES) {
  // Every right-to-left line is wrapped in FSI and PDI so a line beginning
  // with a Latin word cannot flip. Most of these faces map neither by default.
  const plain = inkHeight(face.family, sampleFor(face));
  const wrapped = inkHeight(face.family, `${FSI}${sampleFor(face)}${PDI}`);
  check(
    `${face.family}: FSI and PDI draw nothing`,
    wrapped === plain,
    `${wrapped} wrapped against ${plain} plain — they are drawing, at both ends of every caption`,
  );
}

section("The picker previews the same faces the renderer burns");
{
  const web = path.join(repoRoot, "artifacts/editly/public/caption-fonts");
  for (const face of FACES) {
    check(
      `${face.id}: there is a preview to draw the picker with`,
      existsSync(path.join(web, `${face.id}.woff2`)),
      `${face.id}.woff2`,
    );
  }
}

await rm(work, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("Every caption face draws what the catalogue says it draws.");
