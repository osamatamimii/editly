/**
 * What a render costs, and whether that number can be wrong.
 *
 * The meter counts one column: `jobs.output_seconds`, summed over finished jobs
 * this month. Everything about billing rests on that column being right, and it
 * had three ways to be wrong — all of them in the customer's favour, which is
 * precisely why none of them would ever have been reported.
 *
 *   A failed ffprobe wrote null, and SQL's SUM skips nulls, so a render nobody
 *   could measure was free. Forever. With no alert and no reconciliation.
 *
 *   The upload ceiling that separates the paid tiers was enforced against a
 *   duration the browser sent, which was optional. Omitting it removed the
 *   ceiling.
 *
 *   A template placed its punches against `duration ?? 30`, so a ten-minute
 *   talk got four zooms in the first twenty seconds and nothing after.
 *
 * The checks here are written from the position of someone who wants the render
 * for nothing: make the probe fail, send no duration at all, send a duration of
 * one second for a four-hour file.
 *
 * Usage: node tools/meter-test.mjs
 * Requires: nothing. No keys, no network, no database, no ffmpeg.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-meter-build-"));

function bundle(entry, name, from) {
  const outfile = path.join(buildDir, name);
  const result = spawnSync(
    require.resolve("esbuild/bin/esbuild", { paths: [from] }),
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

const { measureOutput, exceedsCeiling, tooLongMessage } = await import(
  bundle("artifacts/worker/src/duration.ts", "duration.mjs", "artifacts/worker")
);
const { evenlySpacedPunches, TEMPLATES, findTemplate } = await import(
  bundle("artifacts/api-server/src/lib/templates.ts", "templates.mjs", "artifacts/api-server")
);
const { minutesFrom, PLAN_LIMITS } = await import(
  bundle("artifacts/api-server/src/lib/plan-limits.ts", "plan-limits.mjs", "artifacts/api-server")
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
const section = (title) => console.log(`\n${title}`);

const succeeds = (seconds) => async () => seconds;
const fails = (message = "ffprobe: moov atom not found") => async () => {
  throw new Error(message);
};
/** Fails the first n calls, then succeeds. */
const flaky = (n, seconds) => {
  let called = 0;
  return async () => {
    called += 1;
    if (called <= n) throw new Error("ffprobe: temporarily out of memory");
    return seconds;
  };
};

// ─── The column the money comes from ─────────────────────────────────────────

section("A render that can be measured is measured");
{
  const measured = await measureOutput(succeeds(87.4), { estimate: 90, sourceSeconds: 300 });
  check("the file wins over every estimate", measured.seconds === 87.4);
  check("and says it was measured", measured.how === "probe");
  check("which is what the meter will charge", minutesFrom(measured.seconds) === 2);
}

section("A probe that fails once is not believed the first time");
{
  const measured = await measureOutput(flaky(1, 87.4), { estimate: 90, sourceSeconds: 300 });
  check("a second attempt is made", measured.seconds === 87.4);
  check("and it still counts as measured", measured.how === "probe");
}

section("A render that cannot be measured is charged, not forgiven");
{
  const measured = await measureOutput(fails(), { estimate: 90, sourceSeconds: 300 });
  check("something is returned", typeof measured.seconds === "number");
  check("it is the plan's own arithmetic", measured.seconds === 90);
  check("and it is labelled an estimate, not a measurement", measured.how === "estimate");
  check("null is never the answer", measured.seconds !== null && measured.seconds > 0);
  check("so the meter counts it", minutesFrom(measured.seconds) === 2);
}

section("With no estimate either, the source length is used — erring against us");
{
  const measured = await measureOutput(fails(), { estimate: null, sourceSeconds: 300 });
  check("the source is the last resort", measured.seconds === 300);
  check("labelled as such", measured.how === "fallback");
  check(
    "and it can only ever overcharge, never undercharge — no edit lengthens a clip",
    measured.seconds >= 90,
  );
}

section("A render with nothing to measure and nothing to estimate from fails loudly");
{
  let thrown = null;
  try {
    await measureOutput(fails(), { estimate: null, sourceSeconds: null });
  } catch (error) {
    thrown = error;
  }
  check("it throws rather than writing a number", thrown !== null);
  check("and says what happened", /could not be measured/.test(thrown?.message ?? ""), thrown?.message);
}

section("Nonsense from ffprobe is not accepted as a measurement");
{
  for (const [label, value] of [["zero", 0], ["negative", -5], ["NaN", NaN], ["Infinity", Infinity]]) {
    const measured = await measureOutput(succeeds(value), { estimate: 90, sourceSeconds: 300 });
    check(`a duration of ${label} falls through to the estimate`, measured.seconds === 90 && measured.how === "estimate");
  }
}

// ─── The ceiling that separates the tiers ────────────────────────────────────

