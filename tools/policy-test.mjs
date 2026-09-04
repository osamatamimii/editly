/**
 * Can someone get a free render they should not have had?
 *
 * Three ways, and this repo shipped all three at once.
 *
 * The watermark was decided in the browser and sent as an operation in the
 * request body, so removing it took deleting one object from a JSON payload.
 * The editor's render route never checked the month's allowance at all, so the
 * free plan's five minutes bound only the people who used the other button.
 * And new accounts were created on a plan name the rename had turned into an
 * alias for Creator, so everyone who signed up got sixty watermark-free
 * minutes without paying.
 *
 * None of those would ever have been reported by a user. So the checks here are
 * written from the position of someone trying to take something: send a plan
 * with no mark, send one with a mark reading ".", send a full twelve operations
 * so there is no room for ours, ask for a four-hour file on the free plan.
 *
 * Usage: node tools/policy-test.mjs
 * Requires: nothing. No keys, no network, no database.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-policy-build-"));
const outfile = path.join(buildDir, "policy.mjs");

const built = spawnSync(
  require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] }),
  [
    path.join(repoRoot, "artifacts/api-server/src/lib/render-policy.ts"),
    "--bundle", "--platform=node", "--format=esm", "--target=node22",
    `--outfile=${outfile}`, "--log-level=error",
  ],
  { stdio: "inherit" },
);
if (built.status !== 0) {
  console.error("could not bundle the policy module");
  process.exit(1);
}

const { decideRender, smallestPlanFor, FREE_WATERMARK, MAX_RENDERS_IN_FLIGHT } = await import(pathToFileURL(outfile).href);

/*
  The ceiling, read from the schema that enforces it rather than typed here.

  It was twelve, in five places. This file held a sixth copy, and the day the
  direction raised the real one this check went on asserting the old number —
  which is the whole reason the constant is now exported and imported instead of
  written down.
*/
const zodOut = path.join(buildDir, "zod.mjs");
if (
  spawnSync(
    require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] }),
    [
      path.join(repoRoot, "lib/api-zod/src/index.ts"),
      "--bundle", "--platform=node", "--format=esm", "--target=node22",
      `--outfile=${zodOut}`, "--log-level=error",
    ],
    { stdio: "inherit" },
  ).status !== 0
) {
  console.error("could not bundle the contract");
  process.exit(1);
}
const { MAX_PLAN_OPERATIONS } = await import(pathToFileURL(zodOut).href);

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

/**
 * One shape, built the way `usageFor` builds it.
 *
 * Three of these were hand-written object literals further down the file, and
 * when `Usage` grew `secondsRemaining` and `jobsInFlight` those three kept
 * typechecking — a .mjs test does not typecheck at all — and started asserting
 * against `undefined`. The whole point of the seconds balance is that it is
 * not `minutesRemaining * 60`, so a test that builds it by hand is a test of
 * the arithmetic it was written to replace.
 */
const usage = (used, included, { inFlightMinutes = 0, jobs = 0, secondsUsed = used * 60 } = {}) => ({
  minutesUsed: used,
  minutesIncluded: included,
  minutesGranted: 0,
  minutesInFlight: inFlightMinutes,
  jobsInFlight: jobs,
  minutesRemaining: Math.max(0, included - used - inFlightMinutes),
  secondsRemaining: Math.max(0, included * 60 - secondsUsed - inFlightMinutes * 60),
  exhausted: used + inFlightMinutes >= included,
});

const SILENCE = { type: "removeSilence", thresholdDb: -32, minSilenceMs: 500, paddingMs: 80 };
const VERTICAL = { type: "formatForPlatform", platform: "tiktok" };
const marks = (result) => (result.operations ?? []).filter((op) => op.type === "watermark");

