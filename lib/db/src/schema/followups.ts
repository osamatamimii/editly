import { pgTable, text, timestamp, jsonb, uuid } from "drizzle-orm/pg-core";

/**
 * A plan requested while a render was already running.
 *
 * The chat has always answered that situation with "I'll fold this in once it
 * finishes" — this table is what makes that sentence true. One row per
 * project, newest request wins: each sentence the planner turns into a plan
 * is the person's *whole* current wish, not an increment, so replacing the
 * older wish is honest and queuing them all would spend minutes on drafts
 * they already superseded.
 *
 * Consumed by the render-status poll the moment it sees the active job
 * settle — see routes/render.ts. The worker never reads it: whether a render
 * may start is API policy, whichever door asks.
 */
export const renderFollowupsTable = pgTable("render_followups", {
  projectId: text("project_id").primaryKey(),
  userId: uuid("user_id").notNull(),
  /** The operations the planner produced, verbatim; policy applies at start. */
  operations: jsonb("operations").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type RenderFollowup = typeof renderFollowupsTable.$inferSelect;
