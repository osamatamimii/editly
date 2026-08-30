/**
 * Where a payment becomes a plan.
 *
 * Two endpoints, and they sit on opposite sides of the trust boundary.
 *
 * `GET /billing/checkout` is for our own signed-in user and returns only public
 * configuration — the product id and the public key the checkout widget needs.
 *
 * `POST /billing/webhook` is called by Freemius, from the open internet, with
 * no session. It is the endpoint that grants paid access, so it is the one an
 * attacker would forge, and the signature is the only thing standing between a
 * real payment and a made-up one. It is mounted **before** authentication for
 * that reason, and it must never trust anything in the body until the signature
 * over the raw bytes has checked out.
 */
import { Router, type IRouter } from "express";
import express from "express";
import { eq } from "drizzle-orm";
import { db, subscriptionsTable } from "@workspace/db";
import { currentUserId } from "../middlewares/auth";
import { checkoutConfig, freemiusConfigured, planFromEvent, verifySignature } from "../lib/freemius";
import { planKeyFrom } from "../lib/plan-limits";
import { decideApply, eventIdFor, eventTimeFrom } from "../lib/billing-ledger";
import { createHash } from "node:crypto";

/**
 * Public router: mounted outside `requireAuth`, because Freemius has no session
 * with us and never will.
 */
export const billingWebhookRouter: IRouter = Router();

/**
 * The raw body is required, not preferred. Express's JSON parser hands back a
 * parsed object, and re-serialising it reorders keys and drops whitespace — the
 * digest of that is not the digest Freemius signed, so every legitimate event
 * would fail verification and every forged one would fail identically. This
 * parser keeps the exact bytes.
 */
billingWebhookRouter.post(
  "/billing/webhook",
  express.raw({ type: "*/*", limit: "1mb" }),
  async (req, res): Promise<void> => {
    if (!freemiusConfigured) {
      // No secret means we cannot tell a real event from a forged one, so we
      // decline rather than trust. 503, not 401: this is our misconfiguration.
      res.status(503).json({ error: "Billing is not configured on this deployment." });
      return;
    }

    const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ""));
    const signature =
      (req.header("x-signature") ?? req.header("X-Signature") ?? req.header("x-freemius-signature")) || undefined;

    if (!verifySignature(raw, signature)) {
      req.log?.warn({ hasSignature: Boolean(signature) }, "rejected an unsigned or mis-signed billing webhook");
      res.status(401).json({ error: "Invalid signature." });
      return;
    }

    let payload: { type?: string; objects?: Record<string, unknown>; data?: Record<string, unknown> };
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      res.status(400).json({ error: "Body is not JSON." });
      return;
    }

    // Freemius nests the interesting record under `objects`; the shapes differ
    // per event, so read defensively and act only on what we recognise.
    const objects = (payload.objects ?? payload.data ?? {}) as Record<string, Record<string, unknown> | undefined>;
    const license = objects["license"] ?? {};
    const user = (objects["user"] ?? {}) as Record<string, unknown>;

    const decision = planFromEvent({
      type: String(payload.type ?? ""),
      planId: (license["plan_id"] as string | number | undefined) ?? null,
    });

    const type = String(payload.type ?? "");
    const email = String(user["email"] ?? license["user_email"] ?? "").trim().toLowerCase();
    const licenseId = license["id"] != null ? String(license["id"]) : null;
    const eventId = eventIdFor(payload as Record<string, unknown>, raw, (input) =>
      createHash("sha256").update(input).digest("hex"),
    );
    const eventAt = eventTimeFrom(objects, payload as Record<string, unknown>);

    // Written down before anything is decided, and written down whatever the
    // decision turns out to be. This table is the answer to "somebody says they
    // paid and the product disagrees", and a row that only exists when things
    // went well cannot answer that.
    const seenBefore = await recordEvent({
      eventId,
      type,
      email: email || null,
      licenseId,
      plan: decision?.plan ?? null,
      eventAt,
    });

    // An event we do not act on is still a delivered event. Answering 200 stops
    // Freemius retrying something we will never do anything with.
    if (!decision) {
      await closeEvent(eventId, null, "ignored");
      res.status(200).json({ ok: true, ignored: type });
      return;
    }

    // Which of our users is this? Freemius knows them by the email they paid
    // with, which is the only identifier both sides share today.
    if (!email) {
      req.log?.error({ type, eventId }, "billing event carried no email, cannot map it to a user");
      await closeEvent(eventId, null, "no-account-yet");
      res.status(200).json({ ok: true, unmapped: true });
      return;
    }

    const userId = await userIdForEmail(email);
    if (!userId) {
      // They paid before signing up, or paid with a different address. Not an
      // error we can fix from here and not one to retry forever — but no longer
      // one we simply forget either. The row stays unclaimed, with the email on
      // it, and `claimPaidEvents` hands it over the moment an account with that
      // address appears. Until today this branch persisted nothing at all: the
      // customer was charged, got the free plan, and support had no record.
      req.log?.warn({ type, eventId }, "billing event for an email with no account yet. Held for claiming");
      await closeEvent(eventId, null, "no-account-yet");
      res.status(200).json({ ok: true, pending: true });
      return;
    }

    const [current] = await db
      .select()
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.userId, userId))
      .limit(1);

    const verdict = decideApply(
      { plan: decision.plan, licenseId, eventAt, alreadySeen: seenBefore },
      current ? { plan: current.plan, licenseId: current.licenseId, planSourceAt: current.planSourceAt } : null,
    );

    if (!verdict.apply) {
      req.log?.warn(
        { userId, eventId, type, outcome: verdict.outcome, wanted: decision.plan, have: current?.plan },
        "billing event not applied",
      );
      await closeEvent(eventId, userId, verdict.outcome);
      // Still 200. The event was received and understood; refusing to act on a
      // stale one is not a failure Freemius should retry.
      res.status(200).json({ ok: true, outcome: verdict.outcome });
      return;
    }

    await setPlan(userId, decision.plan, licenseId, eventAt);
    await closeEvent(eventId, userId, "applied");
    req.log?.info({ userId, plan: decision.plan, reason: decision.reason, eventId }, "billing event applied");
    res.status(200).json({ ok: true });
  },
);

