/**
 * A font nobody vetted, measured on the machine that will burn with it.
 *
 * `tools/font-test.mjs` checks the thirteen faces this product ships against
 * the numbers written beside them. This checks the other direction: hand the
 * intake a file it has never seen, and see whether it comes back with numbers
 * that are true, or a refusal that says something a person can act on.
 *
 * The two halves are the same question asked from both ends, and the second
 * one is the one that matters more. Our thirteen were repaired by hand and
 * measured by hand; an uploaded font gets whatever this code does, once, with
 * nobody looking. Everything the catalogue's header says about being silently
 * wrong applies harder here.
 *
 * ## What it bites against
 *
 * Real files, not fixtures. The thirteen shipped faces, whose numbers are
 * known, so a measurement that drifts is caught against a known answer; and
 * the eleven fonts a person actually uploaded to this product, six of which
 * are `.otf` with cubic outlines — the case the repair had to grow a converter
 * for, and the case a fixture would never have contained.
 *
 * Usage: node tools/user-font-test.mjs
 * Requires: ffmpeg with libass, python3 with fonttools. No database, no keys.
 */
import { mkdtemp, rm, mkdir, copyFile, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-userfont-build-"));

function bundle(entry, name) {
  const outfile = path.join(buildDir, name);
  const result = spawnSync(
    require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/worker"] }),
    [
      path.join(repoRoot, entry),
      "--bundle", "--platform=node", "--format=esm", "--target=node22",
      `--outfile=${outfile}`, "--log-level=error",
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    console.error(`could not bundle ${entry}`);
    process.exit(1);
  }
  return pathToFileURL(outfile).href;
}

/*
  The reference faces live where the image puts them, and this is not the
  image. Pointed at the repository's own copies instead — the same bytes, one
  directory earlier in their life.
*/
process.env.EDITLY_FONT_DIR ??= path.join(repoRoot, "artifacts/worker/fonts");

const { intakeFace } = await import(bundle("artifacts/worker/src/font-intake.ts", "intake.mjs"));

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

const work = await mkdtemp(path.join(tmpdir(), "editly-userfont-"));

/**
 * The repair, run the way the worker runs it: as a subprocess, on one file.
 *
 * Not a reimplementation in JavaScript. The repair is Python because fontTools
 * is Python, and a second copy of it here would be a second thing to keep in
 * step with a file whose whole purpose is that there is one of it.
 */
function prepare(source, into, previews) {
  const result = spawnSync(
    "python3",
    [path.join(repoRoot, "artifacts/worker/fonts/prepare-user-font.py"), source, into, previews],
    { encoding: "utf8" },
  );
  try {
    return JSON.parse(result.stdout);
  } catch {
    return { ok: false, code: "unreadable", detail: (result.stderr || result.stdout || "").trim().split("\n").slice(-2).join(" ") };
  }
}

// ── The measurement agrees with the one the catalogue was built from ────────

section("An uploaded copy of a face we ship measures what we wrote down");
{
  /*
    The strongest available bite, and it is worth saying why it is the first
    thing here.

    The intake's numbers have no external truth to be checked against — a font
    nobody has seen has no known ratio. But thirteen faces in this repository
    *do*: their numbers were measured by hand and are asserted every run by
    `tools/font-test.mjs`. Feeding those same files through the intake as if a
    stranger had uploaded them turns "does the intake measure correctly" into a
    question with an answer.
  */
  const source = await readFile(path.join(repoRoot, "lib/api-zod/src/fonts.ts"), "utf8");
  const FACES = [...source.matchAll(
    /\n\s{4}id:\s*"([^"]+)",[\s\S]*?script:\s*"(latin|arabic)",[\s\S]*?family:\s*"([^"]+)",\s*\n\s*file:\s*"([^"]+)",\s*\n\s*capRatio:\s*([0-9.]+),\s*\n\s*widthScale:\s*([0-9.]+),/g,
  )].map((m) => ({ id: m[1], script: m[2], family: m[3], file: m[4], capRatio: Number(m[5]), widthScale: Number(m[6]) }));
  check("the catalogue parsed", FACES.length >= 12, `${FACES.length}`);

  for (const face of FACES) {
    const dir = path.join(work, `ship-${face.id}`);
    await mkdir(dir, { recursive: true });
    const src = path.join(repoRoot, "artifacts/worker/fonts", face.file);
    if (!existsSync(src)) {
      check(`${face.family}: the file is there to measure`, false, face.file);
      continue;
    }
    await copyFile(src, path.join(dir, face.file));
    const result = await intakeFace(dir, face.family, face.script);
    if (!result.ok) {
      check(`${face.family}: a face we ship is accepted`, false, `${result.refusal.code} — ${result.refusal.detail}`);
      continue;
    }
    check(
      `${face.family}: intake measures ${result.capRatio}, catalogue says ${face.capRatio}`,
      Math.abs(result.capRatio - face.capRatio) <= 0.04,
      `${result.capRatio} vs ${face.capRatio}`,
    );
    check(
      `${face.family}: intake scales ${result.widthScale}, catalogue says ${face.widthScale}`,
      // Same one-sided band the catalogue's own numbers are held to: never
      // below what the face runs at, never far above it.
      Math.abs(result.widthScale - face.widthScale) <= 0.3,
      `${result.widthScale} vs ${face.widthScale}`,
    );
  }
}

