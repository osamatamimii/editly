/**
 * How much of this month's allowance a person has actually used.
 *
 * One question, one place. Three routes ask it — creating a project, reading
 * the subscription, starting a render — and if they answered it differently the
 * user would be told two contradictory things about the same number, which is
 * the sort of bug people never report and never forgive.
 *
 * What we **charge** for is a finished render. Not a queued one, not a failed
 * one, not a project created and abandoned. We charge for video that exists, so
 * a render that died on our side is our problem, not the customer's balance.
 *
 * What we **gate** on is that plus the work already accepted. Those were the
 * same number until a render in flight was found to be worth nothing to the
 * meter: thirty projects, thirty simultaneous renders, each one reading a
 * balance the other twenty-nine had already spent, and a five-minute plan
 * delivering a hundred and fifty minutes of video without a single error or
 * log line. Billing lags on purpose; permission may not.
 */
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db, jobsTable, adminActionsTable, projectsTable } from "@workspace/db";
import { exhaustedMessage as messageFor, inFlightMessage as inFlightFor, minutesFrom, PLAN_LIMITS, type PlanKey } from "./plan-limits";

export interface Usage {
  minutesUsed: number;
  /**
   * The plan's minutes plus anything granted by hand this month.
   *
   * One number rather than two, because every reader of this — the render
   * gate, the subscription route, the interface — asks the same question:
   * how much may this person render. A grant that only some of them knew
   * about would let the console promise minutes the gate then refuses.
   */
  minutesIncluded: number;
  /** Of `minutesIncluded`, how much was granted by hand rather than paid for. */
  minutesGranted: number;
  minutesRemaining: number;
  /**
   * The same balance in seconds, unrounded.
   *
   * `minutesRemaining` is the number a person is shown, and it is ceiled on
   * the used side — 61 seconds of finished video is 2 minutes used. Feeding
   * that back through `* 60` to get a seconds budget propagates the ceiling
   * into the number the worker enforces exactly, so a customer with 3 minutes
   * 59 seconds left was told 3 and refused a 3-minute-30 clip that fitted.
   * Shown in minutes, enforced in seconds.
   */
  secondsRemaining: number;
  /**
   * Minutes already committed to renders that are queued or running.
   *
   * The meter counts finished video, which is the right thing to bill and the
   * wrong thing to gate on: a render in flight is worth zero to it, so N
   * requests fired at once each read the same balance and each are allowed.
   * The cap that stopped this was `jobs_one_active_per_project`, which is
   * per **project** — thirty projects is thirty renders, and a five-minute
   * plan delivered a hundred and fifty minutes without one error.
   *
   * So the gate subtracts what is already promised. The number a person is
   * shown does not: they have not been charged for it yet, and telling them
   * they have used minutes that no video exists for would be a second lie in
   * the other direction.
   */
  minutesInFlight: number;
  /** How many of this person's renders are queued or running right now. */
  jobsInFlight: number;
  /** True when the next render would exceed the allowance. */
  exhausted: boolean;
}

export function startOfMonthUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Either the pool or an open transaction.
 *
 * The meter is read in two situations and they want different connections. A
 * dashboard asks "what have I used" and the pool is right. `startRenderForProject`
 * asks the same question *inside* the transaction that is about to insert the
 * job, holding a lock on this user — and reading through the pool there would
 * put the read outside the section the lock protects, which is the whole bug
 * this parameter exists to close.
 */
