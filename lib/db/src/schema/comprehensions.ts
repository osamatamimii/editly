import { pgTable, text, timestamp, uuid, integer, real, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

/**
 * What the material *is*, once something has read it.
 *
 * Every other row in this schema records something the product did: a render, a
 * clip, a post, a charge. This one records something it *understood* — where
 * the parts of a video are, what the speaker asserted, what they asked, which
 * stretches would hold a stranger, and the one line it should open on. Produced
 * by `artifacts/worker/src/comprehend.ts` from the transcript, which is the only
 * moment in the pipeline where the words exist and nothing has been decided yet.
 *
 * ## Why it is stored rather than derived
 *
 * Because it is the input to everything above it, and it costs money to make.
 * A reading is one model call over text; re-doing it for each render, each set
 * of clips, and each "do it again but shorter" would be paying three times for
 * the same answer about the same file — and, worse, could return three
 * different answers, so the same project would have three different ideas about
 * where its chapters are.
 *
 * ## Why one row per project
 *
 * A project is one source video. Two readings of one video are not a history
 * worth keeping; they are an ambiguity about which one is true. So the row is
 * replaced in place, and `digest` — a fingerprint of the words it was made from
 * — is what says whether the stored reading is still about the file that is
 * there now. Same words, keep it; different words, make it again. The file's
 * bytes would answer neither question, since a re-encode of the same recording
 * is a different file and the same material.
 *
 * ## And why `how` is a column and not a detail
 *
 * A reading made by a model and one derived from the *shape* of the speech —
 * pauses, density, question marks — are both structures with chapters in them,
 * and they look identical to anything that reads this table. They are not worth
 * the same. A caller that cannot tell them apart will treat "the longest pause
 * in the first half" as "where the subject changed", which is the sort of
 * silent substitution this product keeps finding in itself. So the difference
 * is a column, beside the notes that say it in words.
 */
export const comprehensionsTable = pgTable(
  "comprehensions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    /** Owner. Every query MUST filter on this, like every other table here. */
    userId: uuid("user_id").notNull(),

    /** `COMPREHENSION_VERSION`. A reading from an older shape is remade, not reinterpreted. */
    version: integer("version").notNull(),

    /** The source length this reading was made against, on the source clock. */
    durationSeconds: real("duration_seconds"),

    /** BCP-47, as the transcript reported it. Null when it reported none. */
    language: text("language"),

    /** `model` | `structure` — see the note above. */
    how: text("how").notNull(),

    /** Which reader produced it, the way a transcript names its source. Null for the shape path. */
    source: text("source"),

    /** Of the words this was made from. The reuse key. */
    digest: text("digest").notNull(),

    chapters: jsonb("chapters").$type<Array<{ start: number; end: number; title: string }>>().notNull(),
    claims: jsonb("claims").$type<Array<{ at: number; quote: string }>>().notNull(),
    questions: jsonb("questions")
      .$type<Array<{ at: number; quote: string; answeredAt: number | null }>>()
      .notNull(),
    peaks: jsonb("peaks")
      .$type<Array<{ start: number; end: number; why: string; strength: number }>>()
      .notNull(),
    /** Null when nothing in the video works as an opening — which is a real answer. */
    hook: jsonb("hook").$type<{ at: number; quote: string } | null>(),

    /**
     * What was lost getting here, in the language the job was asked in: quotes
     * that were dropped because the speaker never said them, a reader that
     * failed, a structure that came from pauses. Same shape as `jobs.notes`.
     */
    notes: jsonb("notes").$type<string[]>(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("comprehensions_project_id_idx").on(t.projectId)],
);

/**
 * Named `Row` rather than `Comprehension` on purpose: the worker's
 * `comprehend.ts` exports a `Comprehension` that is the reading itself, and a
 * file that imports both would have two different things under one name.
 */
export type ComprehensionRow = typeof comprehensionsTable.$inferSelect;
