/**
 * Starting a render, as a thing two doors open onto.
 *
 * This logic lived inside `POST /projects/:id/render`, and the button was the
 * only way in. Then the owner set the bar where it belongs: one prompt, and
 * the work starts by itself. That means the chat has to be able to start a
 * render too — and the moment two routes can start one, the policy between
 * "asked" and "queued" has to live in exactly one place, because the browser
 * has no vote in any of it: the month's allowance, the watermark, the one-
 * render-at-a-time rule are all decided here, whichever door was used.
 *
 * The shape of the answer is deliberately HTTP-flavoured (`status`/`body`)
 * even though the chat door does not return it as a response. The statuses
 * are the vocabulary the policy layer already speaks — 402 for allowance,
 * 409 for an active render — and inventing a second vocabulary for the same
 * refusals is how two doors drift apart.
 */
import { randomUUID } from "crypto";
import { eq, and, desc, inArray } from "drizzle-orm";
import { db, projectsTable, jobsTable, subscriptionsTable, renderFollowupsTable } from "@workspace/db";
import type { EditOperation } from "@workspace/api-zod";
import { evenlySpacedPunches } from "./templates";
import { planKeyFrom } from "./plan-limits";
import { usageFor } from "./usage";
import { decideRender } from "./render-policy";
import { isDuplicateActiveJob, ALREADY_RENDERING } from "./one-active-job";

type ProjectRow = typeof projectsTable.$inferSelect;
type JobRow = typeof jobsTable.$inferSelect;

export type StartRenderOutcome =
  | { ok: true; job: JobRow }
  | { ok: false; status: number; body: Record<string, unknown> };

export async function startRenderForProject(
  userId: string,
  project: ProjectRow,
  requestedOperations: EditOperation[],
  log?: { info: (obj: unknown, msg: string) => void },
  /**
   * Which language the render's notes come back in.
   *
   * Passed by the caller that has the sentence — the messages route — because
   * this module never sees it. The two render routes are buttons, not
   * sentences, so they leave it unset and the notes stay English, which is
   * what a button in an English interface should give.
   */
  language: "en" | "ar" = "en",
): Promise<StartRenderOutcome> {
  // Read before anything else is judged, because suspension is the more
  // fundamental fact about this request than anything about the project. An
  // account that has been stopped and is told "upload a video first" will
  // upload a video, and be stopped anyway — which is a worse experience than
  // being told the truth immediately, and a worse log for us to read later.
  const [sub] = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.userId, userId))
    .limit(1);

  // 403 rather than 402: this is not about running out of minutes, and
  // offering more would be a lie. The message says what happened and that
  // nothing was deleted, because that is the first thing anybody seeing it
  // will fear.
  if (sub?.suspendedAt) {
    return {
      ok: false,
      status: 403,
      body: {
        error:
          "This account is suspended, so new renders cannot start. Nothing has been deleted — your projects and videos are all still here.",
      },
    };
  }

  if (!project.videoPath) {
    return { ok: false, status: 409, body: { error: "Upload a video before rendering." } };
  }

  // One render at a time per project: a second one would race the first for
  // the same output key, and the user has no way to tell which result they got.
  const [pending] = await db
    .select()
    .from(jobsTable)
    .where(and(eq(jobsTable.projectId, project.id), eq(jobsTable.userId, userId)))
    .orderBy(desc(jobsTable.createdAt))
    .limit(1);

  if (pending && (pending.status === "queued" || pending.status === "running")) {
    return { ok: false, status: 409, body: { error: ALREADY_RENDERING, jobId: pending.id } };
  }

  // A plan can arrive with punch timestamps left empty — the chat knows you
  // want emphasis but not where the interesting moments are. Space them out
  // over whatever the clip actually is.
  const requested = requestedOperations.map((op) =>
    op.type === "zoomPunch" && op.at.length === 0
      ? { ...op, at: evenlySpacedPunches(project.duration ?? null, 4) }
      : op,
  );

  // Everything above this line is what the caller *asked for*. Everything
  // below is what the plan they pay for actually allows.
  const planKey = planKeyFrom(sub?.plan);
  const decision = decideRender({
    plan: planKey,
    usage: await usageFor(userId, planKey),
    sourceDurationSeconds: project.duration,
    operations: requested,
  });

  if (!decision.allowed) {
    return { ok: false, status: decision.status, body: decision.body };
  }

  if (decision.corrections.length) {
    log?.info({ userId, plan: planKey, corrections: decision.corrections }, "render plan corrected by policy");
  }

  const plan = { version: 1 as const, operations: decision.operations };

  // The SELECT above is the friendly check; this is the one that holds.
  // Between the two there is a window in which a second request also sees
  // "nothing pending", and what it costs is the customer's month — two
  // encodes of one clip, both billed, one of them invisible.
  let job: JobRow;
  try {
    [job] = await db
      .insert(jobsTable)
      .values({
        id: randomUUID(),
        userId,
        projectId: project.id,
        status: "queued",
        plan,
        inputPath: project.videoPath,
        // Snapshotted so that changing or clearing the reference while this
        // sits in the queue cannot quietly alter a render already accepted.
        referencePath: project.referenceVideoPath ?? null,
        // Snapshotted for the same reason, one line up: a render already
        // accepted must not change language because the next thing they typed
        // was in the other one.
        language,
        // The worker re-checks this against the file it actually downloads.
        maxSourceSeconds: decision.maxSourceSeconds,
        remainingSeconds: decision.remainingSeconds,
        priority: decision.priority,
      })
      .returning();
  } catch (error) {
    if (!isDuplicateActiveJob(error)) throw error;
    const [existing] = await db
      .select({ id: jobsTable.id })
      .from(jobsTable)
      .where(
        and(
          eq(jobsTable.projectId, project.id),
          eq(jobsTable.userId, userId),
          inArray(jobsTable.status, ["queued", "running"]),
        ),
      )
      .limit(1);
    return { ok: false, status: 409, body: { error: ALREADY_RENDERING, ...(existing ? { jobId: existing.id } : {}) } };
  }

  await db
    .update(projectsTable)
    .set({ status: "processing" })
    .where(and(eq(projectsTable.id, project.id), eq(projectsTable.userId, userId)));

  // A render that just started is the freshest thing the person asked for. A
  // follow-up still waiting from an earlier busy moment is by definition an
  // older wish — running it after this one would apply a superseded request
  // on top of the one they just made.
  await db
    .delete(renderFollowupsTable)
    .where(and(eq(renderFollowupsTable.projectId, project.id), eq(renderFollowupsTable.userId, userId)));

  return { ok: true, job };
}
