import { pgTable, index, integer, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * A word somebody types to be given a plan.
 *
 * What this is, and what it deliberately is not.
 *
 * It **is** a grant: a code names a plan and a number of months, and redeeming
 * it writes that plan onto the account with a date it runs out. Nothing about
 * it touches money — no charge is made, no card is asked for, no invoice
 * exists. That is the whole reason it can be built here at all: a hundred
 * per cent off is not a discount on a payment, it is the absence of one, and
 * the absence of a payment is a thing this database can express on its own.
 *
 * It is **not** a coupon. A code that takes $29 down to $9 is a rule about a
 * charge, and the charge is made by the merchant of record, not by us. There
 * is no honest way to build a partial discount on this side: we would be
 * writing a smaller number into a row while the card is still charged the
 * larger one. That half lives wherever checkout lives, and `claude/promo.md`
 * says so rather than leaving the gap to be discovered.
 *
 * The shape follows from the use it was asked for: an affiliate is handed a
 * word, uses it once, and has the tool for a year. So a code carries its own
 * ceiling (`maxRedemptions`, one by default) and its own expiry, and can be
 * revoked without being deleted — a revoked code stops working and the record
 * of who used it survives, which is the point of keeping it.
 */
export const promoCodesTable = pgTable(
  "promo_codes",
  {
    /**
     * Stored normalised — upper case, letters and digits only — because that is
     * the only form the route ever compares against.
     *
     * A person reading a code off a video types it in whatever case they like,
     * with a dash where they saw a space. Normalising on the way in and on the
     * way out means `editly-year` and `EDITLYYEAR` are the same code rather
     * than one working code and one support message.
     */
    code: text("code").primaryKey(),
    /** Which plan it grants: creator · pro · studio. Never free — see the route. */
    plan: text("plan").notNull(),
    /** How long the grant lasts. Twelve unless somebody says otherwise. */
    months: integer("months").notNull().default(12),
    /**
     * How many accounts may use it, and how many have.
     *
     * The count is incremented in the same statement that claims it, under the
     * condition that it is still below the ceiling, so two people redeeming the
     * last seat of a code at the same moment cannot both win it.
     */
    maxRedemptions: integer("max_redemptions").notNull().default(1),
    redeemedCount: integer("redeemed_count").notNull().default(0),
    /**
     * When the code stops being offerable. Null means never.
     *
     * Distinct from the grant's own end: this is the last day it can be typed,
     * not the last day of what it gives. A code that expires at the end of a
     * launch week still owes twelve months to everyone who used it during that
     * week.
     */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** Set when it is withdrawn. Withdrawn, not deleted: the redemptions stay. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** Who it is for, in words. The route refuses an empty one. */
    note: text("note").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [index("promo_codes_created_idx").on(t.createdAt)],
);

/**
 * Who used what, and what they were given for it.
 *
 * The plan and the end date are copied in rather than looked up through the
 * code, because the answer must survive the code being edited or revoked and
 * must survive the subscription moving on. "What did this account actually get,
 * and when does it lapse" is a question support will ask a year from now, and
 * a join through a mutable row is not an answer to it.
 *
 * No foreign keys, for the reason `admin_actions` gives: a record of what was
 * done has to outlive its subject.
 */
export const promoRedemptionsTable = pgTable(
  "promo_redemptions",
  {
    id: uuid("id").primaryKey(),
    code: text("code").notNull(),
    userId: uuid("user_id").notNull(),
    /** What it granted, as granted. */
    plan: text("plan").notNull(),
    /** When that grant runs out. */
    grantExpiresAt: timestamp("grant_expires_at", { withTimezone: true }).notNull(),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /*
      One account per code, enforced here rather than in a check the route
      makes first.

      The route does check, and the check is a better error message. It is not
      a guarantee: two requests from the same account a millisecond apart both
      read "not redeemed yet" and both go on to claim a seat. The index is what
      makes the second one fail, inside the transaction that increments the
      count — so the count and the redemptions cannot disagree.
    */
    uniqueIndex("promo_redemptions_code_user_idx").on(t.code, t.userId),
    index("promo_redemptions_user_idx").on(t.userId),
  ],
);

export const insertPromoCodeSchema = createInsertSchema(promoCodesTable).omit({ createdAt: true, updatedAt: true });
export type InsertPromoCode = z.infer<typeof insertPromoCodeSchema>;
export type PromoCode = typeof promoCodesTable.$inferSelect;

export const insertPromoRedemptionSchema = createInsertSchema(promoRedemptionsTable).omit({ redeemedAt: true });
export type InsertPromoRedemption = z.infer<typeof insertPromoRedemptionSchema>;
export type PromoRedemption = typeof promoRedemptionsTable.$inferSelect;
