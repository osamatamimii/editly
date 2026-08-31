/**
 * The whole path a person's own font takes, from an object in storage to a
 * caption burned in it.
 *
 * `user-font-test.mjs` asks whether a font can be measured. This asks the
 * other half — whether the thing that was measured is what a render actually
 * draws with, and whether a font that belongs to somebody else can be made to
 * draw at all.
 *
 * Six links, and each one of them is a place where nothing would fail:
 *
 *   1. A row appears `pending`, because a serverless function cannot decide
 *      whether bytes are a font.
 *   2. The worker's sweep claims it, measures it, and writes three numbers.
 *   3. A font that cannot draw its script is refused *with a reason a person
 *      can read*, in their language.
 *   4. A plan naming a face this person owns keeps it; a plan naming somebody
 *      else's is stripped before it reaches the queue. A font id is a
 *      capability — the renderer fetches and draws whatever it is handed.
 *   5. The renderer resolves the id to the measured numbers, not to a default
 *      wearing them.
 *   6. And the caption on the frame is drawn in that face, which is provable
 *      only by difference: a style naming a font that is not there renders
 *      byte-identically to one naming the fallback.
 *
 * Usage: DATABASE_URL=postgres://... node tools/typeface-test.mjs
 * Requires: Postgres with the production schema, ffmpeg with libass, python3
 * with fonttools. No keys, no network.
 */
import { mkdtemp, rm, mkdir, copyFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { resolveTestDatabaseUrl } from "./lib/test-db.mjs";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const DATABASE_URL = await resolveTestDatabaseUrl();
process.env.DATABASE_URL = DATABASE_URL;
process.env.EDITLY_FONT_DIR ??= path.join(repoRoot, "artifacts/worker/fonts");
process.env.EDITLY_FONT_SCRIPTS ??= path.join(repoRoot, "artifacts/worker/fonts");

const { Client } = require(require.resolve("pg", { paths: ["lib/db"] }));
const sqlClient = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 3000 });
try {
  await sqlClient.connect();
} catch (error) {
  console.error(`\nNo database at ${DATABASE_URL}`);
  console.error(`  ${error.message}\n`);
  process.exit(1);
}

