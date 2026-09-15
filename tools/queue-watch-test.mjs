/**
 * Proves the queue watcher fires on the outage it was written for — and stays
 * quiet on the four days that look like it and are not.
 *
 * A watcher is only worth its hourly run if both halves hold. One that never
 * fires is furniture; one that fires on a quiet Sunday gets muted within a
 * week, and a muted alert is indistinguishable from no alert at all. So half
 * of this file is the negative half, and it is the half worth having.
 *
 * The first fixture is not invented: it is the shape of the rows that were in
 * `jobs` on 14 September 2026, when the worker had been up and failing
 * everything for twelve days and every signal anybody had was green.
 *
 * Usage: node tools/queue-watch-test.mjs
 */
import { verdict, sentenceFor, shapeOfError, WINDOW_HOURS, ENOUGH_TO_JUDGE } from "./queue-watch.mjs";

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

const NOW = new Date("2026-09-14T20:00:00Z");
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600 * 1000);
const row = (status, hours, errorDetail = null, kind = "render") => ({
  id: `job-${status}-${hours}`,
  kind,
  status,
  finishedAt: hoursAgo(hours),
  cancelledAt: null,
  errorDetail,
});

/**
 * A stop, spelled the way this schema spells it.
 *
 * There is no `status = 'cancelled'` in `lib/db/src/schema/jobs.ts` and there
 * deliberately never was: a stopped render is `failed` carrying
 * `cancelled_at`, because `status` is read as "settled" in about a hundred and
 * seventy places. A watcher that looked for the word instead of the column
 * would read every cancellation as an outage — so these fixtures are built the
 * way `cancelJobs` actually writes the row, not the way it would be convenient
 * to test.
 */
const cancelled = (hours) => ({
  ...row("failed", hours, "This render was stopped."),
  cancelledAt: hoursAgo(hours),
});

console.log("\nThe outage this was written for");
{
  // 14 September, as it actually was: three jobs finished that day, all failed,
  // two different faults, and `/healthz` answering ok throughout.
  const real = [
    row("failed", 1.5, 'ZodError: [\n  {\n    "code": "invalid_value",', "transcribe"),
    row("failed", 8.5, 'ZodError: [\n  {\n    "code": "invalid_value",', "transcribe"),
    row(
      "failed",
      8.2,
      'Error: download failed for 43f0515a-4eeb-424f-bd3c-fac50fb60061/98a36888-cc36-498b-b0a9-4b4d88a2cfb0/source.mp4: 400 {"statusCode":"404","error":"not_found"}',
    ),
  ];
  const v = verdict(real, NOW);
  check("the day every render failed goes red", v.state === "dead", v.state);
  check("and it counts all three", v.failed === 3 && v.done === 0, `${v.done}/${v.failed}`);
  check(
    "and the sentence names the commonest fault, so nobody has to open the database",
    /ZodError/.test(sentenceFor(v)),
    sentenceFor(v),
  );
  check(
    "and it names the other one too",
    /not_found/.test(sentenceFor(v)),
    sentenceFor(v),
  );
  check(
    "and no customer's project id is in the sentence anybody gets emailed",
    !/43f0515a|98a36888/.test(sentenceFor(v)),
    sentenceFor(v),
  );
}

console.log("\nThe days that look like it and are not");
{
  const quiet = verdict([row("failed", 40), row("failed", 72)], NOW);
  check("an outage that ended yesterday stops alarming", quiet.state === "quiet", quiet.state);

  const nothing = verdict([], NOW);
  check("a weekend nobody used the product is not an outage", nothing.state === "quiet", nothing.state);

  const oneBadFile = verdict([row("failed", 2, "Error: could not decode the source")], NOW);
  check(
    "one broken upload does not wake anybody",
    oneBadFile.state === "one-off",
    oneBadFile.state,
  );

  const mixed = verdict([row("failed", 1), row("failed", 2), row("done", 3)], NOW);
  check("two failures with one success between them is a bad day, not a dead queue", mixed.state === "working", mixed.state);

  // The success is the *oldest* row, so this also proves the rule is "did
  // anything succeed in the window", not "did the most recent one succeed".
  const oldSuccess = verdict([row("failed", 1), row("failed", 2), row("done", 23)], NOW);
  check("a success anywhere in the window still counts", oldSuccess.state === "working", oldSuccess.state);
}

