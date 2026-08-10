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

    // An event we do not act on is still a delivered event. Answering 200 stops
    // Freemius retrying something we will never do anything with.
    if (!decision) {
      res.status(200).json({ ok: true, ignored: String(payload.type ?? "") });
      return;
    }

    // Which of our users is this? Freemius knows them by the email they paid
    // with, which is the only identifier both sides share today.
    const email = String(user["email"] ?? license["user_email"] ?? "").trim().toLowerCase();
    if (!email) {
      req.log?.error({ type: payload.type }, "billing event carried no email, cannot map it to a user");
      res.status(200).json({ ok: true, unmapped: true });
      return;
    }

    const userId = await userIdForEmail(email);
    if (!userId) {
      // They paid before signing up, or paid with a different address. Not an
      // error we can fix from here, and not one to retry forever.
      req.log?.warn({ type: payload.type }, "billing event for an email with no account yet");
      res.status(200).json({ ok: true, pending: true });
      return;
    }

    await setPlan(userId, decision.plan);
    req.log?.info({ userId, plan: decision.plan, reason: decision.reason }, "billing event applied");
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
 * Supabase owns the identity table, and it lives in a schema Drizzle does not
 * model. One narrow query is cheaper and clearer than mirroring `auth.users`.
 */
async function userIdForEmail(email: string): Promise<string | null> {
  const { pool } = await import("@workspace/db");
  const { rows } = await pool.query<{ id: string }>(
    "select id from auth.users where lower(email) = $1 limit 1",
    [email],
  );
  return rows[0]?.id ?? null;
}

async function setPlan(userId: string, plan: string): Promise<void> {
  const { pool } = await import("@workspace/db");
  // Upsert: a webhook can arrive before the person has ever loaded the app, and
  // "you paid but you have no subscription row" is not a state worth having.
  await pool.query(
    `INSERT INTO subscriptions (user_id, plan, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE SET plan = EXCLUDED.plan, updated_at = now()`,
    [userId, plan],
  );
}
