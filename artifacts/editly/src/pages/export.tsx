import { useState, useEffect } from "react";
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
import { ChevronLeft, Download, Smartphone, PlaySquare, CheckCircle2, Loader2, AlertCircle } from "lucide-react";
import { BackButton } from "@/components/back-button";
import { useToast } from "@/hooks/use-toast";
import { usePlayableVideo } from "@/lib/video-storage";
import { loadState, isNotFound } from "@/lib/load-state";
import { LoadFailed } from "@/components/load-failed";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";

export default function ExportPage() {
  const params = useParams();
  const id = params.id as string;
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const [platform, setPlatform] = useState<"tiktok" | "reels" | "shorts" | "youtube" | "square">("tiktok");
  const [isExporting, setIsExporting] = useState(false);

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
          title: "Export Complete!",
          description: "Your video is ready to download."
        });
      } else if (exportStatus.status === 'failed') {
        setIsExporting(false);
        toast({
          title: "Export Failed",
          description: "Something went wrong. Please try again.",
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
        toast({ title: "Already rendering", description: "This project has a render in progress." });
        return;
      }

      setIsExporting(false);
      // 429 and 413 are policy, not breakage: the server has already written a
      // sentence naming the minutes or the length. Show it rather than an
      // apology that says nothing. Same rule as the editor.
      toast({
        title:
          status === 429
            ? "Not enough minutes left"
            : status === 413
              ? "That file is too long for this plan"
              : "Could not start export",
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
        <LoadFailed what="this project" onRetry={() => projectQuery.refetch()} testId="project-failed" />
      </div>
    );
  }

  if (projectState === "missing" || !project) return <div className="p-12 text-center">Project not found</div>;

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
        label="Back"
        className="mb-8 -ml-4"
        testId="button-back-export"
      />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 items-start">
        {/* Preview Container */}
        <div className="lg:col-span-5 flex justify-center">
          <div className="force-dark w-full max-w-[360px] aspect-[9/16] bg-background text-foreground rounded-3xl overflow-hidden border-4 border-hairline relative shadow-[0_0_50px_var(--glass-bloom)]">
            {shown.url ? (
              <video
                key={shown.preview ?? shown.url}
                className="w-full h-full object-cover"
                controls
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
                <p>Loading your video…</p>
              </div>
            ) : hasVideo ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground p-6 text-center">
                <AlertCircle className="w-8 h-8 mb-2" />
                <p>We could not load the preview</p>
                <p className="text-xs mt-1 opacity-70">
                  Your video is stored safely — this is a problem on our side, and exporting still works.
                </p>
              </div>
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground p-6 text-center">
                <AlertCircle className="w-8 h-8 mb-2" />
                <p>No video available to export</p>
              </div>
            )}
            
            {/* Fake Platform UI Overlay based on selection */}
            <div className="absolute right-4 bottom-24 flex flex-col gap-4 pointer-events-none opacity-80">
              <div className="w-10 h-10 rounded-full bg-surface-3 backdrop-blur border border-hairline-strong" />
              <div className="w-10 h-10 rounded-full bg-surface-3 backdrop-blur border border-hairline-strong" />
              <div className="w-10 h-10 rounded-full bg-surface-3 backdrop-blur border border-hairline-strong" />
            </div>
            <div className="absolute bottom-4 left-4 right-16 pointer-events-none opacity-80">
              <div className="w-32 h-4 bg-surface-3 rounded mb-2" />
              <div className="w-48 h-3 bg-surface-3 rounded" />
            </div>
          </div>
        </div>

        {/* Export Controls */}
        <div className="lg:col-span-7 flex flex-col gap-8">
          <div>
            <h1 className="text-4xl font-bold tracking-tight mb-2 glow-text">Export Project</h1>
            <p dir="auto" className="text-xl text-muted-foreground">{project.title}</p>
          </div>

          {currentStatus === 'loading' && (
            <Card className="glass-panel border-hairline">
              <CardHeader>
                <CardTitle className="flex items-center gap-3">
                  <Loader2 className="w-6 h-6 animate-spin text-primary" />
                  Checking for a render in progress
                </CardTitle>
                <CardDescription>
                  One moment — offering to start an export while one is already running is how you
                  end up being told it failed.
                </CardDescription>
              </CardHeader>
            </Card>
          )}

          {currentStatus === 'idle' && (
            <>
              <Card className="glass-panel border-hairline">
                <CardHeader>
                  <CardTitle>Select Platform Format</CardTitle>
                  <CardDescription>
                    AI will optimize the framing and resolution for your chosen platform.
                  </CardDescription>
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
                        <span className="text-xs text-muted-foreground mt-1">9:16 Vertical</span>
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
                        <span className="text-xs text-muted-foreground mt-1">9:16 Vertical</span>
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
                        <span className="text-xs text-muted-foreground mt-1">9:16 Vertical</span>
                      </Label>
                    </div>
                  </RadioGroup>
                </CardContent>
              </Card>

              <Button 
                size="lg" 
                className="w-full h-16 text-lg font-bold rounded-xl glow-btn bg-primary text-primary-foreground hover:bg-primary/90"
                onClick={handleStartExport}
                disabled={!hasVideo}
                data-testid="button-start-export"
              >
                Render & Export
              </Button>
            </>
          )}

          {currentStatus === 'pending' && (
            <Card className="glass-panel border-primary/30 shadow-[0_0_30px_rgba(108,59,255,0.15)] relative overflow-hidden">
              <div className="absolute top-0 left-0 h-1 bg-primary animate-pulse w-full"></div>
              <CardHeader>
                <CardTitle className="flex items-center gap-3">
                  <Loader2 className="w-6 h-6 animate-spin text-primary" />
                  Rendering Video
                </CardTitle>
                <CardDescription>
                  Applying final AI touches and formatting for {exportStatus?.platform ?? platform}.
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
                    <span className={`text-lg ${
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
                <CardTitle className="text-2xl text-success">Ready to Share</CardTitle>
                <CardDescription>
                  Your video has been successfully optimized for {exportStatus?.platform || platform}.
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-6">
                <Button
                  size="lg"
                  className="w-full h-16 text-lg font-bold rounded-xl bg-foreground text-background hover:bg-foreground/85 transition-all shadow-[0_0_20px_var(--invert-glow)]"
                  // The edit, or nothing. There is deliberately no fallback to
                  // the original upload here: handing someone their own file
                  // back under a button marked "Download Video" is worse than
                  // a button that is briefly unavailable, because they will not
                  // find out until they have posted it.
                  disabled={!exportedUrl}
                  onClick={() => {
                    if (!exportedUrl) return;
                    const link = document.createElement('a');
                    link.href = exportedUrl;
                    link.download = `${project.title.replace(/\s+/g, '-').toLowerCase()}-${platform}.mp4`;
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);

                    toast({
                      title: "Download started",
                      description: "Your video is downloading."
                    });
                  }}
                  data-testid="button-download"
                >
                  <Download className="w-5 h-5 mr-3" />
                  {exportedUrl ? "Download Video" : "Preparing your file…"}
                </Button>

                {(exportStatus?.notes?.length ?? 0) > 0 && (
                  <div className="mt-6 rounded-xl border border-hairline bg-surface-1 p-4" data-testid="render-notes">
                    <p className="text-sm font-semibold mb-2">What we did</p>
                    <ul className="space-y-1.5">
                      {exportStatus?.notes?.map((note, i) => (
                        <li key={i} dir="auto" className="text-sm text-muted-foreground leading-relaxed">
                          {note}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="mt-6 flex gap-4 justify-center">
                  <Button variant="outline" className="border-hairline" onClick={() => {
                    setIsExporting(false); // Reset to start another export
                    queryClient.invalidateQueries({ queryKey: getGetExportStatusQueryKey(id) });
                  }}>
                    Export Another Format
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
