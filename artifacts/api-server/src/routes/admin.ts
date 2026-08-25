import { randomUUID } from "crypto";
import { Router, type IRouter } from "express";
import { and, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import {
  db,
  adminActionsTable,
  billingEventsTable,
  jobsTable,
  projectsTable,
  subscriptionsTable,
  waitlistTable,
  workerHeartbeatsTable,
} from "@workspace/db";
import {
  GetAdminOverviewResponse,
  ListAdminAccountsResponse,
  ListAdminJobsResponse,
  ListWaitlistResponse,
  ListAdminActionsResponse,
  isPlanKeyGuard,
} from "@workspace/api-zod";
import { requireAdmin } from "../middlewares/admin";
import { currentUserId } from "../middlewares/auth";
import { isUnattended, workerOnline } from "../lib/queue-health";
import { DEFAULT_PLAN, PLAN_LIMITS, minutesFrom, type PlanKey } from "../lib/plan-limits";
import { startOfMonthUtc } from "../lib/usage";

/**
 * The operations console.
 *
 * Every number on it already existed in the database; none of it is new
 * bookkeeping. What is new is that it can be looked at without a psql prompt,
 * which is the difference between knowing the platform is healthy and assuming
 * it.
 *
 * Two rules hold this file together:
 *
 * **Nothing is done without a signature.** The read routes came first and the
 * four actions came after, once the reading was proven. Every one of them
 * writes a row into `admin_actions` naming the actor, the subject and a reason
 * the route refuses to let be blank — and the audit row is written *before*
 * the effect wherever the two can be ordered, because an effect with no record
 * is worse than a record with no effect. Granting minutes goes further: the
 * audit row **is** the grant, and the meter reads it, so there is no code path
 * that can hand out minutes anonymously.
 *
 * **Nothing here destroys anything.** Suspension stops new renders and deletes
 * nothing; there is no delete-account, no delete-video, no sign-in-as. Those
 * are absent by decision, not by omission — see admin-console.md.
 *
 * **The numbers come from the modules the product uses.** Queue health is
 * `queue-health.ts` — the same function the dashboard and the render status
 * route call. Minutes are `coalesce(billed_seconds, output_seconds)`, the same
 * expression the meter bills on. A console that computes its own answers is a
 * console that will one day disagree with the invoice, and when it does nobody
 * will know which of the two is lying.
 */
interface AccountRow extends Record<string, unknown> {
  user_id: string;
  email: string | null;
  created_at: string;
  last_sign_in_at: string | null;
}

/**
 * The rows out of a raw `db.execute`.
 *
 * Written as a named helper rather than `.rows` at each call site because the
 * shape depends on the driver — node-postgres returns pg's QueryResult, others
 * return the array — and reading it wrongly does not throw. It returns nothing,
 * which looks exactly like a table with nothing in it.
 */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

const router: IRouter = Router();

router.use("/admin", requireAdmin);

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** Billed seconds, the way the meter counts them. */
const billedSeconds = sql<number>`coalesce(sum(coalesce(${jobsTable.billedSeconds}, ${jobsTable.outputSeconds})), 0)`;

function planOf(value: string | undefined | null): PlanKey {
  return value && isPlanKeyGuard(value) ? (value as PlanKey) : DEFAULT_PLAN;
}

router.get("/admin/overview", async (_req, res): Promise<void> => {
  const now = Date.now();
  const dayAgo = new Date(now - DAY_MS);
  const weekAgo = new Date(now - WEEK_MS);

  // Read the heartbeat first: it is what every queue judgement turns on. A
  // queue behind a working machine is a queue; only a queue behind no machine
  // is a problem, and telling them apart is the entire point of this card.
  const [newest] = await db
    .select({
      lastSeenAt: workerHeartbeatsTable.lastSeenAt,
      transcription: workerHeartbeatsTable.transcription,
      vision: workerHeartbeatsTable.vision,
    })
    .from(workerHeartbeatsTable)
    .orderBy(desc(workerHeartbeatsTable.lastSeenAt))
    .limit(1);

  const live = await db
    .select({
      status: jobsTable.status,
      createdAt: jobsTable.createdAt,
      lockedAt: jobsTable.lockedAt,
    })
    .from(jobsTable)
    .where(inArray(jobsTable.status, ["queued", "processing"]));

  let processing = 0;
  let waiting = 0;
  let unattended = 0;
  for (const job of live) {
    if (isUnattended(job, newest?.lastSeenAt, now)) unattended += 1;
    else if (job.status === "processing") processing += 1;
    else waiting += 1;
  }

  const [failedRow] = await db
    .select({ n: count() })
    .from(jobsTable)
    .where(and(eq(jobsTable.status, "failed"), gte(jobsTable.updatedAt, dayAgo)));
  const [doneRow] = await db
    .select({ n: count() })
    .from(jobsTable)
    .where(and(eq(jobsTable.status, "done"), gte(jobsTable.finishedAt, dayAgo)));

  // Accounts are counted from `subscriptions`, not from auth.users: every
  // account gets a row there on first use, and counting the table we own keeps
  // this card working even if the definer function is ever revoked.
  const [accountsRow] = await db.select({ n: count() }).from(subscriptionsTable);
  const [newAccountsRow] = await db
    .select({ n: count() })
    .from(subscriptionsTable)
    .where(gte(subscriptionsTable.createdAt, weekAgo));

  const planRows = await db
    .select({ plan: subscriptionsTable.plan, n: count() })
    .from(subscriptionsTable)
    .groupBy(subscriptionsTable.plan);

  const byPlan = planRows
    .map((row) => ({ plan: planOf(row.plan), count: Number(row.n) }))
    .sort((a, b) => PLAN_LIMITS[b.plan].pricePerMonth - PLAN_LIMITS[a.plan].pricePerMonth);
  const monthlyRecurringUsd = byPlan.reduce(
    (sum, row) => sum + PLAN_LIMITS[row.plan].pricePerMonth * row.count,
    0,
  );

  const events = await db
    .select()
    .from(billingEventsTable)
    .orderBy(desc(billingEventsTable.receivedAt))
    .limit(10);

  const [minutesRow] = await db
    .select({ seconds: billedSeconds })
    .from(jobsTable)
    .where(and(eq(jobsTable.status, "done"), gte(jobsTable.finishedAt, startOfMonthUtc())));

  res.json(
    GetAdminOverviewResponse.parse({
      queue: {
        processing,
        waiting,
        unattended,
        failedLastDay: Number(failedRow?.n ?? 0),
        doneLastDay: Number(doneRow?.n ?? 0),
      },
      worker: {
        online: workerOnline(newest?.lastSeenAt, now),
        lastSeenAt: newest?.lastSeenAt ? new Date(newest.lastSeenAt).toISOString() : null,
        transcription: newest?.transcription ?? null,
        vision: newest?.vision ?? null,
      },
      accounts: {
        total: Number(accountsRow?.n ?? 0),
        newLastWeek: Number(newAccountsRow?.n ?? 0),
      },
      revenue: { byPlan, monthlyRecurringUsd },
      billing: events.map((event) => ({
        eventId: event.eventId,
        type: event.type,
        email: event.email ?? null,
        plan: event.plan && isPlanKeyGuard(event.plan) ? event.plan : null,
        receivedAt: new Date(event.receivedAt).toISOString(),
        applied: event.appliedAt !== null,
        outcome: event.outcome ?? null,
      })),
      minutesRenderedThisMonth: minutesFrom(Number(minutesRow?.seconds ?? 0)),
    }),
  );
});

router.get("/admin/accounts", async (req, res): Promise<void> => {
  const search = typeof req.query["q"] === "string" ? req.query["q"].trim() : "";
  const limit = Math.min(200, Math.max(1, Number(req.query["limit"] ?? 50) || 50));
  const offset = Math.max(0, Number(req.query["offset"] ?? 0) || 0);

  // Addresses live in auth.users, which this role cannot read directly — the
  // schema belongs to Supabase. `admin_accounts` is a SECURITY DEFINER function
  // that answers this one question and returns four columns; see migration
  // 0028 for why it exists and what it deliberately does not return.
  //
  // `db.execute` on the node-postgres driver hands back pg's QueryResult, and
  // the rows are on `.rows`. This first read the result as if it were the array
  // itself, which does not throw — it quietly yields nothing — so the console
  // showed "Nobody yet." beside a card counting one account. The suite did not
  // catch it because the local `auth.users` stand-in was empty, and an empty
  // answer is indistinguishable from a wrong one when the fixture is empty too.
  // It is asserted against a seeded row now.
  const listed = await db.execute<AccountRow>(
    sql`select * from public.admin_accounts(${search || null}, ${limit}, ${offset})`,
  );
  const accounts = rowsOf<AccountRow>(listed);

  const counted = await db.execute<{ admin_account_count: string }>(
    sql`select public.admin_account_count(${search || null}) as admin_account_count`,
  );
  const total = Number(rowsOf<{ admin_account_count: string }>(counted)[0]?.admin_account_count ?? 0);

  const ids = accounts.map((row) => row.user_id);
  // One query each for the three facts about a page of accounts, rather than
  // one query per account. Fifty accounts is fifty round trips the naive way,
  // and this page is the one that will be opened when something is already
  // wrong.
  const plans = ids.length
    ? await db
        .select({ userId: subscriptionsTable.userId, plan: subscriptionsTable.plan })
        .from(subscriptionsTable)
        .where(inArray(subscriptionsTable.userId, ids))
    : [];
  const projects = ids.length
    ? await db
        .select({ userId: projectsTable.userId, n: count() })
        .from(projectsTable)
        .where(inArray(projectsTable.userId, ids))
        .groupBy(projectsTable.userId)
    : [];
  const minutes = ids.length
    ? await db
        .select({ userId: jobsTable.userId, seconds: billedSeconds })
        .from(jobsTable)
        .where(
          and(
            inArray(jobsTable.userId, ids),
            eq(jobsTable.status, "done"),
            gte(jobsTable.finishedAt, startOfMonthUtc()),
          ),
        )
        .groupBy(jobsTable.userId)
    : [];

  const planFor = new Map(plans.map((row) => [row.userId, planOf(row.plan)]));
  const projectsFor = new Map(projects.map((row) => [row.userId, Number(row.n)]));
  const secondsFor = new Map(minutes.map((row) => [row.userId, Number(row.seconds)]));

  res.json(
    ListAdminAccountsResponse.parse({
      total,
      accounts: accounts.map((row) => {
        const plan = planFor.get(row.user_id) ?? DEFAULT_PLAN;
        return {
          userId: row.user_id,
          email: row.email,
          createdAt: new Date(row.created_at).toISOString(),
          lastSignInAt: row.last_sign_in_at ? new Date(row.last_sign_in_at).toISOString() : null,
          plan,
          projectCount: projectsFor.get(row.user_id) ?? 0,
          minutesUsedThisMonth: minutesFrom(secondsFor.get(row.user_id) ?? 0),
          minutesIncluded: PLAN_LIMITS[plan].minutesPerMonth,
        };
      }),
    }),
  );
});

/**
 * The waiting list, newest first.
 *
 * The one screen in the console that shows addresses belonging to people who
 * are not customers yet, which is exactly why it is here and nowhere else: the
 * route that *writes* to this table is public, and the route that reads it is
 * the most private one we have.
 */
router.get("/admin/waitlist", async (req, res): Promise<void> => {
  const limit = Math.min(500, Math.max(1, Number(req.query["limit"] ?? 100) || 100));

  const rows = await db
    .select()
    .from(waitlistTable)
    .orderBy(desc(waitlistTable.createdAt))
    .limit(limit);

  const [totalRow] = await db.select({ n: count() }).from(waitlistTable);

  res.json(
    ListWaitlistResponse.parse({
      total: Number(totalRow?.n ?? 0),
      entries: rows.map((row) => ({
        email: row.email,
        source: row.source ?? null,
        createdAt: new Date(row.createdAt).toISOString(),
      })),
    }),
  );
});

router.get("/admin/jobs", async (req, res): Promise<void> => {
  const now = Date.now();
  const limit = Math.min(200, Math.max(1, Number(req.query["limit"] ?? 50) || 50));
  const filter = typeof req.query["status"] === "string" ? req.query["status"] : "";

  const [newest] = await db
    .select({ lastSeenAt: workerHeartbeatsTable.lastSeenAt })
    .from(workerHeartbeatsTable)
    .orderBy(desc(workerHeartbeatsTable.lastSeenAt))
    .limit(1);

  const known = ["queued", "processing", "done", "failed"];
  const where = known.includes(filter) ? eq(jobsTable.status, filter) : undefined;

  const rows = await db
    .select()
    .from(jobsTable)
    .where(where)
    .orderBy(desc(jobsTable.createdAt))
    .limit(limit);

  const [totalRow] = await db.select({ n: count() }).from(jobsTable).where(where);

  res.json(
    ListAdminJobsResponse.parse({
      total: Number(totalRow?.n ?? 0),
      jobs: rows.map((job) => ({
        id: job.id,
        userId: job.userId,
        projectId: job.projectId,
        status: job.status,
        progress: job.progress,
        stage: job.stage ?? null,
        error: job.error ?? null,
        attempts: job.attempts,
        billedSeconds: job.billedSeconds ?? job.outputSeconds ?? null,
        createdAt: new Date(job.createdAt).toISOString(),
        lockedAt: job.lockedAt ? new Date(job.lockedAt).toISOString() : null,
        finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
        unattended: isUnattended(job, newest?.lastSeenAt, now),
      })),
    }),
  );
});

// ── Acting ───────────────────────────────────────────────────────────────────

/**
 * Every action needs a reason, and this decides what counts as one.
 *
 * Not a formality: the reason is the only part of an audit row that a future
 * reader cannot reconstruct from the rest of the database. Six characters is a
 * low bar deliberately — "refund" and "test" both pass — because a bar high
 * enough to be annoying is a bar people route around by typing "aaaaaaaa".
 */
function reasonFrom(body: unknown): string | null {
  const raw = (body as { reason?: unknown } | undefined)?.reason;
  if (typeof raw !== "string") return null;
  const reason = raw.trim();
  return reason.length >= 6 ? reason.slice(0, 500) : null;
}

async function record(entry: {
  actorUserId: string;
  action: string;
  subjectUserId?: string | null;
  subjectJobId?: string | null;
  reason: string;
  detail?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(adminActionsTable).values({
    id: randomUUID(),
    actorUserId: entry.actorUserId,
    action: entry.action,
    subjectUserId: entry.subjectUserId ?? null,
    subjectJobId: entry.subjectJobId ?? null,
    reason: entry.reason,
    detail: entry.detail ?? null,
  });
}

/**
 * Put a stuck job back in the queue.
 *
 * The most-used action and the least dangerous one: the queue was built to be
 * re-claimed, so this only clears the lock a dead worker left behind. It
 * refuses a job that is already finished — requeueing a done render would
 * bill the customer twice for the same video — and it refuses one a live
 * worker is holding, because that worker is not stuck, it is working.
 */
router.post("/admin/jobs/:id/requeue", async (req, res): Promise<void> => {
  const actorUserId = currentUserId(req);
  const reason = reasonFrom(req.body);
  if (!reason) {
    res.status(400).json({ error: "A reason of at least six characters is required." });
    return;
  }

  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, req.params["id"]!)).limit(1);
  if (!job) {
    res.status(404).json({ error: "No such job." });
    return;
  }
  if (job.status === "done") {
    res.status(409).json({ error: "This render finished. Requeueing it would bill for it twice." });
    return;
  }

  const [newest] = await db
    .select({ lastSeenAt: workerHeartbeatsTable.lastSeenAt })
    .from(workerHeartbeatsTable)
    .orderBy(desc(workerHeartbeatsTable.lastSeenAt))
    .limit(1);
  if (job.status === "processing" && job.lockedAt && workerOnline(newest?.lastSeenAt)) {
    res.status(409).json({ error: "A live worker is holding this job. It is working, not stuck." });
    return;
  }

  // The row first, the effect second: an effect nobody wrote down is worse
  // than a record of something that then failed to happen.
  await record({ actorUserId, action: "requeue_job", subjectJobId: job.id, reason,
    detail: { fromStatus: job.status, attempts: job.attempts } });

  await db
    .update(jobsTable)
    .set({ status: "queued", lockedAt: null, lockedBy: null, progress: 0, stage: null, error: null })
    .where(eq(jobsTable.id, job.id));

  res.status(204).end();
});

