/**
 * Freemius, which is where money actually changes hands.
 *
 * Freemius is a merchant of record, not a payment processor: it sells to the
 * customer, collects VAT and sales tax in whatever jurisdiction they are in,
 * and pays us. That is the whole reason it was chosen over Stripe — a seller
 * outside the US selling to Europe otherwise has to solve tax law before they
 * can solve video editing.
 *
 * Two things arrive from them and they are not equally trustworthy.
 *
 * The **checkout** is opened in the browser with a public key. Nothing about
 * that key is secret; it identifies the product, and a person who has it can
 * open a checkout, which is what we want them to do anyway.
 *
 * The **webhook** is the part that grants a paid plan, so it is the part an
 * attacker would forge. Anyone can POST to a public URL claiming a payment
 * succeeded. The only thing separating a real event from a made-up one is the
 * signature, computed with a secret only Freemius and our server know — so an
 * unverified webhook is not a webhook, it is an unauthenticated endpoint that
 * hands out paid plans.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { PlanKey } from "./plan-limits";

/** Set in Vercel's environment. Never in the repo, never in a log line. */
const SECRET = process.env["FREEMIUS_SECRET_KEY"]?.trim();

/**
 * Freemius plan IDs map to ours here rather than by name, because their plan
 * titles are marketing copy that someone will rename on a Tuesday and nobody
 * will connect the outage to it.
 */
const PLAN_BY_FREEMIUS_ID: Record<string, PlanKey> = Object.fromEntries(
  (process.env["FREEMIUS_PLAN_MAP"] ?? "")
    .split(",")
    .map((pair) => pair.split(":").map((s) => s.trim()))
    .filter((pair): pair is [string, string] => pair.length === 2 && Boolean(pair[0]))
    .map(([freemiusId, plan]) => [freemiusId, plan as PlanKey]),
);

export const freemiusConfigured = Boolean(SECRET);

/**
 * Is this really from Freemius?
 *
 * They sign the raw request body with the secret key and send it as a hex
 * digest. Two details matter more than the algorithm:
 *
 * The comparison is constant-time. A plain `===` leaks, through how long it
 * takes to fail, roughly how many leading characters were right — which turns
 * forging a signature from impossible into merely tedious.
 *
 * The body must be the **raw bytes**, not a re-serialised object. `JSON.parse`
 * followed by `JSON.stringify` reorders keys and drops whitespace, and the
 * digest of that is not the digest they signed.
 */
export function verifySignature(rawBody: Buffer | string, signature: string | undefined): boolean {
  if (!SECRET || !signature) return false;

  const expected = createHmac("sha256", SECRET).update(rawBody).digest("hex");
  const given = signature.trim().toLowerCase();

  // timingSafeEqual throws on a length mismatch, which is itself a leak of one
  // bit; checking length first and returning the same way keeps it uniform.
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(given, "utf8"));
}

export type FreemiusEventType =
  | "license.created"
  | "license.updated"
  | "license.extended"
  | "license.cancelled"
  | "license.expired"
  | "subscription.cancelled"
  | "payment.refund";

export interface PlanDecision {
  /** What the user's plan should be after this event. */
  plan: PlanKey;
  /** Why, in words that belong in a log line rather than in front of a user. */
  reason: string;
}

/**
 * What a Freemius event means for someone's access.
 *
 * Deliberately written as "what should be true now" rather than "apply this
 * change". Webhooks arrive out of order and more than once — a renewal can land
 * before the payment that caused it, and a retry can deliver the same event an
 * hour later. Anything expressed as a delta ("add a month", "bump the tier")
 * corrupts itself under those conditions. Anything expressed as a target state
 * is naturally idempotent.
 *
 * A refund or a cancellation drops to free rather than deleting anything. Their
 * projects and their renders are theirs; what they lose is the allowance.
 */
export function planFromEvent(event: {
  type: string;
  planId?: string | number | null;
}): PlanDecision | null {
  const type = event.type;

  if (type === "payment.refund" || type === "license.cancelled" || type === "license.expired" || type === "subscription.cancelled") {
    return { plan: "free", reason: `${type}. Access drops to free, nothing is deleted` };
  }

  if (type === "license.created" || type === "license.updated" || type === "license.extended") {
    const mapped = event.planId != null ? PLAN_BY_FREEMIUS_ID[String(event.planId)] : undefined;
    if (!mapped) {
      // A plan we do not recognise is a configuration error, and guessing would
      // either give away capacity or take away paid capacity. Neither is ours
      // to choose, so we do nothing and say so loudly.
      return null;
    }
    return { plan: mapped, reason: `${type} → ${mapped}` };
  }

  // Events we do not act on — carts, installs, review requests. Ignoring them
  // silently is correct; they are not about access.
  return null;
}

/**
 * Everything the browser needs to open a checkout. All of it is public.
 *
 * `plans` is the same mapping as `PLAN_BY_FREEMIUS_ID`, read the other way:
 * the browser knows it wants "pro" and needs the Freemius id to open. Sending
 * it is safe — the id appears in the checkout URL either way — and sending it
 * from here rather than hardcoding it in the bundle means renaming a plan on
 * Freemius does not require a frontend deploy.
 */
export function checkoutConfig(): {
  productId: string;
  publicKey: string;
  plans: Partial<Record<PlanKey, string>>;
} | null {
  const productId = process.env["FREEMIUS_PRODUCT_ID"]?.trim();
  const publicKey = process.env["FREEMIUS_PUBLIC_KEY"]?.trim();
  if (!productId || !publicKey) return null;

  const plans: Partial<Record<PlanKey, string>> = {};
  for (const [freemiusId, plan] of Object.entries(PLAN_BY_FREEMIUS_ID)) {
    // First id wins. Two ids mapping to one plan is a configuration mistake,
    // and picking either silently is better than opening a checkout for a
    // plan the webhook will then refuse to recognise.
    plans[plan] ??= freemiusId;
  }
  return { productId, publicKey, plans };
}
