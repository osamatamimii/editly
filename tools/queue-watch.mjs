/**
 * Did any render that finished today actually finish?
 *
 * `watch.yml` has asked one question since the 12 August outage: is a machine
 * that can render still listening. It is a good question and it was the right
 * one to build first — but it is a liveness question, and on 15 September it
 * answered yes while **every single job in the queue had failed for twelve
 * days**. Thirteen jobs between 3 and 14 September, every one of them `failed`,
 * and the heartbeat beat through all of it because the worker was up. It was
 * up and wrong: it was an eleven-day-old image that still downloaded from
 * Supabase after the product had moved to R2, and it refused every transcribe
 * job on a schema it predated.
 *
 * Nothing said a word. Not the health check, which is about the API. Not the
 * watcher, which is about the worker being alive. Not the admin console, which
 * nobody was looking at. The only thing that would have noticed is somebody
 * choosing to look — which is the sentence this whole file exists to stop being
 * true, written once more, one level further in.
 *
 * So this asks about outcomes rather than about presence. A worker that is up
 * and failing everything is worse than a worker that is down, because it clears
 * the queue: every customer's minute is spent, every project ends `failed`, and
 * the one signal anybody had is green.
 *
 * Usage: DATABASE_URL=postgres://... node tools/queue-watch.mjs
 * Exit 1 when the queue is dead; 0 otherwise, including when it is quiet.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * How far back to look, and how many finished jobs it takes to believe it.
 *
 * A day, because the alert has to arrive while whoever can fix it is still
 * awake, and because a longer window keeps alarming about an outage that ended
 * — which is how an alert gets muted, and a muted alert is the same as no
 * alert. `watch.yml` says this about its own retry and it is the same argument.
 *
 * Two, because one failure is a customer's broken file, a cancelled upload, a
 * source we could not decode — a normal day in a product that takes video from
 * strangers. Two in a row with nothing succeeding between them is a pattern.
 * The real outage would have tripped this on 13 September and again on the
 * 14th, which is the only evidence that the number is low enough.
 */
export const WINDOW_HOURS = 24;
export const ENOUGH_TO_JUDGE = 2;

/**
 * How long work may wait while a live machine claims nothing.
 *
 * `verdict` below asks about jobs that *settled*, and on 15 September the
 * thing that went wrong never settled. A listen job for a three-gigabyte
 * source sat at `queued` for two hours, `attempts = 0`, while the machine beat
 * every thirty seconds: it was sizing a listen with the render's disk
 * multiplier and handing the row back once a minute. Nothing settled, so this
 * watcher said "quiet, nothing to judge" -- which is the same green it shows
 * on a genuinely idle Sunday.
 *
 * Ten minutes rather than the console's ninety seconds. The console is read by
 * somebody who chose to look and can dismiss a row; this sends mail, and an
 * alert that fires on a queue that was about to clear itself is an alert that
 * gets a filter rule written for it.
 */
export const STALLED_AFTER_MINUTES = 10;

/**
 * Cancelled is not failed — and in this schema, cancelled *is spelled* failed.
 *
 * Somebody pressing stop is the product working. Counting it as a failure
 * would make a busy afternoon of people changing their minds look like an
 * outage; counting it as a success would let a genuinely dead queue hide
 * behind them. It is neither, so it is not counted at all.
 *
 * The first cut of this file read a `status = 'cancelled'`, which does not
 * exist. `lib/db/src/schema/jobs.ts` says why, and it is a good reason: status
 * is compared in about a hundred and seventy places and every one of them
 * means settled by `done` or `failed`, so a stop is `failed` with
 * `cancelled_at` set. Had that gone out, an afternoon of three people changing
 * their minds would have paged somebody about a dead queue — which is the
 * precise way a watcher becomes furniture, built into the watcher on day one.
 *
 * So the column is the test, not the word. `deploy-test` asserts the join.
 */
const DONE = "done";
const FAILED = "failed";

/**
 * The verdict, as a pure function of rows, so it can be tested without a
 * database and so the SQL below has nothing in it but a SELECT.
 *
 * `rows`: `{ id, kind, status, settledAt, cancelledAt, errorDetail }`.
 *
 * `settledAt` rather than `finishedAt`, because `finished_at` did not mean
 * "when this settled" when this file was written. Three of the worker's `done`
 * writes — every one on the path a `transcribe` row takes — set `status` and
 * left the column null, so a day on which transcription succeeded and a render
 * failed read here as a day on which everything failed. The first version of
 * this watcher filtered on `finished_at is not null` and would have alarmed on
 * exactly that. The worker now stamps it everywhere; the rows already in the
 * table do not, and `coalesce` is what makes this true of both.
 */
