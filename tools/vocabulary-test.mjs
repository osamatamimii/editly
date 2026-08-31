/**
 * What the model is allowed to name.
 *
 * The planner does not receive a project's files. It receives a vocabulary:
 * `buildSchema` turns the asset list into three enums — videos into the b-roll
 * enum, images into the overlay enum, audio into the music enum — and the JSON
 * schema is strict. An id that is not in the list is an id the model cannot
 * produce, and an *empty* enum is not a missing file but a missing operation:
 * there is no longer any way for the model to ask for music at all.
 *
 * Which makes the cap on that list a correctness question. It used to read the
 * newest forty rows of the project, mixed, and the failure that hides in that
 * sentence is the one this file exists for:
 *
 *   Somebody uploads a music track. Over the next two months they upload forty
 *   clips. They type "put my music under it". The plan comes back with no
 *   music in it, the reply is confident, the render runs, and the only symptom
 *   is a video that is missing the one thing they asked for.
 *
 * Nothing fails. No error is logged. The model was simply never shown a track,
 * so it never named one — and from the outside that is indistinguishable from
 * a model that decided not to.
 *
 * These run against a real Postgres, because the property is a property of the
 * query. Post-filtering a list of forty rows would pass a test written against
 * a fake and still ship the bug.
 *
 * Usage: DATABASE_URL=postgres://... node tools/vocabulary-test.mjs
 * Requires: a Postgres with the production schema. No keys, no network.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { resolveTestDatabaseUrl } from "./lib/test-db.mjs";

const require = createRequire(import.meta.url);
const DATABASE_URL = await resolveTestDatabaseUrl();
process.env.DATABASE_URL = DATABASE_URL;

const { Client } = require(require.resolve("pg", { paths: ["lib/db"] }));
const sqlClient = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 3000 });
try {
  await sqlClient.connect();
} catch (error) {
  console.error(`\nNo database at ${DATABASE_URL}`);
  console.error(`  ${error.message}`);
  console.error(`  Bring one up, then: DATABASE_URL=... node tools/migrate.mjs\n`);
  process.exit(1);
}

const buildDir = await mkdtemp(path.join(tmpdir(), "editly-vocabulary-"));
const outfile = path.join(buildDir, "planner-assets.mjs");
const built = spawnSync(
  require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] }),
  [
    "artifacts/api-server/src/lib/planner-assets.ts",
    "--bundle", "--platform=node", "--format=esm", "--target=node22",
    `--outfile=${outfile}`, "--log-level=error",
    "--external:pg-native",
    "--banner:js=import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
  ],
  { stdio: "inherit" },
);
if (built.status !== 0) {
  console.error("could not bundle the asset reader");
  process.exit(1);
}
const { plannerAssets, ASSET_BUDGET, ASSET_KINDS } = await import(pathToFileURL(outfile).href);

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

const OWNER = randomUUID();

async function aProject() {
  const id = randomUUID();
  await sqlClient.query(
    `insert into projects (id, user_id, title, platform) values ($1, $2, $3, 'tiktok')`,
    [id, OWNER, "vocabulary fixture"],
  );
  return id;
}

/** `agoMinutes` is how long ago it was uploaded — the axis the cap sorted on. */
async function anAsset(projectId, kind, label, agoMinutes) {
  const id = randomUUID();
  await sqlClient.query(
    `insert into assets (id, project_id, user_id, kind, label, path, created_at)
     values ($1, $2, $3, $4, $5, $6, now() - ($7 || ' minutes')::interval)`,
    [id, projectId, OWNER, kind, label, `${OWNER}/${projectId}/${id}`, String(agoMinutes)],
  );
  return id;
}

// ── The bug ─────────────────────────────────────────────────────────────────
section("One track under forty clips is still a track");