type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function usageFor(userId: string, plan: PlanKey, on: Executor = db): Promise<Usage> {
  // One moment, read once. It used to be `startOfMonthUtc()` in each query,
  // which is two `new Date()` calls — and on the first of the month at
  // midnight those two calls can land on either side of the boundary, so
  // spend could be counted against September while the grants that paid for
  // it were still being read from August.
  const since = startOfMonthUtc();

  const [row] = await on
    .select({
      // The charge column first, the measurement as its fallback. A clips
      // render is billed at the source it read rather than the pieces it
      // produced — that lives in billed_seconds — while rows from before that
      // column existed fall back to output_seconds, which is exactly what
      // they were billed at the time. Jobs with neither are skipped rather
      // than counted as zero, because "we did not measure this" and "this
      // was free" are different claims and only one is true.
      seconds: sql<number>`coalesce(sum(coalesce(${jobsTable.billedSeconds}, ${jobsTable.outputSeconds})), 0)`,
    })
    .from(jobsTable)
    .where(
      and(
        eq(jobsTable.userId, userId),
        eq(jobsTable.status, "done"),
        gte(jobsTable.finishedAt, since),
      ),
    );

  // Minutes handed out by hand this month, read from the audit log — which is
  // where the grant lives, not merely where it is described. The console has
  // no other way to grant one, so a grant that reaches the meter is a grant
  // somebody signed their name to.
  const [granted] = await on
    .select({
      seconds: sql<number>`coalesce(sum((${adminActionsTable.detail} ->> 'seconds')::numeric), 0)`,
    })
    .from(adminActionsTable)
    .where(
      and(
        eq(adminActionsTable.action, "grant_minutes"),
        eq(adminActionsTable.subjectUserId, userId),
        gte(adminActionsTable.createdAt, since),
      ),
    );

  // What is already promised to renders nobody has been charged for yet. See
  // `minutesInFlight`: without this the whole gate is per-project, and a
  // person with thirty projects has thirty allowances.
  //
  // Sized by the project's own duration, which is what the browser reported
  // and what the policy layer projected the render at. A project with no
  // duration reserves nothing here — the door's concurrency cap and the
  // worker's live re-check are what cover that case, and both are needed
  // because this number is a claim rather than a measurement.
  const [flight] = await on
    .select({
      seconds: sql<number>`coalesce(sum(coalesce(${projectsTable.duration}, 0)), 0)`,
      jobs: sql<number>`count(*)`,
    })
    .from(jobsTable)
    .leftJoin(projectsTable, eq(projectsTable.id, jobsTable.projectId))
    .where(
      and(
        eq(jobsTable.userId, userId),
        inArray(jobsTable.status, ["queued", "running"]),
      ),
    );

  const minutesGranted = minutesFrom(Number(granted?.seconds ?? 0));
  const minutesIncluded = PLAN_LIMITS[plan].minutesPerMonth + minutesGranted;
  const secondsUsed = Number(row?.seconds ?? 0);
  const minutesUsed = minutesFrom(secondsUsed);
  const secondsInFlight = Number(flight?.seconds ?? 0);
  const minutesInFlight = minutesFrom(secondsInFlight);
  const jobsInFlight = Number(flight?.jobs ?? 0);

  return {
    minutesUsed,
    minutesIncluded,
    minutesGranted,
    minutesInFlight,
    jobsInFlight,
    // Shown to the person: finished video only, and the work in flight
    // subtracted so the number cannot promise minutes already spoken for.
    minutesRemaining: Math.max(0, minutesIncluded - minutesUsed - minutesInFlight),
    secondsRemaining: Math.max(0, minutesIncluded * 60 - secondsUsed - secondsInFlight),
    exhausted: minutesUsed + minutesInFlight >= minutesIncluded,
  };
}

/**
 * The wording lives in `plan-limits`, beside the numbers it quotes, so that the
 * policy layer can reach it without importing this module and its database
 * driver. This is the shape the routes already call.
 */
export function exhaustedMessage(plan: PlanKey, usage: Usage): string {
  if (usage.minutesUsed < usage.minutesIncluded && usage.minutesInFlight > 0) {
    return inFlightFor(plan, usage.minutesIncluded, usage.minutesInFlight);
  }
  return messageFor(plan, usage.minutesIncluded, usage.minutesUsed);
}

/**
 * The usage object for a decision that is not about usage.
 *
 * Three routes build one of these by hand to ask `decideRender` a question
 * that has nothing to do with the meter — "is this account suspended" — and
 * three hand-written object literals is three chances to typo a field into a
 * refusal. They were `{ minutesRemaining: 0, exhausted: false }`, which is a
 * state the real meter never produces and which every "would this fit"
 * comparison in the policy layer reads as "nothing fits".
 *
 * Named, so that adding a field to `Usage` cannot silently leave one of them
 * behind, and so the one shape that is deliberately not a measurement says so.
 */
export function usageNotConsulted(): Usage {
  return {
    minutesUsed: 0,
    minutesIncluded: 0,
    minutesGranted: 0,
    minutesInFlight: 0,
    jobsInFlight: 0,
    minutesRemaining: 0,
    secondsRemaining: 0,
    exhausted: false,
  };
}
