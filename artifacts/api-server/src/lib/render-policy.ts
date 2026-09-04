/**
 * May this render happen, and what must the plan contain?
 *
 * Two routes start renders — the editor's `POST /projects/:id/render`, which
 * accepts a plan the browser composed, and the one-click export, which builds
 * its own from a template. They were answering this question differently, and
 * only one of them was answering it at all.
 *
 * That asymmetry was not cosmetic. The editor's route trusted the plan it was
 * handed, which meant the watermark was decided in the browser: anyone willing
 * to open the network tab could drop that operation from the request and get a
 * clean render on the free plan. The growth loop was enforced by politeness.
 * The same route never checked the month's allowance either, so the free plan's
 * five minutes were five minutes only for people who did not look.
 *
 * So the decision moves here, server-side, and both routes ask it. The rule
 * this file exists to enforce: **nothing the client sends can widen what the
 * plan allows.** A request may ask for less than it is entitled to; it may
 * never ask for more.
 */
import { MAX_PLAN_OPERATIONS } from "@workspace/api-zod";
import type { EditOperation } from "@workspace/api-zod";
import { exhaustedMessage, inFlightMessage, minutesFrom, PLAN_LIMITS, type PlanKey } from "./plan-limits";
// Type-only: this module must not pull the database driver into a decision that
// needs nothing but numbers, or its tests would need a Postgres to run.
import type { Usage } from "./usage";

/** Mirrors the cap in `EditPlan`. A plan longer than this fails in the worker. */
const MAX_OPERATIONS = MAX_PLAN_OPERATIONS;

/** The mark a free render carries. Fixed here so the browser cannot restyle it. */
export const FREE_WATERMARK = {
  type: "watermark" as const,
  text: "Edited with Editly",
  position: "bottom-right" as const,
};

export interface PolicyRefusal {
  allowed: false;
  /**
   * HTTP status. 403 for "this account is suspended", 429 for "you have used
   * the month up", 413 for "this file is too long".
   *
   * A union rather than `number`, so a route cannot invent a fourth answer to
   * "may this render start" without coming here first and saying what it means.
   */
  status: 403 | 429 | 413;
  body: Record<string, unknown>;
}

export interface PolicyApproval {
  allowed: true;
  /** The operations that will actually run — corrected, not merely validated. */
  operations: EditOperation[];
  /** What was changed and why, for the log line. Empty when nothing was. */
  corrections: string[];
  /**
   * The upload ceiling this decision was made under, in seconds, to be written
   * onto the job.
   *
   * The check above can only ever be as honest as the duration it was given,
   * and that duration comes from the browser. Carrying the ceiling forward lets
   * the worker — which has the actual file — enforce it for real, without
   * knowing anything about plans or prices.
   */
  maxSourceSeconds: number;
  /**
   * What was left of the month's allowance when this decision was made, in
   * seconds, to be written onto the job.
   *
   * The "would exceed" refusal above is only reachable when a source length was
   * supplied, and it comes from the browser, which is allowed to omit it — so
   * the one guard that stops us paying for an encode nobody can be charged for
   * is skipped precisely when the browser stays quiet. Carrying the balance
   * forward lets the worker apply it to the length it measured itself.
   */
  remainingSeconds: number;
  /**
   * Where this job sits in the queue. Higher is claimed first.
   *
   * Written onto the job rather than looked up when a worker claims one: the
   * claim is a single atomic statement that must not join, and the deal someone
   * was on when they queued the work is the deal to honour.
   */
  priority: number;
}

export type PolicyResult = PolicyRefusal | PolicyApproval;

export interface PolicyInput {
  plan: PlanKey;
  usage: Usage;
  /** Length of the source file in seconds, when we know it. */
  sourceDurationSeconds?: number | null;
  /** What the caller asked for. */
  operations: EditOperation[];
  /**
   * When this account was suspended, or null.
   *
   * It is here rather than at the routes for the same reason the mark, the
   * meter and the upload ceiling are: a rule enforced at each door is a rule
   * enforced at the doors somebody remembered. This one had already fallen
   * through — the editor's button and the chat both refused a suspended
   * account with 403, and Export queued the job, rendered it and billed the
   * minutes. The suspension looked applied; one of the two doors was simply
   * not locked, and nothing anywhere reported a suspended account still
   * consuming render capacity.
   */
  suspendedAt?: Date | string | null;
}

/** See the refusal in `decideRender`. */
export const MAX_RENDERS_IN_FLIGHT = 3;

