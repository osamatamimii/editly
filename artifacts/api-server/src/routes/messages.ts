import { Router, type IRouter } from "express";
import { randomUUID } from "crypto";
import { eq, asc, count, and } from "drizzle-orm";
import { db, messagesTable, projectsTable, subscriptionsTable } from "@workspace/db";
import {
  SendMessageBody,
  SendMessageParams,
  ListMessagesParams,
  ListMessagesResponse,
} from "@workspace/api-zod";
import { serializeMessage } from "../lib/transformers";
import { PLAN_LIMITS, isPlanKey } from "../lib/plan-limits";
import { currentUserId } from "../middlewares/auth";
import { replyFor } from "../lib/plan-from-text";
import { createPlanner } from "../lib/planner";

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

router.post("/projects/:id/messages", async (req, res): Promise<void> => {
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

  const [sub] = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.userId, userId))
    .limit(1);

  const planKey = sub && isPlanKey(sub.plan) ? sub.plan : "starter";
  const limits = PLAN_LIMITS[planKey];

  if (limits.editsPerVideo !== null) {
    const [{ value: userEdits }] = await db
      .select({ value: count() })
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.projectId, params.data.id),
          eq(messagesTable.userId, userId),
          eq(messagesTable.role, "user"),
        ),
      );

    if (userEdits >= limits.editsPerVideo) {
      res.status(429).json({
        error: `You've reached your ${planKey} plan limit of ${limits.editsPerVideo} edits per video. Upgrade for more edits.`,
        limitReached: true,
        plan: planKey,
      });
      return;
    }
  }

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
