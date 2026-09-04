/**
 * A payment that arrived before its owner did.
 *
 * Somebody pays with a different address than the one they signed up with, or
 * pays first and creates an account afterwards. Freemius knows them only by the
 * email on the card, so the webhook cannot find a user, and until now it
 * answered 200 and wrote nothing down at all — the money arrived, the plan did
 * not, and there was no record to reconcile from beyond a log line that
 * deliberately excluded the address.
 *
 * The webhook now keeps those events. This is the other half: whenever we read
 * somebody's subscription we check whether anything is waiting for their
 * address, and if so, hand it over. It costs one indexed query on a partial
 * index that only covers unclaimed rows — so the common case, where nothing is
 * waiting, is a single index probe that finds nothing.
 *
 * Only the *newest* pending event is applied, and only if it grants more than
 * they already have. Two reasons. Replaying a whole history in order would let
 * an old `license.cancelled` be the last word; and someone who has since been
 * given a plan by any other route should not be quietly downgraded by a
 * six-week-old event nobody could match at the time.
 */
import { logger } from "./logger";
import { PLAN_LIMITS, planKeyFrom, type PlanKey } from "./plan-limits";

const RANK: Record<PlanKey, number> = { free: 0, creator: 1, pro: 2, studio: 3 };

export interface PendingEvent {
  eventId: string;
  plan: string;
  licenseId: string | null;
  eventAt: Date | string | null;
}

/**
 * Which pending event, if any, should be handed to this account — decided
 * without touching a database so the rule can be read and tested on its own.
 */
export function claimable(pending: PendingEvent[], currentPlan: string): PendingEvent | null {
  const current = planKeyFrom(currentPlan);
  let best: PendingEvent | null = null;
  let bestAt = -Infinity;

  for (const event of pending) {
    const plan = planKeyFrom(event.plan);
    // Never a downgrade. An unmatched event is by definition one we could not
    // act on when it arrived, and acting on a stale one now — against somebody
    // who has since been granted a plan properly — would take away access
    // nobody asked us to take away.
    if (RANK[plan] <= RANK[current]) continue;
    const at = event.eventAt ? new Date(event.eventAt).getTime() : 0;
    if (at >= bestAt) {
      bestAt = at;
      best = event;
    }
  }

  return best;
}

/** Human-readable, for the log line and for support reading the table later. */
export function claimNote(event: PendingEvent): string {
  return `claimed a ${PLAN_LIMITS[planKeyFrom(event.plan)].pricePerMonth > 0 ? "paid" : "free"} event received before this account existed`;
}

/**
 * Applies the claim. Returns the plan the account should now be on.
 *
 * Never throws: this runs inside `GET /subscription`, and a failure to claim a
 * payment must not take the page down. It is retried on the next read, which is
 * the next time they load the app.
 */
export async function claimPaidEvents(userId: string, email: string | null, currentPlan: string): Promise<string> {
  if (!email) return currentPlan;
  try {
    const { pool } = await import("@workspace/db");
    const { rows } = await pool.query<{
      event_id: string;
      plan: string;
      license_id: string | null;
      event_at: Date | null;
    }>(
      `SELECT event_id, plan, license_id, event_at
         FROM billing_events
        WHERE user_id IS NULL AND plan IS NOT NULL AND email = $1`,
      [email.trim().toLowerCase()],
    );

    if (rows.length === 0) return currentPlan;

    const winner = claimable(
      rows.map((r) => ({ eventId: r.event_id, plan: r.plan, licenseId: r.license_id, eventAt: r.event_at })),
      currentPlan,
    );

    /*
      The plan first, then the mark. It used to be the other way round.

      These are two separate statements with no transaction between them, and
      the mark was going first — so a failure in the second (a pool exhausted, a
      statement timeout, a serverless invocation cut short between the two) left
      the row saying `outcome = 'applied'` with `applied_at` set, and no
      subscription written. The catch below swallows it and answers with the old
      plan, so the page looks entirely normal.

      And it is unrecoverable in that order. The row no longer satisfies
      `user_id IS NULL`, so the query above will never select it again on any
      future request; the retry this file's header promises — "it is retried on
      the next read, which is the next time they load the app" — does not exist
      for that window. Support looking into "they say they paid and the product
      disagrees" is shown a row that says the payment *was* applied.

      Written this way round, the same failure leaves the row unclaimed and the
      subscription written: the next page load re-selects it, `claimable`
      declines to apply a plan the account already has, and it is marked then.
      A repeat of work already done is the safe direction; a mark with no work
      behind it is not.
    */
    if (winner) {
      await pool.query(
        `INSERT INTO subscriptions (user_id, plan, license_id, plan_source_at, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (user_id) DO UPDATE
           SET plan = EXCLUDED.plan,
               license_id = EXCLUDED.license_id,
               plan_source_at = EXCLUDED.plan_source_at,
               updated_at = now()`,
        [userId, winner.plan, winner.licenseId, winner.eventAt ?? null],
      );
    }

    // Every row for this address stops being unclaimed either way, so a payment
    // that is not worth applying is not re-examined on every page load for the
    // rest of the account's life.
    await pool.query(
      `UPDATE billing_events
          SET user_id = $2,
              outcome = CASE WHEN event_id = $3 THEN 'applied' ELSE 'claimed-not-applied' END,
              applied_at = CASE WHEN event_id = $3 THEN now() ELSE applied_at END
        WHERE user_id IS NULL AND email = $1`,
      [email.trim().toLowerCase(), userId, winner?.eventId ?? null],
    );

    if (!winner) return currentPlan;

    logger.info({ userId, plan: winner.plan, eventId: winner.eventId }, claimNote(winner));
    return winner.plan;
  } catch (error) {
    logger.error({ err: error, userId }, "could not claim pending billing events");
    return currentPlan;
  }
}
