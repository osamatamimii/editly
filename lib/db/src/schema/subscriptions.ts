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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertSubscriptionSchema = createInsertSchema(subscriptionsTable).omit({ createdAt: true, updatedAt: true });
export type InsertSubscription = z.infer<typeof insertSubscriptionSchema>;
export type Subscription = typeof subscriptionsTable.$inferSelect;
