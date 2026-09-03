import { useState, useEffect, useRef } from "react";
import { useLocation, useParams } from "wouter";
import { 
  useGetProject, 
  useStartExport,
  useGetExportStatus,
  getGetProjectQueryKey,
  getGetExportStatusQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronLeft, Download, Smartphone, PlaySquare, CheckCircle2, Loader2, AlertCircle, VideoOff } from "lucide-react";
import { BackButton } from "@/components/back-button";
import { useToast } from "@/hooks/use-toast";
import { usePlayableVideo, downloadableVideoUrl } from "@/lib/video-storage";
import { loadState, isNotFound } from "@/lib/load-state";
import { LoadFailed } from "@/components/load-failed";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { playbackVerdict, PLAYBACK_POLL_MS } from "@/lib/playability";
import { ScheduleComposer } from "@/components/schedule-composer";
import { apiJson } from "@/lib/api-fetch";
import { useLanguage } from "@/lib/language";
import { COMMON, LOAD, REFUSAL } from "@/lib/copy/common";
import { EXPORT } from "@/lib/copy/export";
import type { PlatformInfo, ConnectedAccount } from "@/components/social-connections";

export default function ExportPage() {
  const params = useParams();
  const id = params.id as string;
  const [, setLocation] = useLocation();
  const { t, fmt } = useLanguage();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const [platform, setPlatform] = useState<"tiktok" | "reels" | "shorts" | "youtube" | "square">("tiktok");
  const [isExporting, setIsExporting] = useState(false);

  /*
    Where this edit could go, asked for once on arrival.

    Not lazily when the render finishes: the answer is needed the moment the
    "Ready to Share" card appears, and asking then means the composer pops in a
    second late underneath a button somebody is already reaching for. Both
    requests are cheap and neither blocks anything on screen.

    A failure here is deliberately silent. Not being able to list connected
    accounts is a reason to hide the scheduler; it is not a reason to put an
    error over a video that rendered perfectly.
  */
  const [destinations, setDestinations] = useState<{
    platforms: PlatformInfo[];
    accounts: ConnectedAccount[];
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [cat, mine] = await Promise.all([
        apiJson<{ platforms?: PlatformInfo[] }>("/api/social/platforms"),
        apiJson<{ accounts?: ConnectedAccount[] }>("/api/social/accounts"),
      ]);
      if (cancelled || !cat.ok || !mine.ok) return;
      setDestinations({ platforms: cat.body.platforms ?? [], accounts: mine.body.accounts ?? [] });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const projectQuery = useGetProject(id, {
    query: { enabled: !!id, queryKey: getGetProjectQueryKey(id) }
  });
  const { data: project } = projectQuery;
  const projectState = loadState(projectQuery);

  // The bucket is private, so playback and download need a signed URL.
  const { url: playbackUrl, previewUrl: playbackPreviewUrl, isResolving: playbackResolving } = usePlayableVideo(
    project?.editedVideoPath ?? project?.videoPath ?? project?.editedVideoUrl ?? project?.videoUrl,
  );

  const hasVideo = Boolean(project?.videoPath ?? project?.videoUrl);

  // Asked for on every visit, not only while this tab happens to have started
  // one.
  //
  // `isExporting` is a local boolean that resets on every mount, and it used to
  // gate this query — so reloading the page, or stepping back to the editor and
  // returning, made a render that was genuinely running invisible. The server
  // has the row the whole time. What the person saw instead was the platform
  // picker and a live "Render & Export" button; clicking it hit the server's
  // 409 guard, which this screen has no branch for, so they were told the
  // export failed to start while it was in fact running.
  const exportQuery = useGetExportStatus(id, {
    query: {
      enabled: !!id,
      queryKey: getGetExportStatusQueryKey(id),
      // A project that has never been exported answers 404, which is an answer
      // rather than a fault. Retrying it four times on every visit is noise.
      retry: (count, error) => (isNotFound(error) ? false : count < 2),
      refetchInterval: (query) => {
        // Stop polling if done or failed
        if (query.state.data?.status === 'done' || query.state.data?.status === 'failed') {
          return false;
        }
        return 2000;
      }
    }
  });
  const { data: exportStatus } = exportQuery;
  const exportState = loadState(exportQuery);

  // A render this page did not start is still a render this page must show.
  const isRunning = isExporting || exportStatus?.status === 'pending';

  // The finished file, signed from the key this export reported — not from the
  // project. `project` is a cached copy fetched before this export existed, so
  // its `editedVideoPath` is still null when the export finishes, and the
  // preview fell through to `videoPath`: the original upload, offered for
  // download under a card saying the edit was ready.
  const { url: exportedUrl, previewUrl: exportedPreviewUrl, isResolving: exportedResolving } = usePlayableVideo(exportStatus?.outputPath ?? null);

  /* The download is signed on the press rather than kept alongside the playable
     one, because the two are different signatures and only one of them is used.
     It is a round trip, so the button says it is doing something. */
  const [isPreparingDownload, setIsPreparingDownload] = useState(false);

  /**
   * The pair actually on screen. The download button below deliberately keeps
   * using the mp4 master — the preview is for *watching here*, on browsers
   * whose H.264 decoder is broken; what people hand to TikTok stays H.264.
   */
  const shown = exportedUrl
    ? { url: exportedUrl, preview: exportedPreviewUrl }
    : { url: playbackUrl, preview: playbackPreviewUrl };

  /** A URL that is being minted is not a video that is missing. */
  const isSigning = playbackResolving || exportedResolving;

  /*
    And a URL that arrived is not a video that plays.

    This screen had three states — signing, no URL, no video at all — and no
    fourth for the one that actually happens on a real machine: the file is
    there, the element has it, and the browser will not decode it. The master
    is H.264 and that decoder is a licensed operating-system component; a
    browser without it sits in `NETWORK_LOADING` forever with no `error` event,
    which on screen is a black phone-shaped rectangle beside a green "Ready to
    Share". The editor has said so for months. This screen said nothing.

    Same verdict function as the editor and the stock sheet, so all three agree
    about what "will not play" means — and it is asked repeatedly and allowed
    to answer "fine" again, because a single timer once told the owner of a
    perfectly good file that it would not play while the element was still
    loading it.
  */
  const previewRef = useRef<HTMLVideoElement>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  useEffect(() => {
    setPreviewFailed(false);
    if (!shown.url) return;
    const startedAt = Date.now();
    const tick = () => {
      const verdict = playbackVerdict(previewRef.current, Date.now() - startedAt);
      if (verdict === "pending") return;
      setPreviewFailed(verdict === "failed");
      clearInterval(timer);
    };
    const timer = setInterval(tick, PLAYBACK_POLL_MS);
    tick();
    return () => clearInterval(timer);
  }, [shown.url, shown.preview]);

  const startExport = useStartExport();

  // Watch export status changes
  useEffect(() => {
    if (exportStatus) {
      if (exportStatus.status === 'done') {
        setIsExporting(false);
        // The project row now points at the new render. Without this the editor
        // and the preview keep showing the previous cut.
        queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(id) });
        toast({
          title: t(EXPORT.complete),
          description: t(EXPORT.completeDetail)
        });
      } else if (exportStatus.status === 'failed') {
        setIsExporting(false);
        toast({
          title: t(EXPORT.failed),
          description: t(EXPORT.failedDetail),
          variant: "destructive"
        });
      }
    }
  }, [exportStatus, toast, queryClient, id]);

  const handleStartExport = async () => {
    try {
      setIsExporting(true);
      await startExport.mutateAsync({
        id,
        data: { platform }
      });
      // Start polling
      queryClient.invalidateQueries({ queryKey: getGetExportStatusQueryKey(id) });
    } catch (error: unknown) {
      const status = (error as { status?: number })?.status;
      const said = (error as { data?: { error?: string } })?.data?.error;

      // A 409 means one is already running — which is not a failure to start,
      // it is the answer to "has one started". Telling somebody their export
      // could not be started while it is being rendered is the worst of the
      // four possible sentences here, and it was the one this screen always
      // said. Keep the running state and let the poll show it.
      if (status === 409) {
        setIsExporting(true);
        queryClient.invalidateQueries({ queryKey: getGetExportStatusQueryKey(id) });
        toast({
          title: t(REFUSAL.alreadyRendering),
          description: t(REFUSAL.renderInProgress),
        });
        return;
      }

      setIsExporting(false);
      // 429 and 413 are policy, not breakage: the server has already written a
      // sentence naming the minutes or the length. Show it rather than an
      // apology that says nothing. Same rule as the editor.
      toast({
        title:
          status === 429
            ? t(REFUSAL.notEnoughMinutes)
            : status === 413
              ? t(REFUSAL.tooLongForPlan)
              : t(EXPORT.couldNotStart),
        description: said,
        variant: "destructive"
      });
    }
  };

  if (projectState === "loading") {
    return (
      <div className="w-full max-w-5xl mx-auto px-6 py-12">
        <Skeleton className="h-8 w-48 mb-8" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
          <Skeleton className="aspect-[9/16] w-full rounded-2xl" />
          <div className="space-y-6">
            <Skeleton className="h-64 w-full rounded-2xl" />
            <Skeleton className="h-16 w-full rounded-2xl" />
          </div>
        </div>
      </div>
    );
  }

  if (projectState === "failed") {
    return (
      <div className="w-full max-w-3xl mx-auto px-6 py-24">
        <LoadFailed what={LOAD.thisProject} onRetry={() => projectQuery.refetch()} testId="project-failed" />
      </div>
    );
  }

  if (projectState === "missing" || !project) {
    return <div className="p-12 text-center">{t(EXPORT.notFound)}</div>;
  }

  // Four states, not two. "We have not asked" and "we asked and could not
  // read it" are no longer collapsed into "idle", which is what made a running
  // export look like one that had never been started.
  const currentStatus =
    exportState === "loading" && !exportStatus
      ? 'loading'
      : isRunning
        ? (exportStatus?.status ?? 'pending')
        : exportStatus?.status === 'done'
          ? 'done'
          : 'idle';

  return (
    <div className="w-full max-w-6xl mx-auto px-6 py-12 min-h-screen">
      <BackButton
        fallback={`/project/${project.id}`}
        label={t(COMMON.back)}
        className="mb-8 -ms-4"
        testId="button-back-export"
      />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 items-start">
        {/* Preview Container.
            Second on a phone, first from `lg` up. A preview is what you check
            *after* you know what screen you are on and what it is offering — and
            putting it first meant the heading, the platform picker and the
            export button were all below the fold. `order` rather than moving
            the markup, so the reading order for a screen reader stays: what
            this is, then what it looks like. */}
        <div className="order-2 lg:order-1 lg:col-span-5 flex justify-center">
          {/* Smaller on a phone.
              At 390px this was 358×636, and with the back button above it the
              page's own heading — the thing that says what screen you are on —
              started below the fold. A preview is worth a third of the screen,
              not all of it. */}
          <div className="force-dark w-full max-w-[240px] sm:max-w-[360px] aspect-[9/16] bg-background text-foreground rounded-3xl overflow-hidden border-4 border-hairline relative shadow-[0_0_50px_var(--glass-bloom)]">
            {shown.url ? (
              <video
                key={shown.preview ?? shown.url}
                ref={previewRef}
                className="w-full h-full object-cover"
                controls
                /* See the note in project-editor: without this, pressing play
                   on an iPhone hands the screen to the system player. */
                playsInline
                autoPlay
                loop
                muted
              >
                {/* VP9 first — it decodes in software everywhere; the H.264
                    master leans on an OS codec we have watched be broken. */}
                {shown.preview && <source src={shown.preview} type="video/webm" />}
                <source src={shown.url} type="video/mp4" />
              </video>
            ) : isSigning ? (
              // Signing a private object takes a round trip. Saying "no video"
              // during it — under a red alert icon, beside an enabled Render
              // button — tells someone with 40 MB sitting in storage that their
              // upload was lost, on every single visit.
              <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground p-6 text-center">
                <Loader2 className="w-8 h-8 mb-2 animate-spin" />
                <p>{t(EXPORT.loadingVideo)}</p>
              </div>
            ) : hasVideo ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground p-6 text-center">
                <AlertCircle className="w-8 h-8 mb-2" />
                <p>{t(EXPORT.previewFailed)}</p>
                <p className="text-xs mt-1 opacity-70">{t(EXPORT.previewFailedDetail)}</p>
              </div>
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground p-6 text-center">
                <AlertCircle className="w-8 h-8 mb-2" />
                <p>{t(EXPORT.noVideo)}</p>
              </div>
            )}
            
            {/* The fourth state, over the frame rather than instead of it, so
                the controls underneath stay usable — the same arrangement the
                editor settled on, and for the same reason: not being able to
                see a frame does not stop somebody from downloading the file or
                scheduling it. */}
            {previewFailed && (
              <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-1.5 bg-black/85 px-4 text-center">
                <VideoOff className="w-5 h-5 text-muted-foreground flex-shrink-0" />
                <p className="text-sm font-semibold leading-snug">{t(EXPORT.wontPreview)}</p>
                <p className="text-xs text-muted-foreground leading-snug">
                  {t(EXPORT.wontPreviewDetail)}
                </p>
              </div>
            )}

            {/* Where the platform will put its own chrome.
                This is a guide, not decoration: TikTok, Reels and Shorts all
                draw a column of buttons up the right edge and a caption along
                the bottom, and anything the edit places there is covered on the
                only screen that matters. It has to *read* as a guide, though —
                three filled grey circles at 80% opacity, sitting over the
                video's own controls, read as an interface that failed to load.
                Dashed and unfilled, with the reason written under it, it reads
                as what it is.

                `aria-hidden`: it is a drawing of somebody else's app. */}
            <div aria-hidden="true" className="absolute inset-0 pointer-events-none">
              <div className="absolute end-3 bottom-28 flex flex-col gap-3">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="w-9 h-9 rounded-full border border-dashed border-white/25" />
                ))}
              </div>
              <div className="absolute bottom-16 start-3 end-14">
                <div className="h-10 rounded-lg border border-dashed border-white/25" />
              </div>
            </div>
          </div>
        </div>

        {/* Export Controls */}
        <div className="order-1 lg:order-2 lg:col-span-7 flex flex-col gap-8">
          <div>
            <h1 className="text-4xl font-bold tracking-tight mb-2">{t(EXPORT.title)}</h1>
            <p dir="auto" className="text-xl text-muted-foreground">{project.title}</p>
          </div>

          {currentStatus === 'loading' && (
            <Card className="glass-panel border-hairline">
              <CardHeader>
                <CardTitle className="flex items-center gap-3">
                  <Loader2 className="w-6 h-6 animate-spin text-primary" />
                  {t(EXPORT.checkingTitle)}
                </CardTitle>
                <CardDescription>{t(EXPORT.checkingLead)}</CardDescription>
              </CardHeader>
            </Card>
          )}

          {currentStatus === 'idle' && (
            <>
              <Card className="glass-panel border-hairline">
                <CardHeader>
                  <CardTitle>{t(EXPORT.pickTitle)}</CardTitle>
                  <CardDescription>{t(EXPORT.pickLead)}</CardDescription>
                </CardHeader>
                <CardContent>
                  <RadioGroup value={platform} onValueChange={(v) => setPlatform(v as "tiktok" | "reels" | "shorts" | "youtube" | "square")} className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                      <RadioGroupItem value="tiktok" id="tiktok" className="peer sr-only" />
                      <Label
                        htmlFor="tiktok"
                        className="flex flex-col items-center justify-between rounded-xl border-2 border-hairline bg-band p-4 hover:bg-surface-1 hover:text-accent-foreground peer-data-[state=checked]:border-primary peer-data-[state=checked]:bg-primary/10 [&:has([data-state=checked])]:border-primary cursor-pointer transition-all"
                      >
                        <Smartphone className="mb-3 h-8 w-8 text-[#00f2fe]" />
                        <span className="font-semibold text-lg">TikTok</span>
                        <span className="text-xs text-muted-foreground mt-1">{t(EXPORT.vertical)}</span>
                      </Label>
                    </div>
                    <div>
                      <RadioGroupItem value="reels" id="reels" className="peer sr-only" />
                      <Label
                        htmlFor="reels"
                        className="flex flex-col items-center justify-between rounded-xl border-2 border-hairline bg-band p-4 hover:bg-surface-1 hover:text-accent-foreground peer-data-[state=checked]:border-secondary peer-data-[state=checked]:bg-secondary/10 [&:has([data-state=checked])]:border-secondary cursor-pointer transition-all"
                      >
                        <PlaySquare className="mb-3 h-8 w-8 text-[#E1306C]" />
                        <span className="font-semibold text-lg">Reels</span>
                        <span className="text-xs text-muted-foreground mt-1">{t(EXPORT.vertical)}</span>
                      </Label>
                    </div>
                    <div>
                      <RadioGroupItem value="shorts" id="shorts" className="peer sr-only" />
                      <Label
                        htmlFor="shorts"
                        className="flex flex-col items-center justify-between rounded-xl border-2 border-hairline bg-band p-4 hover:bg-surface-1 hover:text-accent-foreground peer-data-[state=checked]:border-red-500 peer-data-[state=checked]:bg-red-500/10 [&:has([data-state=checked])]:border-red-500 cursor-pointer transition-all"
                      >
                        <PlaySquare className="mb-3 h-8 w-8 text-red-500" />
                        <span className="font-semibold text-lg">Shorts</span>
                        <span className="text-xs text-muted-foreground mt-1">{t(EXPORT.vertical)}</span>
                      </Label>
                    </div>
                  </RadioGroup>
                </CardContent>
              </Card>

              <Button
                size="lg"
                /* No `glow-btn`, and no `bg-primary` either: the Button
                   component's default variant is `.aura-btn` in the primary
                   tint now, and two classes both writing `box-shadow` is one of
                   them silently winning. This screen was the last place in the
                   app still wearing the old ring, which is why the finished
                   render sat under a button that matched nothing around it. */
                className="w-full h-16 text-lg font-bold rounded-xl"
                onClick={handleStartExport}
                disabled={!hasVideo}
                data-testid="button-start-export"
              >
                {t(EXPORT.renderAndExport)}
              </Button>
            </>
          )}

          {currentStatus === 'pending' && (
            <Card className="glass-panel border-primary/30 shadow-[0_0_30px_rgba(108,59,255,0.15)] relative overflow-hidden">
              <div className="absolute top-0 start-0 h-1 bg-primary animate-pulse w-full"></div>
              <CardHeader>
                <CardTitle className="flex items-center gap-3">
                  <Loader2 className="w-6 h-6 animate-spin text-primary" />
                  {t(EXPORT.renderingTitle)}
                </CardTitle>
                <CardDescription>
                  {fmt(EXPORT.renderingLead, exportStatus?.platform ?? platform)}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {exportStatus?.steps.map((step, idx) => (
                  <div key={idx} className="flex items-center gap-4">
                    {step.status === 'done' ? (
                      <CheckCircle2 className="w-6 h-6 text-success flex-shrink-0" />
                    ) : step.status === 'active' ? (
                      <Loader2 className="w-6 h-6 animate-spin text-secondary flex-shrink-0" />
                    ) : (
                      <div className="w-6 h-6 rounded-full border-2 border-hairline-strong flex-shrink-0" />
                    )}
                    <span dir="auto" className={`text-lg ${
                      step.status === 'active' ? 'text-foreground font-medium' : 
                      step.status === 'done' ? 'text-muted-foreground' : 'text-foreground/30'
                    }`}>
                      {step.label}
                    </span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {currentStatus === 'done' && (
            <Card className="glass-panel border-green-500/30 shadow-[0_0_30px_rgba(34,197,94,0.15)]">
              <CardHeader className="text-center pb-2">
                <div className="mx-auto w-16 h-16 rounded-full bg-green-500/20 flex items-center justify-center mb-4">
                  <CheckCircle2 className="w-8 h-8 text-success" />
                </div>
                <CardTitle className="text-2xl text-success">{t(EXPORT.readyTitle)}</CardTitle>
                <CardDescription>
                  {fmt(EXPORT.readyLead, exportStatus?.platform || platform)}
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-6">
                <Button
                  size="lg"
                  /* The default variant, which is `.aura-btn` in the primary
                     tint — the same object as every other button in the app.

                     It replaces `bg-foreground` with a raw `shadow-[...]`
                     glow, which is not a quieter version of that look but a
                     different one: a blur has no edge and reads as haze around
                     a flat disc, where a spread ring reads as a second, softer
                     silhouette. Inverting the strongest action on the screen
                     also made it the one control that matched nothing else. */
                  className="w-full h-16 text-lg font-bold rounded-xl"
                  // The edit, or nothing. There is deliberately no fallback to
                  // the original upload here: handing someone their own file
                  // back under a button marked "Download Video" is worse than
                  // a button that is briefly unavailable, because they will not
                  // find out until they have posted it.
                  disabled={!exportedUrl || isPreparingDownload}
                  onClick={async () => {
                    if (!exportedUrl) return;
                    const filename = `${project.title.replace(/\s+/g, '-').toLowerCase()}-${platform}.mp4`;

                    /*
                      Signed for saving, not for playing.

                      `<a download>` is ignored for a cross-origin href, and
                      every URL here is cross-origin: the file is on Supabase,
                      the page is on our own domain. So the attribute was
                      decoration. The browser followed the link, Storage
                      answered `Content-Disposition: inline`, and the tab played
                      the video — on a phone, full screen, with the filename
                      gone and no obvious way to keep it. Nothing failed: the
                      button worked, the file was right, and the person was
                      looking at their finished video wondering where it had
                      been saved.

                      Storage will send `attachment` and the name if it is asked
                      at signing time, which is the only moment that choice can
                      be made, because it is inside the signature.
                    */
                    setIsPreparingDownload(true);
                    const key = exportStatus?.outputPath;
                    const signed = key ? await downloadableVideoUrl(key, filename) : null;
                    setIsPreparingDownload(false);

                    const link = document.createElement('a');
                    // The playable URL is the fallback rather than nothing: a
                    // video that opens in a tab is worse than one that saves,
                    // and much better than a button that does not work.
                    link.href = signed ?? exportedUrl;
                    link.download = filename;
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);

                    toast({
                      title: t(EXPORT.downloadStarted),
                      description: t(EXPORT.downloadStartedDetail)
                    });
                  }}
                  data-testid="button-download"
                >
                  <Download className="w-5 h-5 me-3" />
                  {!exportedUrl
                    ? t(EXPORT.preparingFile)
                    : isPreparingDownload
                      ? t(EXPORT.gettingReady)
                      : t(EXPORT.downloadVideo)}
                </Button>

                {(exportStatus?.notes?.length ?? 0) > 0 && (
                  <div className="mt-6 rounded-xl border border-hairline bg-surface-1 p-4" data-testid="render-notes">
                    <p className="text-sm font-semibold mb-2">{t(EXPORT.whatWeDid)}</p>
                    <ul className="space-y-1.5">
                      {exportStatus?.notes?.map((note, i) => (
                        <li key={i} dir="auto" className="text-sm text-muted-foreground leading-relaxed">
                          {note}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {destinations ? (
                  <div className="mt-6">
                    <ScheduleComposer
                      projectId={id}
                      exportId={exportStatus?.id ?? null}
                      platforms={destinations.platforms}
                      accounts={destinations.accounts}
                      // The *edit's* shape and length, not the source's. A 16:9
                      // take reframed to 9:16 is vertical, and judging it on
                      // the upload would refuse the very thing this screen just
                      // did. Same for the length: a three-minute take cut to
                      // ninety seconds fits X, and the source length says it
                      // does not.
                      //
                      // `undefined` rather than the source length when the
                      // render could not be measured, because "unknown" and
                      // "too long" must not be the same answer — the limits
                      // treat a null duration as no reason to refuse.
                      durationSeconds={exportStatus?.outputSeconds ?? null}
                      width={project.editedWidth ?? project.width ?? null}
                      height={project.editedHeight ?? project.height ?? null}
                    />
                  </div>
                ) : null}

                <div className="mt-6 flex gap-4 justify-center">
                  <Button variant="outline" className="border-hairline" onClick={() => {
                    setIsExporting(false); // Reset to start another export
                    queryClient.invalidateQueries({ queryKey: getGetExportStatusQueryKey(id) });
                  }}>
                    {t(EXPORT.anotherFormat)}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
