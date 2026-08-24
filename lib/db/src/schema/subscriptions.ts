import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/** One subscription per authenticated user, keyed by their auth user id. */
export const subscriptionsTable = pgTable("subscriptions", {
  userId: uuid("user_id").primaryKey(),
  /**
   * The default is `free` and must stay `free`.
   *
   * It used to be `starter`, a name the plan map aliases to Creator — so any
   * insert that forgot this column handed out sixty minutes, no watermark and
   * reference style for nothing. Both insert sites set it explicitly today, so
   * it was a trap rather than a leak, but a default that contradicts
   * `DEFAULT_PLAN` is a trap that eventually goes off.
   */
  plan: text("plan").notNull().default("free"),
  /**
   * Which Freemius licence granted the current plan, and as of when.
   *
   * Without these two the webhook had nothing to compare an incoming event
   * against, so a redelivered `license.cancelled` for a *superseded* licence
   * wrote free over the Pro plan that had replaced it. Idempotence was never
   * the problem — `planFromEvent` returns a target state — order was.
   *
   * Null on rows that predate them, and on any plan set by something other than
   * a webhook (a self-serve downgrade). Both are treated as "unknown", and an
   * unknown never causes an event to be ignored: the comparison only rejects an
   * event when both sides are known and the incoming one is genuinely older.
   */
  /**
   * Set when the console suspends the account: no new renders, nothing
   * deleted.
   *
   * A suspended account keeps every byte, every project and every clip, and
   * can still sign in and look at them. The only thing it cannot do is start
   * work that costs us money. Deleting somebody's footage is not a moderation
   * action, it is destruction of their property.
   */
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  licenseId: text("license_id"),
  planSourceAt: timestamp("plan_source_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertSubscriptionSchema = createInsertSchema(subscriptionsTable).omit({ createdAt: true, updatedAt: true });
export type InsertSubscription = z.infer<typeof insertSubscriptionSchema>;
export type Subscription = typeof subscriptionsTable.$inferSelect;
