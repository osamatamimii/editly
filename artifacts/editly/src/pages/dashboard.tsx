import { useRef, useState } from "react";
import { Link, useLocation, Redirect } from "wouter";
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
  getGetAdminOverviewQueryKey,
  type Project
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Video, Plus, Clock, PlayCircle, CheckCircle2,
  Trash2, AlertCircle, Loader2, Sparkles, Activity, TrendingUp, UserRound,
  UploadCloud, Gauge, Scissors, CalendarClock, Mic, Store
} from "lucide-react";
import { BackButton } from "@/components/back-button";
import { ProjectArt } from "@/components/project-art";
import { ThemeToggle } from "@/components/theme-toggle";
import { videoRejection } from "@/lib/start-from-video";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import {
  usePlayableVideo,
  ACCEPTED_VIDEO_ACCEPT,
  whyNotAVideo,
  servedCeiling,
  formatBytes,
} from "@/lib/video-storage";
import { stashPendingUpload, titleFromFilename } from "@/lib/pending-upload";
import { hasSkippedFirstRun } from "@/lib/first-run";
import { loadState } from "@/lib/load-state";
import { FREE_TIER } from "@/lib/pricing";
import { useLanguage } from "@/lib/language";
import { useDates } from "@/lib/dates";
import { ACCOUNT } from "@/lib/copy/account";
import { COMMON, LOAD } from "@/lib/copy/common";
import { DASHBOARD } from "@/lib/copy/dashboard";
import { PRICING_AR, phrase, template } from "@/lib/landing-copy";
import { LoadFailed } from "@/components/load-failed";
import { refusalToast, isPlanWall } from "@/lib/refusal";
import { Badge } from "@/components/ui/badge";

/*
  Two sentences this screen owns, rather than two entries in
  `lib/copy/dashboard.ts`.

  Both exist because the copy table carries an older version of them and the
  fix is in the wording, not in the table's shape. They are written with the
  same `phrase`/`template` primitives that file uses, so either can move into
  it unchanged the moment its entry is corrected.
*/

/*
  Not "Invalid file type", which is the title `DASHBOARD.badFileType` still
  carries. The single most-refused file at this door is an iPhone HEIC photo,
  and its owner reading "invalid file type" learns that something is wrong and
  nothing about what to do; `whyNotAVideo` writes the half of the toast that
  tells them, and the title has to leave room for it to be about a photo, an
  audio file or a codec rather than only about a format list.
*/
const CANNOT_USE_FILE = phrase("لا يمكننا استخدام هذا الملف", "We cannot use that file");

/*
  Not "every editing feature": free does not include style matching or 4K, and
  this band repeated the pricing card's overclaim in the one place a free
  customer reads it daily. `DASHBOARD.freeBandDetail` still says "every editing
  feature" in both languages — "وكل ميزات التعديل" — so the pair is written
  here, with the Arabic making the same narrower claim the English does.
*/
const FREE_BAND_DETAIL = template<[number, number]>(
  (minutes, upload) =>
    `${minutes} دقائق فيديو منتهٍ في الشهر، ورفع حتى ${upload} دقائق، والمحرّر نفسه كاملًا. بلا بطاقة وبلا انتهاء. تعمل وحسب.`,
  (minutes, upload) =>
    `${minutes} minutes of finished video a month, uploads up to ${upload} minutes, and the real editor. No card, no expiry. It simply keeps working.`,
);

/**
 * A project's poster frame. The bucket is private, so the stored key has to be
 * signed before it can be shown — and each card signs its own rather than the
 * dashboard signing all of them, so one failure costs one card.
 */
