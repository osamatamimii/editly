/**
 * The only thing in this product that deletes, held to the rules that make
 * deleting survivable.
 *
 * Every other suite here can be wrong and cost a bad render. This one guards a
 * code path whose mistakes are permanent: an object that goes is gone, and the
 * customer's copy went with it. So the suite is written the way `tighten-test`
 * is — asymmetrically. The checks that a cold preview *is* chosen are ordinary.
 * The checks that a master is **never** chosen, that nothing at all is chosen
 * before the floor, and that a file is deleted before the row that names it,
 * are the ones the thresholds were picked for.
 *
 * Three failures are being designed against, and each has its own section.
 *
 *   1. **Ageing from a column nobody fills.** `last_opened_at` is NULL on every
 *      row that existed before the migration that added it. A sweep that reads
 *      that as "never opened" empties the estate on the first day its window
 *      elapses. The clock therefore starts at the *later* of the row's own
 *      timestamps and the moment migration 0040 was applied.
 *
 *   2. **Deleting the thing somebody paid for.** The master is not eligible at
 *      any age, under any configuration. The check is not "we do not ask for
 *      it"; it is that no key the chooser ever emits equals a master's.
 *
 *   3. **Clearing a row before its object.** A column emptied first is a file
 *      nothing will ever name again — an orphan that no future sweep can find,
 *      because the sweep works from the columns. The order is asserted by
 *      recording it.
 *
 * Usage: node tools/retention-test.mjs
 * Requires: nothing. No database, no bucket, no ffmpeg.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-retention-"));

function build(source, name) {
  const outfile = path.join(buildDir, name);
  const built = spawnSync(
    require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/worker"] }),
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

const S = await import(build("artifacts/worker/src/sweep.ts", "sweep.mjs"));

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

/* ── A world to age ────────────────────────────────────────────────────────── */

const USER = "11111111-1111-4111-8111-111111111111";
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-12-01T00:00:00Z");
const ago = (days) => new Date(NOW.getTime() - days * DAY);

/** Migration 0040 went in thirty days ago, so nothing can be older than that. */
const FLOOR = ago(30);

const project = (over = {}) => ({
  id: "p1",
  userId: USER,
  editedVideoPath: `${USER}/p1/edited.mp4`,
  videoPath: `${USER}/p1/source.mp4`,
  thumbnailPath: `${USER}/p1/poster.jpg`,
  lastOpenedAt: null,
  updatedAt: ago(400),
  renders: 3,
  ...over,
});

const clip = (over = {}) => ({
  id: "c1",
  projectId: "p1",
  outputPath: `${USER}/p1/clips/c1.mp4`,
  thumbnailPath: `${USER}/p1/clips/c1.jpg`,
  ...over,
});

const config = (over = {}) => ({ ...S.DEFAULT_RETENTION, mode: "on", ...over });

const choose = (over = {}) =>
  S.chooseRemovals({
    projects: [project()],
    clips: [],
    now: NOW,
    floor: FLOOR,
    config: config(),
    ...over,
  });

const keys = (removals) => removals.map((r) => r.key).sort();

/* ── 1. The clock, and the disaster it prevents ────────────────────────────── */

section("Nothing ages from before the day the column started being written");
{
  // The whole estate, on day one. `updated_at` a year old, `last_opened_at`
  // null because the column did not exist when these rows were made.
  const ancient = choose({ projects: [project({ lastOpenedAt: null, updatedAt: ago(400) })] });
  check(
    "a project untouched for a year is not swept thirty days after the migration",
    ancient.length === 0,
    JSON.stringify(keys(ancient)),
  );

  // …and the same rows once the window has genuinely elapsed since the floor.
  const later = S.chooseRemovals({
    projects: [project({ lastOpenedAt: null, updatedAt: ago(400) })],
    clips: [],
    now: new Date(FLOOR.getTime() + 91 * DAY),
    floor: FLOOR,
    config: config(),
  });
  check(
    "and is swept ninety days after it, which is the first honest moment",
    later.some((r) => r.kind === "preview"),
    JSON.stringify(keys(later)),
  );

  check(
    "the clock is the latest of the three, not the earliest",
    S.coldSince(project({ lastOpenedAt: ago(5), updatedAt: ago(400) }), FLOOR) === ago(5).getTime(),
  );
  check(
    "and the floor wins over both when both are older than it",
    S.coldSince(project({ lastOpenedAt: ago(400), updatedAt: ago(300) }), FLOOR) === FLOOR.getTime(),
  );

  const future = S.chooseRemovals({
    projects: [project({ lastOpenedAt: new Date(NOW.getTime() + 5 * DAY) })],
    clips: [],
    now: NOW,
    floor: FLOOR,
    config: config(),
  });
  check(
    "a row stamped in the future — a clock skew — makes the sweep do nothing, not everything",
    future.length === 0,
    JSON.stringify(keys(future)),
  );
}

