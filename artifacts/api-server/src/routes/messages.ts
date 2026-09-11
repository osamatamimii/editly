import { Router, type IRouter } from "express";
import { randomUUID } from "crypto";
import { eq, asc, desc, and } from "drizzle-orm";
import { db, messagesTable, projectsTable, renderFollowupsTable, comprehensionsTable } from "@workspace/db";
import {
  SendMessageBody,
  SendMessageParams,
  ListMessagesParams,
  ListMessagesResponse,
} from "@workspace/api-zod";
import { PROJECT_MESSAGES_LIMIT } from "@workspace/api-zod/limits";
import { serializeMessage, serializeJob } from "../lib/transformers";
import { currentUserId } from "../middlewares/auth";
import { replyFor, becauseIn } from "../lib/plan-from-text";
import { createPlanner } from "../lib/planner";
import { withCaptionFonts, myFaceIds } from "../lib/caption-fonts";
import { withCaptionLook } from "../lib/caption-look";
import { applyHabits, habitsFor } from "../lib/habits";
import { direct, withDirection, type Reading } from "../lib/direct";
import { asksForAnEdit, saysOnlyThis, clockOf } from "../lib/plan-from-text";
import { applyNotes } from "../lib/notes";
import { notesFor, wordsFor } from "../lib/notes-store";
import { plannerAssets } from "../lib/planner-assets";
import { startRenderForProject } from "../lib/start-render";
import { ALREADY_RENDERING } from "../lib/one-active-job";
import { rateLimit, LIMITS } from "../lib/rate-limit";
import { badRequest } from "../lib/bad-request";

const router: IRouter = Router();

/**
 * One planner for the process. It reads the key once at startup, so a
 * deployment either has a model behind it or does not — rather than deciding
 * per request and behaving differently on two identical messages.
 */
const planner = createPlanner();

router.get("/projects/:id/messages", async (req, res): Promise<void> => {
  const userId = currentUserId(req);
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = ListMessagesParams.safeParse({ id: raw });
  if (!params.success) {
    badRequest(res, params.error);
    return;
  }

  /*
    The newest of the conversation, returned oldest-first.

    This had no `LIMIT`, and the obvious way to add one is wrong: `asc` with a
    `limit` keeps the *oldest* messages and drops everything recent, so a long
    conversation would open on its own beginning and the last thing anybody
    said would be missing. So the query takes the newest by `desc` and the
    array is turned back around before it is sent, which leaves the shape the
    client already expects.
  */
  const newest = await db
    .select()
    .from(messagesTable)
    .where(
      and(
        eq(messagesTable.projectId, params.data.id),
        eq(messagesTable.userId, userId),
      ),
    )
    .orderBy(desc(messagesTable.createdAt))
    .limit(PROJECT_MESSAGES_LIMIT);

  res.json(ListMessagesResponse.parse(newest.reverse().map(serializeMessage)));
});