const buildDir = await mkdtemp(path.join(tmpdir(), "editly-typeface-build-"));
function bundle(entry, name, workspace) {
  const outfile = path.join(buildDir, name);
  const built = spawnSync(
    require.resolve("esbuild/bin/esbuild", { paths: [workspace] }),
    [
      entry, "--bundle", "--platform=node", "--format=esm", "--target=node22",
      `--outfile=${outfile}`, "--log-level=error", "--external:pg-native",
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

const { withCaptionFonts, myFaceIds } = await import(
  bundle("artifacts/api-server/src/lib/caption-fonts.ts", "caption-fonts.mjs", "artifacts/api-server")
);
const { facePair, asCaptionFace } = await import(
  bundle("artifacts/worker/src/caption-layout.ts", "layout.mjs", "artifacts/worker")
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
const section = (t) => console.log(`\n${t}`);

const work = await mkdtemp(path.join(tmpdir(), "editly-typeface-"));
const OWNER = randomUUID();
const STRANGER = randomUUID();

/**
 * A prepared face, put in the table the way the worker would have left it.
 *
 * Prepared for real — the same Python, the same measurement — rather than a
 * row of made-up numbers. The point of the table is that it holds what was
 * *measured*, and a fixture that skips the measuring is a fixture that would
 * pass while the measuring was broken.
 */
async function aReadyFace({ owner = OWNER, source, script, label }) {
  const id = randomUUID();
  const faceDir = path.join(work, id, "face");
  const previewDir = path.join(work, id, "preview");
  await mkdir(faceDir, { recursive: true });
  const prepared = JSON.parse(
    spawnSync("python3", [
      path.join(repoRoot, "artifacts/worker/fonts/prepare-user-font.py"),
      source, faceDir, previewDir, "--id", id,
    ], { encoding: "utf8" }).stdout.trim().split("\n").pop(),
  );
  const { intakeFace } = await import(
    bundle("artifacts/worker/src/font-intake.ts", `intake-${id}.mjs`, "artifacts/worker")
  );
  const verdict = await intakeFace(faceDir, prepared.family, script);
  await sqlClient.query(
    `insert into caption_faces
       (id, user_id, label, declared, script, family, source_path, face_path, cap_ratio, width_scale, status, rights)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'own')`,
    [
      id, owner, label, prepared.declared, script, prepared.family,
      `${owner}/fonts/${id}.ttf`, `${owner}/fonts/${id}.ttf`,
      verdict.ok ? verdict.capRatio : null,
      verdict.ok ? verdict.widthScale : null,
      verdict.ok ? "ready" : "refused",
    ],
  );
  return { id, faceDir, prepared, verdict };
}

/*
  The file everything below is measured with.

  One of the thirteen we ship, uploaded as if it were a stranger's font, for
  the reason `user-font-test.mjs` gives: its numbers are known, so "did the
  path preserve them" is a question with an answer. Its family is renamed on
  the way in, so it does not resolve to the installed copy — the id it gets is
  generated, and nothing in this file names "Cairo Black".
*/
const SOURCE = path.join(repoRoot, "artifacts/worker/fonts/Cairo-Black.ttf");
const RUBIK = path.join(repoRoot, "artifacts/worker/fonts/Rubik-Black.ttf");

// ── 1 & 2: pending, then measured ──────────────────────────────────────────

section("A font arrives unusable and becomes usable, and the row says which");
let mine;
{
  const id = randomUUID();
  await sqlClient.query(
    `insert into caption_faces (id, user_id, label, script, source_path, status, rights)
     values ($1, $2, 'brand face', 'arabic', $3, 'pending', 'own')`,
    [id, OWNER, `${OWNER}/fonts/${id}.ttf`],
  );
  const [row] = (await sqlClient.query(`select * from caption_faces where id = $1`, [id])).rows;
  check("it lands pending, because nothing in an API can measure a font", row.status === "pending", row.status);
  check("with no numbers yet, rather than plausible ones", row.cap_ratio === null && row.width_scale === null);
  check(
    "and a plan may not name it while it has none",
    !(await myFaceIds(OWNER)).includes(id),
    "a face with no measured size would render at a guessed one",
  );
  await sqlClient.query(`delete from caption_faces where id = $1`, [id]);

  mine = await aReadyFace({ source: SOURCE, script: "arabic", label: "brand face" });
  check("a measured face is ready", mine.verdict.ok, JSON.stringify(mine.verdict).slice(0, 120));
  check(
    "and the numbers in the row are the ones that were measured, not defaults",
    Math.abs(mine.verdict.capRatio - 0.38) <= 0.04 && mine.verdict.widthScale > 0,
    `${mine.verdict.capRatio} / ${mine.verdict.widthScale}`,
  );
  check("and it is renamed, so it cannot resolve to a font already on the machine",
    mine.prepared.family.startsWith("Editly ") && mine.prepared.family !== "Cairo Black",
    mine.prepared.family);
}

// ── 3: a refusal somebody can read ─────────────────────────────────────────

section("A font that cannot draw its script is refused with the reason");
{
  const refused = await aReadyFace({ source: RUBIK, script: "arabic", label: "rubik as arabic" });
  check("it is refused rather than measured", !refused.verdict.ok, JSON.stringify(refused.verdict).slice(0, 90));
  check(
    "the reason names the shape that is missing",
    !refused.verdict.ok && refused.verdict.refusal.arabic.includes("لا"),
    refused.verdict.ok ? "accepted" : refused.verdict.refusal.arabic,
  );
  check(
    "and it is said in both languages, because a rejection nobody can read is a support message",
    !refused.verdict.ok &&
      refused.verdict.refusal.english.length > 20 &&
      refused.verdict.refusal.arabic.length > 20,
  );
  check(
    "a refused face is not offered to a plan",
    !(await myFaceIds(OWNER)).includes(refused.id),
  );
}

// ── 4: a font id is a capability ───────────────────────────────────────────

section("A plan may name your fonts and only yours");
{
  const theirs = await aReadyFace({ owner: STRANGER, source: SOURCE, script: "arabic", label: "not yours" });
  const plan = { version: 1, operations: [{ type: "autoCaptions", style: "clean" }] };

  const withMine = withCaptionFonts(plan, { arabic: mine.id }, await myFaceIds(OWNER));
  check(
    "a face you own reaches the plan",
    withMine.operations[0].fontArabic === mine.id,
    String(withMine.operations[0].fontArabic),
  );

  const withTheirs = withCaptionFonts(plan, { arabic: theirs.id }, await myFaceIds(OWNER));
  check(
    "somebody else's face id is dropped before the queue sees it",
    // Not an error and not a 403: the id is simply not a name this plan can
    // carry, so the render draws the default. The alternative is a renderer
    // that fetches and burns whatever file an id points at.
    withTheirs.operations[0].fontArabic === undefined,
    String(withTheirs.operations[0].fontArabic),
  );

  const invented = withCaptionFonts(plan, { arabic: randomUUID() }, await myFaceIds(OWNER));
  check("and an id nobody owns is dropped too", invented.operations[0].fontArabic === undefined);
}

// ── 5: the renderer resolves it to the measured numbers ────────────────────

section("The renderer draws with what was measured, not with a default");
{
  const { rows } = await sqlClient.query(`select * from caption_faces where id = $1`, [mine.id]);
  const row = rows[0];
  const asFace = asCaptionFace({
    id: row.id, label: row.label, declared: row.declared, script: row.script,
    family: row.family, capRatio: row.cap_ratio, widthScale: row.width_scale,
  });
  const pair = facePair({ arabic: mine.id }, [asFace]);
  check("the pair names the uploaded face", pair.arabic.id === mine.id, pair.arabic.id);
  check(
    "and carries its measured ratio, which is what a caption's size is computed from",
    Math.abs(pair.arabic.capRatio - row.cap_ratio) < 0.001,
    `${pair.arabic.capRatio} vs ${row.cap_ratio}`,
  );
  check("and its family, which is what fontconfig is asked for", pair.arabic.family === row.family);

  const without = facePair({ arabic: mine.id });
  check(
    "the same id with the face not passed in falls back rather than throwing",
    // A plan saved before a font was deleted has to render *something*. A
    // caption in the wrong face beats a job that dies at its last step after
    // somebody paid minutes for it.
    without.arabic.id === "cairo-black",
    without.arabic.id,
  );
}

// ── 6: and the frame is different ──────────────────────────────────────────

section("A caption in an uploaded face is not a caption in the fallback");
{
  /*
    The only proof that survives.

    fontconfig substitutes silently: a style naming a family that is not there
    renders byte-identically to one naming DejaVu. So "the render used the
    font" cannot be shown by the render succeeding, only by the frame being
    different from the one the fallback draws — which is the same argument
    `font-test.mjs` makes about the thirteen we ship, applied to the file a
    person brought.
  */
  const sample = "لا أحد يخبرك بهذا";
  const drawIn = (family, dir) => {
    const ass = path.join(work, "frame.ass");
    const rows = [
      "[Script Info]", "ScriptType: v4.00+", "PlayResX: 900", "PlayResY: 300", "WrapStyle: 2", "",
      "[V4+ Styles]",
      "Format: Name,Fontname,Fontsize,PrimaryColour,OutlineColour,BackColour,Bold,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
      `Style: P,${family},100,&H00FFFFFF,&H00000000,&H00000000,-1,1,0,0,5,10,10,10,1`, "",
      "[Events]",
      "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
      `Dialogue: 0,0:00:00.00,0:00:01.00,P,,0,0,0,,{\\an5\\pos(450,150)}${sample}`, "",
    ].join("\n");
    spawnSync("bash", ["-c", `cat > ${JSON.stringify(ass)}`], { input: rows });
    const grey = spawnSync("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=900x300:d=1",
      "-vf", `subtitles=${ass}${dir ? `:fontsdir=${dir}` : ""},format=gray`,
      "-frames:v", "1", "-f", "rawvideo", "-",
    ], { maxBuffer: 1 << 26 }).stdout;
    if (!grey) return "none";
    let ink = 0;
    let left = 900;
    let right = -1;
    let top = -1;
    let bottom = -1;
    for (let y = 0; y < 300; y += 1) {
      for (let x = 0; x < 900; x += 1) {
        if (grey[y * 900 + x] > 40) {
          ink += 1;
          if (top < 0) top = y;
          bottom = y;
          if (x < left) left = x;
          if (x > right) right = x;
        }
      }
    }
    return ink === 0 ? "none" : `${ink}:${right - left + 1}x${bottom - top + 1}`;
  };

  const uploaded = drawIn(mine.prepared.family, mine.faceDir);
  const fallback = drawIn("EditlyNoSuchFamily-9f3c", mine.faceDir);
  check("the uploaded face draws the sentence", uploaded !== "none", uploaded);
  check(
    "and the frame is not the frame the fallback draws",
    uploaded !== fallback,
    `${uploaded} against ${fallback}`,
  );
  const notFetched = drawIn(mine.prepared.family, null);
  check(
    "without the fonts directory it is the fallback — which is what fetching the file is for",
    notFetched === fallback,
    `${notFetched} against ${fallback}`,
  );
}

// ── The migration says what the table says ─────────────────────────────────

section("The migration and the schema agree");
{
  const migration = await readFile(
    path.join(repoRoot, "lib/db/migrations/0035_uploaded_caption_faces.sql"),
    "utf8",
  );
  check("the migration exists and is committed", migration.length > 500);
  check(
    "and it enables row-level security, because the table holds one person's files",
    /ALTER TABLE caption_faces ENABLE ROW LEVEL SECURITY/.test(migration),
  );
  const { rows } = await sqlClient.query(
    `select column_name from information_schema.columns where table_name = 'caption_faces'`,
  );
  const columns = new Set(rows.map((r) => r.column_name));
  for (const needed of ["cap_ratio", "width_scale", "family", "face_path", "refusal_ar", "rights"]) {
    check(`the table has ${needed}`, columns.has(needed));
  }
  check(
    "the repair scripts ship beside the bundle, or an uploaded font never leaves pending",
    existsSync(path.join(repoRoot, "artifacts/worker/fonts/facerepair.py")) &&
      existsSync(path.join(repoRoot, "artifacts/worker/fonts/prepare-user-font.py")),
  );
}

await sqlClient.query(`delete from caption_faces where user_id = any($1::uuid[])`, [[OWNER, STRANGER]]);
await sqlClient.end();
await rm(work, { recursive: true, force: true });
await rm(buildDir, { recursive: true, force: true });
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
console.log("A person's own font reaches the frame, and only theirs.");
