import { Router, type IRouter } from "express";
import { randomUUID } from "crypto";
import { eq, desc, and } from "drizzle-orm";
import { db, exportsTable, projectsTable } from "@workspace/db";
import {
  StartExportBody,
  StartExportParams,
  GetExportStatusParams,
  GetExportStatusResponse,
} from "@workspace/api-zod";
import { serializeExport } from "../lib/transformers";
import { currentUserId } from "../middlewares/auth";

const router: IRouter = Router();

const EXPORT_STEPS = [
  { label: "Analyzing video", status: "done" },
  { label: "Applying edits", status: "done" },
  { label: "Generating captions", status: "done" },
  { label: "Formatting for platform", status: "done" },
  { label: "Finalizing export", status: "done" },
];

router.post("/projects/:id/export", async (req, res): Promise<void> => {
  const userId = currentUserId(req);
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = StartExportParams.safeParse({ id: raw });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = StartExportBody.safeParse(req.body);
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

  const initialSteps = EXPORT_STEPS.map((s, i) => ({
    label: s.label,
    status: i === 0 ? "active" : "pending",
  }));

  const [exportJob] = await db
    .insert(exportsTable)
    .values({
      id: randomUUID(),
      userId,
      projectId: params.data.id,
      status: "processing",
      platform: parsed.data.platform,
      steps: initialSteps,
    })
    .returning();

  // Processing is finalized lazily by the status endpoint ~5s after creation.
  // (A setTimeout would not survive in serverless environments like Vercel.)

  res.status(202).json(GetExportStatusResponse.parse(serializeExport(exportJob)));
});

router.get("/projects/:id/export/status", async (req, res): Promise<void> => {
  const userId = currentUserId(req);
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetExportStatusParams.safeParse({ id: raw });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  let [exportJob] = await db
    .select()
    .from(exportsTable)
    .where(
      and(
        eq(exportsTable.projectId, params.data.id),
        eq(exportsTable.userId, userId),
      ),
    )
    .orderBy(desc(exportsTable.createdAt))
    .limit(1);

  if (!exportJob) {
    res.status(404).json({ error: "No export found for this project" });
    return;
  }

  // Lazily finalize simulated processing ~5 seconds after the job started.
  const PROCESSING_DURATION_MS = 5000;
  if (
    exportJob.status === "processing" &&
    Date.now() - new Date(exportJob.createdAt).getTime() >= PROCESSING_DURATION_MS
  ) {
    const [project] = await db
      .select()
      .from(projectsTable)
      .where(
        and(
          eq(projectsTable.id, params.data.id),
          eq(projectsTable.userId, userId),
        ),
      );

    const [updated] = await db
      .update(exportsTable)
      .set({
        status: "done",
        downloadUrl: project?.videoUrl || "https://example.com/edited-video.mp4",
        steps: EXPORT_STEPS,
      })
      .where(
        and(
          eq(exportsTable.id, exportJob.id),
          eq(exportsTable.userId, userId),
        ),
      )
      .returning();

    await db
      .update(projectsTable)
      .set({ status: "done", platform: exportJob.platform })
      .where(
        and(
          eq(projectsTable.id, params.data.id),
          eq(projectsTable.userId, userId),
        ),
      );

    if (updated) exportJob = updated;
  }

  res.json(GetExportStatusResponse.parse(serializeExport(exportJob)));
});

export default router;