/* ── 2. The file nobody may delete ─────────────────────────────────────────── */

section("The master is what they paid for, and nothing here can select one");
{
  const old = S.chooseRemovals({
    projects: [project({ lastOpenedAt: ago(3650) })],
    clips: [clip()],
    now: new Date(FLOOR.getTime() + 3650 * DAY),
    floor: FLOOR,
    // Every window at its most aggressive, including the one that is off by
    // default: if a master can ever be selected, it is selected here.
    config: config({ previewDays: 0, unusedSourceDays: 0, thumbnailDays: 1 }),
  });
  check(
    "ten years cold, every window at zero, and the master is still not in the list",
    !old.some((r) => r.key === `${USER}/p1/edited.mp4`),
    JSON.stringify(keys(old)),
  );
  check(
    "nor is a clip's own output, which is a master too",
    !old.some((r) => r.key === `${USER}/p1/clips/c1.mp4`),
    JSON.stringify(keys(old)),
  );
  check(
    "and the source of a project that has rendered is kept, because the master came from it",
    !old.some((r) => r.key === `${USER}/p1/source.mp4`),
    JSON.stringify(keys(old)),
  );
  check("what it does take is the copies", old.length > 0 && old.every((r) => r.kind !== "source"), JSON.stringify(old.map((r) => r.kind)));
}

/* ── 3. What each window means ─────────────────────────────────────────────── */

section("The previews, which cost megabytes and are found by convention");
{
  const cold = S.chooseRemovals({
    projects: [project()],
    clips: [clip()],
    now: new Date(FLOOR.getTime() + 100 * DAY),
    floor: FLOOR,
    config: config(),
  });
  check(
    "the project's preview goes",
    cold.some((r) => r.key === `${USER}/p1/edited.preview.webm`),
    JSON.stringify(keys(cold)),
  );
  check(
    "and each clip's, because a clip's preview is as cold as the project it is in",
    cold.some((r) => r.key === `${USER}/p1/clips/c1.preview.webm`),
    JSON.stringify(keys(cold)),
  );
  check(
    "no column is cleared for them — the player finds a preview by convention, so there is nothing to unname",
    cold.filter((r) => r.kind === "preview").every((r) => r.clear === undefined),
  );

  const warm = S.chooseRemovals({
    projects: [project()],
    clips: [clip()],
    now: new Date(FLOOR.getTime() + 89 * DAY),
    floor: FLOOR,
    config: config(),
  });
  check("nothing goes at eighty-nine days", warm.length === 0, JSON.stringify(keys(warm)));
}

section("The source nothing was ever made from");
{
  const never = S.chooseRemovals({
    projects: [project({ renders: 0 })],
    clips: [],
    now: new Date(FLOOR.getTime() + 31 * DAY),
    floor: FLOOR,
    config: config(),
  });
  const source = never.find((r) => r.kind === "source");
  check("goes after thirty days", source !== undefined, JSON.stringify(keys(never)));
  check(
    "and the column that named it is cleared afterwards, so the editor does not offer a file that is gone",
    source?.clear?.table === "projects" && source?.clear?.column === "video_path" && source?.clear?.id === "p1",
    JSON.stringify(source?.clear),
  );

  const queued = S.chooseRemovals({
    projects: [project({ renders: 1 })],
    clips: [],
    now: new Date(FLOOR.getTime() + 3650 * DAY),
    floor: FLOOR,
    config: config(),
  });
  check(
    "a project with even one job — queued, failed, anything — keeps its source forever",
    !queued.some((r) => r.kind === "source"),
    JSON.stringify(keys(queued)),
  );
}

