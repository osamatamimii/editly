import { useState } from "react";
import { Link } from "wouter";
import {
  useGetAdminOverview,
  useListAdminAccounts,
  useListAdminJobs,
  useListWaitlist,
  useListAdminActions,
  useRequeueJob,
  useGrantMinutes,
  useSetSuspended,
  getGetAdminOverviewQueryKey,
  getListAdminAccountsQueryKey,
  getListAdminJobsQueryKey,
  getListWaitlistQueryKey,
  getListAdminActionsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, ArrowLeft, Search } from "lucide-react";
import NotFound from "@/pages/not-found";
import { loadState, isNotFound, COULD_NOT_LOAD } from "@/lib/load-state";

/**
 * What an empty cell says.
 *
 * These were em dashes. A dash standing in for "no value" is a real
 * typographic convention and it is not what these tables needed: the same
 * character reads as prose punctuation everywhere else in the product, and it
 * has been taken out of the product's writing. A middle dot is a mark, not a
 * word and not a dash: it holds the column, it is obviously not data, and it
 * cannot be misread as a sentence that lost its other half. One constant so
 * the twelve cells that use it stay the same as each other.
 */
const EMPTY = "\u00b7";


/**
 * The operations console.
 *
 * Two things about this page are decisions rather than details.
 *
 * **The client never decides who is an admin.** There is no flag in the session
 * it could read and no list it could compare against; it asks the server for
 * the overview and renders the console if that succeeds. When the server says
 * 404 — which is what it says to everyone not on its allowlist — this renders
 * the ordinary not-found page, identical to any mistyped URL. A client-side
 * check would be a curtain: the data would already have been fetched, or the
 * route would exist to anyone who read the bundle.
 *
 * **Nothing here plays a video.** There is no player, no signed URL, no link
 * into anyone's footage — on purpose. This is a tool for knowing whether the
 * platform is healthy and why a particular render failed, and those questions
 * are answered by metadata. See admin-console.md.
 */