console.log("\nTaking the mark off");
{
  // The original attack: the browser simply does not send it.
  const stripped = decideRender({
    plan: "free",
    usage: usage(0, 5),
    operations: [SILENCE, VERTICAL],
  });
  check("a free plan gets the mark even when the request omits it", marks(stripped).length === 1, JSON.stringify(stripped.operations));
  check(
    "and it is our text, in our corner",
    marks(stripped)[0]?.text === FREE_WATERMARK.text && marks(stripped)[0]?.position === FREE_WATERMARK.position,
    JSON.stringify(marks(stripped)[0]),
  );
  check("the mark is drawn last, over everything else", stripped.operations.at(-1).type === "watermark", "");

  // The subtler one: send a mark, but an unreadable one in the corner TikTok
  // covers with its own interface.
  const sneaky = decideRender({
    plan: "free",
    usage: usage(0, 5),
    operations: [SILENCE, { type: "watermark", text: ".", position: "bottom-center" }],
  });
  check("a client-supplied mark on the free plan is replaced, not kept", marks(sneaky).length === 1, "");
  check("with ours, not theirs", marks(sneaky)[0]?.text === FREE_WATERMARK.text, JSON.stringify(marks(sneaky)[0]));
  check("and the substitution is reported rather than silent", sneaky.corrections.some((c) => c.includes("replaced")), JSON.stringify(sneaky.corrections));

  // Filling every slot so there is no room for the thirteenth operation. The
  // plan schema caps a render at twelve, and a thirteenth fails in the worker,
  // where it looks like a broken render rather than a policy decision.
  const full = decideRender({
    plan: "free",
    usage: usage(0, 5),
    operations: Array.from({ length: MAX_PLAN_OPERATIONS }, () => ({ ...SILENCE })),
  });
  check("a full plan cannot crowd the mark out", marks(full).length === 1, "");
  check(
    "and the result still fits the plan schema",
    full.operations.length <= MAX_PLAN_OPERATIONS,
    `${full.operations.length} operations against a cap of ${MAX_PLAN_OPERATIONS}`,
  );
}

console.log("\nPaying for it, and keeping your own mark");
{
  for (const plan of ["creator", "pro", "studio"]) {
    const result = decideRender({ plan, usage: usage(1, 60), operations: [SILENCE, VERTICAL] });
    check(`${plan} renders carry no mark`, marks(result).length === 0, JSON.stringify(result.operations));
  }

  // A paid customer branding their own video is a feature, not an attack.
  const branded = decideRender({
    plan: "pro",
    usage: usage(1, 400),
    operations: [SILENCE, { type: "watermark", text: "@osama", position: "top-right" }],
  });
  check("a paid customer keeps their own watermark", marks(branded)[0]?.text === "@osama", JSON.stringify(marks(branded)));
  check("and nothing was corrected", branded.corrections.length === 0, JSON.stringify(branded.corrections));
}

console.log("\nRunning out");
{
  const spent = decideRender({ plan: "free", usage: usage(5, 5), operations: [SILENCE] });
  check("an exhausted allowance refuses the render", spent.allowed === false, "");
  check("with 429, not 500 — this is a limit, not a fault", spent.status === 429, String(spent.status));
  check("and the message names the number", String(spent.body?.error).includes("5"), String(spent.body?.error));
  check("and the plan, so the UI can offer the way out", spent.body?.plan === "free", "");

  const overspent = decideRender({ plan: "creator", usage: usage(75, 60), operations: [SILENCE] });
  check("going past the allowance is still refused, not merely reaching it", overspent.allowed === false, "");

  const last = decideRender({ plan: "creator", usage: usage(59, 60), operations: [SILENCE] });
  check("the last minute is still allowed", last.allowed === true, "");
}

console.log("\nA file that is too long");
{
  // Four hours on the free plan, whose ceiling is ten minutes.
  const long = decideRender({
    plan: "free",
    usage: usage(0, 5),
    operations: [SILENCE],
    sourceDurationSeconds: 4 * 3600,
  });
  check("a four-hour file is refused on the free plan", long.allowed === false, "");
  check("with 413 rather than 429 — a different problem, a different fix", long.status === 413, String(long.status));
  check("and it names the plan that would have taken it", long.body?.suggestedPlan === "pro", JSON.stringify(long.body));
  check(
    "the message says how long the file is and what this plan takes",
    String(long.body?.error).includes("240 minutes") && String(long.body?.error).includes("free plan takes up to 10"),
    String(long.body?.error),
  );

  const fine = decideRender({
    plan: "pro",
    usage: usage(0, 400),
    operations: [SILENCE],
    sourceDurationSeconds: 4 * 3600,
  });
  check("the same file is fine on Pro", fine.allowed === true, JSON.stringify(fine.body));

  // Six hours is above Pro and exactly Studio's ceiling.
  check("Studio is offered for a six-hour file", smallestPlanFor(360) === "studio", String(smallestPlanFor(360)));
  check("nothing is offered beyond Studio's ceiling", smallestPlanFor(601) === null, String(smallestPlanFor(601)));

  const noBetterPlan = decideRender({
    plan: "studio",
    usage: usage(0, 1000),
    operations: [SILENCE],
    sourceDurationSeconds: 11 * 3600,
  });
  check(
    "an eleven-hour file suggests splitting rather than a plan that does not exist",
    noBetterPlan.allowed === false && /\bsplit\b/i.test(String(noBetterPlan.body?.error)),
    String(noBetterPlan.body?.error),
  );

  // Duration is often unknown — a project created before we measured it, or a
  // file we could not probe. Unknown must not mean refused.
  for (const unknown of [null, undefined, 0, NaN]) {
    const result = decideRender({ plan: "free", usage: usage(0, 5), operations: [SILENCE], sourceDurationSeconds: unknown });
    check(`an unmeasured duration (${String(unknown)}) does not block the render`, result.allowed === true, "");
  }

  // Exactly at the ceiling is inside it. Off-by-one here refuses a file the
  // pricing page promises.
  const exact = decideRender({
    plan: "creator",
    usage: usage(0, 60),
    operations: [SILENCE],
    sourceDurationSeconds: 30 * 60,
  });
  check("a file exactly at the ceiling is accepted", exact.allowed === true, JSON.stringify(exact.body));
}

