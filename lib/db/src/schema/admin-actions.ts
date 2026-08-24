import { pgTable, index, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Every act of the admin console, and for one of them the act itself.
 *
 * Granting minutes is stored here and nowhere else — the meter reads this
 * table — so there is no path that grants somebody minutes without recording
 * who did it and why. A design where the grant lives in one table and the
 * reason in another is a design where the reason eventually stops being
 * written.
 *
 * No foreign keys, deliberately: an audit row has to outlive its subject. A
 * job gets swept, an account gets deleted, and the record of what was done to
 * them is exactly the thing that must survive that.
 */
export const adminActionsTable = pgTable(
  "admin_actions",
  {
    id: uuid("id").primaryKey(),
    /** Who did it. An action with no actor is not an audit row. */
    actorUserId: uuid("actor_user_id").notNull(),
    /** requeue_job · grant_minutes · set_plan · set_suspended */
    action: text("action").notNull(),
    /** One of these is set, never both. */
    subjectUserId: uuid("subject_user_id"),
    subjectJobId: text("subject_job_id"),
    /** Why, in words. The route refuses an empty one. */
    reason: text("reason").notNull(),
    /** The action's own numbers — seconds granted, the plan set. */
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Partial: the only hot query is the meter reading this month's grants for
    // one person, on every render start.
    index("admin_actions_grants_idx")
      .on(t.subjectUserId, t.createdAt)
      .where(sql`action = 'grant_minutes'`),
  ],
);

export const insertAdminActionSchema = createInsertSchema(adminActionsTable).omit({ createdAt: true });
export type InsertAdminAction = z.infer<typeof insertAdminActionSchema>;
export type AdminAction = typeof adminActionsTable.$inferSelect;
