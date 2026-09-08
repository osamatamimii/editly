import { pgTable, text, timestamp, uuid, integer, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

/**
 * The words heard in a project's source, kept rather than bought again.
 *
 * A transcript is the most expensive thing this pipeline produces: billed by
 * the minute of audio, the slowest step in a render somebody is watching a
 * progress bar for, and a **pure function of the sound in the file** — the same
 * audio through the same model gives the same words.
 *
 * And it was thrown away every time. Every message that asks for an edit starts
 * a render, and every render with captions transcribed the source again from
 * the top: five refinements on one thirty-minute podcast bought the same half
 * hour of speech five times. Nothing failed. The words were right on each of
 * the five.
 *
 * ## Why the key is the media and not the words
 *
 * `comprehensions` keys on a fingerprint of the transcript it was read from,
 * which is exactly right there and circular here — the words are the thing
 * being stored. So this keys on the media instead: `sourcePath` is the storage
 * object, and `stamp` is that object's own version, its byte length and the
 * moment the store last wrote it, from one HEAD request.
 *
 * A content hash would be exact and costs a full read of the media — seven
 * seconds for a 72 MB file on the worker's disk, and proportionally worse on
 * the four-hour sources the pricing page sells. Paying that on every render to
 * avoid paying a transcriber on some of them is the wrong trade.
 *
 * ## Why `provider` and `version` are part of the match
 *
 * A transcript from a different model, or from an older shape of this code, is
 * a different answer that looks identical from here — the same field names,
 * the same confidence numbers, different words. Reuse requires all three to
 * agree, or the product would silently serve one model's hearing under
 * another's name.
 */
export const transcriptsTable = pgTable(
  "transcripts",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    /** Owner. Every query MUST filter on this, like every other table here. */
    userId: uuid("user_id").notNull(),

    /** `TRANSCRIPT_VERSION`. Words from an older shape are bought again, not reinterpreted. */
    version: integer("version").notNull(),

    /** The storage object these words were heard from. */
    sourcePath: text("source_path").notNull(),
    /** That object's own version: byte length and last write. Same stamp, same words. */
    stamp: text("stamp").notNull(),

    /** Which provider and model produced it, the way the render notes name it. */
    provider: text("provider").notNull(),

    /** BCP-47 where the provider reports it. Null when it reported none. */
    language: text("language"),

    /**
     * The words, whole. jsonb rather than a row per word: nothing queries
     * inside them, they are read entire by the thing about to lay out
     * captions, and a hundred thousand word rows per project would buy nothing
     * and cost a cascade.
     */
    segments: jsonb("segments")
      .$type<
        Array<{
          startMs: number;
          endMs: number;
          text: string;
          speaker?: number;
          words: Array<{
            text: string;
            startMs: number;
            endMs: number;
            confidence: number;
            filler: boolean;
          }>;
        }>
      >()
      .notNull(),

    /**
     * What was lost getting here, in the language the job was asked in.
     *
     * Carried with the words rather than regenerated, so a reused transcript
     * still tells the customer it rested on a single reading instead of two
     * that agree — a sentence that would otherwise disappear the second time a
     * project is rendered, which is the version of it they see most.
     */
    notes: jsonb("notes").$type<string[]>(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("transcripts_project_id_idx").on(t.projectId)],
);

export type TranscriptRow = typeof transcriptsTable.$inferSelect;