{
  const project = await aProject();
  // Oldest thing in the project, and the only one of its kind. Exactly the
  // shape of the file somebody uploads once and refers to for a year.
  const track = await anAsset(project, "audio", "my-theme.mp3", 60 * 24 * 60);
  const logo = await anAsset(project, "image", "logo.png", 59 * 24 * 60);
  // Forty-one newer clips, which under a flat newest-forty cap is enough to
  // push both of them out on their own.
  for (let i = 0; i < 41; i += 1) await anAsset(project, "video", `take-${i}.mp4`, 100 - i);

  const vocabulary = await plannerAssets(project);
  const ids = vocabulary.map((a) => a.id);

  check(
    "the music the model is asked for is in the vocabulary it was given",
    ids.includes(track),
    // Without this the model cannot choose addMusic at all: the enum it would
    // have to name a track from is empty, so it names nothing and says nothing.
    `${vocabulary.filter((a) => a.kind === "audio").length} audio of ${vocabulary.length}`,
  );
  check(
    "and so is the logo, for the same reason",
    ids.includes(logo),
    `${vocabulary.filter((a) => a.kind === "image").length} images`,
  );
  check(
    "every kind the project has is represented",
    ASSET_KINDS.every((kind) => vocabulary.some((a) => a.kind === kind)),
    vocabulary.map((a) => a.kind).join(","),
  );
  check(
    "and the list is still bounded, because every id becomes an enum member",
    vocabulary.length <= ASSET_KINDS.reduce((n, k) => n + ASSET_BUDGET[k], 0),
    `${vocabulary.length}`,
  );
  check(
    "no kind exceeds its own share",
    ASSET_KINDS.every((kind) => vocabulary.filter((a) => a.kind === kind).length <= ASSET_BUDGET[kind]),
    ASSET_KINDS.map((k) => `${k}:${vocabulary.filter((a) => a.kind === k).length}`).join(" "),
  );
}

// ── Within a kind, the cap still has to fall the right way ──────────────────
section("When one kind does overflow, it keeps the newest");

{
  const project = await aProject();
  // Numbered so that a smaller number is newer.
  for (let i = 0; i < ASSET_BUDGET.video + 5; i += 1) {
    await anAsset(project, "video", `take-${i}.mp4`, i + 1);
  }

  const clips = (await plannerAssets(project)).filter((a) => a.kind === "video");
  check("it keeps exactly its share", clips.length === ASSET_BUDGET.video, `${clips.length}`);
  check(
    "and the ones it keeps are the newest",
    clips.every((c) => Number(c.label.match(/take-(\d+)/)[1]) < ASSET_BUDGET.video),
    clips.map((c) => c.label).join(","),
  );
  check(
    "newest first, so a plan that takes the first one takes the latest upload",
    clips[0].label === "take-0.mp4",
    clips[0].label,
  );
}

// ── The thing a per-kind read must not lose ─────────────────────────────────
section("A vocabulary is still one project's");

{
  const mine = await aProject();
  const theirs = await aProject();
  await anAsset(mine, "audio", "mine.mp3", 5);
  const stranger = await anAsset(theirs, "audio", "theirs.mp3", 1);

  const vocabulary = await plannerAssets(mine);
  check(
    "another project's file is never offered to this one's planner",
    !vocabulary.some((a) => a.id === stranger),
    // Three queries instead of one is three chances to drop the filter, and
    // the symptom would be somebody else's music in your video.
    vocabulary.map((a) => a.label).join(","),
  );
  check("and its own is", vocabulary.some((a) => a.label === "mine.mp3"), "");
}

// ── An empty project is empty, not an error ─────────────────────────────────
section("A project with no files asks for none");

{
  const project = await aProject();
  const vocabulary = await plannerAssets(project);
  check("three reads of nothing is an empty list", vocabulary.length === 0, `${vocabulary.length}`);
}

// ── Clean up ────────────────────────────────────────────────────────────────
await sqlClient.query(`delete from assets where user_id = $1`, [OWNER]);
await sqlClient.query(`delete from projects where user_id = $1`, [OWNER]);
await sqlClient.end();
await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("The model can name the file it is being asked about.");
