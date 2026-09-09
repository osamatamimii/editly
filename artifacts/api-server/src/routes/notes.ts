/**
 * Notes: write, read and remove one sentence pinned to one moment.
 *
 * The rows themselves, and nothing about what they mean — that is
 * `lib/notes.ts`, which the render path calls. Keeping the two apart is what
 * lets the vocabulary grow a verb without touching a route, and lets a note
 * written today be re-read through tomorrow's vocabulary: the sentence is
 * stored, not the operation it produced.
 */
import { Router, type IRouter } from "express";
import { randomUUID } from "crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { db, notesTable, projectsTable, transcriptsTable } from "@workspace/db";
import {
  CreateNoteBody,
  DeleteNoteParams,
  ListNotesResponse,
  ProjectNoteParams,
  TranscriptResponse,
  PROJECT_NOTES_LIMIT,
  TRANSCRIPT_WORDS_LIMIT,
} from "@workspace/api-zod";
import type { StoredSegment } from "../lib/notes-store";
import { currentUserId } from "../middlewares/auth";
import { badRequest } from "../lib/bad-request";
import { rateLimit, LIMITS } from "../lib/rate-limit";

const router: IRouter = Router();

/** The project, if it is this person's. 404 either way — see `clips.ts`. */
async function ownedProject(id: string, userId: string) {
  const [project] = await db
    .select({ id: projectsTable.id })
    .from(projectsTable)
    .where(and(eq(projectsTable.id, id), eq(projectsTable.userId, userId)))
    .limit(1);
  return project ?? null;
}

router.get("/projects/:id/notes", async (req, res): Promise<void> => {
  const userId = currentUserId(req);
  const params = ProjectNoteParams.safeParse(req.params);
  if (!params.success) {
    badRequest(res, params.error);
    return;
  }
  if (!(await ownedProject(params.data.id, userId))) {
    res.status(404).json({ error: "Project not found." });
    return;
  }

  const rows = await db
    .select()
    .from(notesTable)
    .where(and(eq(notesTable.projectId, params.data.id), eq(notesTable.userId, userId)))
    // Time order, not creation order: this list is read beside the video, and
    // the only sequence that means anything there is the video's own.
    .orderBy(asc(notesTable.sourceMs))
    .limit(PROJECT_NOTES_LIMIT);

  res.json(
    ListNotesResponse.parse({
      notes: rows.map((row) => ({
        id: row.id,
        sourceMs: row.sourceMs,
        text: row.text,
        createdAt: row.createdAt.toISOString(),
      })),
      limit: PROJECT_NOTES_LIMIT,
    }),
  );
});

router.post("/projects/:id/notes", rateLimit(LIMITS.createProject), async (req, res): Promise<void> => {
  const userId = currentUserId(req);
  const params = ProjectNoteParams.safeParse(req.params);
  if (!params.success) {
    badRequest(res, params.error);
    return;
  }
  const body = CreateNoteBody.safeParse(req.body);
  if (!body.success) {
    badRequest(res, body.error);
    return;
  }
  if (!(await ownedProject(params.data.id, userId))) {
    res.status(404).json({ error: "Project not found." });
    return;
  }

  /*
   * Counted before inserting, and the ceiling is the plan schema's rather than
   * this route's opinion.
   *
   * `removeSilence.protect` holds at most sixty stretches, so a sixty-first
   * "keep this" would be accepted, stored, shown in the list, and then quietly
   * not applied to any render. A refusal somebody can read beats a row that
   * exists and does nothing.
   */
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notesTable)
    .where(and(eq(notesTable.projectId, params.data.id), eq(notesTable.userId, userId)));
  if (Number(n) >= PROJECT_NOTES_LIMIT) {
    res.status(409).json({
      error: `This project already has ${PROJECT_NOTES_LIMIT} notes, which is as many as one edit can carry. Remove one to add another.`,
      limit: PROJECT_NOTES_LIMIT,
    });
    return;
  }

  const now = new Date();
  const row = {
    id: randomUUID(),
    projectId: params.data.id,
    userId,
    sourceMs: body.data.sourceMs,
    text: body.data.text,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(notesTable).values(row);

  res.status(201).json({
    id: row.id,
    sourceMs: row.sourceMs,
    text: row.text,
    createdAt: now.toISOString(),
  });
});

router.delete("/projects/:id/notes/:noteId", async (req, res): Promise<void> => {
  const userId = currentUserId(req);
  const params = DeleteNoteParams.safeParse(req.params);
  if (!params.success) {
    badRequest(res, params.error);
    return;
  }

  // Scoped by user *and* project *and* note: an id guessed from another
  // account removes nothing and gets the same 404 as an id that never was.
  const removed = await db
    .delete(notesTable)
    .where(
      and(
        eq(notesTable.id, params.data.noteId),
        eq(notesTable.projectId, params.data.id),
        eq(notesTable.userId, userId),
      ),
    )
    .returning({ id: notesTable.id });

  if (removed.length === 0) {
    res.status(404).json({ error: "Note not found." });
    return;
  }
  res.status(204).end();
});

/**
 * The words of this project's source, on the source clock.
 *
 * This is the surface a note is placed against. Hiding the timeline does not
 * mean hiding everything — it means replacing it with the thing a person
 * navigating a talking head or a podcast actually looks for, which is what was
 * said. The words are already bought and stored for the edit; this hands back
 * the copy that exists rather than buying another.
 *
 * `available: false` rather than a 404 when nothing has been transcribed yet.
 * A project uploaded a minute ago legitimately has no words, the page has to
 * draw that state, and answering 404 would make "not yet" and "no such
 * project" the same reply.
 */
router.get("/projects/:id/transcript", async (req, res): Promise<void> => {
  const userId = currentUserId(req);
  const params = ProjectNoteParams.safeParse(req.params);
  if (!params.success) {
    badRequest(res, params.error);
    return;
  }
  if (!(await ownedProject(params.data.id, userId))) {
    res.status(404).json({ error: "Project not found." });
    return;
  }

  const [row] = await db
    .select({ segments: transcriptsTable.segments, language: transcriptsTable.language })
    .from(transcriptsTable)
    .where(and(eq(transcriptsTable.projectId, params.data.id), eq(transcriptsTable.userId, userId)))
    .limit(1);

  if (!row?.segments) {
    res.json(TranscriptResponse.parse({ available: false, language: null, words: [], truncated: false }));
    return;
  }

  /*
   * `startMs`/`endMs`/`text` — the worker's own field names, and the same ones
   * `wordsOf` reads for snapping. Milliseconds all the way out, so a word this
   * hands to the page can be posted straight back as a note's `sourceMs`
   * without a conversion anybody could get wrong in one direction only.
   */
  const words: Array<[number, number, string]> = [];
  let truncated = false;
  for (const segment of (row.segments as StoredSegment[]) ?? []) {
    for (const word of segment?.words ?? []) {
      if (typeof word.startMs !== "number" || typeof word.endMs !== "number") continue;
      if (words.length >= TRANSCRIPT_WORDS_LIMIT) {
        truncated = true;
        break;
      }
      words.push([word.startMs, word.endMs, String(word.text ?? "")]);
    }
    if (truncated) break;
  }

  res.json(TranscriptResponse.parse({ available: true, language: row.language ?? null, words, truncated }));
});

export default router;
