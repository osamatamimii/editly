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
import { and, asc, count, eq, gte, inArray, sql } from "drizzle-orm";
import { db, notesTable, jobsTable, projectsTable, subscriptionsTable, transcriptsTable } from "@workspace/db";
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
import { servedPlan } from "../lib/plan-limits";

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
/**
 * How many videos a free account may have read to it in a day.
 *
 * Transcription is the only thing in this product that spends real money
 * without producing a file, so it is the one thing the meter cannot bound: the
 * meter charges for video that exists, and this makes none. Without some
 * ceiling a free account can upload podcasts and have them read, for ever, at
 * about nine tenths of a cent a source minute.
 *
 * A count of videos rather than of minutes, because the upload ceiling already
 * bounds how long any one of them is, and because a number somebody can hold
 * in their head is the kind of limit that can be explained in a sentence.
 * Three is more than a trial needs and far less than a business runs on.
 *
 * Paying accounts have no ceiling here at all. They are already bounded by
 * what they can upload, and a subscriber who opens a panel to read their own
 * video should not meet a limit at all.
 */
const FREE_LISTENS_PER_DAY = 3;

/**
 * Ask for the words, which is what the panel does when it finds none.
 *
 * The panel has always told a person that "the transcription follows the
 * upload by a minute or two, and this panel fills in on its own the moment it
 * is ready". Nothing in this repository was trying to keep that: `transcripts`
 * is written only as a side effect of a render whose plan needed the words, so
 * a video nobody has captioned has none, and the panel spun in front of a
 * promise for as long as the feature has existed.
 *
 * The worker's own reason for not simply transcribing everything is the right
 * one — "paying a speech model on its behalf so that a *later* request might
 * be better planned would be charging somebody for a feature they did not ask
 * for" — and it is an argument for *asking*, not for the silence we had.
 * Opening the panel is the asking, so this is the door it knocks on.
 *
 * Every answer is a 200 with a state rather than an error, because none of
 * these is a failure: already read, being read now, nothing to read from.
 * The panel polls the transcript itself and shows what is happening; a 409
 * here would make it invent an apology for a video that is simply still being
 * listened to.
 */
router.post("/projects/:id/transcript", rateLimit(LIMITS.write), async (req, res): Promise<void> => {
  const userId = currentUserId(req);
  const params = ProjectNoteParams.safeParse(req.params);
  if (!params.success) {
    badRequest(res, params.error);
    return;
  }
  const projectId = params.data.id;

  const [project] = await db
    .select({ id: projectsTable.id, videoPath: projectsTable.videoPath })
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), eq(projectsTable.userId, userId)))
    .limit(1);
  if (!project) {
    res.status(404).json({ error: "Project not found." });
    return;
  }

  // Already bought. Said before anything else, because the panel asks on every
  // open and the common answer after the first time is this one.
  const [existing] = await db
    .select({ projectId: transcriptsTable.projectId })
    .from(transcriptsTable)
    .where(and(eq(transcriptsTable.projectId, projectId), eq(transcriptsTable.userId, userId)))
    .limit(1);
  if (existing) {
    res.json({ status: "ready" });
    return;
  }

  if (!project.videoPath) {
    res.json({ status: "no-source" });
    return;
  }

  /*
    Anything already working on this project, of either kind.

    `jobs_one_active_per_project` allows exactly one, so a second insert would
    be refused by the index rather than by a sentence — and it would be refused
    for a render, too, which is the case that matters: somebody opening the
    panel while their edit is in the queue must not be able to push the edit
    out of the way. A render that needs the words writes them anyway, and the
    panel is polling, so waiting here costs nothing and is usually free.
  */
  /*
    A listen already working, and only a listen.

    This asked whether *anything* was in flight, so a running render answered
    yes and no transcript was ever queued. The panel then waited for words
    nobody was fetching -- which is the exact failure this whole route was
    written to end, arriving again through the door that was supposed to have
    closed it.
  */
  const [working] = await db
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(
      and(
        eq(jobsTable.projectId, projectId),
        eq(jobsTable.userId, userId),
        eq(jobsTable.kind, "transcribe"),
        inArray(jobsTable.status, ["queued", "running"]),
      ),
    )
    .limit(1);
  if (working) {
    res.json({ status: "working" });
    return;
  }

  /*
    The free plan's daily ceiling, counted in videos read today.

    Only the free plan meets this. A subscriber reading their own video is
    doing the thing they pay for, and the upload ceiling already bounds how
    much any one of them can be.
  */
  const [subscription] = await db
    .select({ plan: subscriptionsTable.plan, planExpiresAt: subscriptionsTable.planExpiresAt })
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.userId, userId))
    .limit(1);
  if (servedPlan(subscription) === "free") {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [today] = await db
      .select({ used: count() })
      .from(jobsTable)
      .where(
        and(
          eq(jobsTable.userId, userId),
          eq(jobsTable.kind, "transcribe"),
          gte(jobsTable.createdAt, since),
        ),
      );
    if (Number(today?.used ?? 0) >= FREE_LISTENS_PER_DAY) {
      res.json({ status: "enough-for-today", limit: FREE_LISTENS_PER_DAY });
      return;
    }
  }

  try {
    await db.insert(jobsTable).values({
      id: randomUUID(),
      userId,
      projectId,
      kind: "transcribe",
      status: "queued",
      // Nothing to plan. The column is `notNull` because every render has one,
      // and a nullable plan would make every reader of a plan check for a
      // state only one kind can be in.
      plan: {},
      inputPath: project.videoPath,
      // Whichever language this person is reading the product in, so the
      // provider's own notes come back in it. Not a claim about the audio.
      language: req.get("accept-language")?.toLowerCase().startsWith("ar") ? "ar" : "en",
    });
  } catch {
    /*
      The index got there first: something was queued between the check above
      and this insert. That is the same answer as finding it there, and it is
      not a failure — one of the two is going to read this video.
    */
    res.json({ status: "working" });
    return;
  }

  res.status(202).json({ status: "queued" });
});

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