section("The poster frames, which are off by default and the arithmetic says why");
{
  const dflt = S.chooseRemovals({
    projects: [project()],
    clips: [clip()],
    now: new Date(FLOOR.getTime() + 3650 * DAY),
    floor: FLOOR,
    config: config(),
  });
  check(
    "nothing sweeps a thumbnail unless somebody turns it on",
    !dflt.some((r) => r.kind === "thumbnail"),
    JSON.stringify(dflt.map((r) => r.kind)),
  );
  check("the default is the word never, not a large number", S.DEFAULT_RETENTION.thumbnailDays === 0);

  const on = S.chooseRemovals({
    projects: [project()],
    clips: [clip()],
    now: new Date(FLOOR.getTime() + 100 * DAY),
    floor: FLOOR,
    config: config({ thumbnailDays: 90 }),
  });
  check(
    "and when somebody does, both the project's and the clips' go, each with its column",
    on.filter((r) => r.kind === "thumbnail").length === 2 &&
      on.filter((r) => r.kind === "thumbnail").every((r) => r.clear?.column === "thumbnail_path"),
    JSON.stringify(on.filter((r) => r.kind === "thumbnail")),
  );
}

/* ── 4. Keys that are not ours ─────────────────────────────────────────────── */

section("A key that does not belong to the project it is on is not deleted");
{
  // The shape every object key in this product has is `<user>/<project>/…`.
  // A row whose path does not — a bad migration, a hand-edited row, a bug in
  // some future writer — is the one case where deleting is unrecoverable and
  // wrong, so it is skipped rather than trusted.
  const foreign = S.chooseRemovals({
    projects: [
      project({
        renders: 0,
        videoPath: "someone-else/p9/source.mp4",
        editedVideoPath: "/etc/passwd",
        thumbnailPath: "../../secrets.jpg",
      }),
    ],
    clips: [clip({ outputPath: "someone-else/p9/clips/c1.mp4", thumbnailPath: "x.jpg" })],
    now: new Date(FLOOR.getTime() + 3650 * DAY),
    floor: FLOOR,
    config: config({ thumbnailDays: 1 }),
  });
  check("not one of them is chosen", foreign.length === 0, JSON.stringify(keys(foreign)));
}

section("And the same object is never asked for twice");
{
  const twice = S.chooseRemovals({
    projects: [project()],
    // Two clips whose outputs are the same file, which is what a retry that
    // reused a key looks like from here.
    clips: [clip(), clip({ id: "c2" })],
    now: new Date(FLOOR.getTime() + 100 * DAY),
    floor: FLOOR,
    config: config(),
  });
  check("one key, one removal", new Set(keys(twice)).size === twice.length, JSON.stringify(keys(twice)));
}

/* ── 5. Doing it, and refusing to do it ────────────────────────────────────── */