section("The upload ceiling is enforced against the file, not against a claim");
{
  const freeCeiling = PLAN_LIMITS.free.maxUploadMinutes * 60;
  check("a file inside the ceiling passes", exceedsCeiling(freeCeiling - 60, freeCeiling) === false);
  check("a file past it does not", exceedsCeiling(freeCeiling + 120, freeCeiling) === true);
  check(
    "a file at the ceiling passes — the boundary belongs to the customer",
    exceedsCeiling(freeCeiling, freeCeiling) === false,
  );
  check(
    "container rounding does not cost anyone a render",
    exceedsCeiling(freeCeiling + 0.04, freeCeiling) === false,
  );
  check("but a real overrun is not absorbed by the tolerance", exceedsCeiling(freeCeiling + 5, freeCeiling) === true);
}

section("A job queued before the ceiling existed is not retroactively refused");
{
  check("no ceiling recorded means no ceiling enforced", exceedsCeiling(4 * 3600, null) === false);
  check("nor does a nonsense one", exceedsCeiling(4 * 3600, 0) === false);
  check("nor an infinite one", exceedsCeiling(4 * 3600, Infinity) === false);
}

section("The refusal names the numbers rather than saying 'too long'");
{
  const message = tooLongMessage(45 * 60, 30 * 60);
  check("it says how long the file is", /45 minutes/.test(message), message);
  check("and what the plan takes", /up to 30/.test(message), message);
  check("and offers a way forward", /longer plan|shorter clip/.test(message), message);
}

// ─── The guess that was placing zooms ────────────────────────────────────────

section("A template does not pretend to know how long the video is");
{
  check("an unknown duration places no punches at all", evenlySpacedPunches(null, 4).length === 0);
  check("nor does undefined", evenlySpacedPunches(undefined, 4).length === 0);
  check("nor zero", evenlySpacedPunches(0, 4).length === 0);
  check("nor NaN", evenlySpacedPunches(NaN, 4).length === 0);

  // An empty `at` is not a failure — it is the plan saying "you choose", and
  // the worker chooses from the transcript, which is better than any arithmetic
  // over a length we would have had to invent.
  const highEnergy = findTemplate("high-energy").build({
    platform: "tiktok",
    durationSeconds: null,
    watermark: false,
  });
  const punch = highEnergy.find((op) => op.type === "zoomPunch");
  check("so the template still asks for punches", punch !== undefined);
  check("with the moments left to the worker", punch.at.length === 0, JSON.stringify(punch?.at));
  check("and the rest of the look is intact", highEnergy.some((op) => op.type === "removeSilence"));
}

section("A known duration still places them proportionally");
{
  const punches = evenlySpacedPunches(600, 4);
  check("four of them", punches.length === 4);
  check("none in the first two seconds — a zoom on the hook fights it", punches.every((t) => t >= 2));
  check("none in the last two — nobody is still watching", punches.every((t) => t <= 598));
  check("spread across the whole clip, not the first half", punches[3] > 300, String(punches[3]));
  check("in order", punches.every((t, i) => i === 0 || t > punches[i - 1]));

  const short = evenlySpacedPunches(30, 4);
  check("a short clip gets them too", short.length === 4);
  check("and they scale to it", short[3] < 30, String(short[3]));
}

section("Every template survives an unmeasured file");
{
  for (const template of TEMPLATES) {
    const operations = template.build({ platform: "tiktok", durationSeconds: null, watermark: false });
    const ok =
      operations.length > 0 &&
      operations.every((op) => op.type !== "zoomPunch" || Array.isArray(op.at));
    check(`${template.id} builds a usable plan`, ok, JSON.stringify(operations));
  }
}

