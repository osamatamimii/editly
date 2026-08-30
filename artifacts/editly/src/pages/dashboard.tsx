import { useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { format } from "date-fns";
import { 
  useListProjects, 
  useGetDashboardStats, 
  useCreateProject, 
  useDeleteProject,
  useGetSubscription,
  getListProjectsQueryKey,
  getGetDashboardStatsQueryKey,
  getGetSubscriptionQueryKey,
  useGetAdminOverview,
  getGetAdminOverviewQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Video, Plus, Clock, PlayCircle, CheckCircle2,
  Trash2, AlertCircle, Loader2, Sparkles, Activity, TrendingUp, UserRound,
  UploadCloud, Gauge
} from "lucide-react";
import { BackButton } from "@/components/back-button";
import { ProjectArt } from "@/components/project-art";
import { ThemeToggle } from "@/components/theme-toggle";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import {
  deleteProjectVideos,
  usePlayableVideo,
  ACCEPTED_VIDEO_TYPES,
  MAX_UPLOAD_BYTES,
  formatBytes,
} from "@/lib/video-storage";
import { stashPendingUpload, titleFromFilename } from "@/lib/pending-upload";
import { loadState } from "@/lib/load-state";
import { FREE_TIER } from "@/lib/pricing";
import { LoadFailed } from "@/components/load-failed";
import { ToastAction } from "@/components/ui/toast";
import { Badge } from "@/components/ui/badge";

/**
 * A project's poster frame. The bucket is private, so the stored key has to be
 * signed before it can be shown — and each card signs its own rather than the
 * dashboard signing all of them, so one failure costs one card.
 */
function ProjectThumbnail({ project }: { project: { title: string; thumbnailPath?: string | null; thumbnailUrl?: string | null } }) {
  const { url } = usePlayableVideo(project.thumbnailPath ?? project.thumbnailUrl);
  if (!url) return null;
  return (
    <img
      src={url}
      alt={project.title}
      loading="lazy"
      className="absolute inset-0 w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity group-hover:scale-105 duration-500"
      data-testid="img-project-thumbnail"
    />
  );
}

/**
 * The fallback for a project that has a clip but no stored poster.
 *
 * Rather than a grey camera icon, the card shows the clip itself, parked on a
 * frame a little way in via a media fragment — the browser draws that frame
 * without playing anything and without any JavaScript. It costs a range request
 * rather than a whole download.
 *
 * This matters because a poster is only written when a project is uploaded or
 * opened. Everything made before posters existed would otherwise stay a grey
 * rectangle until someone happened to open it, and the library is exactly the
 * screen where you should be able to recognise your own work at a glance.
 *
 * The icon underneath stays put: if a browser will not decode the file, a
 * silent black rectangle is the thing this was meant to stop.
 */
function ProjectClipFrame({
  project,
}: {
  project: { title: string; videoPath?: string | null; videoUrl?: string | null; duration?: number | null };
}) {
  const { url } = usePlayableVideo(project.videoPath ?? project.videoUrl);
  if (!url) return null;
  const at = project.duration && project.duration > 4 ? Math.round(project.duration * 0.25) : 1;
  return (
    <video
      src={`${url}#t=${at}`}
      preload="metadata"
      muted
      playsInline
      className="absolute inset-0 w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity group-hover:scale-105 duration-500"
      data-testid="video-project-frame"
    />
  );
}

export default function Dashboard() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const createFileRef = useRef<HTMLInputElement>(null);
  const [isDropActive, setIsDropActive] = useState(false);

  const statsQuery = useGetDashboardStats({
    query: { queryKey: getGetDashboardStatsQueryKey() }
  });
  // Asking the server whether this person is an admin, by asking for the thing
  // only an admin can have. Everyone else gets a 404, which is not retried and
  // costs one request. Nothing about the answer is stored or trusted beyond
  // showing a link — the console asks again for itself.
  const adminQuery = useGetAdminOverview({
    query: { queryKey: getGetAdminOverviewQueryKey(), retry: false, staleTime: 5 * 60_000 }
  });
  const isAdmin = adminQuery.isSuccess;
  const projectsQuery = useListProjects({
    query: { queryKey: getListProjectsQueryKey() }
  });
  const subscriptionQuery = useGetSubscription({
    query: { queryKey: getGetSubscriptionQueryKey() }
  });

  const { data: stats } = statsQuery;
  const { data: projects } = projectsQuery;
  const { data: subscription } = subscriptionQuery;

  // Every screen used to know only two states, loading and loaded, and a failed
  // query is neither: it leaves `data` undefined, which renders as an empty
  // list. That is how a total outage looked like an empty account for two days.
  const statsState = loadState(statsQuery);
  const projectsState = loadState(projectsQuery, (list) => list.length === 0);
  const subscriptionState = loadState(subscriptionQuery);

  const createProject = useCreateProject();
  const deleteProject = useDeleteProject();
  const { user } = useAuth();

  /**
   * One creation path, two doors in.
   *
   * The named door is the old dialog flow. The file door is the shorter road
   * the product actually sells — "upload a raw take and describe it" — where
   * the project names itself after the file and the editor starts the upload
   * the moment it mounts. Both share the same error handling, because a 429
   * is a 429 whichever way you asked.
   */
  const createAndOpen = async (title: string, file?: File) => {
    try {
      const project = await createProject.mutateAsync({ data: { title } });
      queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetDashboardStatsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetSubscriptionQueryKey() });
      // Stash only after the row exists: a failed create must not leave a file
      // waiting for a project that was never made.
      if (file) stashPendingUpload(project.id, file);
      setIsCreateOpen(false);
      setNewTitle("");
      setLocation(`/project/${project.id}`);
    } catch (error: unknown) {
      const status = (error as { response?: { status?: number } })?.response?.status;
      if (status === 429) {
        toast({
          title: "Video limit reached",
          description: `You've used all ${subscription?.minutesIncluded ?? ""} exported minutes on your ${subscription?.plan ?? ""} plan this month.`,
          variant: "destructive",
          action: (
            <ToastAction altText="Upgrade plan" onClick={() => window.location.href = "/#pricing"}>
              Upgrade
            </ToastAction>
          ),
        });
        setIsCreateOpen(false);
      } else {
        toast({
          title: "Failed to create project",
          description: "Please try again later.",
          variant: "destructive"
        });
      }
    }
  };

  const handleCreate = () => {
    if (!newTitle.trim()) return;
    void createAndOpen(newTitle);
  };

  /**
   * The same gatekeeping the editor applies, applied before the project
   * exists — a rejected file should cost a toast, not an empty project row
   * named after a spreadsheet.
   */
  const handleStartFromVideo = (file: File) => {
    if (!ACCEPTED_VIDEO_TYPES.includes(file.type) && !file.name.match(/\.(mp4|mov|webm)$/i)) {
      toast({
        title: "Invalid file type",
        description: "Please upload an mp4, mov, or webm file.",
        variant: "destructive",
      });
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      toast({
        title: "File too large",
        description: `That file is ${formatBytes(file.size)}. The current limit is ${formatBytes(MAX_UPLOAD_BYTES)} per video.`,
        variant: "destructive",
      });
      return;
    }
    void createAndOpen(titleFromFilename(file.name), file);
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      // Drop the stored bytes first: once the row is gone we no longer know
      // that this project existed, and the objects would linger unreferenced.
      if (user) await deleteProjectVideos(user.id, id);
      await deleteProject.mutateAsync({ id });
      queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetDashboardStatsQueryKey() });
      toast({
        title: "Project deleted",
        description: "The project has been removed."
      });
    } catch (error) {
      toast({
        title: "Failed to delete project",
        description: "Please try again later.",
        variant: "destructive"
      });
    }
  };

  /**
   * The badge, with one addition: a render nobody has picked up.
   *
   * "Processing" with a pulsing spark says work is happening. When the queue has
   * been unclaimed for five minutes there is no worker, and two of these have
   * been saying "Processing" for two days. The card should say which it is —
   * the state is not the user's fault and there is nothing for them to do about
   * it, but a lie about it is still a lie.
   */
  /*
   * A status badge that sits on a picture.
   *
   * These were colour-on-10%-colour — "Done" in green on a green wash — which
   * is legible on the black rectangle they were designed against and nearly
   * invisible the moment there is artwork underneath. On the new project art,
   * "Ready" in violet on a violet card disappeared entirely.
   *
   * Same rule as the AI Edited badge over a video: a scrim first, so the badge
   * has a floor it controls, then white text, and the status colour kept for
   * the icon — where it is a signal rather than the thing carrying the words.
   */
  const ON_ART = "bg-black/70 text-white border-white/15 backdrop-blur-md shadow-[0_2px_8px_rgba(0,0,0,0.45)]";

  const getStatusBadge = (status: string, renderStalled = false) => {
    if (renderStalled) {
      return (
        <Badge
          variant="outline"
          className={ON_ART}
          title="The render is queued, but no machine has picked it up."
          data-testid="badge-render-stalled"
        >
          <Clock className="w-3 h-3 mr-1" /> Waiting for a machine
        </Badge>
      );
    }
    switch (status) {
      case 'uploading':
        return <Badge variant="outline" className={ON_ART}><Loader2 className="w-3 h-3 mr-1 animate-spin text-blue-300" /> Uploading</Badge>;
      case 'ready':
        return <Badge variant="outline" className={ON_ART}><PlayCircle className="w-3 h-3 mr-1 text-violet-300" /> Ready</Badge>;
      case 'processing':
        return <Badge variant="outline" className={ON_ART}><Sparkles className="w-3 h-3 mr-1 animate-pulse text-violet-200" /> Processing</Badge>;
      case 'done':
        return <Badge variant="outline" className={ON_ART}><CheckCircle2 className="w-3 h-3 mr-1 text-green-400" /> Done</Badge>;
      case 'failed':
        return <Badge variant="outline" className={ON_ART}><AlertCircle className="w-3 h-3 mr-1 text-red-400" /> Failed</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  return (
    <div className="w-full max-w-7xl mx-auto px-6 py-12">
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between mb-12 gap-4">
        <div className="flex items-start gap-2">
          <BackButton fallback="/" className="-ml-3 mt-1" />
          <div>
          {/* No `glow-text`. A 60px purple halo behind a heading is a landing-page
              effect: it works once, over a hero, on a page somebody is being
              sold to. On the screen you open every day it is a smudge behind
              the word, and it was one of the things making this page feel
              cheap. The landing page keeps it. */}
          <h1 className="text-3xl font-bold tracking-tight mb-2">Projects</h1>
          {/* Not a slogan bolted on: on this screen it is the instruction —
              you are about to open a project and type what you want. */}
          <p className="text-muted-foreground" data-testid="text-signature-dashboard">
            Stop editing. Start describing.
          </p>
          </div>
        </div>
        {/* Wraps, because for one person it does not fit.
            Three controls fit a phone; an admin gets a fourth — "Operations" —
            and the row measured 526px against a 390px screen, so the whole
            dashboard scrolled sideways. It went unseen because the only account
            that sees that button is the one nobody tests with. */}
        <div className="flex flex-wrap items-center gap-2 sm:gap-3 w-full md:w-auto">
          <ThemeToggle />
          {/*
            Shown only when the server has already answered the admin overview.
            The client is not deciding anything here — it asked, and a 404 (what
            everyone else gets) simply leaves this out. One cheap request per
            dashboard load, and no way to make the link appear by editing
            anything in the browser, because the page behind it asks again.
          */}
          {isAdmin ? (
            <Button
              variant="outline"
              className="border-hairline rounded-full h-12 px-4 sm:px-5"
              onClick={() => setLocation("/admin")}
              data-testid="button-admin"
            >
              <Gauge className="w-4 h-4 mr-2" />
              Operations
            </Button>
          ) : null}
          <Button
            variant="outline"
            className="border-hairline rounded-full h-12 px-4 sm:px-5"
            onClick={() => setLocation("/account")}
            data-testid="button-account"
          >
            <UserRound className="w-4 h-4 mr-2" />
            Account
          </Button>
          <Button
            onClick={() => setIsCreateOpen(true)}
            className="glow-btn rounded-full bg-primary text-primary-foreground hover:bg-primary/90 px-5 sm:px-6 h-12 flex-1 sm:flex-none"
            data-testid="button-new-project"
          >
            <Plus className="w-5 h-5 mr-2" />
            New Project
          </Button>
        </div>
      </div>

      {/* Stats */}
      {/* A card built for a quarter of a desktop row is, stacked on a phone,
          230px of padding around one number — three screens of scrolling before
          the projects the person came for. The numbers stay; the box shrinks.

          Shrinking the box was not enough, because the box was still the full
          width of the screen and there were three of them: measured on a
          390x852 phone, "0, 0, 0" was taking 330px — forty per cent of the
          screen — to say that nothing has happened yet, and the projects the
          person opened the app for started below the fold. Three numbers side
          by side is what three numbers are; a row of them costs about 80px.

          The labels shorten with the column, because "Currently Processing" in
          a 118px column is three lines of type above a single digit. They are
          the same three facts either way. */}
      <div className="grid grid-cols-3 gap-2 md:gap-6 mb-8 md:mb-12">
        <Card className="glass-panel border-hairline-faint">
          <CardHeader className="flex flex-row items-start md:items-center justify-between gap-1 p-3 pb-0.5 md:p-6 md:pb-2">
            <CardTitle className="text-xs md:text-sm font-medium text-muted-foreground leading-snug">
              <span className="md:hidden">Projects</span>
              <span className="hidden md:inline">Total Projects</span>
            </CardTitle>
            <Video className="w-4 h-4 text-primary flex-shrink-0" />
          </CardHeader>
          <CardContent className="p-3 pt-0 md:p-6 md:pt-0">
            {statsState === "loading" ? (
              <Skeleton className="h-7 w-10 md:h-8 md:w-16" />
            ) : statsState === "failed" ? (
              /* A zero here is a claim about the person's account. When the
                 read failed we do not know the number, and "0" is the one
                 answer guaranteed to be wrong for anybody who has ever used
                 the product. */
              <LoadFailed what="this" compact onRetry={() => statsQuery.refetch()} testId="stats-failed-total" />
            ) : (
              <div className="text-2xl md:text-3xl font-bold">{stats?.totalProjects || 0}</div>
            )}
          </CardContent>
        </Card>
        <Card className="glass-panel border-hairline-faint">
          <CardHeader className="flex flex-row items-start md:items-center justify-between gap-1 p-3 pb-0.5 md:p-6 md:pb-2">
            <CardTitle className="text-xs md:text-sm font-medium text-muted-foreground leading-snug">
              <span className="md:hidden">Working</span>
              <span className="hidden md:inline">Currently Processing</span>
            </CardTitle>
            <Activity className="w-4 h-4 text-secondary flex-shrink-0" />
          </CardHeader>
          <CardContent className="p-3 pt-0 md:p-6 md:pt-0">
            {statsState === "loading" ? (
              <Skeleton className="h-7 w-10 md:h-8 md:w-16" />
            ) : statsState === "failed" ? (
              <LoadFailed what="this" compact onRetry={() => statsQuery.refetch()} testId="stats-failed-processing" />
            ) : (
              <>
                <div className="text-2xl md:text-3xl font-bold" data-testid="text-processing-count">
                  {stats?.processingCount || 0}
                </div>
                {/* Counted apart from the number above it. "Processing: 2" over
                    two cards that read "waiting for a machine" is the counter
                    contradicting the cards. */}
                {/* Two different situations that used to read as one. A queue
                    with nobody listening is "nothing is going to happen"; a
                    queue with a worker on it is "your turn is coming". Before
                    the worker reported in, the product could only guess, and
                    only after five minutes of guessing. */}
                {(stats?.stalledCount ?? 0) > 0 && (
                  <div className="text-xs text-warning mt-1" data-testid="text-stalled-count">
                    {stats?.stalledCount}{" "}
                    {stats?.worker?.online ? "waiting their turn" : "waiting for a machine"}
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
        <Card className="glass-panel border-hairline-faint">
          <CardHeader className="flex flex-row items-start md:items-center justify-between gap-1 p-3 pb-0.5 md:p-6 md:pb-2">
            <CardTitle className="text-xs md:text-sm font-medium text-muted-foreground leading-snug">
              <span className="md:hidden">Done</span>
              <span className="hidden md:inline">Completed Edits</span>
            </CardTitle>
            <CheckCircle2 className="w-4 h-4 text-success flex-shrink-0" />
          </CardHeader>
          <CardContent className="p-3 pt-0 md:p-6 md:pt-0">
            {statsState === "loading" ? (
              <Skeleton className="h-7 w-10 md:h-8 md:w-16" />
            ) : statsState === "failed" ? (
              <LoadFailed what="this" compact onRetry={() => statsQuery.refetch()} testId="stats-failed-done" />
            ) : (
              <div className="text-2xl md:text-3xl font-bold">{stats?.doneCount || 0}</div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Usage Banner */}
      {subscriptionState === "failed" && (
        <div className="mb-8 rounded-2xl border border-warning/40 px-6 py-4 glass-panel">
          <LoadFailed
            what="your plan and usage"
            compact
            onRetry={() => subscriptionQuery.refetch()}
            testId="subscription-failed"
          />
        </div>
      )}
      {/*
        The free plan, said out loud.

        Someone on it could already read "0 / 5 minutes" off the meter below
        and a badge saying "free plan", and neither of those tells them the
        thing they actually want to know: that they are not on a countdown,
        that nobody has their card, and that what they are trying is the whole
        editor rather than a crippled preview of it. That was the complaint —
        the free tier is on the pricing page and invisible everywhere someone
        actually uses the product.

        The numbers come from the same FREE_TIER the pricing page reads, so
        this cannot quietly drift away from what we sell.
      */}
      {subscriptionState === "ready" && subscription?.plan === "free" && (
        <div
          data-testid="free-plan-band"
          className="mb-4 rounded-2xl border border-primary/25 bg-primary/5 px-6 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 glass-panel"
        >
          <div className="min-w-0">
            <div className="text-sm font-semibold">
              {FREE_TIER.headline}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {FREE_TIER.minutes} minutes of finished video a month, uploads up to{" "}
              {FREE_TIER.uploadMinutes} minutes, and every editing feature. No card, no
              expiry. It simply keeps working.
            </div>
          </div>
          <Link href="/#pricing">
            <Button
              size="sm"
              variant="outline"
              data-testid="button-see-plans"
              className="rounded-full text-xs h-8 px-4 border-primary/30"
            >
              See plans
            </Button>
          </Link>
        </div>
      )}

      {subscriptionState === "ready" && subscription && (
        <div className={`mb-8 rounded-2xl border px-6 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 glass-panel ${
          subscription.minutesUsedThisMonth >= subscription.minutesIncluded
            ? "border-red-500/30 bg-red-500/5"
            : subscription.minutesUsedThisMonth / subscription.minutesIncluded >= 0.8
            ? "border-amber-500/30 bg-amber-500/5"
            : "border-hairline-faint"
        }`}>
          <div className="flex items-center gap-3 min-w-0">
            <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${
              subscription.minutesUsedThisMonth >= subscription.minutesIncluded
                ? "bg-red-500/15"
                : subscription.minutesUsedThisMonth / subscription.minutesIncluded >= 0.8
                ? "bg-amber-500/15"
                : "bg-primary/10"
            }`}>
              <TrendingUp className={`w-4 h-4 ${
                subscription.minutesUsedThisMonth >= subscription.minutesIncluded
                  ? "text-destructive"
                  : subscription.minutesUsedThisMonth / subscription.minutesIncluded >= 0.8
                  ? "text-warning"
                  : "text-primary"
              }`} />
            </div>
            <div>
              <div className="text-sm font-medium">
                <span className="font-bold">{subscription.minutesUsedThisMonth} / {subscription.minutesIncluded}</span>
                {" "}minutes of finished video this month
              </div>
              <div className="mt-1.5 w-48 h-1.5 rounded-full bg-surface-2 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${
                    subscription.minutesUsedThisMonth >= subscription.minutesIncluded
                      ? "bg-red-400"
                      : subscription.minutesUsedThisMonth / subscription.minutesIncluded >= 0.8
                      ? "bg-amber-400"
                      : "bg-primary"
                  }`}
                  style={{ width: `${Math.min(100, (subscription.minutesUsedThisMonth / subscription.minutesIncluded) * 100)}%` }}
                />
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Badge variant="outline" className="capitalize border-hairline bg-surface-1 text-xs font-semibold">
              {subscription.plan} plan
            </Badge>
            {subscription.minutesUsedThisMonth / subscription.minutesIncluded >= 0.8 && (
              <Link href="/#pricing">
                <Button size="sm" className="bg-primary hover:bg-primary/90 text-white rounded-full text-xs h-8 px-4">
                  Upgrade
                </Button>
              </Link>
            )}
          </div>
        </div>
      )}

      {/* Projects Grid */}
      <div className="space-y-4">
        <h2 className="text-xl font-semibold">Recent Projects</h2>
        
        {projectsState === "loading" ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[1, 2, 3].map(i => (
              <Card key={i} className="glass-panel overflow-hidden border-hairline-faint">
                <Skeleton className="w-full aspect-[16/9] rounded-none" />
                <CardContent className="p-4">
                  <Skeleton className="h-5 w-2/3 mb-2" />
                  <Skeleton className="h-4 w-1/3" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : projectsState === "failed" ? (
          /* Before this branch existed, a failed read fell through to the
             empty state below — "Nothing here yet", over a library that was
             entirely intact. */
          <LoadFailed
            what="your projects"
            onRetry={() => projectsQuery.refetch()}
            testId="projects-failed"
          />
        ) : projectsState === "empty" ? (
          <div className="flex flex-col items-center justify-center py-24 text-center glass-panel rounded-2xl border-hairline-faint border-dashed">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-4 border border-primary/20">
              <Video className="w-8 h-8 text-primary" />
            </div>
            <h3 className="text-xl font-bold mb-2">Nothing here yet</h3>
            <p className="text-muted-foreground max-w-sm mb-6">
              Upload a raw take and tell Editly what you want done with it. Stop
              editing, start describing.
            </p>
            <Button onClick={() => setIsCreateOpen(true)} variant="outline" className="rounded-full">
              Create Project
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {projects?.map(project => (
              <Link key={project.id} href={`/project/${project.id}`}>
                {/* The thumbnail is inset inside the card rather than bleeding
                    to its edge: a picture with a margin around it reads as
                    something the card is holding, which is the difference
                    between a library and a list. */}
                <Card className="glass-panel border-hairline-faint overflow-hidden hover:border-primary/50 transition-all group cursor-pointer h-full flex flex-col p-2 hover:-translate-y-0.5">
                  <div className="force-dark w-full aspect-[16/9] bg-background text-foreground relative overflow-hidden flex-shrink-0 rounded-xl">
                    {/* What is under everything else.
                        This was a black rectangle with a grey camera in the
                        middle, three across — the least appealing screen in the
                        product and the one people open most. The art belongs to
                        the project (its hue comes from its id) so the grid is
                        something you can find your way around by colour, and a
                        poster that fails to load lands on a picture rather than
                        on a hole. See components/project-art.tsx. */}
                    <ProjectArt seed={project.id} />
                    <div className="absolute inset-0 flex items-center justify-center">
                      <Video className="w-10 h-10 text-white/25" />
                    </div>
                    {project.thumbnailPath || project.thumbnailUrl ? (
                      <ProjectThumbnail project={project} />
                    ) : (
                      <ProjectClipFrame project={project} />
                    )}
                    <div className="absolute top-3 right-3">
                      {getStatusBadge(project.status, project.renderStalled)}
                    </div>
                  </div>
                  <CardContent className="px-3 pt-3 pb-1 flex-1">
                    <CardTitle dir="auto" className="text-lg mb-1 group-hover:text-primary transition-colors line-clamp-1" data-testid={`text-project-title-${project.id}`}>
                      {project.title}
                    </CardTitle>
                    <div className="flex items-center text-xs text-muted-foreground">
                      <Clock className="w-3 h-3 mr-1" />
                      {format(new Date(project.updatedAt), 'MMM d, yyyy')}
                    </div>
                  </CardContent>
                  <CardFooter className="px-3 pb-2 pt-0 flex justify-end">
                    <Button 
                      variant="ghost" 
                      size="icon"
                      className="h-11 w-11 md:h-8 md:w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                      onClick={(e) => handleDelete(project.id, e)}
                      data-testid={`button-delete-${project.id}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </CardFooter>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>

      <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
        <DialogContent className="glass-panel border-hairline sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Create New Project</DialogTitle>
            <DialogDescription>
              Start from your video, or just give the project a name.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            {/* The short road: the file is the project. It gets its name from
                the filename and the editor starts uploading it on arrival, so
                the distance from "I have a clip" to "tell Noah what you want"
                is one gesture. */}
            <div
              role="button"
              tabIndex={0}
              onClick={() => createFileRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") createFileRef.current?.click();
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setIsDropActive(true);
              }}
              onDragLeave={(e) => {
                e.preventDefault();
                setIsDropActive(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                setIsDropActive(false);
                const file = e.dataTransfer.files?.[0];
                if (file) handleStartFromVideo(file);
              }}
              className={`group rounded-xl border border-dashed px-4 py-6 text-center cursor-pointer transition-colors ${
                isDropActive
                  ? "border-primary bg-primary/10"
                  : "border-hairline hover:border-primary/50 hover:bg-primary/5"
              }`}
              data-testid="dropzone-create-from-video"
            >
              {createProject.isPending ? (
                <Loader2 className="w-6 h-6 mx-auto mb-2 text-primary animate-spin" />
              ) : (
                <UploadCloud
                  className={`w-6 h-6 mx-auto mb-2 transition-colors ${
                    isDropActive ? "text-primary" : "text-muted-foreground group-hover:text-primary"
                  }`}
                />
              )}
              <div className="text-sm font-medium">Drop your video here</div>
              <div className="text-xs text-muted-foreground mt-1">
                The project names itself and the upload starts right away
              </div>
              <input
                ref={createFileRef}
                type="file"
                accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  // Allow picking the same file again after a rejection.
                  e.target.value = "";
                  if (file) handleStartFromVideo(file);
                }}
                data-testid="input-create-from-video"
              />
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <div className="h-px flex-1 bg-hairline" />
              or name it first
              <div className="h-px flex-1 bg-hairline" />
            </div>
            <div className="flex flex-col gap-3">
              <Label htmlFor="name" className="text-left">
                Project Name
              </Label>
              <Input
                id="name"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="e.g. My Viral Short"
                className="col-span-3 bg-surface-1 border-hairline focus-visible:ring-primary"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreate();
                }}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setIsCreateOpen(false)}>Cancel</Button>
            <Button 
              onClick={handleCreate} 
              disabled={!newTitle.trim() || createProject.isPending}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
              data-testid="button-submit-project"
            >
              {createProject.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Create Project
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
