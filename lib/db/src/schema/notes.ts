import { pgTable, text, timestamp, uuid, integer, index } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

/**
 * A sentence somebody attached to one moment of their own video.
 *
 * This is the second of the two ways to edit here, and the two are the same
 * object seen from different distances. A **prompt** describes the whole video
 * — "tighten it up and put it on TikTok" — and produces a plan. A **note** is
 * one instruction pinned to one instant: "leave this pause", "push in here".
 * Both end up as operations in the same `EditPlan`; what differs is scope.
 *
 * ## Two layers, not two modes
 *
 * The plan a render uses is the base plus the notes:
 *
 *     plan = base (from the prompt or a template — regenerated and thrown away)
 *          + notes (human, anchored, kept)
 *
 * Every new prompt rebuilds the base and leaves these rows alone. That is the
 * whole reason they are rows and not just more operations appended to a plan:
 * an operation in the plan is destroyed the next time somebody types a
 * sentence, and losing an hour of manual work to one careless re-prompt is the
 * single most enraging thing an editor can do to a person.
 *
 * ## Why the anchor is on the source clock
 *
 * `sourceMs` is milliseconds into **the file as uploaded**, never into the
 * edit. A person places a note while watching a cut version, and any change
 * earlier in that cut — three seconds of silence removed at 0:20 — moves every
 * later moment in the edited clock while moving nothing in the source. Anchor
 * to the edit and every note after the first change silently points at the
 * wrong instant: no error, no log line, just an instruction that lands
 * somewhere else. `zoomPunch.at` and `removeSilence.protect` already read the
 * source clock for exactly this reason, so a note needs no conversion to reach
 * them.
 *
 * The anchor is snapped to a word boundary when it is applied, from whatever
 * transcript is current, rather than stored as a word index: a word index is a
 * position in one particular reading of the audio, and the reading is bought
 * again whenever the model or the file changes. Milliseconds survive that.
 */
export const notesTable = pgTable(
  "notes",
  {
    id: uuid("id").primaryKey(),
    /* `text`, not `uuid`, because `projects.id` is text — the ids this product
       hands out are not all v4, and a foreign key whose type disagrees with the
       column it points at cannot be created at all. Caught by running the
       migration rather than by reading it. */
    projectId: text("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    /** Denormalised so every read is one query and every query is owner-scoped. */
    userId: uuid("user_id").notNull(),
    /** Milliseconds into the source. See the note above on which clock. */
    sourceMs: integer("source_ms").notNull(),
    /**
     * What the person typed, verbatim.
     *
     * Kept as written rather than as the operation it produced, because the
     * operation is derived and the sentence is the record. When the vocabulary
     * grows a verb, every note already written is re-read through it — which
     * is only possible if the words are still here.
     */
    text: text("text").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /* Every read is "this person's notes on this project, in time order". */
    byProject: index("notes_project_time").on(table.projectId, table.sourceMs),
  }),
);

export type NoteRow = typeof notesTable.$inferSelect;
