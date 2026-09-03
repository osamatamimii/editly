import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import {
  db,
  billingEventsTable,
  jobsTable,
  scheduledPostsTable,
  socialAccountsTable,
  subscriptionsTable,
  workerHeartbeatsTable,
} from "@workspace/db";
import { isPlanKeyGuard } from "@workspace/api-zod";
import { logger } from "./logger";
import { isUnattended, workerOnline } from "./queue-health";
import { DEFAULT_PLAN, PLAN_LIMITS, minutesFrom, type PlanKey } from "./plan-limits";
import { startOfMonthUtc } from "./usage";

/**
 * The list of things that need somebody, as things rather than as counts.
 *
 * The console could already tell you that three renders had failed and two
 * posts were overdue. It could not tell you *which*, and that gap is where the
 * time goes: the verdict at the top of the page said a number, and finding the
 * rows behind it meant scrolling to a different section, choosing a filter,
 * and reading a table sorted by time rather than by whether anything was wrong
 * with the row. Six sections, each answering "how many", and no page that was
 * a list of work.
 *
 * So this route answers the question the console is opened with. One list,
 * every kind of fault together, worst first, each row naming the exact object
 * and carrying enough to act on it without a database prompt.
 *
 * Three rules hold it:
 *
 * **It counts the whole table and lists part of it.** Every count here is a
 * `count(*)` over the real condition; the rows are a capped sample of the same
 * query. A total derived from the rows would be a lie the moment there were
 * more faults than the cap, which is precisely the morning it matters. The two
 * are returned separately so the page can say "and 40 more" instead of
 * quietly showing 25 and looking calm.
 *
 * **It returns facts, not sentences.** A kind, a timestamp, an id, an address,
 * and — where the system that failed wrote one — its own words, verbatim. The
 * console writes the sentence, in the language the person reading it uses. A
 * server that shipped English prose to a screen this product translates would
 * be one more place the Arabic half of the product silently stops.
 *
 * **Nothing customer-facing crosses.** A post's caption is the customer's
 * writing and is not here; a job's plan is not here. What is here is what
 * operations needs: which row, whose, when, and what the failure said. Same
 * line the rest of the console holds — see admin-console.md.
 */
export type AttentionKind =
  | "worker-gone"
  | "render-unattended"
  | "post-overdue"
  | "post-stranded"
  | "billing-unapplied"
  | "render-failed"
  | "account-disconnected"
  | "minutes-spent"
  | "minutes-nearly-spent";

export interface AttentionItem {
  /**
   * Stable between refreshes, because React keys and human attention both
   * depend on it: a list whose keys move every thirty seconds re-renders every
   * row, and a row that changes identity while somebody is reading it is a row
   * they lose their place in.
   */
  id: string;
  kind: AttentionKind;
  severity: "critical" | "warning";
  /** When this became true, where that is knowable. Null where it is not. */
  at: string | null;
  userId: string | null;
  email: string | null;
  jobId: string | null;
  postId: string | null;
  platform: string | null;
  handle: string | null;
  /**
   * What the failing system said, in its own words and untruncated.
   *
   * `jobs.error_detail` where there is one, because `jobs.error` is the
   * sentence the customer was given and for most failures that sentence is our
   * own reassurance. The whole value of a work queue is that the row says what
   * happened.
   */
  detail: string | null;
  /** The two numbers behind a cap, on the kinds that are about one. */
  used: number | null;
  included: number | null;
}

export interface Attention {
  items: AttentionItem[];
  /** The true total per kind, counted over the whole table. */
  counts: Record<AttentionKind, number>;
}

/**
 * How bad, and in what order.
 *
 * Ordered the way somebody would work through them rather than by how
 * alarming each sounds: no machine at all beats a queue nobody is serving,
 * which beats a post that has already missed its time, which beats a payment
 * that did not apply, which beats a render that failed with a reason. The last
 * three are not faults at all — they are things about to become one.
 */
