import { useState, useEffect } from "react";
import { Link, useRoute } from "wouter";
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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Loader2,
  ArrowLeft,
  Search,
  Gauge,
  AlertTriangle,
  Users,
  Film,
  Send,
  CreditCard,
  Server,
  ScrollText,
  Inbox,
  CircleAlert,
  Clock,
  Activity,
  Wallet,
  CheckCircle2,
  ChevronRight,
  type LucideIcon,
} from "lucide-react";
import { TrendChart, type Series } from "@/components/trend-chart";
import NotFound from "@/pages/not-found";
import { apiFetch } from "@/lib/api-fetch";
import { Sparkline, weekOnWeek } from "@/components/sparkline";
import type { AdminTrend } from "@workspace/api-client-react";
import { loadState, isNotFound } from "@/lib/load-state";
import { useLanguage } from "@/lib/language";
import { useDates } from "@/lib/dates";
import { ADMIN } from "@/lib/copy/admin";
import { COMMON, LOAD } from "@/lib/copy/common";
import { type Phrase, type Template } from "@/lib/app-copy";
import { fill, say, type Language } from "@/lib/landing-copy";

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
 * Four things about this page are decisions rather than details.
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
 *
 * **It is eight screens rather than one.** It used to be one column: a verdict,
 * then eight sections, and you scrolled past everything to reach the one you
 * came for. That is a report, and this is a console — so the rail on the left
 * is the shape, each entry is a real address, and each screen fetches only what
 * it draws. A phone gets the same rail laid across the top, because the moment
 * somebody opens this is the moment they are not at a desk.
 *
 * **The queue lists things, not counts.** `/admin/attention` is the screen this
 * console was missing. Every other screen answers "how many"; that one answers
 * "what", one row per actual render, post, account or payment, worst first,
 * with the button that acts on it in the row. See `lib/attention.ts` for why
 * the counts and the rows are fetched as two different numbers.
 *
 * **There is no period selector, and that is deliberate.** The obvious thing to
 * put beside the heading is a "last 30 days" control. Every window on this page
 * is fixed in the query that produces it — the last day, this calendar month, a
 * fortnight of trend — so a selector would change the label above numbers that
 * did not move. A control that lies is worse than a control that is missing.
 */