section("Dry is the default, and dry deletes nothing");
{
  check("the shipped default is dry", S.DEFAULT_RETENTION.mode === "dry");
  check("and an unset environment stays dry", S.retentionFrom({}).mode === "dry");
  check("as does a typo", S.retentionFrom({ RETENTION_SWEEP: "yes please" }).mode === "dry");
  check("only the exact word switches it on", S.retentionFrom({ RETENTION_SWEEP: "on" }).mode === "on");
  check(
    "a window that is not a number falls back rather than becoming zero, which would mean today",
    S.retentionFrom({ RETENTION_PREVIEW_DAYS: "ninety" }).previewDays === 90 &&
      S.retentionFrom({ RETENTION_UNUSED_SOURCE_DAYS: "-4" }).unusedSourceDays === 30,
  );

  /*
    And zero is not a number of days either, for the two windows that delete
    something irreplaceable.

    The guard was `raw >= 0`, and the comment two lines above it said a typo
    "must not be able to mean 'delete everything today'". Zero is exactly that
    instruction: a project created five minutes ago has `coldDays` of 0, and
    `0 >= 0` selects it. Two ways a real deployment reached it —
    `Number("") === 0`, so a variable that is present and empty did **not**
    fall back; and this same file documents `thumbnailDays: 0` as meaning
    *never*, so an operator writes zero by analogy and gets the opposite.
  */
  check(
    "an empty variable falls back rather than meaning today",
    S.retentionFrom({ RETENTION_UNUSED_SOURCE_DAYS: "" }).unusedSourceDays === 30 &&
      S.retentionFrom({ RETENTION_PREVIEW_DAYS: "" }).previewDays === 90,
    JSON.stringify(S.retentionFrom({ RETENTION_UNUSED_SOURCE_DAYS: "" })),
  );
  check(
    "and so does a literal zero, which is the one value that means 'delete it today'",
    S.retentionFrom({ RETENTION_UNUSED_SOURCE_DAYS: "0" }).unusedSourceDays === 30 &&
      S.retentionFrom({ RETENTION_PREVIEW_DAYS: "0" }).previewDays === 90,
    JSON.stringify(S.retentionFrom({ RETENTION_UNUSED_SOURCE_DAYS: "0" })),
  );
  check(
    "while zero still means never for the poster frames, where it is documented and harmless",
    S.retentionFrom({ RETENTION_THUMBNAIL_DAYS: "0" }).thumbnailDays === 0,
    String(S.retentionFrom({ RETENTION_THUMBNAIL_DAYS: "0" }).thumbnailDays),
  );

  /*
    A window may be made longer than what the customer was told, never shorter.

    `/privacy` renders `RETENTION.previewDays` and `RETENTION.unusedSourceDays`
    and this suite's neighbour binds that page to `DEFAULT_RETENTION`. The
    deployed windows are environment variables, and nothing reconciled the two:
    `RETENTION_UNUSED_SOURCE_DAYS=7` deleted customer sources twenty-three days
    before the page they agreed to said it would, with a green build.
  */
  check(
    "a window shorter than the published policy is refused in favour of the promise",
    S.retentionFrom({ RETENTION_UNUSED_SOURCE_DAYS: "7" }).unusedSourceDays === 30 &&
      S.retentionFrom({ RETENTION_PREVIEW_DAYS: "10" }).previewDays === 90,
    JSON.stringify(S.retentionFrom({ RETENTION_UNUSED_SOURCE_DAYS: "7", RETENTION_PREVIEW_DAYS: "10" })),
  );
  check(
    "a longer one is honoured, because keeping something longer breaks no promise",
    S.retentionFrom({ RETENTION_UNUSED_SOURCE_DAYS: "120" }).unusedSourceDays === 120,
    String(S.retentionFrom({ RETENTION_UNUSED_SOURCE_DAYS: "120" }).unusedSourceDays),
  );

  /*
    And the shape of the thing all of that protects: a file uploaded today is
    not sweepable, whatever a window says. Asked directly, because the question
    "prove the age computation cannot select a file uploaded today" is the one
    this module exists to be able to answer yes to.
  */
  const today = new Date();
  const uploadedToday = S.chooseRemovals({
    projects: [{
      id: "p-fresh", userId: USER,
      editedVideoPath: null, videoPath: `${USER}/p-fresh/source.mp4`, thumbnailPath: null,
      lastOpenedAt: today, updatedAt: today, renders: 0,
    }],
    clips: [],
    now: today,
    floor: today,
    config: S.retentionFrom({ RETENTION_SWEEP: "on", RETENTION_UNUSED_SOURCE_DAYS: "0" }),
  });
  check(
    "a source uploaded minutes ago is never selected, whatever the window says",
    uploadedToday.length === 0,
    JSON.stringify(uploadedToday),
  );

  const calls = [];
  const result = await S.applyRemovals(
    [{ key: `${USER}/p1/edited.preview.webm`, kind: "preview", why: "cold" }],
    { ...S.DEFAULT_RETENTION, mode: "dry" },
    {
      remove: async (k) => calls.push(["remove", ...k]),
      clearColumn: async (t, id, c) => calls.push(["clear", t, id, c]),
      log: () => {},
    },
  );
  check("it counts what it would take", result.chosen === 1 && result.byKind.preview === 1, JSON.stringify(result));
  check("and touches nothing", calls.length === 0 && result.removed === 0, JSON.stringify(calls));

  check("off does not even choose", S.chooseRemovals({ projects: [project({ lastOpenedAt: ago(3650) })], clips: [], now: NOW, floor: FLOOR, config: config({ mode: "off" }) }).length === 0);
}

