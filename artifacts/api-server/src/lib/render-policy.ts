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
import type { EditOperation } from "@workspace/api-zod";
import { exhaustedMessage, PLAN_LIMITS, type PlanKey } from "./plan-limits";
// Type-only: this module must not pull the database driver into a decision that
// needs nothing but numbers, or its tests would need a Postgres to run.
import type { Usage } from "./usage";

/** Mirrors the cap in `EditPlan`. A plan longer than this fails in the worker. */
const MAX_OPERATIONS = 12;

/** The mark a free render carries. Fixed here so the browser cannot restyle it. */
export const FREE_WATERMARK = {
  type: "watermark" as const,
  text: "Edited with Editly",
  position: "bottom-right" as const,
};

export interface PolicyRefusal {
  allowed: false;
  /** HTTP status. 429 for "you have used the month up", 413 for "this file is too long". */
  status: 429 | 413;
  body: Record<string, unknown>;
}

export interface PolicyApproval {
  allowed: true;
  /** The operations that will actually run — corrected, not merely validated. */
  operations: EditOperation[];
  /** What was changed and why, for the log line. Empty when nothing was. */
  corrections: string[];
}

export type PolicyResult = PolicyRefusal | PolicyApproval;

export interface PolicyInput {
  plan: PlanKey;
  usage: Usage;
  /** Length of the source file in seconds, when we know it. */
  sourceDurationSeconds?: number | null;
  /** What the caller asked for. */
  operations: EditOperation[];
}

export function decideRender(input: PolicyInput): PolicyResult {
  const limits = PLAN_LIMITS[input.plan];

  // The allowance first, because it is the only refusal the user can fix by
  // waiting rather than by changing the request.
  if (input.usage.exhausted) {
    return {
      allowed: false,
      status: 429,
      body: {
        error: exhaustedMessage(input.plan, input.usage.minutesIncluded),
        limitReached: true,
        plan: input.plan,
        minutesUsed: input.usage.minutesUsed,
        minutesIncluded: input.usage.minutesIncluded,
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
  }

  const corrections: string[] = [];
  let operations = input.operations;

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

  return { allowed: true, operations, corrections };
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
    return `That file is ${rounded} minutes. The longest single upload we take is ${PLAN_LIMITS.studio.maxUploadMinutes} minutes — split it and we'll edit each part.`;
  }
  return `That file is ${rounded} minutes, and the ${plan} plan takes up to ${limits.maxUploadMinutes}. The ${better} plan takes ${PLAN_LIMITS[better].maxUploadMinutes} minutes in one file.`;
}