/**
 * Hand somebody minutes.
 *
 * The grant is the audit row — there is no other table and no column to set,
 * and `usage.ts` sums these for the current month. Which means the reason is
 * not documentation attached to the grant; it is part of it, and a grant
 * without one cannot be written at all.
 *
 * It expires with the month, like the plan's own allowance. A grant that
 * carried forever would be a plan change made by accident.
 */
router.post("/admin/accounts/:userId/minutes", async (req, res): Promise<void> => {
  const actorUserId = currentUserId(req);
  const reason = reasonFrom(req.body);
  if (!reason) {
    res.status(400).json({ error: "A reason of at least six characters is required." });
    return;
  }
  const minutes = Number((req.body as { minutes?: unknown } | undefined)?.minutes);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 600) {
    res.status(400).json({ error: "Minutes must be a number between 1 and 600." });
    return;
  }

  const subjectUserId = req.params["userId"]!;
  await record({
    actorUserId,
    action: "grant_minutes",
    subjectUserId,
    reason,
    detail: { seconds: Math.round(minutes * 60), minutes },
  });

  res.status(204).end();
});

/**
 * Set somebody's plan by hand.
 *
 * For the case that has actually happened: the Freemius webhook failed and the
 * customer is paying for one thing and holding another. It is the one action
 * here that can disagree with an outside system, so the response says so
 * rather than leaving whoever used it to remember.
 */
