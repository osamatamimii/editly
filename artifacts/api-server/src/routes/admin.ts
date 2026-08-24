import { Router, type IRouter } from "express";
import { and, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import {
  db,
  billingEventsTable,
  jobsTable,
  projectsTable,
  subscriptionsTable,
  workerHeartbeatsTable,
} from "@workspace/db";
import {
  GetAdminOverviewResponse,
  ListAdminAccountsResponse,
  ListAdminJobsResponse,
  isPlanKeyGuard,
} from "@workspace/api-zod";
import { requireAdmin } from "../middlewares/admin";
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
 * **It reads and does not write.** There is no handler here that changes
 * anything, deliberately, for this first version. Actions come next and each
 * will leave an audit row; a console that can act before it can be trusted to
 * read correctly is a console nobody should have.
 *
 * **The numbers come from the modules the product uses.** Queue health is
 * `queue-health.ts` — the same function the dashboard and the render status
 * route call. Minutes are `coalesce(billed_seconds, output_seconds)`, the same
 * expression the meter bills on. A console that computes its own answers is a
 * console that will one day disagree with the invoice, and when it does nobody
 * will know which of the two is lying.
 */
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
  const rows = await db.execute<{
    user_id: string;
    email: string | null;
    created_at: string;
    last_sign_in_at: string | null;
  }>(sql`select * from public.admin_accounts(${search || null}, ${limit}, ${offset})`);
  const accounts = Array.from(rows as unknown as Iterable<{
    user_id: string;
    email: string | null;
    created_at: string;
    last_sign_in_at: string | null;
  }>);

  const totalRows = await db.execute<{ admin_account_count: string }>(
    sql`select public.admin_account_count(${search || null}) as admin_account_count`,
  );
  const total = Number(
    Array.from(totalRows as unknown as Iterable<{ admin_account_count: string }>)[0]
      ?.admin_account_count ?? 0,
  );

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

export default router;