console.log("\nA render is refused before the encode, not after it");
{
  // The hole this closes: the meter only ever noticed *after* a render. Someone
  // with two minutes left could queue a four-hour file, we would pay for the
  // encode, and the refusal would arrive on their next request.
  const overrun = decideRender({
    plan: "creator",
    usage: usage(58, 60),
    operations: [SILENCE],
    sourceDurationSeconds: 12 * 60,
  });
  check("a clip longer than the balance is refused", overrun.allowed === false);
  check("as an allowance problem, not a file-size one", overrun.status === 429, String(overrun.status));
  check("flagged as a projection rather than an exhausted meter", overrun.body?.wouldExceed === true);
  check("the message names the clip's length", /12 minutes/.test(overrun.body?.error ?? ""), overrun.body?.error);
  check("and how much is left", /2 minutes left/.test(overrun.body?.error ?? ""), overrun.body?.error);
  check("the numbers travel with it", overrun.body?.projectedMinutes === 12 && overrun.body?.minutesRemaining === 2);

  const fits = decideRender({
    plan: "creator",
    usage: usage(58, 60),
    operations: [SILENCE],
    sourceDurationSeconds: 110,
  });
  check("a clip that fits is allowed", fits.allowed === true, JSON.stringify(fits.body));

  const exact = decideRender({
    plan: "creator",
    usage: usage(58, 60),
    operations: [SILENCE],
    sourceDurationSeconds: 120,
  });
  check("a clip exactly the size of the balance is allowed", exact.allowed === true, JSON.stringify(exact.body));

  const oneSecondOver = decideRender({
    plan: "creator",
    usage: usage(58, 60),
    operations: [SILENCE],
    sourceDurationSeconds: 121,
  });
  check("a second past it is not — minutes round up, as the meter does", oneSecondOver.allowed === false);

  const unknown = decideRender({
    plan: "creator",
    usage: usage(58, 60),
    operations: [SILENCE],
    sourceDurationSeconds: null,
  });
  check(
    "an unmeasured file is not refused here — the worker enforces it against the real one",
    unknown.allowed === true,
  );

  const studio = decideRender({
    plan: "studio",
    usage: usage(599, 600),
    operations: [SILENCE],
    sourceDurationSeconds: 600,
  });
  check("the top plan is not told to upgrade", !/Upgrading/.test(studio.body?.error ?? ""), studio.body?.error);
  check("it is told when the minutes come back", /reset at the start of next month/.test(studio.body?.error ?? ""), studio.body?.error);
}

console.log("\nThe ceiling the worker will actually enforce travels with the decision");
{
  const free = decideRender({ plan: "free", usage: usage(0, 5), operations: [SILENCE] });
  check("an approval carries a ceiling", typeof free.maxSourceSeconds === "number");
  check("in seconds, matching the plan", free.maxSourceSeconds === 10 * 60, String(free.maxSourceSeconds));

  const pro = decideRender({ plan: "pro", usage: usage(0, 200), operations: [SILENCE] });
  check("a bigger plan carries a bigger one", pro.maxSourceSeconds === 240 * 60, String(pro.maxSourceSeconds));
  check(
    "and it does not depend on what the browser claimed the duration was",
    decideRender({ plan: "pro", usage: usage(0, 200), operations: [SILENCE], sourceDurationSeconds: 3 })
      .maxSourceSeconds === pro.maxSourceSeconds,
  );
}

