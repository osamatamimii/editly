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

await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("A render that happened is a render that was counted.");
