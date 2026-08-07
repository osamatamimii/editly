import { pgTable, text, timestamp, jsonb, uuid, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const exportsTable = pgTable(
  "exports",
  {
    id: text("id").primaryKey(),
    /** Denormalised from the parent project so ownership checks never need a join. */
    userId: uuid("user_id").notNull(),
    projectId: text("project_id").notNull(),
    status: text("status").notNull().default("pending"),
    platform: text("platform").notNull(),
    downloadUrl: text("download_url"),
    steps: jsonb("steps").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [index("exports_user_project_idx").on(t.userId, t.projectId, t.createdAt)],
);

export const insertExportSchema = createInsertSchema(exportsTable).omit({ createdAt: true, updatedAt: true });
export type InsertExport = z.infer<typeof insertExportSchema>;
export type Export = typeof exportsTable.$inferSelect;