router.post("/admin/accounts/:userId/plan", async (req, res): Promise<void> => {
  const actorUserId = currentUserId(req);
  const reason = reasonFrom(req.body);
  if (!reason) {
    res.status(400).json({ error: "A reason of at least six characters is required." });
    return;
  }
  const requested = (req.body as { plan?: unknown } | undefined)?.plan;
  if (typeof requested !== "string" || !isPlanKeyGuard(requested)) {
    res.status(400).json({ error: "Unknown plan." });
    return;
  }

  const subjectUserId = req.params["userId"]!;
  const [existing] = await db
    .select({ plan: subscriptionsTable.plan })
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.userId, subjectUserId))
    .limit(1);

  await record({
    actorUserId,
    action: "set_plan",
    subjectUserId,
    reason,
    detail: { from: existing?.plan ?? null, to: requested },
  });

  await db
    .insert(subscriptionsTable)
    .values({ userId: subjectUserId, plan: requested })
    .onConflictDoUpdate({ target: subscriptionsTable.userId, set: { plan: requested } });

  res.json({
    plan: requested,
    note:
      "Set by hand. Freemius still believes whatever it believed — until it is corrected there, its next webhook can overwrite this.",
  });
});

/**
 * Suspend or restore an account.
 *
 * Stops new renders and deletes nothing: every byte, project and clip stays,
 * and the person can still sign in and look at their work. There is no
 * delete-account action here and there will not be one.
 */