router.post("/projects/:id/messages", rateLimit(LIMITS.chat), async (req, res): Promise<void> => {
  const userId = currentUserId(req);
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = SendMessageParams.safeParse({ id: raw });
  if (!params.success) {
    badRequest(res, params.error);
    return;
  }

  const parsed = SendMessageBody.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, parsed.error);
    return;
  }

  const [project] = await db
    .select()
    .from(projectsTable)
    .where(
      and(
        eq(projectsTable.id, params.data.id),
        eq(projectsTable.userId, userId),
      ),
    );

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  // There is no cap on how many times you can ask for a change.
  //
  // The old one charged for iteration: ten messages per video on the entry
  // plan, then a paywall mid-conversation. But iteration *is* the product —
  // "make the intro punchier", "actually, keep that pause" — and a conversation
  // costs us almost nothing until it becomes a render. The meter is minutes of
  // finished video, and that is checked where the render starts.

  // The reply is derived from a real plan, so it cannot promise an edit the
  // worker has no operation for — whether a model or the keyword matcher chose
  // the operations. See lib/planner.ts.
  // What this project can actually put on screen.
  //
  // Without this the planner has the operations for b-roll and overlays and no
  // way to name a file, so it can never choose them — the library, the upload
  // panel and the stock search would all exist and none of them would ever be
  // reachable from a sentence. Ids and labels only: the planner is never told
  // where a file is.
  const assets = await plannerAssets(params.data.id);

  const intent = await planner.plan(parsed.data.content, {
    defaultPlatform: project.platform as never,
    assets: assets as never,
  });
  if (intent.degraded) req.log?.warn({ reason: intent.degraded }, "planner fell back to keywords");

  // One prompt, and the work starts. The sentence produced a real plan and the
  // project has a video, so the render is started here — the same door the
  // button uses, with the same policy between "asked" and "queued" — rather
  // than answered with an instruction to go press something. The refusals a
  // person can act on (a render already going, the month's minutes spent) come
  // back as words in Noah's reply instead of as an HTTP error nobody sees.
  let render: { started: true } | { started: false; because: string } | undefined;
  let startedJob: ReturnType<typeof serializeJob> | null = null;
  // The chosen faces, applied here for the same reason they are applied on the
  // render route: the plan reaches the queue three ways and the choice belongs
  // to the person, not to whichever of the three made it.
  intent.operations = withCaptionFonts(
    { version: 1, operations: intent.operations },
    parsed.data.fonts,
    await myFaceIds(userId),
  ).operations;
  // And the look picked in the panel, on the same seam and with the same
  // deference: a sentence that named a style keeps it.
  intent.operations = withCaptionLook(
    { version: 1, operations: intent.operations },
    parsed.data.look,
  ).operations;

  /*
    And the things they always ask for, on the sentence where they did not.

    After the font choice, because the picker is a thing they set *now* and a
    habit is a thing they set by repetition; the explicit one wins where both
    have an opinion. Before the render starts, because the whole point is that
    the plan that runs is the one they would have typed.

    Only the subjects the sentence left alone — see `spoke`. And every fill is
    added to `willDo`, so the reply says it happened: a memory that silently
    changes what somebody gets is the failure this codebase is written
    against, and it does not stop being that because the guess was right.
  */
  /*
    And the edit this material wants, underneath whatever they typed.

    This is the half the product never had. The planner is a translator: every
    line of its instructions says "choose this when they ask for it", and not
    one says "this is what a good edit of this material looks like". So the
    ceiling on the output was the customer's vocabulary — somebody who knew to
    type four operations got four, and somebody who typed "make this good" got
    nothing at all and was told so politely.

    `direct` reads what the material is — how long, what shape, whether anybody
    speaks, where the reading says attention is held — and builds the plan a
    competent editor would apply unasked. What they typed sits on top of it and
    always wins: `direct` skips every subject the sentence spoke about, and
    `withDirection` enforces it again.

    Before `applyHabits`, so a habit can still fill in the style of a caption
    the direction added. And every decision it makes is pushed into `willDo`,
    because a twelve-operation edit that arrives unannounced is a product doing
    things to somebody's video for reasons they cannot see.
  */
  /*
    And the gate on it, because the direction starts a render.

    The old planner produced nothing for a sentence it did not recognise, so a
    message that was not a request cost nothing. A direction that runs on every
    message would spend somebody's minutes because they said hello. So it runs
    when the sentence produced an operation — they asked for something and this
    is the rest of the edit around it — or when it asked for an edit without
    naming one, which is the sentence the old planner could not hear at all.
  */
  const wantsAnEdit = intent.operations.length > 0 || asksForAnEdit(parsed.data.content);
  const reading = wantsAnEdit ? await readingFor(params.data.id, userId) : null;
  const decided = wantsAnEdit
    ? direct({
        platform: (project.platform as never) ?? null,
        sourceSeconds: project.duration ?? null,
        /*
          Speech is what captions, silence and tightening all rest on — and
          this used to be `reading !== null`, which closed a loop that could
          not open.

          A reading exists only after a transcript. A transcript is bought only
          when the plan asks for captions, a highlight, clips or chosen
          punches. And the direction asked for none of those without a reading.
          So the first "make it nice" on a new project produced
          `formatForPlatform + normalizeLoudness + fade`, no transcript was
          bought, no reading was written, and the second message produced the
          same three operations. And the tenth. **The product never improved on
          its own material, ever**, and nothing anywhere failed: three
          operations is a valid edit and every note about it was true.

          So the question changes. This API has no ears — it never opens the
          file — and "have we already heard speech" is not the same question as
          "could there be any". The honest answer to the second, on a video
          somebody uploaded in order to have it edited, is yes. A reading, when
          one exists, is proof of it rather than the source of it.

          What makes the optimism safe is that the worker *does* have ears and
          answers properly: `enrich.ts` listens for a second before it buys a
          transcript, and a clip with nothing on its sound track loses the
          speech-dependent operations with a sentence saying why. So the cost
          of being wrong is three honest notes, and the cost of the old
          certainty was a product that could not get better.
        */
        hasSpeech: true,
        reading,
        assets: assets as never,
        habits: await habitsFor(userId),
        spokenTypes: new Set(intent.operations.map((op) => op.type)),
        spoke: intent.spoke,
        onlyWhatWasAsked: saysOnlyThis(parsed.data.content),
      })
    : { operations: [], willDo: [] };
  if (decided.operations.length > 0) {
    intent.operations = withDirection(intent.operations, decided.operations);
    for (const said of decided.willDo) intent.willDo.push(said);
  }

  if (intent.operations.length > 0) {
    const { operations, applied } = applyHabits(
      intent.operations,
      await habitsFor(userId),
      intent.spoke,
    );
    intent.operations = operations;
    for (const fill of applied) intent.willDo.push({ en: fill.en, ar: fill.ar });
  }

  /*
   * The notes, last, and last is the point.
   *
   * Everything above this builds the *base*: the sentence, then what the
   * product decided on top of it, then what this person usually chooses. All
   * three are regenerated from scratch every time somebody types, and all
   * three are thrown away on the next message.
   *
   * The notes are not. They are rows pinned to moments of the source, and they
   * come after so that a new prompt can never destroy one — which is the
   * failure that makes people stop trusting an editor. A note narrows what the
   * base decided rather than replacing it: "cut the silences" and "leave this
   * pause" compose into cut-everywhere-except-here, and the field they compose
   * in already existed.
   */
  if (intent.operations.length > 0) {
    const pinned = await notesFor(project.id, userId);
    if (pinned.length > 0) {
      const { operations, applied, unread } = applyNotes(intent.operations, pinned, await wordsFor(project.id, userId));
      intent.operations = operations;
      if (applied.length > 0) {
        const kept = applied.filter((a) => a.verb === "keep").length;
        const pushed = applied.filter((a) => a.verb === "punch").length;
        if (kept > 0) {
          intent.willDo.push(
            kept === 1
              ? { en: "keep the moment you marked, whatever else gets cut", ar: "أُبقي اللحظة التي علّمتها، مهما قُصّ غيرها" }
              : { en: `keep the ${kept} moments you marked, whatever else gets cut`, ar: `أُبقي ${kept} لحظات علّمتها، مهما قُصّ غيرها` },
          );
        }
        if (pushed > 0) {
          intent.willDo.push(
            pushed === 1
              ? { en: "push in where you marked", ar: "أقرّب حيث علّمت" }
              : { en: `push in at the ${pushed} moments you marked`, ar: `أقرّب عند ${pushed} لحظات علّمتها` },
          );
        }
      }
      /* Said out loud rather than dropped. A note this layer has no verb for is
         a person who wrote something and was ignored, and the one thing worse
         than not understanding is not saying so. */
      for (const note of unread) {
        intent.willDo.push({
          en: `I have kept your note at ${clockOf(note.sourceMs / 1000)} but I cannot act on it yet`,
          ar: `احتفظتُ بملاحظتك عند ${clockOf(note.sourceMs / 1000)} لكنني لا أستطيع تنفيذها بعد`,
        });
      }
    }
  }
  if (intent.operations.length > 0 && project.videoPath) {
    // The render's notes come back in the language the sentence was written
    // in. `intent.language` is read from what they typed, not from what the
    // model chose to answer in, so the whole exchange — reply now, notes when
    // it finishes — stays in one language.
    const outcome = await startRenderForProject(
      userId,
      project,
      intent.operations,
      req.log,
      intent.language,
    );
    if (outcome.ok) {
      render = { started: true };
      startedJob = serializeJob(outcome.job);
    } else {
      const busy = outcome.status === 409 && outcome.body["error"] === ALREADY_RENDERING;
      /*
        In the language of the sentence that asked, like everything else on
        this path.

        The busy case keeps its own wording because it is the only refusal that
        is also a promise — the follow-up row below is what keeps it — and the
        policy's bare "a render is already going" does not say that. Every
        other refusal is written by `becauseIn` from the numbers the policy
        attached, so nothing here translates an English sentence.
      */
      const because = busy
        ? intent.language === "ar"
          ? "في تصيير يعمل الآن على هذا المشروع، وسأضمّ هذا إليه حالما ينتهي."
          : "there's a render already going for this project. I'll fold this in once it finishes."
        : becauseIn(intent.language, outcome.body);
      render = { started: false, because };

      // "I'll fold this in" is a promise, and this row is what keeps it. One
      // per project, newest sentence wins: the planner turns each message into
      // the person's whole current wish, so a later wish replaces an earlier
      // one rather than queuing a render they already superseded. Consumed by
      // the render-status poll the moment the active render settles.
      if (busy) {
        await db
          .insert(renderFollowupsTable)
          .values({ projectId: params.data.id, userId, operations: intent.operations })
          .onConflictDoUpdate({
            target: renderFollowupsTable.projectId,
            set: { userId, operations: intent.operations, createdAt: new Date() },
          });
      }
    }
  }

  const aiContent = replyFor(intent, { hasVideo: Boolean(project.videoPath), render });

  const [userMessage] = await db
    .insert(messagesTable)
    .values({
      id: randomUUID(),
      userId,
      projectId: params.data.id,
      role: "user",
      content: parsed.data.content,
    })
    .returning();

  const [aiMessage] = await db
    .insert(messagesTable)
    .values({
      id: randomUUID(),
      userId,
      projectId: params.data.id,
      role: "assistant",
      content: aiContent,
    })
    .returning();

  res.status(201).json({
    userMessage: serializeMessage(userMessage),
    aiMessage: serializeMessage(aiMessage),
    // The editor renders exactly this, so what gets built is what was promised.
    plan: intent.operations.length > 0 ? { version: 1, operations: intent.operations } : null,
    // The render this message started, when it started one — so the editor can
    // show the progress it just caused instead of waiting to be told.
    render: startedJob,
  });
});

