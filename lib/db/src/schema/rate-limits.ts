import { pgTable, text, timestamp, integer, index } from "drizzle-orm/pg-core";

/**
 * How often each person has called each endpoint that costs us something.
 *
 * The quota caps minutes of finished video. It caps nothing else, and the chat
 * that turns a sentence into an edit plan is a paid model call that produces no
 * minutes at all — so it was unlimited, on the free plan, to anybody.
 *
 * Kept in Postgres rather than in memory because there is no "in memory" here:
 * the API runs as many short-lived serverless copies, and a counter each of
 * them keeps privately is not a limit.
 */
export const rateLimitsTable = pgTable(
  "rate_limits",
  {
    /** "<userId>:<name>" — one row per person per endpoint, reused forever. */
    bucket: text("bucket").primaryKey(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull().defaultNow(),
    count: integer("count").notNull().default(0),
  },
  (t) => [index("rate_limits_window_idx").on(t.windowStart)],
);

export type RateLimitRow = typeof rateLimitsTable.$inferSelect;
