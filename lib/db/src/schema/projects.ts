import { pgTable, text, timestamp, real, uuid, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const projectsTable = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    /** Owner. Every query MUST filter on this — see middlewares/auth.ts. */
    userId: uuid("user_id").notNull(),
    title: text("title").notNull(),
    status: text("status").notNull().default("ready"),
    thumbnailUrl: text("thumbnail_url"),
    videoUrl: text("video_url"),
    editedVideoUrl: text("edited_video_url"),
    duration: real("duration"),
    platform: text("platform"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [index("projects_user_id_created_idx").on(t.userId, t.createdAt)],
);

export const insertProjectSchema = createInsertSchema(projectsTable).omit({ createdAt: true, updatedAt: true });
export type InsertProject = z.infer<typeof insertProjectSchema>;
export type Project = typeof projectsTable.$inferSelect;