/** Authenticated router: mounted inside `requireAuth` with everything else. */
const router: IRouter = Router();

router.get("/billing/checkout", async (req, res): Promise<void> => {
  const config = checkoutConfig();
  if (!config) {
    res.status(503).json({ error: "Billing is not configured on this deployment." });
    return;
  }

  const [sub] = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.userId, currentUserId(req)))
    .limit(1);

  // Only public values leave this handler. The secret key exists to verify
  // webhooks and has no business in a browser.
  res.json({ ...config, currentPlan: planKeyFrom(sub?.plan) });
});

export default router;

/**
 * Supabase owns the identity table, and it lives in a schema the application
 * role is not allowed to touch — querying `auth.users` directly threw
 * "permission denied" on every webhook, after the event was recorded and
 * before anything was decided (see migration 0020). The lookup goes through
 * `public.user_id_for_email`, a SECURITY DEFINER function that answers this
 * one question with its owner's rights; the app role holds EXECUTE on it and
 * nothing else.
 */
async function userIdForEmail(email: string): Promise<string | null> {
  const { pool } = await import("@workspace/db");
  const { rows } = await pool.query<{ id: string | null }>(
    "select public.user_id_for_email($1) as id",
    [email],
  );
  return rows[0]?.id ?? null;
}

async function setPlan(
  userId: string,
  plan: string,
  licenseId: string | null,
  eventAt: Date | null,
): Promise<void> {
  const { pool } = await import("@workspace/db");
  // Upsert: a webhook can arrive before the person has ever loaded the app, and
  // "you paid but you have no subscription row" is not a state worth having.
  //
  // The licence and the timestamp travel with the plan, because they are what
  // the *next* event is compared against. Writing the plan without them would
  // leave the row unable to tell a retry from news, which is where this started.
  await pool.query(
    `INSERT INTO subscriptions (user_id, plan, license_id, plan_source_at, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (user_id) DO UPDATE
       SET plan = EXCLUDED.plan,
           license_id = EXCLUDED.license_id,
           plan_source_at = EXCLUDED.plan_source_at,
           updated_at = now()`,
    [userId, plan, licenseId, eventAt],
  );
}

/**
 * Records the event and says whether we had already seen it.
 *
 * `ON CONFLICT DO NOTHING` plus a check of what came back is the whole
 * duplicate rule: the primary key is the arbiter, so two simultaneous
 * redeliveries cannot both decide they are the first.
 */
async function recordEvent(event: {
  eventId: string;
  type: string;
  email: string | null;
  licenseId: string | null;
  plan: string | null;
  eventAt: Date | null;
}): Promise<boolean> {
  const { pool } = await import("@workspace/db");
  const { rows } = await pool.query(
    `INSERT INTO billing_events (event_id, type, email, license_id, plan, event_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [event.eventId, event.type, event.email, event.licenseId, event.plan, event.eventAt],
  );
  return rows.length === 0;
}

/** Marks what became of an event. Never throws: bookkeeping must not fail a payment. */
async function closeEvent(eventId: string, userId: string | null, outcome: string): Promise<void> {
  try {
    const { pool } = await import("@workspace/db");
    await pool.query(
      `UPDATE billing_events
          SET user_id = COALESCE($2, user_id),
              outcome = $3,
              applied_at = CASE WHEN $3 = 'applied' THEN now() ELSE applied_at END
        WHERE event_id = $1`,
      [eventId, userId, outcome],
    );
  } catch {
    // Deliberately silent. The plan is already written; failing the request now
    // would make Freemius retry a payment we have already honoured.
  }
}