/*
  The art stays until the picture has actually painted.

  Both of these used to return `null` while they had no URL, which left the
  container exactly as it was drawn — black — with a status badge floating in
  it. That covered the common case badly enough, and it missed the worse one
  entirely: a URL that *resolves* and then does not decode. A poster whose
  object was deleted, a link that expired between signing and fetching, or —
  and this is the one that matters — a browser that will not decode H.264, of
  which there is at least one on this project's own desk. In every one of those
  the element is present, every check that asks "is there an <img>" says yes,
  and the card is a black rectangle.

  So the art is drawn *until* the media reports that it painted, and only then
  does the art come out of the tree. Not underneath it, ever: the poster is
  drawn at 80% opacity so it brightens on hover, and 80% over a coloured floor
  is not a dimmed photograph, it is a tinted one — every card with real footage
  in it was wearing somebody else's green the last time that shortcut was
  taken. Underneath a *transparent* element is the one arrangement where the
  two cannot mix.
*/
function ProjectThumbnail({
  project,
}: {
  project: { id: string; title: string; thumbnailPath?: string | null; thumbnailUrl?: string | null };
}) {
  const { url } = usePlayableVideo(project.thumbnailPath ?? project.thumbnailUrl);
  const [painted, setPainted] = useState(false);

  return (
    <>
      {painted ? null : <ProjectArt seed={project.id} />}
      {url ? (
        <img
          src={url}
          alt={project.title}
          loading="lazy"
          onLoad={(e) => {
            if (e.currentTarget.naturalWidth > 0) setPainted(true);
          }}
          className={`absolute inset-0 w-full h-full object-cover transition-opacity group-hover:scale-105 duration-500 ${
            painted ? "opacity-80 group-hover:opacity-100" : "opacity-0"
          }`}
          data-testid="img-project-thumbnail"
        />
      ) : null}
    </>
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
  project: {
    id: string;
    title: string;
    videoPath?: string | null;
    videoUrl?: string | null;
    duration?: number | null;
  };
}) {
  const { url } = usePlayableVideo(project.videoPath ?? project.videoUrl);
  const [painted, setPainted] = useState(false);
  const at = project.duration && project.duration > 4 ? Math.round(project.duration * 0.25) : 1;

  return (
    <>
      {painted ? null : <ProjectArt seed={project.id} />}
      {url ? (
        <video
          src={`${url}#t=${at}`}
          preload="metadata"
          muted
          playsInline
          // `loadeddata` rather than `loadedmetadata`: metadata means the
          // browser read the header, and a browser with no decoder for the
          // stream reads the header perfectly well and then draws nothing.
          // `videoWidth` is the frame it really has.
          onLoadedData={(e) => {
            if (e.currentTarget.videoWidth > 0) setPainted(true);
          }}
          className={`absolute inset-0 w-full h-full object-cover transition-opacity group-hover:scale-105 duration-500 ${
            painted ? "opacity-80 group-hover:opacity-100" : "opacity-0"
          }`}
          data-testid="video-project-frame"
        />
      ) : null}
    </>
  );
}

/**
 * Does this project have a picture of its own to show?
 *
 * A stored poster, or a clip we can park on a frame of. Anything else gets the
 * generated art instead — never underneath, which is the bug this answers: the
 * poster is drawn at 80% opacity so it brightens on hover, and 80% over a
 * coloured floor is not a dimmed photograph, it is a *tinted* one. Every card
 * with real footage in it was wearing somebody else's green.
 */
function hasPoster(project: {
  thumbnailPath?: string | null;
  thumbnailUrl?: string | null;
  videoPath?: string | null;
  videoUrl?: string | null;
}): boolean {
  return Boolean(
    project.thumbnailPath || project.thumbnailUrl || project.videoPath || project.videoUrl,
  );
}