console.log("\nResolution is decided by the tier, not by the browser");
{
  const ask = (plan, maxHeight) =>
    decideRender({
      plan,
      usage: usage(0, 60),
      operations: [SILENCE, { type: "formatForPlatform", platform: "tiktok", maxHeight }],
    });
  const heightOf = (r) => r.operations.find((op) => op.type === "formatForPlatform").maxHeight;

  const greedy = ask("free", 2160);
  check("a free plan asking for 4K does not get it", heightOf(greedy) === 1280, String(heightOf(greedy)));
  check("but the render is not refused over it", greedy.allowed === true);
  check("and the correction is recorded rather than silent", greedy.corrections.some((c) => /2160/.test(c)), greedy.corrections.join(" | "));

  check("Pro asking for 4K gets it", heightOf(ask("pro", 2160)) === 2160);
  check("Creator asking for 4K gets 1080p", heightOf(ask("creator", 2160)) === 1920);
  check("asking for less than the tier allows is honoured", heightOf(ask("pro", 1280)) === 1280);
  check("and asking for less is not a correction", ask("pro", 1280).corrections.length === 0);

  const unset = decideRender({
    plan: "creator",
    usage: usage(0, 60),
    operations: [SILENCE, { type: "formatForPlatform", platform: "tiktok" }],
  });
  check("asking for nothing gets the tier's own ceiling", heightOf(unset) === 1920, String(heightOf(unset)));
}

console.log("\nPaid work is claimed first, and that is the whole of it");
{
  const priorityOf = (plan) =>
    decideRender({ plan, usage: usage(0, 60), operations: [SILENCE] }).priority;

  check("free waits", priorityOf("free") === 0);
  check("so does Creator, which is not sold a queue", priorityOf("creator") === 0);
  check("Pro is claimed first", priorityOf("pro") > 0);
  check("Studio too", priorityOf("studio") > 0);
  check(
    "but Studio does not jump Pro — that would sell one customer the other's wait",
    priorityOf("studio") === priorityOf("pro"),
  );
}

console.log("\nThe order of refusals");
{
  // Both wrong at once. The allowance is the one the user can fix by waiting,
  // so it is the one to say first — telling someone to upgrade for a longer
  // upload when they have no minutes left sells them the wrong thing.
  const both = decideRender({
    plan: "free",
    usage: usage(5, 5),
    operations: [SILENCE],
    sourceDurationSeconds: 4 * 3600,
  });
  check("the allowance is reported before the file length", both.status === 429, String(both.status));
}

await rm(buildDir, { recursive: true, force: true });

console.log("\nWhat the decision hands to the worker");
{
  // Two numbers travel on the job so that the worker can enforce them against
  // the file it downloaded, without knowing anything about plans or prices. The
  // ceiling has always travelled. The balance did not, and that was the hole:
  // when the browser omits a duration this function skips *both* checks, so the
  // one that stops us paying for an encode nobody can be charged for was
  // skipped precisely when the file could be anything at all.
  const decision = decideRender({
    plan: "free",
    usage: usage(4, 5),
    sourceDurationSeconds: null,
    operations: [{ type: "removeSilence", thresholdDb: -32, minSilenceMs: 500, paddingMs: 80 }],
  });

  check("a render with no known duration is still accepted", decision.allowed === true, JSON.stringify(decision));
  check(
    "and carries the ceiling, as it always has",
    decision.allowed && decision.maxSourceSeconds > 0,
    String(decision.allowed && decision.maxSourceSeconds),
  );
  check(
    "and now the balance too, in the same seconds the worker measures in",
    decision.allowed && decision.remainingSeconds === 60,
    String(decision.allowed && decision.remainingSeconds),
  );

  const rich = decideRender({
    plan: "pro",
    usage: usage(0, 240),
    sourceDurationSeconds: 600,
    operations: [],
  });
  check(
    "a full month is carried as a full month rather than as a flag",
    rich.allowed && rich.remainingSeconds === 240 * 60,
    String(rich.allowed && rich.remainingSeconds),
  );

  // Zero is a real answer and must not be confused with "no limit recorded".
  // `exhausted` already refuses this case, so this asserts the shape rather
  // than a reachable path — which is the point: if the refusal above is ever
  // relaxed, the number behind it is still honest.
  const spent = decideRender({
    plan: "free",
    usage: usage(5, 5),
    sourceDurationSeconds: 30,
    operations: [],
  });
  check("an exhausted month is refused before any of this", spent.allowed === false);
  check("with the status that means a limit, not a fault", spent.allowed === false && spent.status === 429, String(spent.status));
}