// ── A font that resolves to nothing is caught, not measured ────────────────

section("A face the renderer never actually used is refused, not measured");
{
  /*
    The bug this whole file exists for, staged.

    An empty directory and a family name nothing answers to is exactly the
    state a bad upload leaves behind: the render succeeds, the captions are
    legible, and every one of them is in DejaVu Sans. Nothing anywhere fails.
  */
  const empty = path.join(work, "empty");
  await mkdir(empty, { recursive: true });
  const result = await intakeFace(empty, "ThisFamilyDoesNotExistAnywhere", "latin");
  check("it is refused", !result.ok, JSON.stringify(result));
  check(
    "and the reason is that nothing on the frame came from the file",
    !result.ok && result.refusal.code === "doesNotResolve",
    result.ok ? "accepted" : result.refusal.code,
  );
  check(
    "and the person is told in both languages",
    !result.ok && result.refusal.english.length > 20 && result.refusal.arabic.length > 20,
    result.ok ? "accepted" : `${result.refusal.english.length}/${result.refusal.arabic.length}`,
  );
}

section("A face that cannot draw the script is refused for that script only");
{
  /*
    Rubik, which is in this repository precisely because it got this far once.

    It resolves, it draws every isolated Arabic form, and its ratio is sane. It
    renders لا as a box. If the intake accepts it for Arabic, the intake has
    the bug the suite was rewritten to catch.
  */
  const dir = path.join(work, "rubik");
  await mkdir(dir, { recursive: true });
  await copyFile(
    path.join(repoRoot, "artifacts/worker/fonts/Rubik-Black.ttf"),
    path.join(dir, "Rubik-Black.ttf"),
  );
  const arabic = await intakeFace(dir, "Rubik Black", "arabic");
  check(
    "Rubik is refused for Arabic, because it draws لا as a box",
    !arabic.ok && arabic.refusal.code === "cannotDrawTheScript",
    arabic.ok ? `accepted at ${arabic.capRatio}` : arabic.refusal.detail,
  );
  check(
    "and the refusal says which shape is missing, not just that something is",
    !arabic.ok && arabic.refusal.arabic.includes("لا"),
    arabic.ok ? "accepted" : arabic.refusal.arabic,
  );
  const latin = await intakeFace(dir, "Rubik Black", "latin");
  check(
    "and the same file is accepted for Latin, which it draws perfectly well",
    latin.ok,
    latin.ok ? `${latin.capRatio}/${latin.widthScale}` : latin.refusal.code,
  );
}

// ── Real uploads ───────────────────────────────────────────────────────────

section("A font filed under the wrong script is told which script it is");
{
  /*
    The most likely mistake on that screen, given the least useful answer.

    The upload form has two headings side by side, Latin and Arabic, and a
    person picking a display face for their captions will sooner or later drop
    a Latin one under the Arabic heading. What happened then: the intake drew
    the Arabic sample, fontconfig substituted (the font has no Arabic), the
    frame matched the fallback's, and step 2 answered `doesNotResolve` — *the
    family name inside the file is not one the renderer can be asked for*. That
    sentence is about metadata, it is true of an entirely different fault, and
    there is nothing whatsoever a person can do with it. They have a working
    font and a message about names.

    The numbers that answer it properly were already being counted by
    `prepare-user-font.py`, already returned in its JSON as `arabicGlyphs` and
    `latinGlyphs`, and read by nothing at all.

    Run through the real repair rather than with hand-written counts, so the
    two halves have to agree: the Python's coverage and the intake's use of it.

    Only one direction is checked, and the asymmetry is real rather than an
    omission. Every Arabic face in this repository — Cairo, Almarai, Tajawal,
    Alexandria, Changa, Noto Kufi — also carries the full Latin alphabet,
    because an Arabic text font that cannot set a Latin word is not shippable.
    Latin faces carry no Arabic. So "Arabic font filed under Latin" is a case
    that barely exists, and a check asserting it would be asserting something
    untrue about real files. The rule is written both ways; only the way that
    happens is claimed here.
  */
  const dir = path.join(work, "misfiled-anton");
  await mkdir(dir, { recursive: true });
  const prepared = prepare(
    path.join(repoRoot, "artifacts/worker/fonts/Anton.ttf"),
    path.join(dir, "face"),
    path.join(dir, "preview"),
  );
  check("the repair reads Anton", prepared.ok === true, prepared.detail ?? "");
  if (prepared.ok) {
    check(
      "and counts it as Latin with no Arabic in it, which is the fact the refusal needs",
      prepared.latinGlyphs >= 20 && prepared.arabicGlyphs < 20,
      `${prepared.arabicGlyphs} Arabic, ${prepared.latinGlyphs} Latin`,
    );

    const coverage = { arabic: prepared.arabicGlyphs, latin: prepared.latinGlyphs };
    const misfiled = await intakeFace(path.join(dir, "face"), prepared.family, "arabic", coverage);
    check(
      "Anton under the Arabic heading is refused for the reason that is true",
      !misfiled.ok && misfiled.refusal.code === "wrongScript",
      misfiled.ok ? "accepted" : misfiled.refusal.code,
    );
    check(
      "and the sentence says which script it is and what to do with it",
      !misfiled.ok &&
        misfiled.refusal.arabic.includes("لاتيني") &&
        /instead/.test(misfiled.refusal.english),
      misfiled.ok ? "accepted" : misfiled.refusal.english,
    );
    check(
      "rather than the old answer, which was about the name inside the file",
      !misfiled.ok && misfiled.refusal.code !== "doesNotResolve",
      misfiled.ok ? "accepted" : misfiled.refusal.code,
    );

    // And the same file, filed correctly, still goes through everything below.
    const properly = await intakeFace(path.join(dir, "face"), prepared.family, "latin", coverage);
    check(
      "Anton under Latin is measured, not refused on coverage",
      properly.ok,
      properly.ok ? `${properly.capRatio}/${properly.widthScale}` : properly.refusal.code,
    );
  }
}