export function verdict(rows, now = new Date()) {
  const since = new Date(now.getTime() - WINDOW_HOURS * 3600 * 1000);
  const inWindow = rows.filter((r) => r.settledAt instanceof Date && r.settledAt > since);
  const settled = inWindow.filter(
    (r) => (r.status === DONE || r.status === FAILED) && !r.cancelledAt,
  );
  const failed = settled.filter((r) => r.status === FAILED);
  const done = settled.filter((r) => r.status === DONE);

  if (settled.length === 0) {
    return { state: "quiet", settled: 0, done: 0, failed: 0, reasons: [] };
  }
  if (done.length > 0) {
    return { state: "working", settled: settled.length, done: done.length, failed: failed.length, reasons: [] };
  }
  if (failed.length < ENOUGH_TO_JUDGE) {
    // One failure and nothing else. Real, worth printing, not worth waking
    // anybody for — see ENOUGH_TO_JUDGE.
    return { state: "one-off", settled: settled.length, done: 0, failed: failed.length, reasons: reasonsOf(failed) };
  }
  return { state: "dead", settled: settled.length, done: 0, failed: failed.length, reasons: reasonsOf(failed) };
}

/**
 * The other way a queue is dead: nothing is failing because nothing is running.
 *
 * `verdict` cannot see this. It reads settled rows, and the whole shape of
 * this fault is that no row settles -- so the window is empty and the answer
 * is "quiet", the same word for an idle Sunday and for a machine refusing
 * every job it is offered.
 *
 * The test is not age, which would fire behind every ninety-minute render. It
 * is that a machine is alive, holds a lock on nothing, and a row has been
 * waiting anyway. A machine working through a queue is holding something.
 *
 * `queue`: `{ waitingSince: Date | null, running: number, workerLastSeenAt:
 * Date | null }`.
 */
export function stalled(queue, now = new Date()) {
  if (!queue || queue.running > 0) return null;
  if (!(queue.waitingSince instanceof Date)) return null;
  if (!(queue.workerLastSeenAt instanceof Date)) return null;
  // The same two-minute window `workerOnline` uses, written out because this
  // file deliberately imports nothing from the server it watches.
  const beatAgoMs = now.getTime() - queue.workerLastSeenAt.getTime();
  if (beatAgoMs >= 2 * 60 * 1000 || beatAgoMs < -2 * 60 * 1000) return null;
  const waitedMs = now.getTime() - queue.waitingSince.getTime();
  if (waitedMs < STALLED_AFTER_MINUTES * 60 * 1000) return null;
  return { minutes: Math.floor(waitedMs / 60000) };
}

/** One sentence for it, on the same terms as `sentenceFor`. */
export function stalledSentence(s) {
  return (
    `A machine is listening and has claimed nothing for ${s.minutes} minutes ` +
    `while work waits. It is refusing the queue rather than working through it.`
  );
}

/**
 * What the failures have in common, most common first.
 *
 * An alert that says "everything failed" sends somebody to a database. One
 * that says "everything failed, and eleven of them say `download failed …
 * not_found`" sends them to the bucket. The line is cut short and stripped of
 * ids on purpose: this string goes into a GitHub annotation and into an email,
 * and neither is a place to put a customer's project id.
 */
export function reasonsOf(failed) {
  const counts = new Map();
  for (const row of failed) {
    const key = shapeOfError(row.errorDetail);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => ({ reason, count }));
}

/**
 * The shape of an error, not the error.
 *
 * First line, with uuids and long hex runs replaced — so that thirteen
 * failures naming thirteen different projects are recognisably one fault
 * rather than thirteen. A uuid here is a customer's project, and this string
 * ends up in an email.
 *
 * Deliberately *not* collapsing ordinary digits, which the first cut of this
 * did. It grouped a little better and it turned `404` into `N` and `.mp4` into
 * `.mpN` — throwing away the one token in the whole line that says where to
 * look. The point of the reason is that somebody reads it.
 */