const RANK: Record<AttentionKind, number> = {
  "worker-gone": 0,
  "render-unattended": 1,
  "post-overdue": 2,
  "post-stranded": 3,
  "billing-unapplied": 4,
  "render-failed": 5,
  "account-disconnected": 6,
  "minutes-spent": 7,
  "minutes-nearly-spent": 8,
};

const CRITICAL: ReadonlySet<AttentionKind> = new Set<AttentionKind>([
  "worker-gone",
  "render-unattended",
  "post-overdue",
  "post-stranded",
  "billing-unapplied",
]);

/**
 * How many rows of one kind are listed.
 *
 * Per kind rather than overall, so a hundred failed renders cannot push the
 * one overdue post off the page — which is the failure mode a single global
 * cap has, and it hides the quietest fault behind the noisiest one.
 */
const PER_KIND = 25;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Matching `postingHealth`: the publisher's poll plus its own minimum lead. */
const POST_GRACE_MS = 120_000;
/** Matching `surfaceStrandedPosts`, which is what eventually clears them. */
const STRANDED_AFTER_MS = 15 * 60_000;

/**
 * Where a plan's allowance stops being headroom and starts being a phone call.
 *
 * Eighty per cent, and it is a warning rather than a fault: an account at the
 * ceiling is either somebody who should be on a larger plan or somebody about
 * to be told no in the middle of their work, and both are better handled
 * before the render is refused than after.
 */
const NEARLY = 0.8;

function planOf(value: string | undefined | null): PlanKey {
  return value && isPlanKeyGuard(value) ? (value as PlanKey) : DEFAULT_PLAN;
}

/**
 * Addresses for a set of ids, through the one function allowed to read them.
 *
 * `auth.users` belongs to Supabase and the application role cannot select from
 * it; `admin_emails` is a SECURITY DEFINER function that answers this and
 * nothing wider — see migration 0043. A failure to resolve an address is not a
 * failure of this page: the rows are still listed, with the id, because a
 * queue that refuses to draw because one lookup failed is worse than a queue
 * with a missing column.
 */
async function emailsFor(ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)].filter((id) => id.length > 0);
  if (unique.length === 0) return new Map();
  try {
    const result = await db.execute<{ user_id: string; email: string | null }>(
      // `sql.param`, not `${unique}` on its own. Drizzle flattens a bare
      // array in a template into one placeholder per element — which is how
      // `inArray` builds its list, and is exactly wrong for a function that
      // takes one array argument: the call became `admin_emails($1, $2)` and
      // Postgres answered that no such function exists. The catch below
      // swallowed it, so the queue drew with every address missing and no
      // error anywhere. `param` sends the array as one value.
      sql`select * from public.admin_emails(${sql.param(unique)}::uuid[])`,
    );
    const rows = Array.isArray(result)
      ? (result as Array<{ user_id: string; email: string | null }>)
      : ((result as { rows?: Array<{ user_id: string; email: string | null }> })?.rows ?? []);
    return new Map(rows.filter((row) => row.email).map((row) => [row.user_id, row.email as string]));
  } catch (error) {
    /*
      Degraded, and said so. The rows are still worth drawing without an
      address, so this does not throw — but the silent version of this catch
      is what hid the bug above for an afternoon: every row drew with a
      missing address and nothing anywhere said why.
    */
    logger.warn({ err: error }, "the work queue could not resolve addresses");
    return new Map();
  }
}