/** Bytes as a number somebody reads, not as a number somebody counts. */
function gigabytes(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 10) return `${Math.round(gb)} GB`;
  if (gb >= 0.1) return `${gb.toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}

/**
 * What this much egress costs where the files are today.
 *
 * Supabase includes 250 GB and charges $0.09 for each one after. The number is
 * here rather than fetched because it is a published price that changes about
 * once a year, and a console that showed nothing until a pricing API answered
 * would show nothing.
 */
function egressCost(bytes: number, language: Language = "en"): string {
  const gb = bytes / (1024 * 1024 * 1024);
  const billable = Math.max(0, gb - 250);
  if (billable === 0) return "nothing yet";
  return `$${(billable * 0.09).toFixed(2)}`;
}

/**
 * The eight screens, in the order the rail lists them.
 *
 * Two groups, and the split is the console's own priority: the first is what
 * you open when you do not know whether anything is wrong, and the second is
 * the six places you go once you do. A flat list of eight puts "Log" and
 * "Needs you" at the same weight, which is not true of any morning.
 */
type Section =
  | "insights"
  | "attention"
  | "accounts"
  | "renders"
  | "posting"
  | "money"
  | "system"
  | "log";

const SECTIONS: ReadonlyArray<{
  id: Section;
  href: string;
  label: Phrase;
  /** What the screen is for, which a heading naming a table does not say. */
  lead: Phrase;
  Icon: LucideIcon;
  group: "overview" | "platform";
}> = [
  { id: "insights", href: "/admin", label: ADMIN.navInsights, lead: ADMIN.leadInsights, Icon: Gauge, group: "overview" },
  { id: "attention", href: "/admin/attention", label: ADMIN.navAttention, lead: ADMIN.leadAttention, Icon: AlertTriangle, group: "overview" },
  { id: "accounts", href: "/admin/accounts", label: ADMIN.navAccounts, lead: ADMIN.leadAccounts, Icon: Users, group: "platform" },
  { id: "renders", href: "/admin/renders", label: ADMIN.navRenders, lead: ADMIN.leadRenders, Icon: Film, group: "platform" },
  { id: "posting", href: "/admin/posting", label: ADMIN.navPosting, lead: ADMIN.leadPosting, Icon: Send, group: "platform" },
  { id: "money", href: "/admin/money", label: ADMIN.navMoney, lead: ADMIN.leadMoney, Icon: CreditCard, group: "platform" },
  { id: "system", href: "/admin/system", label: ADMIN.navSystem, lead: ADMIN.leadSystem, Icon: Server, group: "platform" },
  { id: "log", href: "/admin/log", label: ADMIN.navLog, lead: ADMIN.leadLog, Icon: ScrollText, group: "platform" },
];

/** The screens that can do something, and therefore need a reason first. */
const ACTS_ON: ReadonlySet<Section> = new Set<Section>(["attention", "accounts", "renders"]);

/*
  The work queue, as it arrives.

  Typed here rather than imported from the generated client for the same reason
  `/admin/deployment` is: the endpoint is new and the client is regenerated
  from the spec on a schedule, and a console that has to wait for a codegen run
  before it can show an overdue post is a console that shows it a day late.
  Which means it is also validated here, by hand, before it is trusted.
*/
type AttentionKind =
  | "worker-gone"
  | "render-unattended"
  | "post-overdue"
  | "post-stranded"
  | "billing-unapplied"
  | "render-failed"
  | "account-disconnected"
  | "minutes-spent"
  | "minutes-nearly-spent";

interface AttentionItem {
  id: string;
  kind: AttentionKind;
  severity: "critical" | "warning";
  at: string | null;
  userId: string | null;
  email: string | null;
  jobId: string | null;
  postId: string | null;
  platform: string | null;
  handle: string | null;
  detail: string | null;
  used: number | null;
  included: number | null;
}

interface Attention {
  items: AttentionItem[];
  counts: Partial<Record<AttentionKind, number>>;
}

const KIND_LABEL: Record<AttentionKind, Phrase> = {
  "worker-gone": ADMIN.kindWorkerGone,
  "render-unattended": ADMIN.kindRenderUnattended,
  "post-overdue": ADMIN.kindPostOverdue,
  "post-stranded": ADMIN.kindPostStranded,
  "billing-unapplied": ADMIN.kindBillingUnapplied,
  "render-failed": ADMIN.kindRenderFailed,
  "account-disconnected": ADMIN.kindAccountDisconnected,
  "minutes-spent": ADMIN.kindMinutesSpent,
  "minutes-nearly-spent": ADMIN.kindMinutesNearlySpent,
};

/**
 * The answer to "is anything actually broken", in one number.
 *
 * The rail's badge counts the critical kinds only. Every kind on this list is
 * something the platform is doing wrong; the warnings below it are things
 * about to go wrong or things a customer did. A badge that counted both would
 * be red on a healthy morning because four accounts are near their minutes,
 * and a badge that is always red is a badge nobody looks at.
 *
 * Held here as well as on the server because the server sends a kind and this
 * draws a colour. `tools/viewport-test.mjs` holds the two lists to each other.
 */
const CRITICAL: ReadonlyArray<AttentionKind> = [
  "worker-gone",
  "render-unattended",
  "post-overdue",
  "post-stranded",
  "billing-unapplied",
];

/**
 * The queue, checked before it is trusted.
 *
 * `/admin/deployment` taught this file the lesson the hard way: the page read
 * a field off a hand-fetched body the moment the state was set, and any answer
 * without it — a proxy returning an empty body, a deploy mid-rollout, an
 * endpoint that 200s with nothing — took the whole console down with a
 * TypeError. Every read that goes through the generated client is validated by
 * it; the two that do not have to do the same job by hand.
 */
function attentionFrom(body: unknown): Attention | null {
  if (body === null || typeof body !== "object") return null;
  const items = (body as { items?: unknown }).items;
  const counts = (body as { counts?: unknown }).counts;
  if (!Array.isArray(items)) return null;
  if (counts === null || typeof counts !== "object") return null;
  const kept: AttentionItem[] = [];
  for (const row of items) {
    if (row === null || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    if (typeof item["id"] !== "string" || typeof item["kind"] !== "string") continue;
    if (!(item["kind"] in KIND_LABEL)) continue;
    kept.push({
      id: item["id"],
      kind: item["kind"] as AttentionKind,
      severity: item["severity"] === "critical" ? "critical" : "warning",
      at: typeof item["at"] === "string" ? item["at"] : null,
      userId: typeof item["userId"] === "string" ? item["userId"] : null,
      email: typeof item["email"] === "string" ? item["email"] : null,
      jobId: typeof item["jobId"] === "string" ? item["jobId"] : null,
      postId: typeof item["postId"] === "string" ? item["postId"] : null,
      platform: typeof item["platform"] === "string" ? item["platform"] : null,
      handle: typeof item["handle"] === "string" ? item["handle"] : null,
      detail: typeof item["detail"] === "string" ? item["detail"] : null,
      used: typeof item["used"] === "number" ? item["used"] : null,
      included: typeof item["included"] === "number" ? item["included"] : null,
    });
  }
  const totals: Partial<Record<AttentionKind, number>> = {};
  for (const [key, value] of Object.entries(counts as Record<string, unknown>)) {
    if (key in KIND_LABEL && typeof value === "number") totals[key as AttentionKind] = value;
  }
  return { items: kept, counts: totals };
}

export default function AdminPage() {
  const { t, fmt, language } = useLanguage();
  const dates = useDates();
  /*
    Which of the eight screens this address is.

    `/admin` is the first one, and every other is `/admin/<id>`. An address
    that is not one of them renders the ordinary not-found page rather than
    falling back to the first screen: a console that quietly shows you
    something other than what you asked for is a console you cannot trust to
    be showing you the thing you think it is.
  */
  const [, params] = useRoute("/admin/:section");
  const asked = params?.section ?? "insights";
  const here = SECTIONS.find((entry) => entry.id === asked) ?? null;
  const section = here?.id ?? null;

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

  /*
    What the deployment actually does, against what the code assumes.

    Fetched here rather than through the generated client because the endpoint
    is new and the client is regenerated from the spec on a schedule; a console
    that has to wait for a codegen run to show a wrong bucket is a console that
    shows it a day late. `retry: false` for the same reason as everything else
    here: the expected failure is a 404 meaning "you are not an admin".
  */
  const [deployment, setDeployment] = useState<{
    findings: Array<{ id: string; verdict: "ok" | "wrong" | "unknown"; expected: string; actual: string; consequence: string }>;
    summary: { wrong: number; unknown: number; ok: number };
    usage: {
      storedBytes: number | null;
      objects: number | null;
      egressBytes: number;
      measuredRenders: number;
      unmeasuredRenders: number;
    };
  } | null>(null);
  const [deploymentAnswered, setDeploymentAnswered] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const response = await apiFetch("/api/admin/deployment");
      if (cancelled) return;
      if (!response.ok) {
        setDeploymentAnswered(true);
        return;
      }
      const body = (await response.json().catch(() => null)) as unknown;
      /*
        Checked before it is trusted, and this caught a real white screen.

        The page read `deployment.summary.wrong` the moment the state was set,
        so any answer without a `summary` — a proxy returning an empty body, a
        deploy mid-rollout, an endpoint that 200s with nothing — took the whole
        admin console down with a TypeError. Every other read on this page goes
        through the generated client, which validates; this one is hand-written
        and had to do the same job by hand.
      */
      const ok =
        body !== null &&
        typeof body === "object" &&
        Array.isArray((body as { findings?: unknown }).findings) &&
        typeof (body as { summary?: unknown }).summary === "object" &&
        (body as { summary: unknown }).summary !== null;
      if (ok) setDeployment(body as typeof deployment);
      // Answered, whatever it answered. Without this the System screen could
      // not tell "still asking" from "this deployment has no audit endpoint",
      // and drew the same nothing for both.
      if (!cancelled) setDeploymentAnswered(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /*
    The work queue, on every screen rather than only on its own.

    Because the rail carries its count, and a badge that only appears once you
    have already opened the page it belongs to is a badge for nobody. It is the
    one read here that is not gated on the section being looked at.
  */
  const attention = useQuery({
    queryKey: ["/api/admin/attention"],
    retry: false,
    refetchInterval: 30_000,
    enabled: overview.isSuccess,
    queryFn: async (): Promise<Attention | null> => {
      const response = await apiFetch("/api/admin/attention");
      if (!response.ok) return null;
      return attentionFrom((await response.json().catch(() => null)) as unknown);
    },
  });

  /*
    Each list is fetched by the screen that draws it.

    All six used to be fetched on every visit, because there was only ever one
    visit: one page, eight sections, and opening it to look at the queue also
    pulled the waiting list, the audit log and fifty accounts. Now that they
    are separate addresses, `enabled` is the difference between one request and
    six on a screen that shows one table.
  */
  const waitlist = useListWaitlist(
    { limit: 200 },
    {
      query: {
        queryKey: getListWaitlistQueryKey({ limit: 200 }),
        retry: false,
        enabled: overview.isSuccess && section === "accounts",
      },
    },
  );
  const accounts = useListAdminAccounts(
    { q: search || undefined, limit: 50 },
    {
      query: {
        queryKey: getListAdminAccountsQueryKey({ q: search || undefined, limit: 50 }),
        retry: false,
        enabled: overview.isSuccess && section === "accounts",
      },
    },
  );
  const actions = useListAdminActions(
    { limit: 25 },
    {
      query: {
        queryKey: getListAdminActionsQueryKey({ limit: 25 }),
        retry: false,
        enabled: overview.isSuccess && section === "log",
      },
    },
  );
  const jobs = useListAdminJobs(
    { status: jobFilter || undefined, limit: 50 },
    {
      query: {
        queryKey: getListAdminJobsQueryKey({ status: jobFilter || undefined, limit: 50 }),
        retry: false,
        enabled: overview.isSuccess && section === "renders",
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
    // The queue is the screen most of these buttons are pressed from, and it
    // is the one that will still be showing the row a moment after the row has
    // been dealt with unless it is asked again.
    void queryClient.invalidateQueries({ queryKey: [`/api/admin/attention`] });
  };
  const onFailure = (error: unknown) => {
    const message = (error as { message?: string } | undefined)?.message;
    setActionError(message && message.length < 300 ? message : t(ADMIN.didNotWork));
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
  if (section === null) return <NotFound />;
  if (overviewState !== "ready" || !overview.data) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <div className="max-w-md text-center space-y-2">
          <h1 className="text-xl font-semibold">{t(ADMIN.title)}</h1>
          <p className="text-muted-foreground text-sm">{t(LOAD.couldNotLoad)}</p>
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

  const queue = attention.data ?? null;
  const counts = queue?.counts ?? {};
  const countOf = (kind: AttentionKind) => counts[kind] ?? 0;
  const urgent = CRITICAL.reduce((sum, kind) => sum + countOf(kind), 0);
  const paidAccounts = data.revenue.byPlan
    .filter((row) => row.plan !== "free")
    .reduce((sum, row) => sum + row.count, 0);

  const workerCard = (
    <Card
      language={language}
      label={t(ADMIN.worker)}
      Icon={Server}
      value={
        claimsOnlineButIsStale
          ? t(ADMIN.workerUnclear)
          : worker.online
            ? t(ADMIN.workerOnline)
            : t(ADMIN.workerOffline)
      }
      hint={
        claimsOnlineButIsStale
          ? fmt(ADMIN.workerContradiction, elapsed(seenAgo as number, language))
          : seenAgo === null
            ? t(ADMIN.neverSeen)
            : fmt(ADMIN.lastBeat, elapsed(seenAgo, language))
      }
      alarming={!worker.online || claimsOnlineButIsStale}
    />
  );

  const reasonField = (
    /*
      The reason, before the act.

      It sits above the buttons rather than inside a dialog because that is the
      honest order: you decide why first. Every button below is dead until it
      holds six characters, and it empties itself after each action so the next
      one cannot inherit it — which is how audit logs end up with one plausible
      sentence repeated forty times.

      It is drawn on the three screens that can do something and nowhere else.
      A field demanding a justification on a screen with no buttons is a screen
      teaching people to fill it in before they know what for.
    */
    <section className="rounded-xl border border-border bg-card px-4 py-3">
      {/*
        One line, not a panel.

        It was a boxed section with a heading and a full-width field, three
        screens deep, and on the queue it pushed the first row of actual work
        below the fold on a laptop. The rule it enforces has not changed; the
        room it takes to enforce it has.
      */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
        <label
          className="text-sm font-medium text-muted-foreground shrink-0 sm:w-44 leading-snug"
          htmlFor="admin-reason"
        >
          {t(ADMIN.reasonLabel)}
        </label>
        <input
          id="admin-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t(ADMIN.reasonPlaceholder)}
          data-testid="admin-reason"
          className="flex-1 min-w-0 px-3 min-h-11 sm:min-h-0 sm:py-2 rounded-lg bg-background border border-border text-base sm:text-sm"
        />
      </div>
      {actionError ? (
        <p className="text-sm text-destructive mt-2" data-testid="admin-action-error">
          {actionError}
        </p>
      ) : null}
    </section>
  );

  /*
    The fortnight, as four series over one axis rather than four thumbnails.

    The days are computed here rather than sent: `trends.daily` is fourteen
    entries oldest first, including the empty ones, so the nth entry is n days
    before today and there is nothing on the wire to disagree with. Formatting
    is the page's job in any case, because the labels are in the reader's
    language.
  */
  const fortnight = data.trends
    ? Array.from({ length: data.trends.renders.daily.length }, (_, i) =>
        dates.shortDay(
          new Date(Date.now() - (data.trends!.renders.daily.length - 1 - i) * 24 * 60 * 60 * 1000),
        ),
      )
    : [];
  const series: Series[] = data.trends
    ? [
        { id: "renders", label: t(ADMIN.seriesRenders), values: data.trends.renders.daily, total: String(sum(data.trends.renders.daily)), tone: "text-primary" },
        { id: "minutes", label: t(ADMIN.seriesMinutes), values: data.trends.minutes.daily, total: String(Math.round(sum(data.trends.minutes.daily))), tone: "text-success" },
        { id: "failures", label: t(ADMIN.seriesFailures), values: data.trends.failures.daily, total: String(sum(data.trends.failures.daily)), tone: "text-destructive" },
        { id: "signups", label: t(ADMIN.seriesSignups), values: data.trends.signups.daily, total: String(sum(data.trends.signups.daily)), tone: "text-warning" },
      ]
    : [];

  const insights = (
    <div className="space-y-8" data-testid="admin-panel-insights">
      {/*
        What, if anything, needs somebody.

        The console answers a dozen questions and asks you to read all of them
        to find out whether any is bad news. That is the wrong order for a
        screen you open *because* something might be wrong: the first line
        should be the answer, and everything below it the evidence.

        Computed from the overview that is already on the page rather than from
        the queue beside it, so it cannot disagree with the cards underneath
        it. And it says nothing when there is nothing to say, because a banner
        that is always present is a banner nobody reads.
      */}
      <Attention
        language={language}
        worker={{ online: worker.online, unclear: claimsOnlineButIsStale }}
        unattended={data.queue.unattended}
        failedLastDay={data.queue.failedLastDay}
        unappliedBilling={data.billing.filter((event) => !event.applied).length}
        posting={data.posting}
        href="/admin/attention"
        open={t(ADMIN.seeTheQueue)}
      />

      {/* ── Money, first ─────────────────────────────────────────────────
          First because it is the only number on this console that is about
          whether the product survives, and because it is the one an operator
          cannot get anywhere else: the queue is visible from the dashboard and
          the failures arrive as support mail.

          There is no dollar figure for what is at risk, and that is on purpose.
          A billing event carries a plan and a type, not an amount, so "revenue
          at risk" would have to be inferred — and an inference that counts a
          cancellation as a loss and a redelivered create as a gain is a number
          that is wrong in both directions on the same screen. What is shown
          instead is the count, and the queue names the events. */}
      {/* ── Money, first ─────────────────────────────────────────────────
          First because it is the only number on this console that is about
          whether the product survives, and because it is the one an operator
          cannot get anywhere else: the queue is visible from the dashboard and
          the failures arrive as support mail.

          There is no dollar figure for what is at risk, and that is on purpose.
          A billing event carries a plan and a type, not an amount, so "revenue
          at risk" would have to be inferred, and an inference that counts a
          cancellation as a loss and a redelivered create as a gain is a number
          that is wrong in both directions on the same screen. What is shown
          instead is the count, and the queue names the events. */}
      <section
        data-testid="admin-money"
        className="rounded-xl border border-border bg-card overflow-hidden"
      >
        <div className="grid sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x rtl:sm:divide-x-reverse divide-border">
          <div className="p-5">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span
                aria-hidden="true"
                className="w-6 h-6 rounded-md bg-primary/15 text-primary grid place-items-center shrink-0"
              >
                <Wallet className="w-3.5 h-3.5" />
              </span>
              <span>{t(ADMIN.subscriptions)}</span>
            </div>
            <div className="mt-2 text-3xl font-bold tabular-nums leading-none">
              {fmt(ADMIN.monthlyRecurring, data.revenue.monthlyRecurringUsd)}
            </div>
            <div className="text-xs text-muted-foreground mt-2">
              {fmt(ADMIN.paying, paidAccounts, data.accounts.total)}
            </div>
          </div>

          <div className="p-5">
            <div className="text-sm text-muted-foreground">{t(ADMIN.perPlan)}</div>
            <div className="mt-3 space-y-1.5">
              {data.revenue.byPlan.map((row) => (
                <div key={row.plan} className="flex items-center justify-between gap-3 text-sm">
                  <span className="capitalize truncate">{row.plan}</span>
                  <span className="text-muted-foreground tabular-nums shrink-0">{row.count}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="p-5">
            <div className="text-sm text-muted-foreground">{t(ADMIN.paymentsTitle)}</div>
            {countOf("billing-unapplied") > 0 ? (
              <Link
                href="/admin/attention"
                data-testid="admin-money-at-risk"
                className="mt-3 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive hover:bg-destructive/15 transition-colors"
              >
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
                <span className="leading-snug">
                  {fmt(ADMIN.billingProblem, countOf("billing-unapplied"))}
                </span>
              </Link>
            ) : (
              <div className="mt-3 flex items-center gap-2 text-sm text-success">
                <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span>{t(ADMIN.allApplied)}</span>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ── The platform, in eight numbers ───────────────────────────────
          One grid rather than two, because the split was arbitrary: a reader
          scanning for bad news does not know that the worker is in the second
          row and the failures in the first. The two that can be alarming come
          first inside it. */}
      <section className="space-y-3">
        <h2 className="text-xl font-semibold">{t(ADMIN.platformToday)}</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4" data-testid="admin-health">
          {workerCard}
          <Card
            language={language}
            label={t(ADMIN.unattended)}
            Icon={AlertTriangle}
            value={data.queue.unattended}
            hint={t(ADMIN.unattendedHint)}
            alarming={data.queue.unattended > 0}
          />
          <Card
            language={language}
            label={t(ADMIN.failedDay)}
            Icon={CircleAlert}
            value={data.queue.failedLastDay}
            alarming={data.queue.failedLastDay > 0}
            trend={data.trends?.failures}
            upIsGood={false}
          />
          <Card language={language} label={t(ADMIN.renderingNow)} value={data.queue.processing} Icon={Activity} />
          <Card
            language={language}
            label={t(ADMIN.waitingInQueue)}
            Icon={Inbox}
            value={data.queue.waiting}
            hint={t(ADMIN.behindLiveMachine)}
          />
          <Card
            language={language}
            label={t(ADMIN.doneDay)}
            Icon={Film}
            value={data.queue.doneLastDay}
            trend={data.trends?.renders}
          />
          <Card
            language={language}
            label={t(ADMIN.minutesThisMonth)}
            Icon={Clock}
            value={data.minutesRenderedThisMonth}
            trend={data.trends?.minutes}
          />
          <Card
            language={language}
            label={t(ADMIN.accounts)}
            value={data.accounts.total}
            Icon={Users}
            hint={fmt(ADMIN.newThisWeek, data.accounts.newLastWeek)}
            trend={data.trends?.signups}
          />
        </div>
      </section>

      <Panel
        title={t(ADMIN.fortnightTitle)}
        testId="admin-fortnight"
        aside={<span className="text-xs text-muted-foreground">{t(ADMIN.thisMonth)}</span>}
      >
        <p className="text-xs text-muted-foreground mb-4 leading-snug max-w-2xl">
          {t(ADMIN.fortnightLead)}
        </p>
        <TrendChart series={series} days={fortnight} emptyLabel={t(ADMIN.fortnightEmpty)} />
      </Panel>

      {/*
        Who is at their ceiling, in one line.

        The accounts screen shows fifty rows ordered by when each was made, so
        "who is about to be refused a render" was a question it could not
        answer at all — and adding a sortable column would have answered it
        from an arbitrary fifty rather than from the table. Counted across
        every account that has rendered anything this month instead, on the
        server, and the queue names them.
      */}
      {countOf("minutes-spent") + countOf("minutes-nearly-spent") > 0 ? (
        <Link
          href="/admin/attention"
          className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3.5 hover:border-primary/50 transition-colors"
          data-testid="admin-caps"
        >
          <span
            aria-hidden="true"
            className="w-8 h-8 rounded-lg bg-warning/15 text-warning grid place-items-center shrink-0"
          >
            <Clock className="w-4 h-4" />
          </span>
          <span className="flex-1 min-w-0 text-sm leading-snug">
            {fmt(ADMIN.capLine, countOf("minutes-spent"), countOf("minutes-nearly-spent"))}
          </span>
          <span className="hidden sm:inline text-xs text-muted-foreground whitespace-nowrap">
            {t(ADMIN.capLineOpen)}
          </span>
          <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0 rtl:rotate-180" aria-hidden="true" />
        </Link>
      ) : null}
    </div>
  );

  const queueRows = (queue?.items ?? []).map((item) => [
    <Badge
      key="what"
      tone={item.severity === "critical" ? "bad" : "warn"}
      testId={`queue-kind-${item.kind}`}
    >
      {t(KIND_LABEL[item.kind])}
    </Badge>,
    /*
      How long, not when.

      Every other table on this console is a record and prints a timestamp;
      this is a queue, and the question a queue row raises is "how long has
      this been sitting there". "Aug 24, 2026, 07:40" makes the reader do the
      subtraction, once per row, against a clock they have to remember.
    */
    item.at ? (
      <span key="since" className="whitespace-nowrap" title={dates.moment(item.at)}>
        {fmt(ADMIN.ago, elapsed(Math.max(0, Math.round((Date.now() - new Date(item.at).getTime()) / 1000)), language))}
      </span>
    ) : item.kind === "worker-gone" ? (
      t(ADMIN.neverBeat)
    ) : (
      EMPTY
    ),
    item.email || item.userId ? (
      <span key="whose" className="flex items-center gap-2.5 min-w-0">
        <Initials of={item.email} />
        <span className="truncate" dir="ltr">
          {item.email ?? (item.userId as string).slice(0, 8)}
        </span>
      </span>
    ) : (
      EMPTY
    ),
    // What the failing system said, in its own words. The minutes rows have no
    // sentence to quote and are the two numbers instead; a connected account
    // leads with the handle, because "which account" is the whole question.
    item.used !== null && item.included !== null ? (
      fmt(ADMIN.minutesOf, item.used, item.included)
    ) : item.handle ? (
      <span key="detail" dir="auto" className="block max-w-xs whitespace-normal">
        {item.handle}
        {item.detail ? ` ${EMPTY} ${item.detail}` : ""}
      </span>
    ) : item.detail ? (
      <span key="detail" dir="auto" className="block max-w-xs whitespace-normal break-words">
        {item.detail}
      </span>
    ) : (
      item.platform ?? EMPTY
    ),
    // The button that deals with the row, in the row. A queue whose next step
    // is a different screen is a list, not a queue.
    item.jobId ? (
      <RowButton
        key="requeue"
        disabled={!canAct || requeue.isPending}
        onClick={() => requeue.mutate({ jobId: item.jobId as string, data: { reason: reason.trim() } })}
        language={language}
        testId={`admin-requeue-${item.jobId}`}
      >
        {t(ADMIN.requeue)}
      </RowButton>
    ) : item.userId && (item.kind === "minutes-spent" || item.kind === "minutes-nearly-spent") ? (
      <RowButton
        key="grant"
        disabled={!canAct || grant.isPending}
        onClick={() =>
          grant.mutate({ userId: item.userId as string, data: { minutes: 30, reason: reason.trim() } })
        }
        language={language}
        testId={`admin-grant-${item.userId}`}
      >
        {t(ADMIN.grantMinutes)}
      </RowButton>
    ) : (
      <span key="none" className="text-muted-foreground">{EMPTY}</span>
    ),
  ]);

  const listedTotal = Object.values(counts).reduce((sum, n) => sum + n, 0);

  const attentionPanel = (
    <div className="space-y-6" data-testid="admin-panel-attention">
      {/* The counts, per kind, above the rows. Nashra's header line and the
          reason it works: the numbers are the whole table and the rows below
          are a sample of it, so the two must be shown as two things. */}
      {queue ? (
        <div className="flex flex-wrap gap-2" data-testid="admin-queue-counts">
          {(Object.keys(KIND_LABEL) as AttentionKind[])
            .filter((kind) => countOf(kind) > 0)
            .map((kind) => (
              <span
                key={kind}
                data-testid={`queue-count-${kind}`}
                className={`px-3 py-1.5 rounded-lg border text-sm ${
                  CRITICAL.includes(kind)
                    ? "border-destructive/50 bg-destructive/10 text-destructive"
                    : "border-border bg-card text-muted-foreground"
                }`}
              >
                {t(KIND_LABEL[kind])} <span className="tabular-nums font-medium">{countOf(kind)}</span>
              </span>
            ))}
        </div>
      ) : null}

      {reasonField}

      {attention.isError || (attention.isFetched && queue === null) ? (
        <Problem>{t(LOAD.couldNotLoad)}</Problem>
      ) : queue === null ? (
        <div className="text-sm text-muted-foreground py-6">{t(ADMIN.loading)}</div>
      ) : queueRows.length === 0 ? (
        <section
          className="rounded-xl border border-success/40 bg-success/10 px-4 py-3 text-sm"
          data-testid="admin-queue-clear"
        >
          <span className="font-medium text-success">{t(ADMIN.queueClear)}</span>{" "}
          <span className="text-muted-foreground">{t(ADMIN.queueClearLead)}</span>
        </section>
      ) : (
        <>
          <Table
            head={[
              t(ADMIN.headWhat),
              t(ADMIN.headSince),
              t(ADMIN.headWhose),
              t(ADMIN.headDetail),
              "",
            ]}
            rows={queueRows}
            empty={t(ADMIN.queueClear)}
          />
          {/*
            The rows are capped per kind and the counts are not, so the two can
            differ — and when they do, saying so is the difference between a
            screen that is showing you everything and a screen that looks like
            it is.
          */}
          {listedTotal > queueRows.length ? (
            <p className="text-xs text-muted-foreground" data-testid="admin-queue-showing">
              {fmt(ADMIN.queueShowing, queueRows.length, listedTotal)}
            </p>
          ) : null}
        </>
      )}
    </div>
  );

  const accountsPanel = (
    <div className="space-y-8" data-testid="admin-panel-accounts">
      {reasonField}
      <section>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3">
          <h2 className="text-xl font-semibold">
            {t(ADMIN.accounts)}{" "}
            <span className="text-muted-foreground text-base font-normal">
              ({accounts.data?.total ?? 0})
            </span>
          </h2>
          <div className="relative w-full sm:w-auto">
            <Search className="w-4 h-4 absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t(ADMIN.searchByEmail)}
              data-testid="admin-account-search"
              className="ps-9 pe-3 min-h-11 md:min-h-0 md:py-2 rounded-lg bg-card border border-border text-base md:text-sm w-full sm:w-64"
            />
          </div>
        </div>
        {/*
          A summary of the plans, and not a filter.

          The obvious thing here is a row of segmented buttons: all, free,
          creator, pro, studio. The list is paged by the server and the plan is
          joined in afterwards, so a filter drawn here would filter the fifty
          rows that happened to arrive rather than the table, and would answer
          "how many are on Pro" with a number off the first page. The counts
          come from the overview, which counts the whole table.
        */}
        <div className="flex flex-wrap gap-2 mb-3" data-testid="admin-plan-summary">
          <span className="text-xs text-muted-foreground self-center">{t(ADMIN.perPlan)}</span>
          {data.revenue.byPlan.map((row) => (
            <span
              key={row.plan}
              className="px-3 py-1 rounded-lg border border-border bg-card text-xs"
            >
              <span className="capitalize">{row.plan}</span>{" "}
              <span className="text-muted-foreground tabular-nums">{row.count}</span>
            </span>
          ))}
        </div>
        {accountsState === "failed" ? (
          <Problem>{t(LOAD.couldNotLoad)}</Problem>
        ) : (
          <Table
            head={[
              t(ADMIN.headEmail),
              t(ADMIN.headPlan),
              t(ADMIN.headMinutes),
              t(ADMIN.headProjects),
              t(ADMIN.headJoined),
              t(ADMIN.headLastSeen),
              "",
            ]}
            rows={(accounts.data?.accounts ?? []).map((account) => [
              <span key="who" className="flex items-center gap-2.5 min-w-0">
                <Initials of={account.email} />
                <span className="truncate" dir="ltr">{account.email ?? account.userId}</span>
              </span>,
              <Badge key="plan" tone={account.plan === "free" ? "neutral" : "good"}>
                {account.plan}
              </Badge>,
              /*
                The allowance as a bar. It was "22.5 / 60", which is a division
                the reader does in their head fifty times down a page, and the
                one row that matters is the one where the answer is close to
                one. The numbers stay under it, because a bar alone cannot say
                which plan it belongs to.
              */
              <span key="minutes" className="block min-w-28">
                <Meter used={account.minutesUsedThisMonth} of={account.minutesIncluded} />
                <span className="text-xs tabular-nums">
                  {account.minutesUsedThisMonth} / {account.minutesIncluded}
                </span>
              </span>,
              String(account.projectCount),
              dates.day(account.createdAt),
              account.lastSignInAt ? dates.day(account.lastSignInAt) : t(ADMIN.never),
              <span key="act" className="flex gap-2 whitespace-nowrap">
                <RowButton
                  disabled={!canAct || grant.isPending}
                  onClick={() =>
                    grant.mutate({
                      userId: account.userId,
                      data: { minutes: 30, reason: reason.trim() },
                    })
                  }
                  language={language}
                  testId={`admin-grant-${account.userId}`}
                >
                  {t(ADMIN.grantMinutes)}
                </RowButton>
                <RowButton
                  disabled={!canAct || suspend.isPending}
                  onClick={() =>
                    suspend.mutate({
                      userId: account.userId,
                      data: { suspended: true, reason: reason.trim() },
                    })
                  }
                  language={language}
                  testId={`admin-suspend-${account.userId}`}
                >
                  {t(ADMIN.suspend)}
                </RowButton>
              </span>,
            ])}
            empty={accountsState === "loading" ? t(ADMIN.loading) : t(ADMIN.nobodyYet)}
          />
        )}
      </section>

      {/* ── The waiting list ─────────────────────────────────────────────
          Beside the accounts rather than on a screen of its own, because it is
          the same question a fortnight earlier: who is here. */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xl font-semibold">{t(ADMIN.waitlistTitle)}</h2>
          <span className="text-sm text-muted-foreground">
            {waitlist.data ? fmt(ADMIN.waiting, waitlist.data.total) : ""}
          </span>
        </div>
        {/*
          The only table here made of people who are not customers. Shown
          with the page each came from, because the landing page and the
          waiting-list domain are two different promises and this column is
          the only place a difference between them will appear.
        */}
        {loadState(waitlist) === "loading" ? (
          <div className="text-sm text-muted-foreground py-6">{t(ADMIN.loading)}</div>
        ) : loadState(waitlist) === "failed" ? (
          <Problem>{t(LOAD.couldNotLoad)}</Problem>
        ) : (
          <Table
            head={[t(ADMIN.headEmail), t(ADMIN.headFrom), t(ADMIN.headJoined)]}
            empty={t(ADMIN.nobodyAsked)}
            rows={(waitlist.data?.entries ?? []).map((entry) => [
              entry.email,
              entry.source ?? EMPTY,
              dates.moment(entry.createdAt),
            ])}
          />
        )}
      </section>
    </div>
  );

  const rendersPanel = (
    <div className="space-y-6" data-testid="admin-panel-renders">
      {reasonField}
      <section>
        {/* Five filters and a heading do not fit a phone in one line, and a
            row that does not wrap does not shrink either — it just leaves the
            screen, and takes the page's scroll width with it. */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3">
          <h2 className="text-xl font-semibold">{t(ADMIN.recentRenders)}</h2>
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
                {status || t(ADMIN.all)}
              </button>
            ))}
          </div>
        </div>
        {jobsState === "failed" ? (
          <Problem>{t(LOAD.couldNotLoad)}</Problem>
        ) : (
          <Table
            head={[
              t(ADMIN.headStatus),
              t(ADMIN.headProject),
              t(ADMIN.headBilled),
              t(ADMIN.headCreated),
              t(ADMIN.headFinished),
              t(ADMIN.headWhatTheyWereTold),
              t(ADMIN.headWhatItDid),
              "",
            ]}
            rows={(jobs.data?.jobs ?? []).map((job) => [
              <Badge key="status" tone={job.unattended ? "bad" : toneOfStatus(job.status)}>
                {job.unattended ? fmt(ADMIN.unattendedSuffix, job.status) : job.status}
              </Badge>,
              <span key="project" className="font-mono text-xs">{job.projectId.slice(0, 8)}</span>,
              job.billedSeconds === null ? EMPTY : `${Math.round(job.billedSeconds)}s`,
              dates.moment(job.createdAt),
              job.finishedAt ? dates.moment(job.finishedAt) : EMPTY,
              /*
                Two sentences, because they answer different questions and
                this column had only ever carried the first.

                `error` is what the customer was told. For anything that is
                not a plan, length or transfer problem that reads "Rendering
                failed. We are looking into it." — so an operator opening
                this screen for a failed render was shown our own
                reassurance, while the actual reason sat in a log line on
                Fly. Logs you have to go and read are the shape the August
                outage had.

                Verbatim, and not truncated to something tidy: the whole
                value of this column is that it says what actually happened.
              */
              job.error || job.errorDetail ? (
                <span key="err" className="block max-w-xs whitespace-normal">
                  <span dir="auto">{job.error ?? EMPTY}</span>
                  {job.errorDetail && job.errorDetail !== job.error ? (
                    <span
                      className="block mt-1 font-mono text-[11px] leading-snug text-muted-foreground break-words"
                      data-testid={`admin-job-detail-${job.id}`}
                    >
                      {job.errorDetail}
                    </span>
                  ) : null}
                </span>
              ) : (
                EMPTY
              ),
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
                  language={language}
                  testId={`admin-requeue-${job.id}`}
                >
                  {t(ADMIN.requeue)}
                </RowButton>
              ),
            ])}
            empty={jobsState === "loading" ? t(ADMIN.loading) : t(ADMIN.noRendersYet)}
          />
        )}
      </section>
    </div>
  );

  /*
    ── Posting ───────────────────────────────────────────────────────────

    Its own screen rather than four more cards under the renders, because it is
    a different queue with a different failure. The render queue is about
    whether video is moving; this is about whether the things people promised
    their audience actually went out.

    Rendered only where the API answers with it, so a console pointed at a
    deployment that predates it draws the rest of the screen rather than a row
    of zeroes that look like a healthy quiet.
  */
  const postingKinds: AttentionKind[] = ["post-overdue", "post-stranded", "account-disconnected"];
  const postingPanel = (
    <div className="space-y-6" data-testid="admin-panel-posting">
      {data.posting ? (
        <section data-testid="admin-posting">
          <h2 className="text-xl font-semibold mb-3">{t(ADMIN.postingTitle)}</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card
              language={language}
              label={t(ADMIN.overdue)}
              value={data.posting.overdue}
              hint={t(ADMIN.overdueHint)}
              alarming={data.posting.overdue > 0}
            />
            <Card
              language={language}
              label={t(ADMIN.midSend)}
              value={data.posting.stranded}
              hint={t(ADMIN.midSendHint)}
              alarming={data.posting.stranded > 0}
            />
            <Card language={language} label={t(ADMIN.dueWithinHour)} value={data.posting.dueSoon} />
            <Card
              language={language}
              label={t(ADMIN.postedDay)}
              value={data.posting.publishedLastDay}
              hint={
                data.posting.missedLastDay > 0
                  ? fmt(ADMIN.tooLateToSend, data.posting.missedLastDay)
                  : undefined
              }
            />
          </div>
        </section>
      ) : null}

      {/*
        And the rows behind those three cards, which is the whole reason this
        screen is worth opening rather than reading. Drawn from the queue, so
        there is one definition of "overdue" in the product and both screens
        use it.
      */}
      <section>
        <h2 className="text-xl font-semibold mb-3">{t(ADMIN.queueTitle)}</h2>
        <Table
          head={[t(ADMIN.headWhat), t(ADMIN.headSince), t(ADMIN.headWhose), t(ADMIN.headDetail)]}
          rows={(queue?.items ?? [])
            .filter((item) => postingKinds.includes(item.kind))
            .map((item) => [
              t(KIND_LABEL[item.kind]),
              item.at ? dates.moment(item.at) : EMPTY,
              item.email ?? (item.userId ? item.userId.slice(0, 8) : EMPTY),
              <span key="d" dir="auto" className="block max-w-xs whitespace-normal">
                {[item.platform, item.handle, item.detail].filter(Boolean).join(` ${EMPTY} `) || EMPTY}
              </span>,
            ])}
          empty={queue === null ? t(ADMIN.loading) : t(ADMIN.queueClear)}
        />
      </section>
    </div>
  );

  const moneyPanel = (
    <div className="space-y-6" data-testid="admin-panel-money">
      <section>
        <h2 className="text-xl font-semibold mb-3">{t(ADMIN.subscriptions)}</h2>
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
            {fmt(ADMIN.monthlyRecurring, data.revenue.monthlyRecurringUsd)}
          </div>
        </div>

        <h3 className="text-sm font-semibold text-muted-foreground mb-2">
          {t(ADMIN.lastBillingEvents)}
        </h3>
        <Table
          head={[
            t(ADMIN.headType),
            t(ADMIN.headEmail),
            t(ADMIN.headPlan),
            t(ADMIN.headReceived),
            t(ADMIN.headApplied),
            t(ADMIN.headOutcome),
          ]}
          rows={data.billing.map((event) => [
            event.type,
            event.email ?? EMPTY,
            event.plan ?? EMPTY,
            dates.moment(event.receivedAt),
            <Badge key="applied" tone={event.applied ? "good" : "bad"}>
              {event.applied ? t(ADMIN.yes) : t(ADMIN.no)}
            </Badge>,
            event.outcome ?? EMPTY,
          ])}
          empty={t(ADMIN.nothingFromFreemius)}
        />
      </section>
    </div>
  );

  const systemPanel = (
    <div className="space-y-8" data-testid="admin-panel-system">
      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">{workerCard}</section>

      {/*
        Nothing to show, and which kind of nothing.

        Two thirds of this screen comes from one hand-fetched endpoint, and
        when it does not answer the screen drew a single card and a great deal
        of white. Silence and "everything is fine" look identical, which is the
        one confusion this whole console exists to prevent.
      */}
      {deployment === null ? (
        <Empty>{deploymentAnswered ? t(ADMIN.deploymentSilent) : t(ADMIN.loading)}</Empty>
      ) : null}

      {/* ── What we are storing, and what it costs to move ───────────
          The largest line on the bill of a video product is neither compute
          nor the database. It is egress, and this product's own loop — ask
          again, it is free — multiplies it: a published video costs three or
          more full downloads of its source.

          Both numbers are measured. `jobs.bytes_in` is counted off the wire
          by the worker; the stored total comes from `storage.objects`, which
          knows the exact size of every object. The comparison is here so the
          decision to move object stores is made on our number rather than on
          somebody's estimate in a document. */}
      {deployment?.usage ? (
        <section className="rounded-xl border border-border bg-card p-4 space-y-3" data-testid="admin-usage">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <h2 className="text-sm font-semibold">{t(ADMIN.usageTitle)}</h2>
            <span className="text-xs text-muted-foreground">{t(ADMIN.thisMonth)}</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Card
              label={t(ADMIN.stored)}
              value={
                deployment.usage.storedBytes === null
                  ? t(ADMIN.notKnown)
                  : gigabytes(deployment.usage.storedBytes)
              }
              hint={
                deployment.usage.objects === null
                  ? t(ADMIN.storageSilent)
                  : fmt(ADMIN.objects, deployment.usage.objects)
              }
            />
            <Card
              label={t(ADMIN.pulledByRenders)}
              value={gigabytes(deployment.usage.egressBytes)}
              hint={
                deployment.usage.unmeasuredRenders > 0
                  ? fmt(
                      ADMIN.countedAndBefore,
                      deployment.usage.measuredRenders,
                      deployment.usage.unmeasuredRenders,
                    )
                  : fmt(ADMIN.countedRenders, deployment.usage.measuredRenders)
              }
            />
            <Card
              label={t(ADMIN.egressCost)}
              value={egressCost(deployment.usage.egressBytes, language)}
              hint={t(ADMIN.egressOnR2)}
            />
          </div>
          {deployment.usage.unmeasuredRenders > 0 ? (
            <p className="text-xs text-muted-foreground">
              {/* Null is not zero. A render from before the column existed
                  moved bytes nobody counted, and saying so keeps the total
                  from reading as smaller than it was. */}
              {t(ADMIN.unmeasured)}
            </p>
          ) : null}
        </section>
      ) : null}

      {/* ── Where this deployment disagrees with the code ────────────
          A worker that is up and a bucket that refuses PNG look identical from
          every other card on this console, and the second one is the kind of
          thing that ships for weeks: the browser talks to Storage directly, so
          nothing we log ever sees it.

          Every finding is listed here, including the ones that passed. On the
          first screen only the disagreements were worth the space; on the
          screen somebody opens to ask "what has been checked", a question that
          was asked and answered is the point. */}
      {deployment ? (
        <section
          className="rounded-xl border border-border bg-card p-4 space-y-3"
          data-testid="admin-deployment"
        >
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <h2 className="text-sm font-semibold">{t(ADMIN.deploymentTitle)}</h2>
            <span className="text-xs text-muted-foreground">
              {fmt(
                ADMIN.deploymentSummary,
                deployment.summary.wrong,
                deployment.summary.unknown,
                deployment.summary.ok,
              )}
            </span>
          </div>
          {deployment.summary.wrong + deployment.summary.unknown === 0 ? (
            <p className="text-sm text-success">{t(ADMIN.deploymentAllWell)}</p>
          ) : null}
          <ul className="space-y-2">
            {deployment.findings.map((f) => (
              <li
                key={f.id}
                className={`rounded-lg border px-3 py-2 text-sm ${
                  f.verdict === "wrong"
                    ? "border-destructive/40 bg-destructive/5"
                    : f.verdict === "unknown"
                      ? "border-warning/30 bg-warning/5"
                      : "border-border"
                }`}
                data-testid={`deployment-${f.id}`}
              >
                <div className="font-mono text-xs text-muted-foreground">{f.id}</div>
                {/* Both halves, always. "Mismatch" is a line somebody
                    scrolls past; the pair is a line somebody fixes. */}
                <div className="mt-1">
                  <span className="text-muted-foreground">{t(ADMIN.expects)}</span> {f.expected}
                </div>
                <div>
                  <span className="text-muted-foreground">{t(ADMIN.actually)}</span> {f.actual}
                </div>
                {f.consequence && f.verdict !== "ok" ? (
                  <div className="mt-1 text-muted-foreground">{f.consequence}</div>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );

  const logPanel = (
    <div className="space-y-6" data-testid="admin-panel-log">
      <section>
        <h2 className="text-xl font-semibold mb-1">{t(ADMIN.logTitle)}</h2>
        <p className="text-sm text-muted-foreground mb-3">{t(ADMIN.logLead)}</p>
        {actionsState === "failed" ? (
          <Problem>{t(LOAD.couldNotLoad)}</Problem>
        ) : (
          <Table
            head={[
              t(ADMIN.headWhen),
              t(ADMIN.headAction),
              t(ADMIN.headSubject),
              t(ADMIN.headReason),
              t(ADMIN.headDetail),
            ]}
            rows={(actions.data?.actions ?? []).map((entry) => [
              dates.moment(entry.createdAt),
              entry.action,
              entry.subjectUserId ?? entry.subjectJobId ?? EMPTY,
              entry.reason,
              entry.detail ? JSON.stringify(entry.detail) : EMPTY,
            ])}
            empty={actionsState === "loading" ? t(ADMIN.loading) : t(ADMIN.nothingDoneYet)}
          />
        )}
      </section>
    </div>
  );

  const panels: Record<Section, React.ReactNode> = {
    insights,
    attention: attentionPanel,
    accounts: accountsPanel,
    renders: rendersPanel,
    posting: postingPanel,
    money: moneyPanel,
    system: systemPanel,
    log: logPanel,
  };

  /*
    When the numbers on the screen were last true.

    Read off the query rather than ticked by a timer: the overview refetches
    every thirty seconds, so this label changes when the data does. A clock
    counting up beside stale numbers would be the console's own version of the
    progress bar that moves while nothing is happening.
  */
  const readAgo = Math.round((Date.now() - (overview.dataUpdatedAt || Date.now())) / 1000);

  return (
    <div className="min-h-screen bg-background text-foreground md:flex">
      {/*
        The rail, and it is one element rather than two.

        A sticky column on a desktop and a band across the top of a phone, from
        the same markup and the same list. Two of them would be two things to
        keep in step, and the phone copy is the one that would fall behind:
        this console is opened from a phone at the moment a render is failing,
        which is the moment nobody is checking whether the navigation matches.

        It sits on the design system's own sidebar tokens, which existed and
        had never been used by anything. That is what makes this read as a tool
        rather than as another page of the product: the chrome is a different
        surface from the content, in both themes, without a hex anywhere.
      */}
      <nav
        data-testid="admin-rail"
        aria-label={t(ADMIN.title)}
        className="bg-sidebar text-sidebar-foreground border-b md:border-b-0 md:border-e border-sidebar-border md:w-60 md:shrink-0 md:h-screen md:sticky md:top-0 md:flex md:flex-col"
      >
        <div className="flex items-center gap-2.5 px-4 py-3.5 md:py-5 md:border-b border-sidebar-border">
          <span
            aria-hidden="true"
            className="w-9 h-9 rounded-xl bg-sidebar-primary text-sidebar-primary-foreground grid place-items-center shrink-0"
          >
            <Gauge className="w-5 h-5" />
          </span>
          <div className="min-w-0">
            <div className="text-sm font-semibold leading-tight truncate">{t(ADMIN.title)}</div>
            <div className="text-[11px] uppercase tracking-[0.14em] opacity-60 leading-tight">
              {t(ADMIN.consoleTag)}
            </div>
          </div>
        </div>

        <div className="md:flex-1 md:overflow-y-auto px-3 pb-3 md:py-4">
          <div className="flex md:block gap-2 overflow-x-auto md:overflow-visible md:space-y-5 -mx-3 px-3 md:mx-0 md:px-0">
            {(["overview", "platform"] as const).map((group) => (
              <div key={group} className="flex md:block gap-2 md:space-y-0.5">
                <div className="hidden md:block text-[11px] uppercase tracking-[0.14em] opacity-50 px-3 pb-1.5">
                  {t(group === "overview" ? ADMIN.navOverview : ADMIN.navPlatform)}
                </div>
                {SECTIONS.filter((entry) => entry.group === group).map((entry) => {
                  const on = entry.id === section;
                  return (
                    <Link
                      key={entry.id}
                      href={entry.href}
                      data-testid={`admin-nav-${entry.id}`}
                      aria-current={on ? "page" : undefined}
                      className={`flex items-center gap-2.5 whitespace-nowrap rounded-lg px-3 min-h-11 md:min-h-0 md:py-2 text-sm transition-colors ${
                        on
                          ? "bg-sidebar-primary text-sidebar-primary-foreground font-medium"
                          : "opacity-70 hover:opacity-100 hover:bg-sidebar-accent"
                      }`}
                    >
                      <entry.Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                      <span className="md:flex-1">{t(entry.label)}</span>
                      {/*
                        One badge, on one entry, and only when it is not zero. A
                        count beside every heading is decoration; a count that
                        appears only when somebody is needed is a signal.
                      */}
                      {entry.id === "attention" && urgent > 0 ? (
                        <span
                          data-testid="admin-nav-urgent"
                          className={`inline-flex items-center justify-center rounded-full text-[11px] font-semibold min-w-5 px-1.5 tabular-nums ${
                            on
                              ? "bg-sidebar-primary-foreground text-sidebar-primary"
                              : "bg-destructive text-destructive-foreground"
                          }`}
                        >
                          {urgent}
                        </span>
                      ) : null}
                    </Link>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        {/*
          The foot of the rail, on a desktop only.

          The worker's state is here as well as on two screens because it is the
          one fact that changes what every other number on this console means,
          and the rail is the only thing visible from all eight of them. On a
          phone the band is already three lines tall and this would be a fourth
          before any content.
        */}
        <div className="hidden md:block px-3 py-3 border-t border-sidebar-border space-y-1">
          <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
            <span
              aria-hidden="true"
              className={`w-2 h-2 rounded-full shrink-0 ${
                claimsOnlineButIsStale
                  ? "bg-warning"
                  : worker.online
                    ? "bg-success"
                    : "bg-destructive"
              }`}
            />
            <span className="opacity-70 truncate">
              {claimsOnlineButIsStale
                ? t(ADMIN.workerUnclear)
                : worker.online
                  ? t(ADMIN.workerOnline)
                  : t(ADMIN.workerOffline)}
            </span>
          </div>
          <Link
            href="/dashboard"
            className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm opacity-70 hover:opacity-100 hover:bg-sidebar-accent transition-colors"
          >
            <ArrowLeft className="w-4 h-4 rtl:rotate-180 shrink-0" aria-hidden="true" />
            <span>{t(ADMIN.navBack)}</span>
          </Link>
        </div>
      </nav>

      <div className="flex-1 min-w-0">
        {/*
          The screen's own header, and it says what the screen is for.

          A heading names a table. It does not say what a bad number in it would
          mean, and the person reading this at two in the morning is the one
          least able to reconstruct that from the column titles.
        */}
        <header className="sticky top-0 z-20 bg-background/85 backdrop-blur border-b border-border">
          <div className="px-4 md:px-8 py-4 md:py-5 flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="text-xl md:text-2xl font-bold leading-tight">{t(here?.label ?? ADMIN.title)}</h1>
              <p className="text-sm text-muted-foreground mt-1">{t(here?.lead ?? ADMIN.lead)}</p>
            </div>
            <div className="hidden sm:flex items-center gap-2 text-xs text-muted-foreground shrink-0 pt-1">
              <span
                aria-hidden="true"
                className="w-1.5 h-1.5 rounded-full bg-success animate-pulse shrink-0"
              />
              <span className="tabular-nums">
                {readAgo < 5 ? t(ADMIN.readJustNow) : fmt(ADMIN.readAt, elapsed(readAgo, language))}
              </span>
            </div>
          </div>
        </header>

        <main className="px-4 md:px-8 py-6 md:py-8 pb-20">{panels[section]}</main>
      </div>
    </div>
  );
}

function RowButton({
  children,
  onClick,
  disabled,
  testId,
  language = "en",
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled: boolean;
  testId: string;
  language?: Language;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      title={disabled ? say(ADMIN.typeReasonFirst, language) : undefined}
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

/**
 * The first line on the screen, and usually the only one worth reading.
 *
 * Four things can be wrong at once and they are not equally urgent, so they
 * come out in the order somebody would act on them: no machine at all beats a
 * queue nobody is serving, which beats renders that failed, which beats a
 * payment that did not apply. The wording says what to do, not what is true —
 * "no machine is listening" is a fact; "nothing will render until a machine
 * comes back" is the thing you needed to know.
 */
function Attention({
  language,
  worker,
  unattended,
  failedLastDay,
  unappliedBilling,
  posting,
  href,
  open,
}: {
  language: Language;
  worker: { online: boolean; unclear: boolean };
  unattended: number;
  failedLastDay: number;
  unappliedBilling: number;
  posting?: {
    overdue: number;
    stranded: number;
    accountsNeedingReconnect: number;
  };
  /**
   * Where the sentences stop and the rows begin.
   *
   * This banner says how many and the queue says which, and until there were
   * two screens the second half of that sentence had nowhere to go: an
   * operator read "two posts are past their time" and then went looking. One
   * link, on the one banner, and only when there is something to look at.
   */
  href: string;
  open: string;
}) {
  /*
    Resolved here rather than by a hook, because this is a plain function that
    builds a list of sentences and the language is the only thing it needs from
    the screen. Passed in for the same reason `waitInWords` takes one: it keeps
    the sentence-building a pure function of its inputs.
  */
  const said = (phrase: Phrase) => say(phrase, language);
  const shaped = <A extends unknown[]>(pattern: Template<A>, ...args: A) => fill(pattern, language, ...args);

  const problems: string[] = [];
  if (worker.unclear) {
    problems.push(said(ADMIN.workerContradicts));
  } else if (!worker.online) {
    problems.push(said(ADMIN.nobodyListening));
  }
  if (unattended > 0) {
    problems.push(shaped(ADMIN.unattendedProblem, unattended));
  }
  if (failedLastDay > 0) {
    problems.push(shaped(ADMIN.failedProblem, failedLastDay));
  }
  /*
    The quietest fault on this screen.

    A render nobody claims produces somebody waiting and then complaining. A
    *post* nobody claims produces nothing at all: it was due at 9pm, the person
    who scheduled it was not watching, and they find out days later from a feed
    with a hole in it. Nothing errors, nothing retries, and no support ticket
    describes it. So it is stated in the verdict rather than left as a number
    on a card somebody has to know to read.

    Above the billing line, because a post that did not go out is a promise the
    product broke without telling anybody, and an unapplied payment is at least
    something the payer will mention.
  */
  if (posting && posting.overdue > 0) {
    problems.push(shaped(ADMIN.overdueProblem, posting.overdue));
  }
  if (posting && posting.stranded > 0) {
    problems.push(shaped(ADMIN.strandedProblem, posting.stranded));
  }
  if (posting && posting.accountsNeedingReconnect > 0) {
    problems.push(shaped(ADMIN.reconnectProblem, posting.accountsNeedingReconnect));
  }

  if (unappliedBilling > 0) {
    problems.push(shaped(ADMIN.billingProblem, unappliedBilling));
  }

  if (problems.length === 0) {
    return (
      <section
        className="rounded-xl border border-success/40 bg-success/10 px-4 py-3 text-sm"
        data-testid="admin-attention-clear"
      >
        <span className="font-medium text-success">{said(ADMIN.nothingNeedsYou)}</span>{" "}
        <span className="text-muted-foreground">{said(ADMIN.allClear)}</span>
      </section>
    );
  }

  return (
    <section
      className="rounded-xl border border-destructive/50 bg-destructive/10 px-4 py-3"
      data-testid="admin-attention"
    >
      <div className="flex items-center gap-2 text-sm font-semibold text-destructive mb-2">
        <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
        {shaped(ADMIN.thingsNeedYou, problems.length)}
      </div>
      {/*
        One row each, separated, rather than five sentences in a block.

        Five paragraphs of prose in a red box is a wall, and a wall gets read
        as one thing that is wrong instead of as five. The rule between them is
        what makes the count at the top countable by eye.
      */}
      <ul className="divide-y divide-destructive/20 border-y border-destructive/20">
        {problems.map((problem) => (
          <li key={problem} className="flex gap-2.5 py-2 text-sm text-foreground leading-snug">
            <span aria-hidden="true" className="mt-1.5 w-1.5 h-1.5 rounded-full bg-destructive shrink-0" />
            <span>{problem}</span>
          </li>
        ))}
      </ul>
      {/*
          A link at the size of a thumb.

          It was an underlined sentence 113px by 20px, which is a link on a
          laptop and a miss on a phone — and this banner exists for the moment
          somebody opens the console away from a desk. Every other control in
          the product answers to the same floor.
      */}
      <Link
        href={href}
        data-testid="admin-attention-open"
        className="inline-flex items-center mt-2 px-3 min-h-11 sm:min-h-0 sm:py-1.5 rounded-lg border border-destructive/50 text-sm font-medium text-destructive hover:bg-destructive/10 transition-colors"
      >
        {open}
      </Link>
    </section>
  );
}

function Card({
  language = "en",
  label,
  value,
  hint,
  alarming = false,
  Icon,
  trend,
  /** Which way is good. Failures going up is not the same news as signups. */
  upIsGood = true,
  testId,
}: {
  language?: Language;
  label: string;
  value: string | number;
  hint?: string;
  alarming?: boolean;
  Icon?: LucideIcon;
  trend?: AdminTrend;
  upIsGood?: boolean;
  testId?: string;
}) {
  const change = trend ? weekOnWeek(trend.thisWeek, trend.lastWeek, language) : null;
  const good = change && change.direction !== "flat" && (change.direction === "up") === upIsGood;
  const bad = change && change.direction !== "flat" && !good;

  return (
    <div
      data-testid={testId}
      /*
        A card that can be alarming, and a card that is alarming, drawn as two
        different things rather than as one thing in two colours.

        A whole tile filled red is loud enough that a screen with three of them
        has no order left in it, and this console can legitimately have three.
        The fill is kept faint and the weight moved to a bar down the leading
        edge: at a glance the eye counts bars, and the numbers stay readable.
      */
      className={`relative overflow-hidden rounded-xl border p-4 transition-colors ${
        alarming
          ? "border-destructive/40 bg-destructive/[0.06]"
          : "border-border bg-card hover:border-border/80"
      }`}
    >
      {alarming ? (
        <span aria-hidden="true" className="absolute inset-y-0 start-0 w-1 bg-destructive" />
      ) : null}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        {Icon ? (
          <span
            aria-hidden="true"
            className={`w-6 h-6 rounded-md grid place-items-center shrink-0 ${
              alarming ? "bg-destructive/15 text-destructive" : "bg-muted text-muted-foreground"
            }`}
          >
            <Icon className="w-3.5 h-3.5" />
          </span>
        ) : null}
        {/*
          Wrapping, not truncating. At 390px "Minutes this month" became
          "Minutes this ..." and "Waiting in queue" became "Waiting in q...",
          which is a label that has had the informative half removed. Two lines
          costs eleven pixels.
        */}
        <span className="leading-snug">{label}</span>
      </div>
      <div className="mt-2 text-2xl font-bold tabular-nums leading-none">{value}</div>
      {change ? (
        <div className="mt-2">
          <span
            /*
              12px and not 11. `tools/viewport-test.mjs` holds a floor under
              every run of body text longer than a dozen characters, and "up
              67% on last week" is one: a delta nobody can read on a phone is a
              delta that may as well not be drawn.
            */
            className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium ${
              good
                ? "bg-success/15 text-success"
                : bad
                  ? "bg-warning/15 text-warning"
                  : "bg-muted text-muted-foreground"
            }`}
          >
            {change.text}
          </span>
        </div>
      ) : null}
      {hint ? <div className="text-xs text-muted-foreground mt-2 leading-snug">{hint}</div> : null}
      {trend ? (
        /*
           The line takes the card's colour, not its own, when the card is
           already alarming. A green sparkline inside a red card is two signals
           disagreeing about one object, and the one that is wrong is the small
           one: the card went red for a reason the fortnight does not know
           about.

           Full width along the foot rather than tucked beside the figure. It
           was 96px wide in a card three times that, which is the size at which
           a fortnight is a texture rather than a shape.
        */
        <Sparkline
          values={trend.daily}
          width={240}
          height={32}
          className={`mt-3 w-full ${
            alarming ? "text-destructive" : good ? "text-success" : bad ? "text-warning" : "text-muted-foreground"
          }`}
        />
      ) : null}
    </div>
  );
}

