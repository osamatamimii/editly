import { pgTable, text, timestamp, uuid, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Every billing event we have been handed.
 *
 * The webhook used to have no memory at all. `planFromEvent` returns a target
 * state rather than a delta, which is idempotent — but idempotence is not
 * order-independence, and Freemius retries. A `license.cancelled` for a
 * superseded Creator licence, redelivered after the `license.created` for the
 * Pro licence that replaced it, wrote free over Pro. The customer kept being
 * charged $29 and kept the free plan's watermark, and `PATCH /subscription`
 * refuses upgrades by design, so nothing in the product could put it back.
 *
 * This table is also where a payment goes when it cannot be matched to anyone —
 * somebody paying with a different address than they signed up with, which is
 * the commonest billing ticket there is. That used to be answered 200 with
 * nothing written down at all, so the money arrived and no record of it did.
 */
export const billingEventsTable = pgTable(
  "billing_events",
  {
    /**
     * Freemius's own id where they send one, and otherwise a digest of the body
     * — so a byte-identical redelivery still collides here rather than being
     * applied twice.
     */
    eventId: text("event_id").primaryKey(),
    type: text("type").notNull(),
    email: text("email"),
    licenseId: text("license_id"),
    /** The plan this event asks for, or null for events we do not act on. */
    plan: text("plan"),
    /** When Freemius says it happened — not when it reached us. */
    eventAt: timestamp("event_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    /** Null with a plan set means "paid, but no account with this address yet". */
    userId: uuid("user_id"),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    /** Why not, when not. Written for whoever is reading this with a customer on the phone. */
    outcome: text("outcome"),
  },
  (t) => [
    // Partial: the only query that uses it is the one that claims a payment for
    // an account that has just appeared, and that query only ever looks at rows
    // nobody owns yet.
    index("billing_events_email_idx").on(t.email).where(sql`user_id IS NULL AND plan IS NOT NULL`),
  ],
);

export const insertBillingEventSchema = createInsertSchema(billingEventsTable).omit({ receivedAt: true });
export type InsertBillingEvent = z.infer<typeof insertBillingEventSchema>;
export type BillingEvent = typeof billingEventsTable.$inferSelect;