export async function attention(now: Date = new Date()): Promise<Attention> {
  const dayAgo = new Date(now.getTime() - DAY_MS);
  const counts: Record<AttentionKind, number> = {
    "worker-gone": 0,
    "render-unattended": 0,
    "post-overdue": 0,
    "post-stranded": 0,
    "billing-unapplied": 0,
    "render-failed": 0,
    "account-disconnected": 0,
    "minutes-spent": 0,
    "minutes-nearly-spent": 0,
  };
  const items: AttentionItem[] = [];

  /*
    The heartbeat first, because every queue judgement turns on it. A queue
    behind a working machine is a queue; only a queue behind no machine is a
    fault, and `isUnattended` is the same function the dashboard and the render
    status route call. A console that computed its own answer here is a console
    that will one day disagree with the product.
  */
  const [beat] = await db
    .select({ lastSeenAt: workerHeartbeatsTable.lastSeenAt })
    .from(workerHeartbeatsTable)
    .orderBy(desc(workerHeartbeatsTable.lastSeenAt))
    .limit(1);
  const lastSeenAt = beat?.lastSeenAt ?? null;

  if (!workerOnline(lastSeenAt, now.getTime())) {
    counts["worker-gone"] = 1;
    items.push({
      ...blank("worker-gone"),
      id: "worker-gone",
      at: lastSeenAt ? new Date(lastSeenAt).toISOString() : null,
    });
  }

  // Queued, unclaimed, and nothing listening. Read as rows rather than as a
  // count because the ages differ and the oldest is the one to speak about.
  const live = await db
    .select({
      id: jobsTable.id,
      userId: jobsTable.userId,
      status: jobsTable.status,
      createdAt: jobsTable.createdAt,
      lockedAt: jobsTable.lockedAt,
    })
    .from(jobsTable)
    .where(inArray(jobsTable.status, ["queued", "running"]))
    .orderBy(jobsTable.createdAt);
  const orphans = live.filter((job) => isUnattended(job, lastSeenAt, now.getTime()));
  counts["render-unattended"] = orphans.length;
  for (const job of orphans.slice(0, PER_KIND)) {
    items.push({
      ...blank("render-unattended"),
      id: `render-unattended:${job.id}`,
      at: job.createdAt ? new Date(job.createdAt).toISOString() : null,
      userId: job.userId,
      jobId: job.id,
    });
  }

  const [failedRow] = await db
    .select({ n: sql<number>`count(*)` })
    .from(jobsTable)
    .where(and(eq(jobsTable.status, "failed"), gte(jobsTable.updatedAt, dayAgo)));
  counts["render-failed"] = Number(failedRow?.n ?? 0);
  const failed = await db
    .select({
      id: jobsTable.id,
      userId: jobsTable.userId,
      error: jobsTable.error,
      errorDetail: jobsTable.errorDetail,
      finishedAt: jobsTable.finishedAt,
      updatedAt: jobsTable.updatedAt,
    })
    .from(jobsTable)
    .where(and(eq(jobsTable.status, "failed"), gte(jobsTable.updatedAt, dayAgo)))
    .orderBy(desc(jobsTable.updatedAt))
    .limit(PER_KIND);
  for (const job of failed) {
    items.push({
      ...blank("render-failed"),
      id: `render-failed:${job.id}`,
      at: new Date(job.finishedAt ?? job.updatedAt).toISOString(),
      userId: job.userId,
      jobId: job.id,
      // The unedited failure, not the sentence written to reassure whoever was
      // waiting. Falling back to that sentence only when there is nothing else.
      detail: job.errorDetail ?? job.error,
    });
  }

  const overdueBefore = new Date(now.getTime() - POST_GRACE_MS);
  const strandedBefore = new Date(now.getTime() - STRANDED_AFTER_MS);
  const [postCounts] = await db
    .select({
      overdue: sql<number>`count(*) filter (where ${scheduledPostsTable.status} = 'scheduled' and ${scheduledPostsTable.scheduledFor} < ${overdueBefore})`,
      stranded: sql<number>`count(*) filter (where ${scheduledPostsTable.status} = 'publishing' and ${scheduledPostsTable.updatedAt} < ${strandedBefore})`,
    })
    .from(scheduledPostsTable);
  counts["post-overdue"] = Number(postCounts?.overdue ?? 0);
  counts["post-stranded"] = Number(postCounts?.stranded ?? 0);

  const overdue = await db
    .select({
      id: scheduledPostsTable.id,
      userId: scheduledPostsTable.userId,
      platform: scheduledPostsTable.platform,
      scheduledFor: scheduledPostsTable.scheduledFor,
    })
    .from(scheduledPostsTable)
    .where(
      and(eq(scheduledPostsTable.status, "scheduled"), lt(scheduledPostsTable.scheduledFor, overdueBefore)),
    )
    .orderBy(scheduledPostsTable.scheduledFor)
    .limit(PER_KIND);
  for (const post of overdue) {
    items.push({
      ...blank("post-overdue"),
      id: `post-overdue:${post.id}`,
      at: new Date(post.scheduledFor).toISOString(),
      userId: post.userId,
      postId: post.id,
      platform: post.platform,
    });
  }

  const stranded = await db
    .select({
      id: scheduledPostsTable.id,
      userId: scheduledPostsTable.userId,
      platform: scheduledPostsTable.platform,
      updatedAt: scheduledPostsTable.updatedAt,
    })
    .from(scheduledPostsTable)
    .where(
      and(eq(scheduledPostsTable.status, "publishing"), lt(scheduledPostsTable.updatedAt, strandedBefore)),
    )
    .orderBy(scheduledPostsTable.updatedAt)
    .limit(PER_KIND);
  for (const post of stranded) {
    items.push({
      ...blank("post-stranded"),
      id: `post-stranded:${post.id}`,
      at: new Date(post.updatedAt).toISOString(),
      userId: post.userId,
      postId: post.id,
      platform: post.platform,
    });
  }

  // A token the platform has stopped accepting fails every post scheduled to
  // it, one at a time, at the moment each was due — so the account is the row
  // worth showing, once, rather than the failures afterwards, one each.
  const disconnected = await db
    .select({
      userId: socialAccountsTable.userId,
      platform: socialAccountsTable.platform,
      handle: socialAccountsTable.handle,
      status: socialAccountsTable.status,
      statusDetail: socialAccountsTable.statusDetail,
      id: socialAccountsTable.id,
      updatedAt: socialAccountsTable.updatedAt,
    })
    .from(socialAccountsTable)
    .where(sql`${socialAccountsTable.status} <> 'ok'`)
    .orderBy(desc(socialAccountsTable.updatedAt))
    .limit(PER_KIND);
  const [disconnectedRow] = await db
    .select({ n: sql<number>`count(*)` })
    .from(socialAccountsTable)
    .where(sql`${socialAccountsTable.status} <> 'ok'`);
  counts["account-disconnected"] = Number(disconnectedRow?.n ?? 0);
  for (const account of disconnected) {
    items.push({
      ...blank("account-disconnected"),
      id: `account-disconnected:${account.id}`,
      at: new Date(account.updatedAt).toISOString(),
      userId: account.userId,
      platform: account.platform,
      handle: account.handle,
      detail: account.statusDetail ?? account.status,
    });
  }

  // Received and never applied. Somebody has paid for something they do not
  // have, and nothing else in the product will ever mention it.
  const unapplied = await db
    .select({
      eventId: billingEventsTable.eventId,
      type: billingEventsTable.type,
      email: billingEventsTable.email,
      userId: billingEventsTable.userId,
      outcome: billingEventsTable.outcome,
      receivedAt: billingEventsTable.receivedAt,
    })
    .from(billingEventsTable)
    .where(sql`${billingEventsTable.appliedAt} is null`)
    .orderBy(desc(billingEventsTable.receivedAt))
    .limit(PER_KIND);
  const [unappliedRow] = await db
    .select({ n: sql<number>`count(*)` })
    .from(billingEventsTable)
    .where(sql`${billingEventsTable.appliedAt} is null`);
  counts["billing-unapplied"] = Number(unappliedRow?.n ?? 0);
  for (const event of unapplied) {
    items.push({
      ...blank("billing-unapplied"),
      id: `billing-unapplied:${event.eventId}`,
      at: new Date(event.receivedAt).toISOString(),
      userId: event.userId,
      email: event.email,
      detail: event.outcome ?? event.type,
    });
  }

  /*
    Who is out of minutes, and who is about to be.

    The accounts table on this console shows fifty rows at a time, ordered by
    when each account was made — so "who is at their ceiling" was a question
    it could not answer at all, and sorting that page would have answered it
    from an arbitrary fifty. Counted here across every subscription instead,
    against the same expression the meter bills on.

    Grants are deliberately not added in. A grant is an admin decision already
    taken about this account this month, and folding it in would quietly
    remove the row that records it — the number here is the plan's allowance
    against what has been spent, which is the thing a plan conversation is
    about.
  */
  const spent = await db
    .select({
      userId: jobsTable.userId,
      seconds: sql<number>`coalesce(sum(coalesce(${jobsTable.billedSeconds}, ${jobsTable.outputSeconds})), 0)`,
    })
    .from(jobsTable)
    .where(and(eq(jobsTable.status, "done"), gte(jobsTable.finishedAt, startOfMonthUtc())))
    .groupBy(jobsTable.userId);
  /*
    Only the accounts that have rendered something this month are considered,
    which is not an optimisation but the whole condition: an account at zero
    minutes cannot be at its ceiling, and walking every subscription to
    discover that is work proportional to how many people have signed up
    rather than to how many are using the product.
  */
  const users = spent.map((row) => row.userId);
  const plans = users.length
    ? await db
        .select({ userId: subscriptionsTable.userId, plan: subscriptionsTable.plan })
        .from(subscriptionsTable)
        .where(inArray(subscriptionsTable.userId, users))
    : [];
  const planFor = new Map(plans.map((row) => [row.userId, planOf(row.plan)]));

  const capped: Array<{ userId: string; used: number; included: number; over: boolean }> = [];
  for (const row of spent) {
    const included = PLAN_LIMITS[planFor.get(row.userId) ?? DEFAULT_PLAN].minutesPerMonth;
    if (included <= 0) continue;
    const used = minutesFrom(Number(row.seconds ?? 0));
    if (used >= included) capped.push({ userId: row.userId, used, included, over: true });
    else if (used >= included * NEARLY) capped.push({ userId: row.userId, used, included, over: false });
  }
  counts["minutes-spent"] = capped.filter((row) => row.over).length;
  counts["minutes-nearly-spent"] = capped.filter((row) => !row.over).length;
  const listed = [
    ...capped.filter((row) => row.over).sort(byUsage).slice(0, PER_KIND),
    ...capped.filter((row) => !row.over).sort(byUsage).slice(0, PER_KIND),
  ];
  for (const row of listed) {
    const kind: AttentionKind = row.over ? "minutes-spent" : "minutes-nearly-spent";
    items.push({
      ...blank(kind),
      id: `${kind}:${row.userId}`,
      userId: row.userId,
      used: row.used,
      included: row.included,
    });
  }

  const withEmail = await emailsFor(items.map((item) => item.userId ?? ""));
  for (const item of items) {
    if (!item.email && item.userId) item.email = withEmail.get(item.userId) ?? null;
  }

  /*
    Worst first, and within one kind the oldest first.

    Oldest rather than newest, which is the opposite of every other table on
    this console and is right here: those tables are a record and this is a
    queue. The render that has been unclaimed for two hours is the one to deal
    with, not the one that joined it a minute ago.
  */
  items.sort((a, b) => {
    const byRank = RANK[a.kind] - RANK[b.kind];
    if (byRank !== 0) return byRank;
    if (a.at && b.at) return a.at.localeCompare(b.at);
    return a.id.localeCompare(b.id);
  });

  return { items, counts };
}

function byUsage(a: { used: number; included: number }, b: { used: number; included: number }): number {
  return b.used / b.included - a.used / a.included;
}

/** Every field present on every row, so a missing one is never an absent key. */
function blank(kind: AttentionKind): AttentionItem {
  return {
    id: "",
    kind,
    severity: CRITICAL.has(kind) ? "critical" : "warning",
    at: null,
    userId: null,
    email: null,
    jobId: null,
    postId: null,
    platform: null,
    handle: null,
    detail: null,
    used: null,
    included: null,
  };
}