/**
 * A word about a row, drawn as a word about a row.
 *
 * Job states, event types and plan names arrived here as bare text in a cell
 * and read as data that had been forgotten about. They are a closed vocabulary
 * and the screen is scanned rather than read, so they get a shape: a pill, in
 * one of four tones, and the tone is a fact rather than decoration.
 */
function Badge({
  children,
  tone = "neutral",
  testId,
}: {
  children: React.ReactNode;
  tone?: "neutral" | "bad" | "warn" | "good";
  testId?: string;
}) {
  const skin = {
    neutral: "border-border bg-muted/60 text-muted-foreground",
    bad: "border-destructive/40 bg-destructive/10 text-destructive",
    warn: "border-warning/40 bg-warning/10 text-foreground",
    good: "border-success/40 bg-success/10 text-success",
  }[tone];
  return (
    <span
      data-testid={testId}
      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs whitespace-nowrap ${skin}`}
    >
      {children}
    </span>
  );
}

/**
 * Which tone a render state gets.
 *
 * Read off the vocabulary the queue actually writes (`lib/db/src/schema/jobs.ts`:
 * queued to running to done or failed) rather than off a guess, and anything
 * unrecognised stays neutral. A default that guessed would eventually paint a
 * new state green.
 */
/**
 * How much of an allowance is gone, drawn.
 *
 * It turns amber before it turns red, because the row worth acting on is the
 * one that is *about* to be refused a render rather than the one that already
 * has been. The bar is capped at full: an account over its plan through a
 * grant is at its ceiling, not at a hundred and forty per cent of a bar.
 */
function Meter({ used, of }: { used: number; of: number }) {
  if (of <= 0) return null;
  const share = Math.min(1, used / of);
  return (
    <span
      aria-hidden="true"
      className="block h-1.5 w-full rounded-full bg-muted overflow-hidden mb-1"
    >
      <span
        className={`block h-full rounded-full ${
          share >= 1 ? "bg-destructive" : share >= 0.8 ? "bg-warning" : "bg-primary"
        }`}
        style={{ width: `${Math.max(2, share * 100)}%` }}
      />
    </span>
  );
}

/** A fortnight added up, for the number on a legend chip. */
function sum(values: number[]): number {
  return values.reduce((total, one) => total + one, 0);
}

function toneOfStatus(status: string): "neutral" | "bad" | "warn" | "good" {
  if (status.startsWith("failed")) return "bad";
  if (status.startsWith("done")) return "good";
  if (status.startsWith("running")) return "warn";
  return "neutral";
}

/**
 * Two letters standing for an address, and nothing standing for the absence of
 * one.
 *
 * Rows of raw email in a first column are hard to tell apart at a glance, and
 * this is a screen somebody scans for the row they were looking for. Derived
 * from the address rather than stored, so there is nothing new to keep true.
 */
function Initials({ of }: { of: string | null }) {
  const letters = (of ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase();
  return (
    <span
      aria-hidden="true"
      className="w-7 h-7 rounded-full bg-primary/15 text-primary grid place-items-center text-[11px] font-semibold shrink-0"
    >
      {letters || "?"}
    </span>
  );
}

/**
 * An empty table that says what would be in it.
 *
 * "Nobody yet." in grey eight-point type is indistinguishable from a table
 * that failed to load, which is the one distinction this console exists to
 * make. An icon, the sentence, and enough space to look deliberate.
 */
function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border py-10 px-6 text-center">
      <Inbox className="w-6 h-6 mx-auto text-muted-foreground/60" aria-hidden="true" />
      <p className="text-sm text-muted-foreground mt-2">{children}</p>
    </div>
  );
}

/** A titled box, so a screen is a set of things rather than a scroll. */
function Panel({
  title,
  aside,
  children,
  testId,
}: {
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <section data-testid={testId} className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between gap-3 flex-wrap px-4 py-3 border-b border-border bg-muted/30">
        <h2 className="text-sm font-semibold">{title}</h2>
        {aside}
      </div>
      <div className="p-4">{children}</div>
    </section>
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
  if (rows.length === 0) return <Empty>{empty}</Empty>;
  return (
    // `min-w-0` and `max-w-full`, or `overflow-x-auto` does nothing.
    // A flex or grid child's `min-width` defaults to `auto` — the width of its
    // own content — so this box grew to the table's 1039px and took the page
    // with it. The console scrolled sideways on a phone, which is exactly the
    // device somebody opens it on: the moment a render is failing and they are
    // not at a desk.
    <div className="w-full min-w-0 max-w-full overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="bg-muted/50">
            {head.map((cell, i) => (
              <th
                key={cell || `blank-${i}`}
                /*
                  Uppercase, small and quiet, which is the difference between a
                  header row and a first row of data. These were the same size
                  and weight as the cells under them, so every table on this
                  console began with a row that looked like a record.
                */
                className="text-start text-[11px] font-medium uppercase tracking-wider text-muted-foreground px-4 py-2.5 whitespace-nowrap border-b border-border"
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-t border-border/50 hover:bg-muted/30 transition-colors">
              {row.map((cell, j) => (
                <td
                  key={j}
                  className="px-4 py-3 align-top max-w-md break-words text-muted-foreground first:text-foreground"
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
function elapsed(seconds: number, language: Language = "en"): string {
  // One letter a unit, in both languages: ث س د و ي against s m h d. A
  // duration on a card is read at a glance beside a number, and a spelled-out
  // Arabic word there is wider than the card and slower to read than the
  // figure it qualifies.
  const [sec, min, hour, day] = language === "ar" ? ["ث", "د", "س", "ي"] : ["s", "m", "h", "d"];
  if (seconds < 60) return `${seconds}${sec}`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}${min}`;
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    return m > 0 ? `${h}${hour} ${m}${min}` : `${h}${hour}`;
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.round((seconds % 86400) / 3600);
  return h > 0 ? `${d}${day} ${h}${hour}` : `${d}${day}`;
}