export default function Dashboard() {
  const [, setLocation] = useLocation();
  const { t, fmt } = useLanguage();
  const dates = useDates();
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
      /*
        The server's sentence, not one written here from numbers this screen
        happens to hold.

        This wrote its own: "You've used all {minutesIncluded} exported minutes
        on your {plan} plan this month." That claim is false in the case the
        refusal most often means now — `exhausted` includes renders already
        accepted, so a Pro customer with nothing billed who has queued a
        400-minute podcast is refused, and the server says so in as many words
        ("Renders already going account for 400 of your 400 minutes… nothing is
        lost"). This screen printed "you've used all 400 exported minutes"
        directly above its own usage banner reading "0 / 400 minutes of
        finished video this month" — two contradictory numbers on one screen,
        and an Upgrade button attached to the wrong one.

        And when the subscription query had not resolved, the `?? ""` fallbacks
        rendered "You've used all  exported minutes on your  plan this month."

        `refusalToast` is what the three editor paths already use. This was the
        one caller that never got converted.
      */
      const status = (error as { response?: { status?: number } })?.response?.status;
      toast(refusalToast(error, DASHBOARD.createFailed, t));
      // Every plan wall closes the dialog, not the 429 alone: a 402 or a 413
      // otherwise leaves the form open over a toast that has already explained
      // why the form cannot succeed.
      if (isPlanWall(status)) setIsCreateOpen(false);
    }
  };

  const handleCreate = () => {
    if (!newTitle.trim()) return;
    // The button is disabled while this is in flight; the field is not, and
    // Enter goes through the field. On a slow connection a second Enter made a
    // second project — and, from the dropzone, a second stashed upload with it.
    if (createProject.isPending) return;
    void createAndOpen(newTitle);
  };

  /**
   * The same gatekeeping the editor applies, applied before the project
   * exists — a rejected file should cost a toast, not an empty project row
   * named after a spreadsheet.
   */
  const handleStartFromVideo = (file: File) => {
    /*
      What this product will take, decided in one place.

      The rule is shared with the clip-extraction screen and the editor, which
      start a project the same way; a hand-written list of three extensions
      beside a hand-written list of three types, repeated at three doors, is
      how this door came to refuse mkv and m4v that the server accepts.
      `whyNotAVideo` also knows the answer somebody can act on: the file most
      often refused here is an iPhone HEIC photo, and "please upload an mp4,
      mov or webm" tells its owner nothing about what to do next.
    */
    /*
      Through `videoRejection`, which is the one function both screens ask.

      Two rules were converging on the same answer from opposite directions:
      this door had learned the derived format list and the useful sentence,
      and the clip screen had the shared function that stops two doors drifting
      apart. Keeping only one of those would give back the other's bug, so
      `videoRejection` now asks `isAcceptableVideo` and both screens call it.
      The words stay each screen's own — somebody standing here has dropped
      anything at all, and somebody on the clip screen is holding an episode.
    */
    const rejection = videoRejection(file, { ceilingBytes: servedCeiling(subscription) });
    if (rejection === "type") {
      toast({
        title: t(CANNOT_USE_FILE),
        // The file most often refused here is an iPhone HEIC photo, and
        // "please upload an mp4, mov or webm" tells its owner nothing about
        // what to do next. `whyNotAVideo` does.
        description: whyNotAVideo(file),
        variant: "destructive",
      });
      return;
    }
    /*
      The ceiling the server actually named, and nothing when it has not said.

      This was `uploadCeiling`, which folds "the server has not answered yet"
      into 50 MB — the build-time fallback, which is the *free* plan's order of
      magnitude. So while the subscription query is in flight, and for the
      whole of any failure or 401 on it, a Pro customer dropping the 200 MB
      file their plan is sold on was refused with a confidently worded toast
      naming a limit that is not theirs. Nothing threw; the customer was simply
      downgraded for a second and told so.

      The signing route enforces the real ceiling before a byte is sent, so
      saying nothing costs one round trip and guessing costs a customer. The
      editor was fixed and these two doors were not.
    */
    if (rejection === "size") {
      // Only reachable with a ceiling the server named: `videoRejection` never
      // answers "size" without one.
      const ceiling = servedCeiling(subscription) as number;
      toast({
        title: t(DASHBOARD.fileTooLarge),
        description: fmt(DASHBOARD.fileTooLargeDetail, formatBytes(file.size), formatBytes(ceiling)),
        variant: "destructive",
      });
      return;
    }
    // Same guard as the Enter key above: the dropzone stays clickable while a
    // create is in flight, and a second drop was a second project plus a
    // second stashed upload.
    if (createProject.isPending) return;
    void createAndOpen(titleFromFilename(file.name), file);
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      /*
        The server does this, and doing it here first was the destructive half
        running behind a message saying nothing happened.

        The comment that was here argued for dropping the bytes before the row,
        so nothing is left unreferenced — which was right when the route did not
        reclaim them. It does now, with the whole property this depended on:
        `DELETE /projects/:id` sweeps the objects, refuses with a 503 when it
        cannot, and never reports a deletion it could not complete.

        With both, the client destroyed the source, the render, the poster and
        every asset with the person's own token, and *then* asked for the row.
        If that failed — a 500, a timeout — the toast read "Failed to delete
        project. Please try again later." while the footage was already gone,
        and the card stayed in the library pointing at objects that no longer
        existed. The only irreversible step ran first, behind a sentence saying
        nothing had happened.
      */
      await deleteProject.mutateAsync({ id });
      queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetDashboardStatsQueryKey() });
      toast({
        title: t(DASHBOARD.projectDeleted),
        description: t(DASHBOARD.projectDeletedDetail)
      });
    } catch (error) {
      toast({
        title: t(DASHBOARD.deleteFailed),
        description: t(DASHBOARD.tryLater),
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
          title={t(DASHBOARD.statusStalledTitle)}
          data-testid="badge-render-stalled"
        >
          <Clock className="w-3 h-3 me-1" /> {t(DASHBOARD.statusStalled)}
        </Badge>
      );
    }
    switch (status) {
      case 'uploading':
        return <Badge variant="outline" className={ON_ART}><Loader2 className="w-3 h-3 me-1 animate-spin text-blue-300" /> {t(DASHBOARD.statusUploading)}</Badge>;
      case 'ready':
        return <Badge variant="outline" className={ON_ART}><PlayCircle className="w-3 h-3 me-1 text-violet-300" /> {t(DASHBOARD.statusReady)}</Badge>;
      case 'processing':
        return <Badge variant="outline" className={ON_ART}><Sparkles className="w-3 h-3 me-1 animate-pulse text-violet-200" /> {t(DASHBOARD.statusProcessing)}</Badge>;
      case 'done':
        return <Badge variant="outline" className={ON_ART}><CheckCircle2 className="w-3 h-3 me-1 text-green-400" /> {t(DASHBOARD.statusDone)}</Badge>;
      case 'failed':
        return <Badge variant="outline" className={ON_ART}><AlertCircle className="w-3 h-3 me-1 text-red-400" /> {t(DASHBOARD.statusFailed)}</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  /*
    One card, rendered from two lists.

    The grid used to be a single `projects.map`, and it is now two — podcasts
    above, everything else below. Pulled into a function rather than copied,
    because a card that renders one way in one section and another way in the
    other is the failure that makes a split like this worse than no split.
  */
  /*
    Where a recording stops being an edit and starts being a source.

    Eight minutes of uploaded video. Under it, a project is a thing you are
    editing; over it, a project is a thing you are taking pieces out of, and
    those two want different screens even though they are the same row.

    `duration` is measured from the file at upload, so a project whose source
    never arrived — or whose measurement failed — is not a podcast by default.
    A wrong guess in that direction hides nothing: the project is still in the
    grid below.
  */
  const PODCAST_SECONDS = 8 * 60;
  const podcasts = (projects ?? []).filter((p) => (p.duration ?? 0) >= PODCAST_SECONDS);
  const shortForm = (projects ?? []).filter((p) => (p.duration ?? 0) < PODCAST_SECONDS);

  const projectCard = (project: Project) => (
            <Link key={project.id} href={`/project/${project.id}`}>
              {/* The thumbnail is inset inside the card rather than bleeding
                  to its edge: a picture with a margin around it reads as
                  something the card is holding, which is the difference
                  between a library and a list. */}
              <Card
                className="glass-panel border-hairline-faint overflow-hidden hover:border-primary/50 transition-all group cursor-pointer h-full flex flex-col p-2 hover:-translate-y-0.5"
                data-testid={`card-project-${project.id}`}
              >
                <div className="force-dark w-full aspect-[16/9] bg-background text-foreground relative overflow-hidden flex-shrink-0 rounded-xl">
                  {/* What is under everything else.
                      This was a black rectangle with a grey camera in the
                      middle, three across — the least appealing screen in the
                      product and the one people open most. The art belongs to
                      the project (its hue comes from its id) so the grid is
                      something you can find your way around by colour, and a
                      poster that fails to load lands on a picture rather than
                      on a hole. See components/project-art.tsx. */}
                  {/*
                    The art is what a project has *instead of* a picture, not
                    underneath one.

                    It was drawn unconditionally, on the reasoning that a
                    floor under everything is safer than a fallback that might
                    not fire. That reasoning was right about the black
                    rectangle it replaced and wrong the moment the floor had
                    colour in it: a poster is `object-contain`, so a clip
                    whose shape is not 16:9 leaves bars at the sides — and the
                    bars filled with someone else's ribbons. Every card with a
                    real frame in it had a green or violet edge around the
                    person's own video.

                    So it is drawn only when there is nothing to draw over it.
                    The camera glyph goes with it, for the same reason: a
                    watermark on top of a photograph is not a fallback, it is
                    a mark on the photograph.
                  */}
                  {hasPoster(project) ? (
                    project.thumbnailPath || project.thumbnailUrl ? (
                      <ProjectThumbnail project={project} />
                    ) : (
                      <ProjectClipFrame project={project} />
                    )
                  ) : (
                    <>
                      <ProjectArt seed={project.id} />
                      <div className="absolute inset-0 flex items-center justify-center">
                        <Video className="w-10 h-10 text-white/25" />
                      </div>
                    </>
                  )}
                  <div className="absolute top-3 end-3">
                    {getStatusBadge(project.status, project.renderStalled)}
                  </div>
                </div>
                {/*
                  The date and the bin share a row.

                  The bin had a row of its own, which on a phone is fifty
                  pixels of empty card between the date and the next project —
                  three of them and a screen holds two projects instead of
                  three. It is still a full tap target and still the furthest
                  thing on the card from where a thumb lands when opening one.
                */}
                <CardContent className="px-3 pt-3 pb-2 flex-1 flex items-end justify-between gap-2">
                  <div className="min-w-0">
                    <CardTitle dir="auto" className="text-lg mb-1 group-hover:text-primary transition-colors line-clamp-1" data-testid={`text-project-title-${project.id}`}>
                      {project.title}
                    </CardTitle>
                    <div className="flex items-center text-xs text-muted-foreground">
                      <Clock className="w-3 h-3 me-1 flex-shrink-0" />
                      {dates.day(project.updatedAt)}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-11 w-11 md:h-8 md:w-8 flex-shrink-0 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                    onClick={(e) => handleDelete(project.id, e)}
                    aria-label={fmt(DASHBOARD.deleteProject, project.title)}
                    data-testid={`button-delete-${project.id}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </CardContent>
              </Card>
            </Link>
  );

  /*
    An account with nothing in it goes to the first-run screen instead.

    Two conditions, and the first one is the whole reason `loadState` exists.
    **Only `"empty"`** — a *successful* read of zero projects. A failed read
    also leaves `projects` undefined, and treating that as empty is how a total
    outage looked like an empty account for two days; here it would be worse
    than a wrong screen, because the first-run screen offers to create a
    project on top of a library the person already has and cannot see.

    And having any project ends the first run permanently, on every device,
    whatever a browser happened to remember. The skip flag only covers somebody
    who chose to look around and has not made anything yet.

    `projectsFailed` is redundant against `loadState` and it is written out
    anyway. The rule "check for failure before you say the account is empty" is
    the one this page has already been wrong about once, and `browser-test`
    enforces it by reading the order of these two comparisons in the source —
    a guard that only works if the rule is *visible*, rather than resting on
    somebody remembering what `loadState` returns.
  */
  const projectsFailed = projectsState === "failed";
  const accountIsNew = !projectsFailed && projectsState === "empty";
  if (accountIsNew && !hasSkippedFirstRun()) {
    return <Redirect to="/onboarding" />;
  }

  return (
    <div className="w-full max-w-7xl mx-auto px-6 py-12">
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between mb-12 gap-4">
        <div className="flex items-start gap-2">
          <BackButton fallback="/" className="-ms-3 mt-1" />
          <div>
          {/* No `glow-text`. A 60px purple halo behind a heading is a landing-page
              effect: it works once, over a hero, on a page somebody is being
              sold to. On the screen you open every day it is a smudge behind
              the word, and it was one of the things making this page feel
              cheap. The landing page keeps it. */}
          <h1 className="text-3xl font-bold tracking-tight mb-2">{t(DASHBOARD.title)}</h1>
          {/* Not a slogan bolted on: on this screen it is the instruction —
              you are about to open a project and type what you want. */}
          <p className="text-muted-foreground" data-testid="text-signature-dashboard">
            {t(DASHBOARD.signature)}
          </p>
          </div>
        </div>
        {/*
          Icons on a phone, words from a tablet up.

          It wrapped, and wrapping was the fix for the row measuring 526px
          against a 390px screen — but wrapped is not the same as tidy: five
          controls over two lines, one of them a bare icon with no label and the
          other three carrying words, reads as a row that ran out of space
          rather than one that was designed.

          The secondary actions drop their words below `sm` and keep an
          `aria-label`, which they needed anyway: "Clips" already hid its text
          on a phone, and a button whose only text is `hidden` is a button with
          no accessible name at all. "New Project" keeps its words, because it
          is the one thing this screen is for and an icon is not an invitation.
        */}
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
              className="border-hairline rounded-full h-12 w-12 sm:w-auto px-0 sm:px-5"
              onClick={() => setLocation("/admin")}
              aria-label={t(DASHBOARD.operations)}
              data-testid="button-admin"
            >
              <Gauge className="w-4 h-4 sm:me-2" />
              <span className="hidden sm:inline">{t(DASHBOARD.operations)}</span>
            </Button>
          ) : null}
          {/* Clips are the output of the thing half this product's users come
              for, and until now they only existed inside the project that made
              them — eleven recordings, eleven panels, no library. */}
          <Button
            variant="outline"
            className="border-hairline rounded-full h-12 w-12 sm:w-auto px-0 sm:px-5"
            onClick={() => setLocation("/clips")}
            aria-label={t(DASHBOARD.clips)}
            data-testid="button-clips"
          >
            <Scissors className="w-4 h-4 sm:me-2" />
            <span className="hidden sm:inline">{t(DASHBOARD.clips)}</span>
          </Button>
          {/* Scheduling had no door.

              It was built, tested and reachable, and the first person to look
              for it in the product could not find it — because the composer is
              at the bottom of the export screen, visible only after a render
              finishes, and the queue is three cards down the account page under
              the plan and the addresses. Neither is where anybody would look
              for "what is going out". */}
          <Button
            variant="outline"
            className="border-hairline rounded-full h-12 w-12 sm:w-auto px-0 sm:px-5"
            onClick={() => setLocation("/scheduled")}
            aria-label={t(DASHBOARD.scheduled)}
            data-testid="button-scheduled"
          >
            <CalendarClock className="w-4 h-4 sm:me-2" />
            <span className="hidden sm:inline">{t(DASHBOARD.scheduled)}</span>
          </Button>
          {/* The other half of who buys this.

              Somebody who sells things has no recording to bring, so every
              door on this screen was shut to them: "New Project" opens a
              dropzone that takes video, and the editor refuses to render until
              a video is in it. This one starts from photographs of a product,
              and it is the same screen the Shopify app shows inside a store's
              admin. */}
          <Button
            variant="outline"
            className="border-hairline rounded-full h-12 w-12 sm:w-auto px-0 sm:px-5"
            onClick={() => setLocation("/ads")}
            aria-label="Product ad"
            data-testid="button-product-ads"
          >
            <Store className="w-4 h-4 sm:mr-2" />
            <span className="hidden sm:inline">Product ad</span>
          </Button>
          <Button
            variant="outline"
            className="border-hairline rounded-full h-12 w-12 sm:w-auto px-0 sm:px-5"
            onClick={() => setLocation("/account")}
            aria-label={t(COMMON.account)}
            data-testid="button-account"
          >
            <UserRound className="w-4 h-4 sm:me-2" />
            <span className="hidden sm:inline">{t(COMMON.account)}</span>
          </Button>
          <Button
            onClick={() => setIsCreateOpen(true)}
            /* No `glow-btn`: the Button component's default variant is
               `.aura-btn` now, and two classes both writing `box-shadow` is one
               of them silently winning. */
            className="rounded-full px-5 sm:px-6 h-12 flex-1 sm:flex-none"
            data-testid="button-new-project"
          >
            <Plus className="w-5 h-5 me-2" />
            {t(DASHBOARD.newProject)}
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
              <span className="md:hidden">{t(DASHBOARD.statProjectsShort)}</span>
              <span className="hidden md:inline">{t(DASHBOARD.statProjects)}</span>
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
              <LoadFailed what={DASHBOARD.thisNumber} compact onRetry={() => statsQuery.refetch()} testId="stats-failed-total" />
            ) : (
              <div className="text-2xl md:text-3xl font-bold">{stats?.totalProjects || 0}</div>
            )}
          </CardContent>
        </Card>
        <Card className="glass-panel border-hairline-faint">
          <CardHeader className="flex flex-row items-start md:items-center justify-between gap-1 p-3 pb-0.5 md:p-6 md:pb-2">
            <CardTitle className="text-xs md:text-sm font-medium text-muted-foreground leading-snug">
              <span className="md:hidden">{t(DASHBOARD.statWorkingShort)}</span>
              <span className="hidden md:inline">{t(DASHBOARD.statWorking)}</span>
            </CardTitle>
            <Activity className="w-4 h-4 text-secondary flex-shrink-0" />
          </CardHeader>
          <CardContent className="p-3 pt-0 md:p-6 md:pt-0">
            {statsState === "loading" ? (
              <Skeleton className="h-7 w-10 md:h-8 md:w-16" />
            ) : statsState === "failed" ? (
              <LoadFailed what={DASHBOARD.thisNumber} compact onRetry={() => statsQuery.refetch()} testId="stats-failed-processing" />
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
                    {stats?.worker?.online
                      ? t(DASHBOARD.waitingTheirTurn)
                      : t(DASHBOARD.waitingForMachine)}
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
        <Card className="glass-panel border-hairline-faint">
          <CardHeader className="flex flex-row items-start md:items-center justify-between gap-1 p-3 pb-0.5 md:p-6 md:pb-2">
            <CardTitle className="text-xs md:text-sm font-medium text-muted-foreground leading-snug">
              <span className="md:hidden">{t(DASHBOARD.statDoneShort)}</span>
              <span className="hidden md:inline">{t(DASHBOARD.statDone)}</span>
            </CardTitle>
            <CheckCircle2 className="w-4 h-4 text-success flex-shrink-0" />
          </CardHeader>
          <CardContent className="p-3 pt-0 md:p-6 md:pt-0">
            {statsState === "loading" ? (
              <Skeleton className="h-7 w-10 md:h-8 md:w-16" />
            ) : statsState === "failed" ? (
              <LoadFailed what={DASHBOARD.thisNumber} compact onRetry={() => statsQuery.refetch()} testId="stats-failed-done" />
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
            what={ACCOUNT.planFailed}
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
            {/*
              The headline is paired at render time rather than copied into the
              copy table: its English half already lives in `lib/pricing.ts`,
              beside the numbers the server enforces, and `landing-test` refuses
              a second copy of a pricing line anywhere else. The Arabic half is
              the one the landing page already shows.
            */}
            <div className="text-sm font-semibold">
              {t(phrase(PRICING_AR.free.headline, FREE_TIER.headline))}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {fmt(FREE_BAND_DETAIL, FREE_TIER.minutes, FREE_TIER.uploadMinutes)}
            </div>
          </div>
          <Link href="/#pricing">
            <Button
              size="sm"
              variant="outline"
              data-testid="button-see-plans"
              className="rounded-full text-xs h-8 px-4 border-primary/30"
            >
              {t(COMMON.seePlans)}
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
                <span className="font-bold" dir="ltr">
                  {subscription.minutesUsedThisMonth} / {subscription.minutesIncluded}
                </span>
                {" "}{t(DASHBOARD.usageBand)}
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
              {fmt(DASHBOARD.planBadge, subscription.plan)}
            </Badge>
            {subscription.minutesUsedThisMonth / subscription.minutesIncluded >= 0.8 && (
              <Link href="/#pricing">
                {/* No `bg-primary hover:bg-primary/90`: that is the default
                    variant's own fill, plus a hover that fights `.aura-btn`'s.
                    Two rules changing the same background on hover is one of
                    them silently winning. */}
                <Button size="sm" className="rounded-full text-xs h-8 px-4">
                  {t(COMMON.upgrade)}
                </Button>
              </Link>
            )}
          </div>
        </div>
      )}

      {/*
        Podcasts and long recordings, first and separate.

        A two-hour episode and a nine-second hook are both "a project", and in
        one undifferentiated grid the episode is a card like any other — which
        is exactly backwards for the person this product is being built for.
        You do not open an episode to watch it. You open it to take pieces out
        of it, and you come back to the same one for weeks.

        The line is drawn at eight minutes of *source*, because that is where
        the intent changes: nothing under it is a recording you clip from, and
        the free plan's own upload ceiling is ten. Measured from the file, not
        from a label somebody has to remember to set — a section you have to
        maintain by hand is a section that is wrong by the second week.

        Hidden entirely when there are none, rather than showing an empty
        heading: a section that says "no podcasts" to somebody who does not
        make podcasts is furniture.
      */}
      {podcasts.length > 0 && (
        <div className="space-y-4 mb-10">
          <div className="flex items-baseline gap-3">
            <h2 className="text-xl font-semibold flex items-center gap-2">
              <Mic className="w-5 h-5 text-secondary flex-shrink-0" />
              {t(DASHBOARD.podcastsTitle)}
            </h2>
            <span className="text-xs text-muted-foreground">
              {t(DASHBOARD.podcastsHint)}
            </span>
            {/* And the door to the screen that does it. Listing the episodes
                here while the extraction lives elsewhere, with no link between
                them, made "Clips" a noun somebody had to guess was a verb. */}
            <Link
              href="/clips"
              className="text-xs text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-1"
              data-testid="link-clip-extraction"
            >
              <Scissors className="w-3 h-3" />
              {t(DASHBOARD.podcastsToClips)}
            </Link>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6" data-testid="grid-podcasts">
            {podcasts.map(projectCard)}
          </div>
        </div>
      )}

      {/*
        Projects Grid, hidden when the podcast grid above already holds
        everything.

        `projectsState` is computed from the whole list, so a library of nothing
        but long recordings is "ready" rather than "empty" — and this section
        rendered a heading called "Everything else" over an empty array. A
        podcaster whose every upload is over eight minutes got a correct grid
        followed by a heading with nothing under it, which reads as a section
        that failed to load.

        The empty state below is still reachable and still right: it is for a
        library with nothing in it at all, and that is exactly when `podcasts`
        is empty too.
      */}
      {(podcasts.length === 0 || shortForm.length > 0) && (
      <div className="space-y-4">
        <h2 className="text-xl font-semibold">
          {podcasts.length > 0 ? t(DASHBOARD.everythingElse) : t(DASHBOARD.recentProjects)}
        </h2>
        
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
            what={LOAD.yourProjects}
            onRetry={() => projectsQuery.refetch()}
            testId="projects-failed"
          />
        ) : projectsState === "empty" ? (
          <div className="flex flex-col items-center justify-center py-24 text-center glass-panel rounded-2xl border-hairline-faint border-dashed">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-4 border border-primary/20">
              <Video className="w-8 h-8 text-primary" />
            </div>
            <h3 className="text-xl font-bold mb-2">{t(DASHBOARD.emptyTitle)}</h3>
            <p className="text-muted-foreground max-w-sm mb-6">{t(DASHBOARD.emptyLead)}</p>
            <Button onClick={() => setIsCreateOpen(true)} variant="outline" className="rounded-full">
              {t(DASHBOARD.createProject)}
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6" data-testid="grid-projects">
            {shortForm.map(projectCard)}
          </div>
        )}
      </div>
      )}

      <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
        <DialogContent className="glass-panel border-hairline sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>{t(DASHBOARD.createTitle)}</DialogTitle>
            <DialogDescription>{t(DASHBOARD.createLead)}</DialogDescription>
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
              <div className="text-sm font-medium">{t(DASHBOARD.dropHere)}</div>
              <div className="text-xs text-muted-foreground mt-1">{t(DASHBOARD.dropHint)}</div>
              <input
                ref={createFileRef}
                type="file"
                /* The one list, not a copy of it: the picker and the check that runs on
                the chosen file have to name the same formats, and a hardcoded
                second copy is how heic, which the server accepts, stayed
                unpickable here. See `ACCEPTED_VIDEO_ACCEPT`. */
                accept={ACCEPTED_VIDEO_ACCEPT}
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
              {t(DASHBOARD.orNameFirst)}
              <div className="h-px flex-1 bg-hairline" />
            </div>
            <div className="flex flex-col gap-3">
              <Label htmlFor="name" className="text-start">
                {t(DASHBOARD.projectName)}
              </Label>
              <Input
                id="name"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder={t(DASHBOARD.projectNameHint)}
                className="col-span-3 bg-surface-1 border-hairline focus-visible:ring-primary"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreate();
                }}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setIsCreateOpen(false)}>{t(COMMON.cancel)}</Button>
            <Button 
              onClick={handleCreate} 
              disabled={!newTitle.trim() || createProject.isPending}
              /* The default variant already is this fill, and its hover is
                 the aura ring rather than a lighter colour. */
              className=""
              data-testid="button-submit-project"
            >
              {createProject.isPending ? <Loader2 className="w-4 h-4 me-2 animate-spin" /> : null}
              {t(DASHBOARD.createProject)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