export default function AdminPage() {
  // `retry: false` throughout, because the expected failure here is a 404 that
  // means "you are not an admin" — retrying it three times is three more
  // requests and the same answer.
  const overview = useGetAdminOverview({
    query: { queryKey: getGetAdminOverviewQueryKey(), retry: false, refetchInterval: 30_000 },
  });
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  /**
   * Nothing is done without a reason typed here first.
   *
   * The buttons are disabled until it is filled in, and it is cleared after
   * every action — so the reason belongs to the thing that was just done and
   * cannot be inherited by the next one, which is how audit logs fill up with
   * one plausible sentence repeated forty times.
   */
  const [reason, setReason] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [jobFilter, setJobFilter] = useState<string>("");
  const waitlist = useListWaitlist(
    { limit: 200 },
    { query: { queryKey: getListWaitlistQueryKey({ limit: 200 }), retry: false } },
  );
  const accounts = useListAdminAccounts(
    { q: search || undefined, limit: 50 },
    {
      query: {
        queryKey: getListAdminAccountsQueryKey({ q: search || undefined, limit: 50 }),
        retry: false,
        enabled: overview.isSuccess,
      },
    },
  );
  const actions = useListAdminActions(
    { limit: 25 },
    {
      query: {
        queryKey: getListAdminActionsQueryKey({ limit: 25 }),
        retry: false,
        enabled: overview.isSuccess,
      },
    },
  );
  const jobs = useListAdminJobs(
    { status: jobFilter || undefined, limit: 50 },
    {
      query: {
        queryKey: getListAdminJobsQueryKey({ status: jobFilter || undefined, limit: 50 }),
        retry: false,
        enabled: overview.isSuccess,
        refetchInterval: 30_000,
      },
    },
  );

  const overviewState = loadState(overview);

  const refreshEverything = () => {
    setReason("");
    setActionError(null);
    void queryClient.invalidateQueries({ queryKey: getGetAdminOverviewQueryKey() });
    void queryClient.invalidateQueries({ queryKey: [`/api/admin/accounts`] });
    void queryClient.invalidateQueries({ queryKey: [`/api/admin/jobs`] });
    void queryClient.invalidateQueries({ queryKey: [`/api/admin/actions`] });
  };
  const onFailure = (error: unknown) => {
    const message = (error as { message?: string } | undefined)?.message;
    setActionError(message && message.length < 300 ? message : "That did not work.");
  };
  const requeue = useRequeueJob({ mutation: { onSuccess: refreshEverything, onError: onFailure } });
  const grant = useGrantMinutes({ mutation: { onSuccess: refreshEverything, onError: onFailure } });
  const suspend = useSetSuspended({ mutation: { onSuccess: refreshEverything, onError: onFailure } });
  const canAct = reason.trim().length >= 6;

  if (overviewState === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  // A 404 is the refusal: it is what the server says to everyone not on the
  // allowlist, and it is what it says for a route that does not exist. This
  // renders the ordinary not-found page for it, so the two are indistinguishable
  // from the outside.
  //
  // Anything else is a real failure and must not be dressed up as one. Only an
  // admin can ever see a 500 here — everyone else was already answered 404 —
  // and telling the one person who can fix the platform that their console does
  // not exist, when what actually happened is that the database is down, is
  // exactly the failure mode load-state.ts exists to prevent.
  if (overviewState === "missing" || isNotFound(overview.error)) return <NotFound />;
  if (overviewState !== "ready" || !overview.data) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <div className="max-w-md text-center space-y-2">
          <h1 className="text-xl font-semibold">Operations</h1>
          <p className="text-muted-foreground text-sm">{COULD_NOT_LOAD}</p>
        </div>
      </div>
    );
  }

  const data = overview.data;
  const worker = data.worker;
  // Failure before emptiness, for these two as well: "nobody has signed up" and
  // "we could not read who signed up" are opposite facts, and on this screen in
  // particular the second is the one worth waking up for.
  const accountsState = loadState(accounts, (page) => page.accounts.length === 0);
  const jobsState = loadState(jobs, (page) => page.jobs.length === 0);
  const actionsState = loadState(actions, (page) => page.actions.length === 0);
  const seenAgo = worker.lastSeenAt
    ? Math.round((Date.now() - new Date(worker.lastSeenAt).getTime()) / 1000)
    : null;

  /*
   * When the word and the number disagree, say so instead of showing both.
   *
   * This card prints two things that come from the same row: a verdict the
   * server reached, and an age this page computes from the timestamp beside it.
   * In production they cannot disagree. Which is exactly why nothing here
   * checked — and why the card read "online · last beat 6d 3h ago" in a
   * screenshot for days without anyone, including me, treating it as a fault.
   *
   * A console whose whole job is to tell you when something is wrong must not
   * be the one screen that renders a contradiction calmly. A stale response, a
   * cached one, a clock that disagrees, or a bug in the threshold all arrive
   * looking like this, and every one of them is worth knowing about.
   *
   * The threshold is written out rather than imported: it belongs to
   * `queue-health.ts` in the API, which deploys separately, and a package
   * between the two for one number would be a build dependency for a constant.
   * browser-test holds the two copies to the same value.
   */
  const WORKER_OFFLINE_AFTER_SECONDS = 120;
  const claimsOnlineButIsStale =
    worker.online && seenAgo !== null && seenAgo > WORKER_OFFLINE_AFTER_SECONDS;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-6xl mx-auto px-6 py-10 space-y-10">
        <div className="flex items-center justify-between">
          <div>
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="w-4 h-4" /> Dashboard
            </Link>
            <h1 className="text-3xl font-bold mt-2">Operations</h1>
            <p className="text-muted-foreground text-sm mt-1">
              Read-only. Every number here comes from the same modules the product bills and
              schedules with.
            </p>
          </div>
        </div>

        {/*
          The reason, before the act.

          It sits above the buttons rather than inside a dialog because that is
          the honest order: you decide why first. Every button below is dead
          until it holds six characters, and it empties itself after each
          action so the next one cannot inherit it — which is how audit logs end
          up with one plausible sentence repeated forty times.
        */}
        <section className="rounded-xl border border-border bg-card p-4 space-y-2">
          <label className="text-sm font-medium" htmlFor="admin-reason">
            Reason (required before anything below can be done)
          </label>
          <input
            id="admin-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why are you doing this? It goes in the log with your name."
            data-testid="admin-reason"
            className="w-full px-3 min-h-11 md:min-h-0 md:py-2 rounded-lg bg-background border border-border text-base md:text-sm"
          />
          {actionError ? (
            <p className="text-sm text-destructive" data-testid="admin-action-error">
              {actionError}
            </p>
          ) : null}
        </section>

        {/* ── Health ───────────────────────────────────────────────────── */}
        <section className="grid grid-cols-2 md:grid-cols-4 gap-4" data-testid="admin-health">
          <Card label="Rendering now" value={data.queue.processing} />
          <Card label="Waiting in queue" value={data.queue.waiting} hint="behind a live machine" />
          <Card
            label="Unattended"
            value={data.queue.unattended}
            hint="queued with nothing listening"
            alarming={data.queue.unattended > 0}
          />
          <Card
            label="Failed (24h)"
            value={data.queue.failedLastDay}
            alarming={data.queue.failedLastDay > 0}
          />
        </section>

        <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card
            label="Worker"
            value={claimsOnlineButIsStale ? "unclear" : worker.online ? "online" : "offline"}
            hint={
              claimsOnlineButIsStale
                ? `the server says online, but the last beat was ${elapsed(seenAgo as number)} ago. Both cannot be true.`
                : seenAgo === null
                  ? "never seen"
                  : `last beat ${elapsed(seenAgo)} ago`
            }
            alarming={!worker.online || claimsOnlineButIsStale}
          />
          <Card label="Done (24h)" value={data.queue.doneLastDay} />
          <Card label="Minutes this month" value={data.minutesRenderedThisMonth} />
          <Card
            label="Accounts"
            value={data.accounts.total}
            hint={`${data.accounts.newLastWeek} new this week`}
          />
        </section>

        {/* ── Money ────────────────────────────────────────────────────── */}
        <section>
          <h2 className="text-xl font-semibold mb-3">Subscriptions</h2>
          <div className="flex flex-wrap gap-3 mb-4">
            {data.revenue.byPlan.map((row) => (
              <div
                key={row.plan}
                className="px-4 py-2 rounded-lg border border-border bg-card text-sm"
              >
                <span className="font-medium capitalize">{row.plan}</span>{" "}
                <span className="text-muted-foreground">× {row.count}</span>
              </div>
            ))}
            <div className="px-4 py-2 rounded-lg border border-primary/40 bg-primary/10 text-sm font-medium">
              ${data.revenue.monthlyRecurringUsd} / month
            </div>
          </div>

          <h3 className="text-sm font-semibold text-muted-foreground mb-2">
            Last billing events
          </h3>
          <Table
            head={["Type", "Email", "Plan", "Received", "Applied", "Outcome"]}
            rows={data.billing.map((event) => [
              event.type,
              event.email ?? EMPTY,
              event.plan ?? EMPTY,
              new Date(event.receivedAt).toLocaleString(),
              event.applied ? "yes" : "no",
              event.outcome ?? EMPTY,
            ])}
            empty="Nothing from Freemius yet."
          />
        </section>

        {/* ── People ───────────────────────────────────────────────────── */}
        <section>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3">
            <h2 className="text-xl font-semibold">
              Accounts{" "}
              <span className="text-muted-foreground text-base font-normal">
                ({accounts.data?.total ?? 0})
              </span>
            </h2>
            <div className="relative w-full sm:w-auto">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by email"
                data-testid="admin-account-search"
                className="pl-9 pr-3 min-h-11 md:min-h-0 md:py-2 rounded-lg bg-card border border-border text-base md:text-sm w-full sm:w-64"
              />
            </div>
          </div>
          {accountsState === "failed" ? (
            <Problem>{COULD_NOT_LOAD}</Problem>
          ) : (
            <Table
              head={["Email", "Plan", "Minutes", "Projects", "Joined", "Last seen", ""]}
              rows={(accounts.data?.accounts ?? []).map((account) => [
                account.email ?? account.userId,
                account.plan,
                `${account.minutesUsedThisMonth} / ${account.minutesIncluded}`,
                String(account.projectCount),
                new Date(account.createdAt).toLocaleDateString(),
                account.lastSignInAt ? new Date(account.lastSignInAt).toLocaleDateString() : "never",
                <span key="act" className="flex gap-2 whitespace-nowrap">
                  <RowButton
                    disabled={!canAct || grant.isPending}
                    onClick={() =>
                      grant.mutate({
                        userId: account.userId,
                        data: { minutes: 30, reason: reason.trim() },
                      })
                    }
                    testId={`admin-grant-${account.userId}`}
                  >
                    +30 min
                  </RowButton>
                  <RowButton
                    disabled={!canAct || suspend.isPending}
                    onClick={() =>
                      suspend.mutate({
                        userId: account.userId,
                        data: { suspended: true, reason: reason.trim() },
                      })
                    }
                    testId={`admin-suspend-${account.userId}`}
                  >
                    Suspend
                  </RowButton>
                </span>,
              ])}
              empty={accountsState === "loading" ? "Loading…" : "Nobody yet."}
            />
          )}
        </section>

        {/* ── The waiting list ─────────────────────────────────────────── */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xl font-semibold">Waiting list</h2>
            <span className="text-sm text-muted-foreground">
              {waitlist.data ? `${waitlist.data.total} waiting` : ""}
            </span>
          </div>
          {/*
            The only table here made of people who are not customers. Shown
            with the page each came from, because the landing page and the
            waiting-list domain are two different promises and this column is
            the only place a difference between them will appear.
          */}
          {loadState(waitlist) === "loading" ? (
            <div className="text-sm text-muted-foreground py-6">Loading…</div>
          ) : loadState(waitlist) === "failed" ? (
            <Problem>{COULD_NOT_LOAD}</Problem>
          ) : (
            <Table
              head={["Email", "From", "Joined"]}
              empty="Nobody has asked yet."
              rows={(waitlist.data?.entries ?? []).map((entry) => [
                entry.email,
                entry.source ?? EMPTY,
                new Date(entry.createdAt).toLocaleString(),
              ])}
            />
          )}
        </section>

        {/* ── Renders ──────────────────────────────────────────────────── */}
        <section>
          {/* Five filters and a heading do not fit a phone in one line, and a
              row that does not wrap does not shrink either — it just leaves the
              screen, and takes the page's scroll width with it. */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3">
            <h2 className="text-xl font-semibold">Recent renders</h2>
            <div className="flex flex-wrap gap-2">
              {["", "failed", "queued", "processing", "done"].map((status) => (
                <button
                  key={status || "all"}
                  onClick={() => setJobFilter(status)}
                  data-testid={`admin-job-filter-${status || "all"}`}
                  className={`px-3 min-h-11 sm:min-h-0 sm:py-1.5 inline-flex items-center rounded-lg text-sm border transition-colors ${
                    jobFilter === status
                      ? "border-primary/60 bg-primary/15 text-foreground"
                      : "border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {status || "all"}
                </button>
              ))}
            </div>
          </div>
          {jobsState === "failed" ? (
            <Problem>{COULD_NOT_LOAD}</Problem>
          ) : (
            <Table
              head={["Status", "Project", "Billed", "Created", "Finished", "Error", "What it did", ""]}
              rows={(jobs.data?.jobs ?? []).map((job) => [
                job.unattended ? `${job.status} · unattended` : job.status,
                job.projectId.slice(0, 8),
                job.billedSeconds === null ? EMPTY : `${Math.round(job.billedSeconds)}s`,
                new Date(job.createdAt).toLocaleString(),
                job.finishedAt ? new Date(job.finishedAt).toLocaleString() : EMPTY,
                // Verbatim, and not truncated to something tidy: the whole
                // value of this column is that it says what actually happened.
                job.error ?? EMPTY,
                /*
                  The column that answers the support question the other six
                  cannot. "It worked and it did not do what I asked" leaves no
                  error and no failure — only these sentences, written by the
                  renderer as it made each decision: no music under the edit, no
                  steady beat in the track, a title whose moment did not survive
                  the cut. Ten seconds instead of a diagnosis session, which is
                  what the whole jobs table is for.
                */
                job.notes && job.notes.length > 0 ? (
                  // `dir="auto"` for the same reason it is on every other place
                  // in this product that renders a sentence: the render notes
                  // are written in the language the job was asked in, so an
                  // Arabic customer's notes arrive here in Arabic — and a line
                  // laid out left-to-right puts their full stop at the wrong
                  // end. One rule, everywhere a sentence is drawn.
                  <span key="notes" dir="auto" className="block max-w-xs whitespace-normal text-muted-foreground">
                    {job.notes.join(" · ")}
                  </span>
                ) : (
                  EMPTY
                ),
                // A finished render has no requeue button at all: doing it
                // would bill the customer twice, and the server refuses it, so
                // offering it here would only be a button that says no.
                job.status === "done" ? (
                  <span key="none" className="text-muted-foreground">{EMPTY}</span>
                ) : (
                  <RowButton
                    key="requeue"
                    disabled={!canAct || requeue.isPending}
                    onClick={() => requeue.mutate({ jobId: job.id, data: { reason: reason.trim() } })}
                    testId={`admin-requeue-${job.id}`}
                  >
                    Requeue
                  </RowButton>
                ),
              ])}
              empty={jobsState === "loading" ? "Loading…" : "No renders yet."}
            />
          )}
        </section>
        {/* ── The log ──────────────────────────────────────────────────── */}
        <section>
          <h2 className="text-xl font-semibold mb-1">What has been done here</h2>
          <p className="text-sm text-muted-foreground mb-3">
            Every action above writes a row. Nothing removes one.
          </p>
          {actionsState === "failed" ? (
            <Problem>{COULD_NOT_LOAD}</Problem>
          ) : (
            <Table
              head={["When", "Action", "Subject", "Reason", "Detail"]}
              rows={(actions.data?.actions ?? []).map((entry) => [
                new Date(entry.createdAt).toLocaleString(),
                entry.action,
                entry.subjectUserId ?? entry.subjectJobId ?? EMPTY,
                entry.reason,
                entry.detail ? JSON.stringify(entry.detail) : EMPTY,
              ])}
              empty={actionsState === "loading" ? "Loading…" : "Nothing has been done here yet."}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function RowButton({
  children,
  onClick,
  disabled,
  testId,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled: boolean;
  testId: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      title={disabled ? "Type a reason first" : undefined}
      // These are the buttons that grant minutes, suspend an account and
      // requeue a job — the console's only irreversible acts — and they were
      // 26px tall. A thumb hitting "Suspend" when it meant "+30 min" is the
      // worst miss in the product.
      className="px-2.5 min-h-11 md:min-h-0 md:py-1 inline-flex items-center justify-center rounded-md border border-border text-xs hover:border-primary/60 hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
    >
      {children}
    </button>
  );
}

function Card({
  label,
  value,
  hint,
  alarming = false,
}: {
  label: string;
  value: string | number;
  hint?: string;
  alarming?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border p-4 ${
        alarming ? "border-destructive/50 bg-destructive/10" : "border-border bg-card"
      }`}
    >
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="text-2xl font-bold mt-1">{value}</div>
      {hint ? <div className="text-xs text-muted-foreground mt-1">{hint}</div> : null}
    </div>
  );
}

function Table({
  head,
  rows,
  empty,
}: {
  head: string[];
  rows: React.ReactNode[][];
  empty: string;
}) {
  if (rows.length === 0) {
    return <div className="text-sm text-muted-foreground py-6">{empty}</div>;
  }
  return (
    // `min-w-0` and `max-w-full`, or `overflow-x-auto` does nothing.
    // A flex or grid child's `min-width` defaults to `auto` — the width of its
    // own content — so this box grew to the table's 1039px and took the page
    // with it. The console scrolled sideways on a phone, which is exactly the
    // device somebody opens it on: the moment a render is failing and they are
    // not at a desk.
    <div className="w-full min-w-0 max-w-full overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-sm">
        <thead className="bg-muted/40">
          <tr>
            {head.map((cell) => (
              <th key={cell} className="text-left font-medium px-4 py-2.5 whitespace-nowrap">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-t border-border/60">
              {row.map((cell, j) => (
                <td
                  key={j}
                  className="px-4 py-2.5 align-top max-w-md break-words text-muted-foreground first:text-foreground"
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Problem({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm">
      {children}
    </div>
  );
}

/**
 * A duration a person can read.
 *
 * The worker's heartbeat was printed as raw seconds, which is fine for the
 * eight seconds it usually is and useless for anything else: a worker last seen
 * on Tuesday read "last beat 511024s ago", and the number this console exists
 * to make obvious — how long has it been gone — became arithmetic. Seconds stay
 * seconds up to a minute, because under a minute is the only range where the
 * exact number is what matters.
 */
function elapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.round((seconds % 86400) / 3600);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}
