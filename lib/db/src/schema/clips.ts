import { pgTable, text, timestamp, uuid, integer, real, index } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

/**
 * The pieces a long video was cut into.
 *
 * A render used to produce exactly one file, pointed at by the project row —
 * so "give me three clips" had nowhere to put its answer. Each clip is its
 * own artifact with its own storage path and its own stretch of the source;
 * the project keeps pointing at whole-video renders only.
 *
 * `jobId` records which render produced the clip and is deliberately not a
 * foreign key: jobs rows are the billing record (nothing cascades onto them),
 * and a clip must not vanish because a future cleanup prunes old job rows —
 * the file it names still exists and still belongs to the person. The one
 * cascade that is right is the project's, same as messages and the library.
 */
export const clipsTable = pgTable(
  "clips",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),

    /** Which render produced it. A record, not a reference. */
    jobId: text("job_id").notNull(),

    /** 1-based position in the set, in source order. */
    idx: integer("idx").notNull(),

    /** The stretch of the source this clip came from, on the source clock. */
    startSeconds: real("start_seconds").notNull(),
    endSeconds: real("end_seconds").notNull(),

    /** `<userId>/<projectId>/...` — the browser signs its own playback URL. */
    outputPath: text("output_path").notNull(),

    /** Measured from the finished file, like jobs.output_seconds. */
    outputSeconds: real("output_seconds"),

    /** The worker's one line about this clip, shown under it in the list. */
    note: text("note"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("clips_project_id_idx").on(t.projectId)],
);

export type Clip = typeof clipsTable.$inferSelect;
