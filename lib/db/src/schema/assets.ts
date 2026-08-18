import { pgTable, uuid, text, timestamp, bigint, integer, real, index, uniqueIndex } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

/**
 * The files a project can put *on screen*, as opposed to the one file it is
 * editing.
 *
 * A job has always carried two paths and neither of them could be composited:
 * `input_path` is the video being cut, and `reference_path` is a video that is
 * only ever measured for style and never shown. So a logo, a photo, a piece of
 * b-roll, or the six screenshots someone wants dropped into the middle of a
 * talking head had nowhere to live.
 *
 * These hang off the project rather than the job on purpose. The same logo
 * belongs to every export of that project; re-uploading it per render attempt
 * would be both slower and a different file each time.
 */
export const assetsTable = pgTable(
  "assets",
  {
    // text, not uuid: `projects.id` and `jobs.id` are text because the ids are
    // generated in the API. A uuid column here would refuse the reference.
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),

    /** `<userId>/<projectId>/<name>` — the same shape every other object uses. */
    path: text("path").notNull(),

    /**
     * "video" | "image" | "audio", decided from the bytes on the server. The
     * filename is a claim made by the browser and is never treated as one.
     */
    kind: text("kind").notNull(),

    /** What the person called it. Shown in the library; never used as a path. */
    label: text("label"),

    bytes: bigint("bytes", { mode: "number" }).notNull().default(0),
    durationSeconds: real("duration_seconds"),
    width: integer("width"),
    height: integer("height"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // A retried upload must not leave two rows on one object: deleting either
    // would orphan the other.
    uniqueIndex("assets_path_key").on(t.path),
    index("assets_project_created_idx").on(t.projectId, t.createdAt),
  ],
);

export type AssetRow = typeof assetsTable.$inferSelect;
export type AssetKind = "video" | "image" | "audio";