export function decideRender(input: PolicyInput): PolicyResult {
  const limits = PLAN_LIMITS[input.plan];

  // Suspension before everything, because it is the more fundamental fact
  // about the request than anything about the plan or the file. An account
  // that has been stopped and is told "that file is too long" will trim the
  // file, and be stopped anyway.
  //
  // 403 rather than 402: this is not about running out of minutes, and
  // offering more would be a lie. The message says what happened and that
  // nothing was deleted, because that is the first thing anybody seeing it
  // will fear.
  if (input.suspendedAt) {
    return {
      allowed: false,
      status: 403,
      body: {
        error:
          "This account is suspended, so new renders cannot start. Nothing has been deleted. Your projects and videos are all still here.",
      },
    };
  }

  // How many of this person's renders may be going at once.
  //
  // Not a plan feature and not on the pricing page: it is a fairness rule and
  // a backstop. The allowance gate above reserves work in flight by the
  // project's own duration, and a project whose duration the browser never
  // sent reserves nothing — so without a hard count on the number of doors a
  // single account can hold open, an allowance can still be spent several
  // times over by simply omitting a field.
  //
  // Three, because the queue is one worker deep. A fourth simultaneous render
  // does not finish any sooner for being accepted; it only makes the estimate
  // on the other three wrong.
  if (input.usage.jobsInFlight >= MAX_RENDERS_IN_FLIGHT) {
    return {
      allowed: false,
      status: 429,
      body: {
        error: `You already have ${input.usage.jobsInFlight} renders going. They run one at a time, so start this one when one of them finishes.`,
        tooManyInFlight: true,
        plan: input.plan,
        jobsInFlight: input.usage.jobsInFlight,
      },
    };
  }

  // The allowance next, because it is the only refusal the user can fix by
  // waiting rather than by changing the request.
  if (input.usage.exhausted) {
    // Which of the two sentences depends on what is actually holding the
    // allowance. Work in flight is not spend — nobody has been charged for it,
    // and it clears without anybody doing anything — so saying "you have used
    // all your minutes" beside a meter reading zero would be a contradiction
    // the person is right to disbelieve.
    const heldByFlight = input.usage.minutesUsed < input.usage.minutesIncluded && input.usage.minutesInFlight > 0;
    return {
      allowed: false,
      status: 429,
      body: {
        error: heldByFlight
          ? inFlightMessage(input.plan, input.usage.minutesIncluded, input.usage.minutesInFlight)
          : exhaustedMessage(input.plan, input.usage.minutesIncluded, input.usage.minutesUsed),
        limitReached: true,
        plan: input.plan,
        minutesUsed: input.usage.minutesUsed,
        minutesIncluded: input.usage.minutesIncluded,
        minutesInFlight: input.usage.minutesInFlight,
      },
    };
  }

  // The upload ceiling is the number that actually separates the tiers, so the
  // refusal names the tier that would have taken this file rather than saying
  // no and stopping there. A person told "too long" goes away; a person told
  // "Pro takes four hours" has somewhere to go.
  const seconds = input.sourceDurationSeconds;
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
    const minutes = seconds / 60;
    if (minutes > limits.maxUploadMinutes) {
      return {
        allowed: false,
        status: 413,
        body: {
          error: uploadTooLongMessage(input.plan, minutes),
          uploadTooLong: true,
          plan: input.plan,
          maxUploadMinutes: limits.maxUploadMinutes,
          uploadMinutes: Math.ceil(minutes),
          suggestedPlan: smallestPlanFor(minutes),
        },
      };
    }

    // No operation makes a clip longer — silence removal shortens it and the
    // rest leave it alone — so the source length is an upper bound on what this
    // render will consume. Refusing when that bound overruns the balance is the
    // difference between "you have used your month up" arriving before a render
    // and arriving after it: without this, someone with two minutes left could
    // queue a four-hour file, and the meter would only notice on the next
    // request, by which time we have already paid for the encode.
    //
    // It is deliberately conservative in the customer's direction and against
    // ours: a talk that is half pauses would have fitted, and is refused. The
    // message says the length rather than hiding behind "limit reached", so the
    // person can see the arithmetic and decide whether to trim or upgrade.
    const projected = minutesFrom(seconds);
    if (projected > input.usage.minutesRemaining) {
      return {
        allowed: false,
        status: 429,
        body: {
          error: wouldExceedMessage(input.plan, projected, input.usage.minutesRemaining),
          limitReached: true,
          wouldExceed: true,
          plan: input.plan,
          minutesUsed: input.usage.minutesUsed,
          minutesIncluded: input.usage.minutesIncluded,
          minutesRemaining: input.usage.minutesRemaining,
          projectedMinutes: projected,
        },
      };
    }
  }

  const corrections: string[] = [];
  let operations = input.operations;

  // Resolution is a tier feature, so the tier decides it — not the browser, and
  // not by refusing the render. A request for more than the plan allows is
  // served at what the plan allows, because someone who asked for 4K and gets
  // 1080p has their video; someone who gets a 402 has nothing. Silence is the
  // only unacceptable answer, so it is corrected out loud.
  operations = operations.map((op) => {
    if (op.type !== "formatForPlatform") return op;
    const asked = op.maxHeight ?? limits.maxHeight;
    const allowed = Math.min(asked, limits.maxHeight);
    if (asked > limits.maxHeight) {
      corrections.push(
        `asked for ${asked}p and the ${input.plan} plan exports up to ${limits.maxHeight}p`,
      );
    }
    return { ...op, maxHeight: allowed };
  });

  if (limits.watermark) {
    // A client-supplied watermark is dropped rather than kept alongside ours,
    // because keeping it would let the browser choose the text and the corner —
    // and a mark reading "." in the corner the platform covers with its own UI
    // is the same as no mark at all.
    const hadOwn = operations.some((op) => op.type === "watermark");
    operations = operations.filter((op) => op.type !== "watermark");

    // The plan schema caps a render at twelve operations, and appending a
    // thirteenth would fail validation in the worker — where the failure looks
    // like a broken render rather than a policy decision. Making room here
    // costs the least important operation instead of the whole job.
    if (operations.length >= MAX_OPERATIONS) {
      operations = operations.slice(0, MAX_OPERATIONS - 1);
      corrections.push(`trimmed to ${MAX_OPERATIONS - 1} operations to make room for the mark`);
    }

    // Appended last so it draws over everything, and appended by the server
    // every single time: a request that simply omits it is the case this
    // function exists to catch.
    operations = [...operations, FREE_WATERMARK];
    corrections.push(hadOwn ? "replaced a client-supplied watermark with the free-plan mark" : "added the free-plan mark");
  }

  return {
    allowed: true,
    operations,
    corrections,
    maxSourceSeconds: limits.maxUploadMinutes * 60,
    // The seconds balance, not the shown one multiplied back up. `minutes`
    // here is ceiled on the used side, so `* 60` handed the worker a budget
    // that could be up to 59 seconds short of what the customer actually had
    // — and the worker enforces it exactly, so the refusal quoted a number
    // that was wrong in our favour.
    remainingSeconds: input.usage.secondsRemaining,
    // Two bands, not four. Priority is worth having as "paid work goes first"
    // and worth nothing as a ladder between paying customers — a Studio
    // subscriber jumping a Pro one buys us nothing and costs the Pro one the
    // exact experience they were sold.
    priority: limits.priorityQueue ? PRIORITY_PAID : PRIORITY_STANDARD,
  };
}

