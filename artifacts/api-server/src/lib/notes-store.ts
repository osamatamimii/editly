/**
 * Where notes are read from, kept apart from what they mean.
 *
 * `notes.ts` is the vocabulary and the merge rule, and it is deliberately free
 * of a database: it is pure functions over a plan and a list of sentences, so
 * it can be imported, reasoned about and tested without a Postgres. The moment
 * a `db` import goes in there, every consumer of `applyNotes` drags `pg` with
 * it — which is what `timeline.ts` in the worker says about itself, for the
 * same reason and in the same words.
 *
 * So the two queries live here.
 */
import { and, asc, eq } from "drizzle-orm";
import { db, notesTable, transcriptsTable } from "@workspace/db";
import type { AnchorWord, Note } from "./notes";

/**
 * This project's notes, oldest anchor first.
 *
 * Owner-scoped in the query rather than checked afterwards, like every other
 * read in this server: a filter somebody can forget to apply is a filter that
 * eventually is not applied.
 */
export async function notesFor(projectId: string, userId: string): Promise<Note[]> {
  const rows = await db
    .select({ sourceMs: notesTable.sourceMs, text: notesTable.text })
    .from(notesTable)
    .where(and(eq(notesTable.projectId, projectId), eq(notesTable.userId, userId)))
    .orderBy(asc(notesTable.sourceMs));
  return rows.map((row) => ({ sourceMs: row.sourceMs, text: row.text }));
}

/**
 * The words of this project's source, for snapping anchors onto boundaries.
 *
 * Read from the stored transcript — the one the worker already bought and
 * kept — so this costs a query and never a model. A project with no transcript
 * yet returns nothing, and `snapAnchor` uses the anchor as given, which is the
 * right answer rather than a degraded one: there are no boundaries to snap to.
 */
export async function wordsFor(projectId: string, userId: string): Promise<AnchorWord[]> {
  const [row] = await db
    .select({ segments: transcriptsTable.segments })
    .from(transcriptsTable)
    .where(and(eq(transcriptsTable.projectId, projectId), eq(transcriptsTable.userId, userId)))
    .limit(1);
  if (!row?.segments) return [];
  return wordsOf(row.segments);
}

/**
 * The stored segments, flattened to word boundaries.
 *
 * `startMs`/`endMs`/`text` are the field names the worker's `TranscriptWord`
 * writes, and reading anything else here fails the way a wrong field name in
 * jsonb always fails — silently, with an empty list that looks exactly like a
 * project nobody has transcribed yet. Both readers of these rows go through
 * this one function so there is a single place to be right.
 */
export function wordsOf(segments: unknown): AnchorWord[] {
  const words: AnchorWord[] = [];
  for (const segment of (segments as StoredSegment[]) ?? []) {
    for (const word of segment?.words ?? []) {
      if (typeof word.startMs === "number" && typeof word.endMs === "number") {
        words.push({ startMs: word.startMs, endMs: word.endMs });
      }
    }
  }
  return words;
}

/** As much of a stored segment as anything on this side reads. */
export interface StoredSegment {
  words?: Array<{ startMs?: number; endMs?: number; text?: string }>;
}
