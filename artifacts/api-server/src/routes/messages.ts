import { Router, type IRouter } from "express";
import { randomUUID } from "crypto";
import { eq, asc, and } from "drizzle-orm";
import { db, messagesTable, projectsTable } from "@workspace/db";
import {
  SendMessageBody,
  SendMessageParams,
  ListMessagesParams,
  ListMessagesResponse,
} from "@workspace/api-zod";
import { serializeMessage } from "../lib/transformers";
import { currentUserId } from "../middlewares/auth";
import { replyFor } from "../lib/plan-from-text";
import { createPlanner } from "../lib/planner";
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
  const intent = await planner.plan(parsed.data.content, { defaultPlatform: project.platform as never });
  const aiContent = replyFor(intent, { hasVideo: Boolean(project.videoPath) });
  if (intent.degraded) req.log?.warn({ reason: intent.degraded }, "planner fell back to keywords");

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
  });
});

export default router;