router.post("/admin/accounts/:userId/suspend", async (req, res): Promise<void> => {
  const actorUserId = currentUserId(req);
  const reason = reasonFrom(req.body);
  if (!reason) {
    res.status(400).json({ error: "A reason of at least six characters is required." });
    return;
  }
  const suspended = (req.body as { suspended?: unknown } | undefined)?.suspended;
  if (typeof suspended !== "boolean") {
    res.status(400).json({ error: "`suspended` must be true or false." });
    return;
  }

  const subjectUserId = req.params["userId"]!;
  await record({
    actorUserId,
    action: "set_suspended",
    subjectUserId,
    reason,
    detail: { suspended },
  });

  const suspendedAt = suspended ? new Date() : null;
  await db
    .insert(subscriptionsTable)
    .values({ userId: subjectUserId, plan: DEFAULT_PLAN, suspendedAt })
    .onConflictDoUpdate({ target: subscriptionsTable.userId, set: { suspendedAt } });

  res.status(204).end();
});

/** The log itself, newest first. Nothing writes to it but the routes above. */
router.get("/admin/actions", async (req, res): Promise<void> => {
  const limit = Math.min(200, Math.max(1, Number(req.query["limit"] ?? 50) || 50));
  const rows = await db
    .select()
    .from(adminActionsTable)
    .orderBy(desc(adminActionsTable.createdAt))
    .limit(limit);
  const [totalRow] = await db.select({ n: count() }).from(adminActionsTable);

  res.json(
    ListAdminActionsResponse.parse({
      total: Number(totalRow?.n ?? 0),
      actions: rows.map((row) => ({
        id: row.id,
        actorUserId: row.actorUserId,
        action: row.action,
        subjectUserId: row.subjectUserId ?? null,
        subjectJobId: row.subjectJobId ?? null,
        reason: row.reason,
        detail: (row.detail ?? null) as Record<string, unknown> | null,
        createdAt: new Date(row.createdAt).toISOString(),
      })),
    }),
  );
});

export default router;
