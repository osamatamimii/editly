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

const router: IRouter = Router();

const AI_RESPONSES: Record<string, string> = {
  caption: "Got you. I'll drop in bold captions, synced word-by-word. Keeps people watching even without sound.",
  hook: "Smart move. I'll punch up the first two seconds — fast zoom, text hit, something that stops the scroll immediately.",
  tiktok: "On it. I'll flip it to vertical, tighten the cuts, and give it that fast-paced TikTok energy. Should perform well.",
  fast: "I'll cut the boring parts and make it way tighter. Jump cuts, no dead air — it'll move.",
  silence: "Easy. I'll strip out all the silences and low-energy bits. You'll only keep the parts that actually land.",
  zoom: "I'll throw in some dynamic zooms at the right moments. Makes it feel a lot more intense.",
  emoji: "I'll sprinkle in some emojis where they make sense. Keeps things light and boosts engagement.",
  reels: "I'll format this for Reels — 9:16, clean transitions, trimmed to the sweet spot. Should look native in the feed.",
  shorts: "On it. I'll shape this up for Shorts — vertical, strong open, snappy pacing throughout.",
  boring: "I'll go through it and cut anything that drags. You'll end up with just the good stuff.",
  default: "Got it. Let me take a look and get those edits applied. Hit Generate Edit when you're ready to go.",
};

function generateAIResponse(userMessage: string): string {
  const msg = userMessage.toLowerCase();
  if (msg.includes("caption")) return AI_RESPONSES.caption;
  if (msg.includes("hook")) return AI_RESPONSES.hook;
  if (msg.includes("tiktok")) return AI_RESPONSES.tiktok;
  if (msg.includes("fast") || msg.includes("pace") || msg.includes("jump")) return AI_RESPONSES.fast;
  if (msg.includes("silence") || msg.includes("silent") || msg.includes("trim")) return AI_RESPONSES.silence;
  if (msg.includes("zoom")) return AI_RESPONSES.zoom;
  if (msg.includes("emoji")) return AI_RESPONSES.emoji;
  if (msg.includes("reels") || msg.includes("instagram")) return AI_RESPONSES.reels;
  if (msg.includes("shorts") || msg.includes("youtube")) return AI_RESPONSES.shorts;
  if (msg.includes("boring") || msg.includes("highlight")) return AI_RESPONSES.boring;
  return AI_RESPONSES.default;
}

router.get("/projects/:id/messages", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = ListMessagesParams.safeParse({ id: raw });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const messages = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.projectId, params.data.id))
    .orderBy(asc(messagesTable.createdAt));

  res.json(ListMessagesResponse.parse(messages.map(serializeMessage)));
});

router.post("/projects/:id/messages", async (req, res): Promise<void> => {
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
    .where(eq(projectsTable.id, params.data.id));

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const [sub] = await db.select().from(subscriptionsTable).limit(1);
  const planKey = sub && isPlanKey(sub.plan) ? sub.plan : "starter";
  const limits = PLAN_LIMITS[planKey];

  if (limits.editsPerVideo !== null) {
    const [{ value: userEdits }] = await db
      .select({ value: count() })
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.projectId, params.data.id),
          eq(messagesTable.role, "user")
        )
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

  const userMsgId = randomUUID();
  const aiMsgId = randomUUID();
  const aiContent = generateAIResponse(parsed.data.content);

  const [userMessage] = await db
    .insert(messagesTable)
    .values({
      id: userMsgId,
      projectId: params.data.id,
      role: "user",
      content: parsed.data.content,
    })
    .returning();

  const [aiMessage] = await db
    .insert(messagesTable)
    .values({
      id: aiMsgId,
      projectId: params.data.id,
      role: "assistant",
      content: aiContent,
    })
    .returning();

  res.status(201).json({
    userMessage: serializeMessage(userMessage),
    aiMessage: serializeMessage(aiMessage),
  });
});

export default router;