/**
 * The queue has two bands: work that was promised a place at the front, and
 * everything else. Within a band it is strictly first-in-first-out, so nothing
 * can starve — a free render waits behind the paid ones queued before it, never
 * behind the paid ones queued after.
 */
const PRIORITY_STANDARD = 0;
const PRIORITY_PAID = 10;

/**
 * Refusing before the encode rather than after it.
 *
 * Both numbers are named because "limit reached" invites an argument and
 * "this clip is 12 minutes and you have 3 left" does not.
 */
function wouldExceedMessage(plan: PlanKey, projected: number, remaining: number): string {
  const left = remaining === 0 ? "none left" : `${remaining} minute${remaining === 1 ? "" : "s"} left`;
  const upgrade =
    plan === "studio"
      ? "Your minutes reset at the start of next month."
      : "Upgrading adds them immediately, or they reset at the start of next month.";
  return `That clip is ${projected} minute${projected === 1 ? "" : "s"} long and you have ${left} this month. ${upgrade}`;
}

/**
 * The smallest plan that would accept a file this long, or null when nothing
 * would. Naming it turns a dead end into an upgrade.
 */
export function smallestPlanFor(minutes: number): PlanKey | null {
  const order: PlanKey[] = ["free", "creator", "pro", "studio"];
  return order.find((key) => PLAN_LIMITS[key].maxUploadMinutes >= minutes) ?? null;
}

function uploadTooLongMessage(plan: PlanKey, minutes: number): string {
  const limits = PLAN_LIMITS[plan];
  const rounded = Math.ceil(minutes);
  const better = smallestPlanFor(minutes);

  if (!better) {
    return `That file is ${rounded} minutes. The longest single upload we take is ${PLAN_LIMITS.studio.maxUploadMinutes} minutes. Split it and we'll edit each part.`;
  }
  return `That file is ${rounded} minutes, and the ${plan} plan takes up to ${limits.maxUploadMinutes}. The ${better} plan takes ${PLAN_LIMITS[better].maxUploadMinutes} minutes in one file.`;
}