section("The file first, the row after — the order is the whole point");
{
  const calls = [];
  await S.applyRemovals(
    [
      {
        key: `${USER}/p1/source.mp4`,
        kind: "source",
        clear: { table: "projects", id: "p1", column: "video_path" },
        why: "never rendered",
      },
    ],
    config(),
    {
      remove: async (k) => calls.push(`remove ${k[0]}`),
      clearColumn: async (t, id, c) => calls.push(`clear ${t}.${c} on ${id}`),
      log: () => {},
    },
  );
  check(
    "the object is deleted before the column that named it is emptied",
    calls[0]?.startsWith("remove") && calls[1]?.startsWith("clear"),
    JSON.stringify(calls),
  );

  // And the reason that order is not a preference: if the delete fails and the
  // column has already been cleared, the file is an orphan forever — nothing
  // will ever name it again, so no later sweep can find it.
  const afterFailure = [];
  const failed = await S.applyRemovals(
    [
      {
        key: `${USER}/p1/source.mp4`,
        kind: "source",
        clear: { table: "projects", id: "p1", column: "video_path" },
        why: "never rendered",
      },
    ],
    config(),
    {
      remove: async () => {
        throw new Error("the bucket said no");
      },
      clearColumn: async (t, id, c) => afterFailure.push(`clear ${t}.${c} on ${id}`),
      log: () => {},
    },
  );
  check("a delete that fails leaves the row alone, so the next sweep tries again", afterFailure.length === 0);
  check("and is counted rather than thrown", failed.failed === 1 && failed.removed === 0, JSON.stringify(failed));

  const mixed = await S.applyRemovals(
    [
      { key: "a", kind: "preview", why: "" },
      { key: "b", kind: "preview", why: "" },
      { key: "c", kind: "preview", why: "" },
    ],
    config(),
    {
      remove: async (k) => {
        if (k[0] === "b") throw new Error("no");
      },
      clearColumn: async () => {},
      log: () => {},
    },
  );
  check("one object that will not go does not stop the next twenty", mixed.removed === 2 && mixed.failed === 1, JSON.stringify(mixed));
}

/* ── 6. The wiring, which is where a sweep gets dangerous ──────────────────── */

section("What the worker does with it");
{
  const worker = readFileSync(path.join(repoRoot, "artifacts/worker/src/index.ts"), "utf8");
  check(
    "the sweep is called from the loop, once",
    (worker.match(/await sweepAgedFiles\(\)/g) ?? []).length === 1,
  );
  check(
    "it deletes through the storage seam and not through an address built by hand",
    /objectStoreFrom\(\)/.test(worker) && /remove: \(keys\) => store\.remove\(keys\)/.test(worker),
  );
  check(
    "it reads its floor from the ledger row for migration 0040",
    /schema_migrations WHERE filename = '0040_last_opened\.sql'/.test(worker),
  );
  check(
    "and does nothing at all when that row is missing, rather than guessing a date",
    /if \(!floor\)[\s\S]{0,400}?return;/.test(worker),
  );
  check(
    "the mode it is running in is on the startup line, so nobody discovers it from a missing file",
    /retention: `\$\{retention\.mode\}/.test(worker),
  );

  const migration = readFileSync(path.join(repoRoot, "lib/db/migrations/0040_last_opened.sql"), "utf8");
  check("the migration adds the column the sweep ages from", /last_opened_at/.test(migration));
  check(
    "and it is added, never backfilled — a backfill would be inventing a date somebody opened something",
    !/UPDATE projects/i.test(migration),
  );

  // The rule that makes the column safe to read at all: something has to write
  // it. A sweep shipped against a column nobody fills is the disaster in
  // section 1, and the only defence is that the writer exists.
  const route = readFileSync(path.join(repoRoot, "artifacts/api-server/src/routes/projects.ts"), "utf8");
  check(
    "opening a project stamps it, so the column is not read before anything writes it",
    /last_opened_at = now\(\)/.test(route),
  );
  check(
    "written without moving updated_at, which answers a different question",
    !/lastOpenedAt: new Date\(\)/.test(route),
  );
}

await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log("A sweep that is wrong is wrong permanently.");
  process.exit(1);
}
console.log("Cold copies age out; the file somebody paid for does not.");