console.log("\nCancelled is neither — and it is spelled `failed`");
{
  const allCancelled = verdict([cancelled(1), cancelled(2), cancelled(3)], NOW);
  check(
    "an afternoon of people changing their minds is not an outage",
    allCancelled.state === "quiet",
    allCancelled.state,
  );

  const hiding = verdict([row("failed", 1), row("failed", 2), cancelled(3)], NOW);
  check(
    "and a dead queue cannot hide behind them",
    hiding.state === "dead",
    hiding.state,
  );
  check("cancelled rows are not counted as settled", hiding.settled === 2, String(hiding.settled));
  check(
    "and they do not inflate the number the alert reads out",
    hiding.failed === 2,
    String(hiding.failed),
  );
  check(
    "and the sentence says two, because two is how many broke",
    /last 2 finished renders/.test(sentenceFor(hiding)),
    sentenceFor(hiding),
  );

  // The sharp one: a single genuine failure with two cancellations around it.
  // Count cancelled as failed and this is an outage; it is one customer's bad
  // file and two people changing their minds.
  const oneAmongCancelled = verdict(
    [row("failed", 1, "Error: could not decode the source"), cancelled(2), cancelled(3)],
    NOW,
  );
  check(
    "one real failure among cancellations stays a one-off",
    oneAmongCancelled.state === "one-off",
    oneAmongCancelled.state,
  );
}

console.log("\nThe window is a window");
{
  const edge = verdict([row("failed", WINDOW_HOURS - 0.1), row("failed", WINDOW_HOURS - 0.2)], NOW);
  check("two failures just inside the window are seen", edge.state === "dead", edge.state);

  const outside = verdict([row("failed", WINDOW_HOURS + 0.1), row("failed", WINDOW_HOURS + 0.2)], NOW);
  check("the same two, an hour older, are not", outside.state === "quiet", outside.state);
}

console.log("\nThirteen failures are one fault, not thirteen");
{
  const many = Array.from({ length: 6 }, (_, i) =>
    row(
      "failed",
      i + 1,
      `Error: download failed for ${"0123abcd"}-4eeb-424f-bd3c-fac50fb6006${i}/source.mp4: 400 {"statusCode":"404"}`,
    ),
  );
  const v = verdict(many, NOW);
  check("six failures naming six different projects group into one reason", v.reasons.length === 1, JSON.stringify(v.reasons));
  check("and the count is right", v.reasons[0]?.count === 6, JSON.stringify(v.reasons));

  check(
    "a uuid is replaced wherever it appears",
    shapeOfError("failed for 43f0515a-4eeb-424f-bd3c-fac50fb60061/x.mp4") === "failed for <id>/x.mp4",
    shapeOfError("failed for 43f0515a-4eeb-424f-bd3c-fac50fb60061/x.mp4"),
  );
  check(
    "and the status code — the one token worth reading — survives",
    shapeOfError('400 {"statusCode":"404","error":"not_found"}') ===
      '400 {"statusCode":"404","error":"not_found"}',
    shapeOfError('400 {"statusCode":"404","error":"not_found"}'),
  );
  check(
    "only the first line survives, because a stack trace is not an alert",
    shapeOfError("Error: the first line\n  at somewhere\n  at somewhere else") === "Error: the first line",
  );
  check("a row with no detail still groups", shapeOfError(null) === "no error recorded");
}

console.log("\nThe constants say what they mean");
{
  check("the window is a day", WINDOW_HOURS === 24, String(WINDOW_HOURS));
  check(
    "and one failure is never enough to alarm",
    ENOUGH_TO_JUDGE >= 2,
    String(ENOUGH_TO_JUDGE),
  );
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log("The watcher does not watch what this says it watches.");
  process.exit(1);
}
console.log("It fires on the twelve days nobody noticed, and stays quiet on the days that only look like them.");