console.log("\nThe allowance a render has not finished spending yet");
{
  // The hole this closes: the meter counts finished video, so thirty renders
  // fired at once each read the same "nothing used" and each were allowed.
  // The per-project unique index did not touch it — thirty projects is thirty
  // renders — and a five-minute plan delivered a hundred and fifty minutes.
  const busy = decideRender({
    plan: "free",
    usage: usage(0, 5, { inFlightMinutes: 5, jobs: 1 }),
    sourceDurationSeconds: 60,
    operations: [SILENCE],
  });
  check("work already accepted holds the allowance", busy.allowed === false, JSON.stringify(busy).slice(0, 120));
  check("and it is a wait, not a fault", busy.allowed === false && busy.status === 429, String(busy.status));
  check(
    "the sentence says renders, not spend — the meter beside it still reads zero",
    busy.allowed === false && /renders already going/i.test(busy.body.error),
    busy.allowed === false ? busy.body.error : "",
  );
  check(
    "and it does not claim minutes were used",
    busy.allowed === false && !/you've used all/i.test(busy.body.error),
    busy.allowed === false ? busy.body.error : "",
  );

  const many = decideRender({
    plan: "pro",
    usage: usage(0, 400, { jobs: MAX_RENDERS_IN_FLIGHT }),
    sourceDurationSeconds: 60,
    operations: [SILENCE],
  });
  check(
    "and a plan with minutes to spare still cannot hold more than three doors open",
    many.allowed === false && many.body.tooManyInFlight === true,
    JSON.stringify(many).slice(0, 140),
  );
  check(
    "which is what covers a project whose duration was never sent, and so reserved nothing",
    decideRender({
      plan: "pro",
      usage: usage(0, 400, { jobs: MAX_RENDERS_IN_FLIGHT }),
      sourceDurationSeconds: null,
      operations: [SILENCE],
    }).allowed === false,
  );
  check(
    "one below the cap is allowed",
    decideRender({
      plan: "pro",
      usage: usage(0, 400, { jobs: MAX_RENDERS_IN_FLIGHT - 1 }),
      sourceDurationSeconds: 60,
      operations: [SILENCE],
    }).allowed === true,
  );
}

console.log("\nAfter a downgrade, the refusal has to survive being checked");
{
  // 200 minutes rendered on Pro, then "Switch to Creator" on the 20th. The
  // meter is plan-independent and the allowance is not, so the block is right
  // and the sentence behind it was arithmetically false: "you've used all 60
  // minutes" to somebody who used two hundred.
  const downgraded = decideRender({
    plan: "creator",
    usage: usage(200, 60),
    sourceDurationSeconds: 30,
    operations: [SILENCE],
  });
  check("still refused", downgraded.allowed === false);
  check(
    "and the number it quotes is the one they actually rendered",
    downgraded.allowed === false && downgraded.body.error.includes("200"),
    downgraded.allowed === false ? downgraded.body.error : "",
  );
  check(
    "beside what the plan they are on now includes",
    downgraded.allowed === false && downgraded.body.error.includes("60"),
    downgraded.allowed === false ? downgraded.body.error : "",
  );
  check(
    "and it does not say they used all sixty, which they did not",
    downgraded.allowed === false && !/used all 60/.test(downgraded.body.error),
    downgraded.allowed === false ? downgraded.body.error : "",
  );
}

console.log("\nThe balance the worker is handed is in seconds, and it is not the shown number");
{
  // 61 seconds rendered on a five-minute plan. Shown: 2 used, 3 left. Real:
  // 239 seconds left. `minutesRemaining * 60` handed the worker 180 and the
  // worker enforces it exactly, so a 200-second clip was refused with a
  // number that was wrong by 59 seconds in our favour.
  const partial = decideRender({
    plan: "free",
    usage: usage(2, 5, { secondsUsed: 61 }),
    sourceDurationSeconds: null,
    operations: [SILENCE],
  });
  check(
    "the seconds carried are the real balance, not the ceiled minutes multiplied back up",
    partial.allowed && partial.remainingSeconds === 239,
    String(partial.allowed && partial.remainingSeconds),
  );
  check(
    "which is more than the shown minutes would have given",
    partial.allowed && partial.remainingSeconds > 3 * 60,
    String(partial.allowed && partial.remainingSeconds),
  );
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("The mark cannot be removed from a free render, and the meter cannot be walked past.");