// ─── The query that decides what somebody owes ───────────────────────────────
//
// Everything above is arithmetic on numbers already in hand. This is the SQL
// that produces them, and it has three edges nothing else covers: which month a
// render belongs to, which statuses count, and whose renders they are. All
// three are one WHERE clause away from being silently wrong in the customer's
// favour, which is the direction nobody reports.

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.log("\n! Skipping the meter query: set DATABASE_URL to a Postgres with the schema to run it.");
  console.log("  Everything above needs no database; this section needs the real query.");
} else {
  const { Pool } = require(require.resolve("pg", { paths: ["lib/db"] }));
  const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });

  // `usage.ts` reaches the database through `pg`, which uses CommonJS `require`
  // at runtime and cannot be bundled into ESM. So it is left external and the
  // bundle is written inside a package that can resolve it — the same shape the
  // billing suite uses for express.
  const usageBundle = path.join(repoRoot, "lib/db/.meter-test-usage.mjs");
  const usageBuild = spawnSync(
    require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] }),
    [
      path.join(repoRoot, "artifacts/api-server/src/lib/usage.ts"),
      "--bundle", "--platform=node", "--format=esm", "--target=node22",
      "--external:pg", `--outfile=${usageBundle}`, "--log-level=error",
    ],
    { stdio: "inherit" },
  );
  if (usageBuild.status !== 0) {
    console.error("could not bundle the usage module");
    process.exit(1);
  }
  const { usageFor, startOfMonthUtc } = await import(pathToFileURL(usageBundle).href);

  const METERED = "33333333-3333-4333-8333-333333333333";
  const OTHER = "44444444-4444-4444-8444-444444444444";

  const insert = async (id, userId, over = {}) => {
    const columns = {
      id,
      user_id: userId,
      project_id: `p-${id}`,
      status: "done",
      plan: JSON.stringify({ version: 1, operations: [] }),
      input_path: `${userId}/p-${id}/source.mp4`,
      output_seconds: 60,
      finished_at: new Date().toISOString(),
      ...over,
    };
    const names = Object.keys(columns);
    await pool.query(
      `INSERT INTO jobs (${names.join(",")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(",")})`,
      Object.values(columns),
    );
  };

  const clear = () => pool.query("DELETE FROM jobs WHERE user_id = ANY($1)", [[METERED, OTHER]]);

  section("The month boundary is where a bill starts");
  {
    await clear();
    const startOfThisMonth = startOfMonthUtc();
    const justInside = new Date(startOfThisMonth.getTime() + 1000).toISOString();
    const justOutside = new Date(startOfThisMonth.getTime() - 1000).toISOString();

    await insert("this-month", METERED, { output_seconds: 120, finished_at: justInside });
    await insert("last-month", METERED, { output_seconds: 6000, finished_at: justOutside });

    const usage = await usageFor(METERED, "free");
    check("a render one second into the month counts", usage.minutesUsed === 2, JSON.stringify(usage));
    check(
      "one a second before it does not — otherwise nobody's allowance ever resets",
      usage.minutesUsed === 2,
      JSON.stringify(usage),
    );
    check("the boundary is UTC midnight on the first", startOfThisMonth.getUTCDate() === 1);
    check("with no local-time drift", startOfThisMonth.getUTCHours() === 0 && startOfThisMonth.getUTCMinutes() === 0);
  }

  section("Only finished renders are charged for");
  {
    await clear();
    await insert("done", METERED, { output_seconds: 60 });
    await insert("running", METERED, { status: "running", output_seconds: 600 });
    await insert("queued", METERED, { status: "queued", output_seconds: 600 });
    await insert("failed", METERED, { status: "failed", output_seconds: 600 });

    const usage = await usageFor(METERED, "free");
    check("the finished one is billed", usage.minutesUsed === 1, JSON.stringify(usage));
    check(
      "a render that died on our side is our problem, not their balance",
      usage.minutesUsed === 1,
      JSON.stringify(usage),
    );
  }

  section("A render nobody could measure is skipped, not counted as free");
  {
    await clear();
    await insert("measured", METERED, { output_seconds: 60 });
    await insert("unmeasured", METERED, { output_seconds: null });

    const usage = await usageFor(METERED, "free");
    check("the null does not crash the sum", Number.isFinite(usage.minutesUsed));
    check("and it contributes nothing rather than a zero", usage.minutesUsed === 1, JSON.stringify(usage));
  }

  section("The meter is per person");
  {
    await clear();
    await insert("mine", METERED, { output_seconds: 60 });
    await insert("theirs", OTHER, { output_seconds: 6000 });

    const mine = await usageFor(METERED, "free");
    const theirs = await usageFor(OTHER, "free");
    check("I am billed for mine", mine.minutesUsed === 1, JSON.stringify(mine));
    check("and not for theirs", mine.minutesUsed === 1);
    check("they are billed for theirs", theirs.minutesUsed === 100, JSON.stringify(theirs));
  }

  section("Running out is reported before it is exceeded, not after");
  {
    await clear();
    // The free plan includes five minutes.
    await insert("four", METERED, { output_seconds: 240 });
    const under = await usageFor(METERED, "free");
    check("four of five is not exhausted", under.exhausted === false, JSON.stringify(under));
    check("and one minute remains", under.minutesRemaining === 1, JSON.stringify(under));

    await insert("one-more", METERED, { output_seconds: 60 });
    const at = await usageFor(METERED, "free");
    check("five of five is exhausted", at.exhausted === true, JSON.stringify(at));
    check("with nothing remaining", at.minutesRemaining === 0, JSON.stringify(at));
    check("and remaining never goes negative", (await usageFor(METERED, "free")).minutesRemaining >= 0);
  }

  section("Seconds round up, as anyone reading a meter would expect");
  {
    await clear();
    await insert("sixty-one", METERED, { output_seconds: 61 });
    const usage = await usageFor(METERED, "free");
    check("a 61-second render costs two minutes", usage.minutesUsed === 2, JSON.stringify(usage));
  }

  await clear();
  await pool.end();
  await rm(usageBundle, { force: true });
}

await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("A render that happened is a render that was counted.");