section("Fonts a person actually uploaded, through the whole intake");
{
  /*
    Eleven files, six of them `.otf`.

    A fixture would have been eleven TrueType fonts from Google Fonts, and the
    cubic-outline case — which is more than half of what a person hands this
    product, because that is what the Arabic foundries sell — would have been
    found in production instead.

    The directory is optional: these are somebody's licensed files and they are
    not in the repository. When it is absent the section says so rather than
    passing silently, because a suite that checks nothing and prints a tick is
    the thing this whole codebase is written against.
  */
  const from = process.env.EDITLY_UPLOADED_FONTS ?? "/tmp/osfonts";
  if (!existsSync(from)) {
    console.log(`  · no uploaded fonts at ${from}; set EDITLY_UPLOADED_FONTS to run this section`);
  } else {
    const files = (await readdir(from)).filter((f) => /\.(ttf|otf)$/i.test(f)).sort();
    check("there are files to try", files.length > 0, `${files.length}`);
    for (const file of files) {
      const dir = path.join(work, `up-${file}`);
      await mkdir(dir, { recursive: true });
      // Separate directories, and the reason is in prepare-user-font.py: a
      // preview subset beside the full face makes libass draw the subset.
      const prepared = prepare(path.join(from, file), path.join(dir, "face"), path.join(dir, "preview"));
      check(`${file}: the repair reads it and writes a face`, prepared.ok === true, prepared.detail ?? "");
      if (!prepared.ok) continue;
      const script = prepared.arabicGlyphs > 40 ? "arabic" : "latin";
      const result = await intakeFace(path.join(dir, "face"), prepared.family, script);
      const verdict = result.ok
        ? `${script} · ratio ${result.capRatio} · width ${result.widthScale}`
        : `refused: ${result.refusal.code}`;
      console.log(`      ${prepared.family} — ${verdict}`);
      check(
        `${file}: the intake reaches a verdict with a reason, either way`,
        result.ok ? result.capRatio > 0 && result.widthScale > 0 : result.refusal.english.length > 20,
        verdict,
      );
    }
  }
}

section("A font with no Unicode cmap is refused with the reason, not a crash");
{
  /*
    A font can carry a cmap table with only a Mac-Roman or symbol subtable and
    no Unicode one. The gate that only checked for a *missing* cmap table let it
    through, and the coverage count then iterated `getBestCmap()`'s `None` into
    a TypeError — which surfaced as "this isn't a font or it's corrupt", while
    the true, translated `noCmap` message sat right there, unreachable.
  */
  const dir = path.join(work, "nocmap");
  await mkdir(dir, { recursive: true });
  const src = path.join(dir, "nocmap.ttf");
  // Strip every Unicode subtable off a real font, leaving one Mac-Roman table.
  const craft = spawnSync("python3", ["-c", `
from fontTools import ttLib
from fontTools.ttLib.tables._c_m_a_p import CmapSubtable
f = ttLib.TTFont(${JSON.stringify(path.join(repoRoot, "artifacts/worker/fonts/Cairo-Black.ttf"))})
sub = CmapSubtable.getSubtableClass(0)(0)
sub.platformID, sub.platEncID, sub.language = 1, 0, 0
sub.cmap = {i: ".notdef" for i in range(10)}
f["cmap"].tables = [sub]
f.save(${JSON.stringify(src)})
`], { encoding: "utf8" });
  check("the no-cmap fixture was built", craft.status === 0 && existsSync(src), craft.stderr?.slice(-200));

  const result = prepare(src, path.join(dir, "out"), path.join(dir, "prev"));
  check(
    "it is refused as noCmap, not crashed into a generic error",
    result.ok === false && result.code === "noCmap",
    JSON.stringify(result),
  );
}

await rm(work, { recursive: true, force: true });
await rm(buildDir, { recursive: true, force: true });
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
console.log("A font nobody vetted is measured before it is offered.");
