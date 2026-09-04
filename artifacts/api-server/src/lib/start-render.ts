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
import { eq, and, desc, inArray, sql } from "drizzle-orm";
import { db, projectsTable, jobsTable, subscriptionsTable, renderFollowupsTable } from "@workspace/db";
import type { EditOperation } from "@workspace/api-zod";
import { evenlySpacedPunches } from "./templates";
import { planKeyFrom, referenceForPlan } from "./plan-limits";
import { usageFor, usageNotConsulted } from "./usage";
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

  // The refusal itself lives in `decideRender` now, beside the mark, the meter
  // and the upload ceiling — for the reason written there: this door had it and
  // the Export door did not, so a suspended account could still render by
  // pressing the other button.
  //
  // What stays here is the *ordering*. Suspension is judged before the project
  // is, because an account that has been stopped and is told "upload a video
  // first" will upload a video and be stopped anyway.
  if (sub?.suspendedAt) {
    const stopped = decideRender({
      plan: planKeyFrom(sub.plan),
      usage: usageNotConsulted(),
      operations: [],
      suspendedAt: sub.suspendedAt,
    });
    if (!stopped.allowed) return { ok: false, status: stopped.status, body: stopped.body };
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

  /**
   * A plan can arrive with punch timestamps left empty — the chat knows you
   * want emphasis but not where the interesting moments are. Space them out
   * over whatever the clip actually is.
   *
   * **Only for emphasis punches.** An empty list means two entirely different
   * things depending on what the punch is following, and until this line said
   * so it meant the wrong one. A beat punch is empty *because the beats are a
   * fact about the audio* — the worker decodes the track, finds the grid and
   * fills them in, and it does that only when it is handed an empty list.
   * Spacing them out here filled the list before the worker ever saw it, so
   * the beat detector never ran on a single real render: every "cut to the
   * beat" landed on four evenly spaced arithmetic moments instead, which look
   * completely deliberate and are on nothing at all. Exactly the failure the
   * detector itself was written to refuse, reintroduced one layer up.
   */
  const requested = requestedOperations.map((op) =>
    op.type === "zoomPunch" && op.on !== "beat" && op.at.length === 0
      ? { ...op, at: evenlySpacedPunches(project.duration ?? null, 4) }
      : op,
  );

  // Everything above this line is what the caller *asked for*. Everything
  // below is what the plan they pay for actually allows.
  const planKey = planKeyFrom(sub?.plan);

  /*
    The allowance is read and spent inside one lock on this person.

    `usageFor` subtracts work in flight, so the arithmetic was right; the
    ordering was not. Reading the meter and inserting the job were two separate
    statements on two separate connections, and between them is a window in
    which another request reads the same meter. The per-project unique index
    does not help — it is per *project*, and this is the account.

    Measured on the real server against Postgres: five simultaneous
    `POST /render` on five projects of a free account with 300 seconds left
    produced **four accepted jobs, each carrying `remaining_seconds = 300`** —
    twenty minutes of encoding authorised against a five-minute plan. Nothing
    failed. Each job was individually correct, each row was individually
    defensible, and the meter only discovered it afterwards, on renders already
    produced and already paid for in machine time.

    An advisory lock rather than `SELECT … FOR UPDATE` because there is no one
    row to lock: the quantity being reserved is a sum over the person's jobs
    and grants, and there is no "account balance" row to hold. The lock is
    taken on the user id and released when the transaction ends, either way.
    It serialises one person's render starts against each other and nobody
    else's — two customers pressing the button in the same millisecond never
    meet.

    `hashtextextended` because advisory locks are keyed by bigint and the user
    id is a uuid. A collision between two users costs one of them a few
    milliseconds of waiting, which is why a hash is acceptable here and would
    not be if this were a correctness boundary between accounts.
  */
  /**
   * What the reservation came back with: a job, or a refusal to pass on.
   *
   * Modelled as a value rather than thrown, because a refusal here is an
   * ordinary answer — "you have no minutes left" is not an error, and throwing
   * it would roll back a transaction that has nothing to roll back.
   */
  type Reserved =
    | { accepted: true; job: JobRow; corrections: readonly string[] }
    | { accepted: false; status: number; body: Record<string, unknown> };

  let reserved: Reserved;
  try {
    reserved = await db.transaction(async (tx): Promise<Reserved> => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);

      const decision = decideRender({
        plan: planKey,
        // Read through `tx`, so the meter is read inside the lock rather than
        // beside it. This is the line the whole transaction exists for.
        usage: await usageFor(userId, planKey, tx),
        sourceDurationSeconds: project.duration,
        operations: requested,
        suspendedAt: sub?.suspendedAt,
      });

      if (!decision.allowed) {
        return { accepted: false, status: decision.status, body: decision.body };
      }

      const plan = { version: 1 as const, operations: decision.operations };

      // Decided here, next to the rest of the decision and inside the lock,
      // rather than at the insert: which reference a job carries is part of
      // what the plan allows, exactly like the minutes read a few lines up.
      // Both are read off `planKey` at the same instant, so a job can never be
      // written with one plan's allowance and another plan's reference. It
      // costs nothing to hold — it is arithmetic, not a query — and keeping it
      // beside `decision` means the transaction contains the whole judgement.
      const referencePath = referenceForPlan(planKey, project.referenceVideoPath);

      // The insert is inside the lock too, and that is not an optimisation.
      // A lock released before the write leaves exactly the window it was
      // taken to close: the next request would acquire it, read a meter that
      // still shows nothing in flight, and authorise the same minutes again.
      const [created] = await tx
        .insert(jobsTable)
        .values({
          id: randomUUID(),
          userId,
          projectId: project.id,
          status: "queued",
          plan,
          inputPath: project.videoPath as string,
          // Snapshotted so that changing or clearing the reference while this
          // sits in the queue cannot quietly alter a render already accepted —
          // and gated on the plan above, so a reference set while paying is not
          // still applied after a downgrade to a plan that does not include it.
          referencePath,
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

      return { accepted: true, job: created as JobRow, corrections: decision.corrections };
    });
  } catch (error) {
    /*
      The other race, caught outside the transaction because it aborts one.

      `jobs_one_active_per_project` is what makes a double-click on a single
      project a refusal rather than two renders. Its violation rolls the whole
      transaction back — including the reservation — which is correct: nothing
      was reserved because nothing was inserted.
    */
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

  if (!reserved.accepted) {
    return { ok: false, status: reserved.status, body: reserved.body };
  }
  const job = reserved.job;

  if (reserved.corrections.length) {
    log?.info({ userId, plan: planKey, corrections: reserved.corrections }, "render plan corrected by policy");
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
