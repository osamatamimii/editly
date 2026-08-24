import { useState } from "react";
import { Link } from "wouter";
import {
  useGetAdminOverview,
  useListAdminAccounts,
  useListAdminJobs,
  getGetAdminOverviewQueryKey,
  getListAdminAccountsQueryKey,
  getListAdminJobsQueryKey,
} from "@workspace/api-client-react";
import { Loader2, ArrowLeft, Search } from "lucide-react";
import NotFound from "@/pages/not-found";
import { loadState, isNotFound, COULD_NOT_LOAD } from "@/lib/load-state";

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
  const [search, setSearch] = useState("");
  const [jobFilter, setJobFilter] = useState<string>("");
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
  const seenAgo = worker.lastSeenAt
    ? Math.round((Date.now() - new Date(worker.lastSeenAt).getTime()) / 1000)
    : null;

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
            value={worker.online ? "online" : "offline"}
            hint={seenAgo === null ? "never seen" : `last beat ${seenAgo}s ago`}
            alarming={!worker.online}
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
              event.email ?? "—",
              event.plan ?? "—",
              new Date(event.receivedAt).toLocaleString(),
              event.applied ? "yes" : "no",
              event.outcome ?? "—",
            ])}
            empty="Nothing from Freemius yet."
          />
        </section>

        {/* ── People ───────────────────────────────────────────────────── */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xl font-semibold">
              Accounts{" "}
              <span className="text-muted-foreground text-base font-normal">
                ({accounts.data?.total ?? 0})
              </span>
            </h2>
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by email"
                data-testid="admin-account-search"
                className="pl-9 pr-3 py-2 rounded-lg bg-card border border-border text-sm w-64"
              />
            </div>
          </div>
          {accountsState === "failed" ? (
            <Problem>{COULD_NOT_LOAD}</Problem>
          ) : (
            <Table
              head={["Email", "Plan", "Minutes", "Projects", "Joined", "Last seen"]}
              rows={(accounts.data?.accounts ?? []).map((account) => [
                account.email ?? account.userId,
                account.plan,
                `${account.minutesUsedThisMonth} / ${account.minutesIncluded}`,
                String(account.projectCount),
                new Date(account.createdAt).toLocaleDateString(),
                account.lastSignInAt ? new Date(account.lastSignInAt).toLocaleDateString() : "never",
              ])}
              empty={accountsState === "loading" ? "Loading…" : "Nobody yet."}
            />
          )}
        </section>

        {/* ── Renders ──────────────────────────────────────────────────── */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xl font-semibold">Recent renders</h2>
            <div className="flex gap-2">
              {["", "failed", "queued", "processing", "done"].map((status) => (
                <button
                  key={status || "all"}
                  onClick={() => setJobFilter(status)}
                  data-testid={`admin-job-filter-${status || "all"}`}
                  className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
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
              head={["Status", "Project", "Billed", "Created", "Finished", "Error"]}
              rows={(jobs.data?.jobs ?? []).map((job) => [
                job.unattended ? `${job.status} · unattended` : job.status,
                job.projectId.slice(0, 8),
                job.billedSeconds === null ? "—" : `${Math.round(job.billedSeconds)}s`,
                new Date(job.createdAt).toLocaleString(),
                job.finishedAt ? new Date(job.finishedAt).toLocaleString() : "—",
                // Verbatim, and not truncated to something tidy: the whole
                // value of this column is that it says what actually happened.
                job.error ?? "—",
              ])}
              empty={jobsState === "loading" ? "Loading…" : "No renders yet."}
            />
          )}
        </section>
      </div>
    </div>
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
  rows: string[][];
  empty: string;
}) {
  if (rows.length === 0) {
    return <div className="text-sm text-muted-foreground py-6">{empty}</div>;
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
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
