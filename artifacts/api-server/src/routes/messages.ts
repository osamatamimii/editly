import { Router, type IRouter } from "express";
import { randomUUID } from "crypto";
import { eq, asc, and, desc } from "drizzle-orm";
import { db, messagesTable, projectsTable, assetsTable, renderFollowupsTable } from "@workspace/db";
import {
  SendMessageBody,
  SendMessageParams,
  ListMessagesParams,
  ListMessagesResponse,
} from "@workspace/api-zod";
import { serializeMessage, serializeJob } from "../lib/transformers";
import { currentUserId } from "../middlewares/auth";
import { replyFor } from "../lib/plan-from-text";
import { createPlanner } from "../lib/planner";
import { startRenderForProject } from "../lib/start-render";
import { ALREADY_RENDERING } from "../lib/one-active-job";
import { rateLimit, LIMITS } from "../lib/rate-limit";

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
    res.status(400).json({ error: params.error.message });
    return;
  }

  const messages = await db
    .select()
    .from(messagesTable)
    .where(
      and(
        eq(messagesTable.projectId, params.data.id),
        eq(messagesTable.userId, userId),
      ),
    )
    .orderBy(asc(messagesTable.createdAt));

  res.json(ListMessagesResponse.parse(messages.map(serializeMessage)));
});

router.post("/projects/:id/messages", rateLimit(LIMITS.chat), async (req, res): Promise<void> => {
  const userId = currentUserId(req);
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = SendMessageParams.safeParse({ id: raw });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = SendMessageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
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
  const assets = await db
    .select({ id: assetsTable.id, kind: assetsTable.kind, label: assetsTable.label })
    .from(assetsTable)
    .where(eq(assetsTable.projectId, params.data.id))
    .orderBy(desc(assetsTable.createdAt))
    .limit(40);

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
      const because = busy
        ? "there's a render already going for this project — I'll fold this in once it finishes."
        : String(outcome.body["error"] ?? "the render could not be started.");
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