export function shapeOfError(detail) {
  if (typeof detail !== "string" || detail.trim() === "") return "no error recorded";
  const firstLine = detail.split("\n", 1)[0].trim();
  return firstLine
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/[0-9a-f]{16,}/gi, "<id>")
    .slice(0, 160);
}

/** One sentence, the one that goes in the annotation. */
export function sentenceFor(v) {
  switch (v.state) {
    case "quiet":
      return `No render finished in the last ${WINDOW_HOURS} hours, so there is nothing to judge.`;
    case "working":
      return `${v.done} of ${v.settled} finished renders succeeded in the last ${WINDOW_HOURS} hours.`;
    case "one-off":
      return `One render failed in the last ${WINDOW_HOURS} hours and none succeeded — not enough to call it an outage. ${describe(v.reasons)}`;
    case "dead":
      return `Every one of the last ${v.failed} finished renders failed and none succeeded. ${describe(v.reasons)}`;
    default:
      return "unknown";
  }
}

function describe(reasons) {
  if (reasons.length === 0) return "";
  return reasons.map((r) => `${r.count}× ${r.reason}`).join(" | ");
}

// ── Everything below only runs when this file is the command ────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const DATABASE_URL = process.env["DATABASE_URL"];
  if (!DATABASE_URL) {
    // Skipped rather than failed, for the reason watch.yml gives about its own
    // secret: a job that goes red for a missing secret is a job somebody turns
    // off, and then nothing is watching anything.
    console.log("DATABASE_URL is not set, so the queue cannot be read.");
    console.log("::warning::Set PRODUCTION_DATABASE_URL to have a dead render queue caught before a customer finds it.");
    process.exit(0);
  }

  const { Pool } = require(require.resolve("pg", { paths: ["lib/db"] }));
  const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(DATABASE_URL);
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ...(isLocal ? {} : { ssl: { rejectUnauthorized: false } }),
    max: 1,
  });

  let rows;
  let queue = null;
  try {
    // Read-only, one statement, bounded. This runs hourly against production.
    const result = await pool.query(
      `select id, kind, status, cancelled_at, error_detail,
              coalesce(finished_at, updated_at) as settled_at
         from jobs
        where status in ('done', 'failed')
          and coalesce(finished_at, updated_at) > now() - ($1 || ' hours')::interval
        order by coalesce(finished_at, updated_at) desc
        limit 500`,
      [String(WINDOW_HOURS)],
    );
    rows = result.rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      settledAt: r.settled_at instanceof Date ? r.settled_at : new Date(r.settled_at),
      // A stop, not a fault. Null for everything else.
      cancelledAt: r.cancelled_at ?? null,
      errorDetail: r.error_detail,
    }));

    /*
      The queue as it stands right now, which is a different question from the
      one above and needs its own three numbers: how long the oldest waiting
      row has waited, whether anything is being worked on, and when a machine
      last spoke. One statement, no join, bounded by its own aggregates.
    */
    const [now] = (
      await pool.query(
        `select (select min(created_at) from jobs where status = 'queued' and locked_at is null) as waiting_since,
                (select count(*) from jobs where status = 'running') as running,
                (select max(last_seen_at) from worker_heartbeats) as worker_last_seen_at`,
      )
    ).rows;
    queue = {
      waitingSince: now?.waiting_since ?? null,
      running: Number(now?.running ?? 0),
      workerLastSeenAt: now?.worker_last_seen_at ?? null,
    };
  } finally {
    await pool.end().catch(() => undefined);
  }

  const v = verdict(rows);
  console.log(`window: ${WINDOW_HOURS}h | settled: ${v.settled} | done: ${v.done} | failed: ${v.failed}`);
  console.log(sentenceFor(v));

  /*
    And the fault that leaves no settled row at all. Reported before the
    verdict's own exit, because "quiet" and "stalled" are the same window and
    only one of them is good news.
  */
  const stall = stalled(queue);
  if (stall) {
    console.log(`::error::${stalledSentence(stall)}`);
    process.exit(1);
  }

  if (v.state === "dead") {
    console.log(`::error::The render queue is not producing anything — ${sentenceFor(v)}`);
    process.exit(1);
  }
  if (v.state === "one-off") {
    console.log(`::warning::${sentenceFor(v)}`);
  }
  process.exit(0);
}
