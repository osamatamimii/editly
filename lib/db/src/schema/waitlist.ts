import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * People who asked to be told when it opens.
 *
 * Keyed by the address itself rather than a generated id, because the only
 * question this table ever answers is "is this person on the list", and a
 * surrogate key would let the same person be on it four times. The address is
 * stored already lowercased and trimmed — normalising on read means every
 * reader has to remember to, and one that forgets makes a duplicate.
 *
 * Deliberately three columns. A waiting list that collects a name, a company
 * and a use-case converts worse and gives us nothing we can act on before we
 * have a product to show them; the address is the whole ask, and everything
 * else can be asked later of people who have already said yes once.
 */
export const waitlistTable = pgTable(
  "waitlist",
  {
    email: text("email").primaryKey(),
    /**
     * Which page they signed up from.
     *
     * Not analytics for its own sake: the landing page and the waiting-list
     * domain are two different promises, and if one of them converts and the
     * other does not, that is the only place the difference will show.
     */
    source: text("source"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("waitlist_created_at_idx").on(t.createdAt)],
);

export const insertWaitlistSchema = createInsertSchema(waitlistTable).omit({ createdAt: true });
export type InsertWaitlistEntry = z.infer<typeof insertWaitlistSchema>;
export type WaitlistEntry = typeof waitlistTable.$inferSelect;
