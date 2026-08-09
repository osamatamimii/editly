import { pgTable, text, timestamp, real, integer, uuid, index } from "drizzle-orm/pg-core";
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
    /**
     * Storage object keys in the private "videos" bucket, always shaped
     * "<userId>/<projectId>/<name>". Signed URLs expire, so the durable key
     * is what gets stored; the client mints a URL when it needs to play.
     */
    videoPath: text("video_path"),
    editedVideoPath: text("edited_video_path"),
    /** Poster frame, same key shape as the video. */
    thumbnailPath: text("thumbnail_path"),
    duration: real("duration"),
    /**
     * The source clip's pixel dimensions, measured in the browser at upload.
     * Kept so the player can be the right shape before a single frame has
     * decoded — and stay right for files the browser cannot decode at all.
     */
    width: integer("width"),
    height: integer("height"),
    platform: text("platform"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [index("projects_user_id_created_idx").on(t.userId, t.createdAt)],
);

export const insertProjectSchema = createInsertSchema(projectsTable).omit({ createdAt: true, updatedAt: true });
export type InsertProject = z.infer<typeof insertProjectSchema>;
export type Project = typeof projectsTable.$inferSelect;