export default router;

/**
 * The project's reading of its own material, narrowed to the timings.
 *
 * Only the shapes `direct` is allowed to decide from — the peaks and the hook —
 * and deliberately not the chapter titles or the claims: a decision made from a
 * model's prose is a different and much less defensible thing to build an edit
 * out of than a decision made from where attention was measured.
 *
 * Null on every failure, including a missing table. The comprehension step is
 * best-effort in the worker and this is the same position on the other side: a
 * project with no reading gets a smaller direction, not an error. That is not
 * hypothetical — migration 0038 was written before it was applied, and for a
 * while the table did not exist in production at all.
 */
async function readingFor(projectId: string, userId: string): Promise<Reading | null> {
  try {
    const [row] = await db
      .select({
        how: comprehensionsTable.how,
        peaks: comprehensionsTable.peaks,
        hook: comprehensionsTable.hook,
        chapters: comprehensionsTable.chapters,
      })
      .from(comprehensionsTable)
      .where(and(eq(comprehensionsTable.projectId, projectId), eq(comprehensionsTable.userId, userId)))
      .limit(1);
    if (!row) return null;
    return {
      peaks: (row.peaks ?? [])
        .filter((p) => typeof p?.start === "number" && typeof p?.strength === "number")
        .map((p) => ({ start: p.start, strength: p.strength })),
      hook: row.hook && typeof row.hook.at === "number" ? { at: row.hook.at } : null,
      chapters: (row.chapters ?? []).length,
      how: row.how === "model" ? "model" : "structure",
    };
  } catch {
    return null;
  }
}
