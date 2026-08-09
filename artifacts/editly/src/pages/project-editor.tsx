import { useState, useEffect, useLayoutEffect, useRef } from "react";
import { useLocation, useParams } from "wouter";
import { 
  useGetProject, 
  useUpdateProject,
  useListMessages,
  useSendMessage,
  useGetSubscription,
  useStartRender,
  useRenderStatus,
  useTemplates,
  isRenderInFlight,
  getGetProjectQueryKey,
  getListMessagesQueryKey,
  type EditOperation,
  type EditPlan
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";
import { 
  UploadCloud, Play, Pause, ChevronLeft, Send,
  Wand2, Download, CheckCircle2, Loader2,
  Video
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/lib/supabase";
import {
  uploadProjectVideo,
  usePlayableVideo,
  ACCEPTED_VIDEO_TYPES,
  MAX_UPLOAD_BYTES,
  formatBytes,
  readVideoFacts,
  captureThumbnail,
  uploadThumbnail,
} from "@/lib/video-storage";
import { ToastAction } from "@/components/ui/toast";
import { ScrollArea } from "@/components/ui/scroll-area";

/** m:ss — anything longer than an hour is not what this product is for. */
function formatTimecode(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

export default function ProjectEditor() {
  const params = useParams();
  const id = params.id as string;
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  
  const [isPlaying, setIsPlaying] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadedBytes, setUploadedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const cancelUploadRef = useRef<(() => void) | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isNoahThinking, setIsNoahThinking] = useState(false);
  /** The plan derived from the conversation, if the assistant understood one. */
  const [chatPlan, setChatPlan] = useState<EditPlan | null>(null);
  /** Set when the browser cannot decode or reach the file behind playbackUrl. */
  const [playbackFailed, setPlaybackFailed] = useState(false);
  /**
   * The video's own aspect ratio, read from the file itself.
   *
   * Without it the player was a fixed landscape box, so a 9:16 clip — which is
   * the entire point of this product — pillarboxed down to a thumbnail in the
   * middle of a wall of black.
   */
  const [decodedAspect, setDecodedAspect] = useState<number | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [playerDuration, setPlayerDuration] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  /** The area the picture gets to live in, measured rather than assumed. */
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  const { data: project, isLoading: isProjectLoading } = useGetProject(id, {
    query: { enabled: !!id, queryKey: getGetProjectQueryKey(id) }
  });

  const { data: messages, isLoading: isMessagesLoading } = useListMessages(id, {
    query: { enabled: !!id, queryKey: getListMessagesQueryKey(id) }
  });

  const updateProject = useUpdateProject();
  const sendMessage = useSendMessage();
  const startRender = useStartRender();
  const { data: subscription } = useGetSubscription();
  const { data: templates } = useTemplates();
  const { user } = useAuth();

  // The worker is the source of truth for what is happening to this video.
  const { data: renderJob } = useRenderStatus(id, { enabled: !!id });
  const isProcessingEdit = isRenderInFlight(renderJob);

  // The bucket is private, so playback needs a freshly signed URL.
  const { url: playbackUrl } = usePlayableVideo(
    project?.editedVideoPath ?? project?.videoPath ?? project?.editedVideoUrl ?? project?.videoUrl,
  );
  const hasVideo = Boolean(project?.videoPath ?? project?.videoUrl);

  /**
   * The ratio to draw at, preferring the file itself but falling back to what
   * was measured when it was uploaded.
   *
   * The stored pair is what makes the player the right shape on the very first
   * paint instead of snapping from 16:9 once the browser gets around to
   * decoding — and it is the only thing that keeps the shape right at all for a
   * codec the browser refuses to decode.
   */
  const aspect =
    decodedAspect ??
    (project?.width && project?.height ? project.width / project.height : null);

  /**
   * A vertical clip leaves a wide empty column beside it. Rather than spend the
   * height on a transport bar underneath — height being the one thing a 9:16
   * clip has none of — the controls move into that column and the frame takes
   * the full height.
   *
   * Below 720px of stage there is no column to move into, so it stays stacked.
   */
  const SIDE_COLUMN_WIDTH = 248;
  const SIDE_COLUMN_GAP = 16;
  const sideBySide = Boolean(aspect && aspect < 1 && stage.w >= 720);

  /**
   * The picture, fitted to the frame's slot by hand.
   *
   * Done in JS rather than CSS because `aspect-ratio` fights `max-width` and
   * `max-height`: whichever constraint bites, the box keeps the dimension that
   * did not, and ends up larger than the picture inside it — which puts the
   * play button and the badges over empty black rather than over the video.
   */
  const picture = (() => {
    const ratio = aspect ?? 16 / 9;
    const available = stage.w - (sideBySide ? SIDE_COLUMN_WIDTH + SIDE_COLUMN_GAP : 0);
    if (available <= 0 || !stage.h) return null;
    const width = Math.min(available, stage.h * ratio);
    return { width, height: width / ratio };
  })();

  /**
   * Measured synchronously before paint, not only through ResizeObserver.
   *
   * A ResizeObserver on its own leaves the picture at the fallback size until
   * the first callback arrives — and in a hidden tab that callback never
   * arrives at all, because delivery is tied to the rendering lifecycle. Come
   * back to such a tab and the video is still the wrong shape. Reading the box
   * in a layout effect settles it before the first frame is drawn; the observer
   * then only has to catch later resizes.
   *
   * `sideBySide` is a dependency because moving the controls out from under the
   * frame gives the frame back their height — the row is a different size the
   * instant that flips, and without a re-measure the picture keeps the size it
   * had while they were still stacked. Measured live: 446px tall instead of 578.
   * It converges after one extra pass, because the second measurement does not
   * change which layout is in use.
   */
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;

    const measure = () => {
      const box = el.getBoundingClientRect();
      setStage((previous) =>
        Math.abs(previous.w - box.width) < 0.5 && Math.abs(previous.h - box.height) < 0.5
          ? previous
          : { w: box.width, h: box.height },
      );
    };

    measure();
    window.addEventListener("resize", measure);
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(el);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [hasVideo, sideBySide]);

  // A new URL deserves a fresh attempt. A stalled load also has to be caught:
  // a browser that cannot decode a file often never fires `error`, it simply
  // sits in NETWORK_LOADING forever, which on screen is just a black rectangle.
  useEffect(() => {
    setPlaybackFailed(false);
    setDecodedAspect(null);
    setCurrentTime(0);
    if (!playbackUrl) return;
    const STALL_MS = 15_000;
    const timer = setTimeout(() => {
      const el = videoRef.current;
      if (el && el.readyState === 0) setPlaybackFailed(true);
    }, STALL_MS);
    return () => clearTimeout(timer);
  }, [playbackUrl]);

  useEffect(() => {
    // Scroll to bottom of chat
    if (scrollAreaRef.current) {
      const scrollContainer = scrollAreaRef.current.querySelector('[data-radix-scroll-area-viewport]');
      if (scrollContainer) {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
      }
    }
  }, [messages, isProcessingEdit, renderJob?.progress, isNoahThinking]);

  const validateAndUpload = async (file: File) => {
    if (!ACCEPTED_VIDEO_TYPES.includes(file.type) && !file.name.match(/\.(mp4|mov|webm)$/i)) {
      toast({
        title: "Invalid file type",
        description: "Please upload an mp4, mov, or webm file.",
        variant: "destructive"
      });
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      toast({
        title: "File too large",
        description: `That file is ${formatBytes(file.size)}. The current limit is ${formatBytes(MAX_UPLOAD_BYTES)} per video.`,
        variant: "destructive"
      });
      return;
    }

    // Read the token fresh — Supabase rotates it roughly hourly and the copy
    // held in context may already be past its expiry on a long-open tab.
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData.session?.access_token;
    if (!user || !accessToken) {
      toast({ title: "Please sign in again", variant: "destructive" });
      return;
    }

    setIsUploading(true);
    setUploadProgress(0);
    setUploadedBytes(0);
    setTotalBytes(file.size);

    // Real bytes on the wire, not a timer pretending to be one.
    const handle = uploadProjectVideo({
      file,
      userId: user.id,
      projectId: id,
      accessToken,
      onProgress: (percent, loaded, total) => {
        setUploadProgress(percent);
        setUploadedBytes(loaded);
        setTotalBytes(total);
      },
    });
    cancelUploadRef.current = handle.cancel;

    // Read the length and grab a poster frame while the bytes are in flight,
    // so neither costs the user any waiting. Both are best-effort: a file the
    // browser cannot decode still uploads, it just arrives without them.
    const facts = readVideoFacts(file).catch(() => null);
    const poster = captureThumbnail(file).catch(() => null);

    try {
      const videoPath = await handle.done;
      const [videoFacts, posterBlob] = await Promise.all([facts, poster]);

      let thumbnailPath: string | undefined;
      if (posterBlob) {
        thumbnailPath = await uploadThumbnail({
          blob: posterBlob,
          userId: user.id,
          projectId: id,
          accessToken,
        }).catch(() => undefined);
      }

      await updateProject.mutateAsync({
        id,
        data: {
          status: "ready",
          videoPath,
          ...(videoFacts ? { duration: videoFacts.duration } : {}),
          ...(videoFacts?.width && videoFacts?.height
            ? { width: videoFacts.width, height: videoFacts.height }
            : {}),
          ...(thumbnailPath ? { thumbnailPath } : {}),
        }
      });
      queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(id) });
      toast({
        title: "Video uploaded",
        description: "Your video is stored and ready for editing."
      });
    } catch (error) {
      toast({
        title: "Upload failed",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive"
      });
    } finally {
      cancelUploadRef.current = null;
      setIsUploading(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    validateAndUpload(file);
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    validateAndUpload(file);
  };

  const handleSendChat = async () => {
    if (!chatInput.trim() || !id) return;
    
    const content = chatInput;
    setChatInput("");

    setIsNoahThinking(true);
    try {
      const result = await sendMessage.mutateAsync({
        id,
        data: { content }
      }) as unknown as { plan?: EditPlan | null };
      // Whatever the reply promised is exactly what Generate Edit will build.
      if (result?.plan) setChatPlan(result.plan);
      queryClient.invalidateQueries({ queryKey: getListMessagesQueryKey(id) });
    } catch (error: unknown) {
      const status = (error as { status?: number })?.status;
      if (status === 429) {
        toast({
          title: "Edit limit reached",
          description: "You've used all your edits for this video on your current plan.",
          variant: "destructive",
          action: (
            <ToastAction altText="Upgrade plan" onClick={() => window.location.href = "/#pricing"}>
              Upgrade
            </ToastAction>
          ),
        });
      } else {
        toast({
          title: "Failed to send message",
          variant: "destructive"
        });
        setChatInput(content); // restore input
      }
    } finally {
      setIsNoahThinking(false);
    }
  };

  /**
   * Queues a real render. The work happens on the ffmpeg worker, so this
   * returns as soon as the job is written — `renderJob` below carries the
   * truth from then on.
   */
  const handleApplyTemplate = async (templateId: string) => {
    try {
      await startRender.mutateAsync({ id, templateId });
      queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(id) });
      toast({ title: "Render queued", description: "You can leave this page — we'll keep working." });
    } catch (error: unknown) {
      const status = (error as { status?: number })?.status;
      toast({
        title: status === 409 ? "Already rendering" : "Could not start the render",
        description: status === 409 ? "This project has a render in progress." : (error as { data?: { error?: string } })?.data?.error,
        variant: "destructive",
      });
    }
  };

  const handleGenerateEdit = async () => {
    // Whatever the conversation settled on, falling back to the sensible
    // default when nobody has said anything specific.
    const operations: EditOperation[] = chatPlan
      ? [...chatPlan.operations]
      : [
          { type: "removeSilence", thresholdDb: -32, minSilenceMs: 500, paddingMs: 80 },
          { type: "formatForPlatform", platform: (project?.platform ?? "tiktok") as "tiktok" | "reels" | "shorts" },
        ];

    // The growth loop: free-plan renders carry the mark, paid ones do not.
    if ((subscription?.plan ?? "starter") === "starter") {
      operations.push({ type: "watermark", text: "Edited with Editly", position: "bottom-right" });
    }

    try {
      await startRender.mutateAsync({ id, plan: { version: 1, operations } });
      queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(id) });
      toast({
        title: "Render queued",
        description: "You can leave this page — we'll keep working."
      });
    } catch (error: unknown) {
      const status = (error as { status?: number })?.status;
      toast({
        title: status === 409 ? "Already rendering" : "Could not start the render",
        description:
          status === 409
            ? "This project has a render in progress."
            : (error as { data?: { error?: string } })?.data?.error,
        variant: "destructive"
      });
    }
  };

  const togglePlay = () => {
    if (videoRef.current) {
      if (isPlaying) {
        videoRef.current.pause();
      } else {
        videoRef.current.play();
      }
      setIsPlaying(!isPlaying);
    }
  };

  if (isProjectLoading) {
    return (
      <div className="w-full h-screen flex flex-col">
        <div className="h-16 border-b border-white/5 flex items-center px-6">
          <Skeleton className="h-8 w-8 mr-4" />
          <Skeleton className="h-6 w-48" />
        </div>
        <div className="flex-1 flex gap-6 p-6">
          <div className="flex-1">
            <Skeleton className="w-full h-full rounded-2xl" />
          </div>
          <div className="w-[400px]">
            <Skeleton className="w-full h-full rounded-2xl" />
          </div>
        </div>
      </div>
    );
  }

  if (!project) {
    return <div className="p-12 text-center">Project not found</div>;
  }

  /**
   * Play, scrub, timecode. Laid out in a row under a landscape clip and in a
   * column beside a vertical one — the same controls either way, so the two
   * layouts cannot drift apart.
   */
  const transport = (
    <div className={`rounded-xl glass-panel border border-white/10 px-4 py-3 ${sideBySide ? "" : "mt-3"}`}>
      <div className={`flex gap-3 ${sideBySide ? "flex-col" : "items-center"}`}>
        <div className="flex items-center gap-3">
          <button
            onClick={togglePlay}
            className="w-9 h-9 flex-shrink-0 rounded-full bg-white/10 hover:bg-white/15 flex items-center justify-center transition-colors"
            aria-label={isPlaying ? "Pause" : "Play"}
            data-testid="button-scrub-play"
          >
            {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
          </button>
          {sideBySide && (
            <span className="text-xs tabular-nums text-muted-foreground" data-testid="text-timecode">
              {formatTimecode(currentTime)} / {formatTimecode(playerDuration || project.duration || 0)}
            </span>
          )}
        </div>

        <input
          type="range"
          min={0}
          max={playerDuration || project.duration || 0}
          step={0.05}
          value={currentTime}
          onChange={(e) => {
            const next = Number(e.target.value);
            setCurrentTime(next);
            if (videoRef.current) videoRef.current.currentTime = next;
          }}
          className="flex-1 h-1.5 appearance-none rounded-full bg-white/10 accent-primary cursor-pointer
                     [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5
                     [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full
                     [&::-webkit-slider-thumb]:bg-secondary
                     [&::-webkit-slider-thumb]:shadow-[0_0_8px_rgba(155,107,255,0.8)]"
          data-testid="input-scrubber"
        />

        {!sideBySide && (
          <span className="text-xs tabular-nums text-muted-foreground flex-shrink-0" data-testid="text-timecode">
            {formatTimecode(currentTime)} / {formatTimecode(playerDuration || project.duration || 0)}
          </span>
        )}
      </div>
    </div>
  );

  /** One-click looks — each a saved edit plan, so the name is what you get. */
  const looks = templates && templates.length > 0 && (
    <div
      className={`rounded-xl glass-panel border border-white/10 px-3 py-2 ${
        sideBySide ? "flex flex-col gap-2 items-stretch" : "mt-3 flex items-center gap-2 overflow-x-auto"
      }`}
    >
      <div className="flex items-center gap-2 flex-shrink-0">
        <Wand2 className="w-3.5 h-3.5 text-secondary flex-shrink-0" />
        <span className="text-xs font-medium text-muted-foreground">Looks</span>
      </div>
      {templates.map((template) => (
        <button
          key={template.id}
          onClick={() => handleApplyTemplate(template.id)}
          disabled={isProcessingEdit || startRender.isPending}
          title={`${template.description} — ${template.bestFor}`}
          className={`flex-shrink-0 border border-white/10 bg-white/[0.03] text-xs font-medium transition-all hover:border-primary/40 hover:bg-white/[0.06] disabled:opacity-40 disabled:cursor-not-allowed ${
            sideBySide ? "rounded-lg px-3 py-2 text-left" : "rounded-full px-3 py-1.5"
          }`}
          data-testid={`button-template-${template.id}`}
        >
          {template.name}
        </button>
      ))}
    </div>
  );

  return (
    <div className="w-full h-screen flex flex-col bg-background overflow-hidden">
      {/* Topbar */}
      <header className="h-16 flex-shrink-0 border-b border-white/10 bg-background/50 backdrop-blur-md flex items-center justify-between px-6 z-10">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => setLocation('/dashboard')} className="text-muted-foreground hover:text-foreground">
            <ChevronLeft className="w-5 h-5" />
          </Button>
          <div className="h-6 w-px bg-white/10" />
          <h1 className="font-semibold text-lg" data-testid="text-editor-title">{project.title}</h1>
          <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-xs text-muted-foreground">
            {project.status}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <Button 
            variant="outline" 
            className="border-white/10"
            disabled={!hasVideo}
            onClick={() => setLocation(`/export/${project.id}`)}
            data-testid="button-export"
          >
            <Download className="w-4 h-4 mr-2" />
            Export
          </Button>
          <Button 
            className="glow-btn btn-gradient-cta text-white border-0"
            disabled={!hasVideo || isProcessingEdit || project.status === 'uploading'}
            onClick={handleGenerateEdit}
            data-testid="button-generate-edit"
          >
            <Wand2 className="w-4 h-4 mr-2" />
            Generate Edit
          </Button>
        </div>
      </header>

      <div className="flex-1 flex flex-col lg:flex-row overflow-hidden relative">
        {/* Main Editor Area */}
        <div className="flex-1 flex flex-col relative p-4 lg:p-6 overflow-hidden">
          
          {!hasVideo && (
            <div className="flex-1 relative rounded-2xl overflow-hidden glass-panel border border-white/10 bg-black/40 flex flex-col">
              <div className="absolute inset-0 flex flex-col items-center justify-center p-8 text-center">
                {isUploading ? (
                  <div className="flex flex-col items-center w-full max-w-sm">
                    <Loader2 className="w-12 h-12 text-primary animate-spin mb-4" />
                    <h3 className="text-xl font-semibold mb-2">Uploading Video...</h3>
                    <div className="w-full h-2 bg-white/10 rounded-full overflow-hidden mb-2">
                      <div className="h-full bg-primary transition-all duration-300" style={{ width: `${uploadProgress}%` }} />
                    </div>
                    <p className="text-sm text-muted-foreground" data-testid="text-upload-progress">
                      {uploadProgress}%{totalBytes > 0 && ` · ${formatBytes(uploadedBytes)} of ${formatBytes(totalBytes)}`}
                    </p>
                  </div>
                ) : (
                  <div 
                    className={`flex flex-col items-center justify-center border-2 border-dashed rounded-2xl w-full max-w-lg aspect-video cursor-pointer transition-all group ${isDragOver ? 'border-primary bg-primary/10 scale-[1.02]' : 'border-white/20 hover:border-primary/50 hover:bg-primary/5'}`}
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                  >
                    <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                      <UploadCloud className={`w-8 h-8 transition-colors ${isDragOver ? 'text-primary' : 'text-muted-foreground group-hover:text-primary'}`} />
                    </div>
                    <h3 className="text-xl font-semibold mb-2">Upload Raw Footage</h3>
                    <p className="text-muted-foreground mb-2">Drag and drop or click to browse</p>
                    <p className="text-xs text-muted-foreground/60 mb-6">MP4, MOV or WebM &bull; up to {formatBytes(MAX_UPLOAD_BYTES)}</p>
                    <Button variant="secondary" className="rounded-full pointer-events-none">
                      Select Video
                    </Button>
                    <input 
                      type="file" 
                      ref={fileInputRef} 
                      className="hidden" 
                      accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm" 
                      onChange={handleFileChange}
                    />
                </div>
              )}
              </div>
            </div>
          )}

          {hasVideo && (
            /* The frame is the video. What was here before was a wide panel
               with the clip parked in the middle of it, so a 9:16 recording sat
               in a landscape box surrounded by black — the frame said landscape
               even when the footage did not. The panel border, the glow and the
               rounded corners now wrap the picture itself, and on a vertical
               clip the transport and the looks move into the column beside it
               rather than eating the height the clip needs. */
            <div ref={stageRef} className="flex-1 min-h-0 flex items-stretch justify-center gap-4">
              {/* Content-width, not flex-1: the frame and its controls read as
                  one object centred in the space, rather than the frame drifting
                  to one edge with a gap between them. */}
              <div className="min-w-0 flex items-center justify-center">
                <div
                  className="relative rounded-2xl overflow-hidden glass-panel border border-white/10"
                  style={{
                    width: picture ? `${picture.width}px` : "100%",
                    height: picture ? `${picture.height}px` : "100%",
                    background: "linear-gradient(135deg, #06030f 0%, #0a0518 50%, #080312 100%)",
                    boxShadow:
                      "0 0 0 1px rgba(108,59,255,0.15), 0 24px 60px rgba(0,0,0,0.55), 0 0 90px rgba(108,59,255,0.18)",
                  }}
                  data-testid="video-stage"
                >
                    <video
                      ref={videoRef}
                      src={playbackUrl ?? undefined}
                      className="w-full h-full object-contain"
                      controls={false}
                      preload="metadata"
                      onLoadedMetadata={(e) => {
                        const el = e.currentTarget;
                        if (el.videoWidth && el.videoHeight) setDecodedAspect(el.videoWidth / el.videoHeight);
                        if (Number.isFinite(el.duration)) setPlayerDuration(el.duration);
                      }}
                      onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                      onEnded={() => setIsPlaying(false)}
                      onError={() => setPlaybackFailed(true)}
                      data-testid="video-preview"
                    />

                    {/* The two purple edges. They were on the old wide stage and
                        went with it; Osama asked for them back, so they now run
                        along the frame itself — which is where they belong, since
                        the frame is the picture. Above everything, including the
                        failure notice, so the frame keeps its edges whatever is
                        happening inside it. */}
                    <div
                      className="absolute inset-x-0 top-0 h-1 z-30 pointer-events-none"
                      style={{ background: "linear-gradient(90deg, transparent, rgba(108,59,255,0.4), rgba(155,107,255,0.6), rgba(108,59,255,0.4), transparent)" }}
                      data-testid="frame-edge-top"
                    />
                    <div
                      className="absolute inset-x-0 bottom-0 h-1 z-30 pointer-events-none"
                      style={{ background: "linear-gradient(90deg, transparent, rgba(108,59,255,0.3), rgba(155,107,255,0.5), rgba(108,59,255,0.3), transparent)" }}
                      data-testid="frame-edge-bottom"
                    />

                    {/* Everything below sits on the picture rather than on the
                        stage, so on a vertical clip the controls and badges are
                        over the video instead of floating in the black beside
                        it. */}

                    {/* A black rectangle is indistinguishable from a broken app.
                        Say what happened, and note that the render is unaffected. */}
                    {playbackFailed && (
                      <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-black/80 px-6 text-center">
                        <p className="font-semibold">This file will not play in the browser</p>
                        <p className="text-sm text-muted-foreground max-w-md">
                          Your video is stored safely and can still be edited — some codecs just cannot be
                          previewed here. The rendered result will play normally.
                        </p>
                      </div>
                    )}

                    {/* Play/Pause overlay */}
                    <div
                      className="absolute inset-0 flex items-center justify-center opacity-0 hover:opacity-100 bg-black/20 transition-opacity cursor-pointer"
                      onClick={togglePlay}
                    >
                      <div className="w-16 h-16 rounded-full bg-black/50 backdrop-blur-sm border border-white/10 flex items-center justify-center text-white">
                        {isPlaying ? <Pause className="w-8 h-8" /> : <Play className="w-8 h-8 ml-1" />}
                      </div>
                    </div>

                    {project.status === 'done' && (
                      <div className="absolute top-3 left-3 px-3 py-1 rounded-full bg-green-500/20 text-green-400 border border-green-500/30 text-xs font-medium flex items-center backdrop-blur-md">
                        <CheckCircle2 className="w-3 h-3 mr-1" />
                        AI Edited
                      </div>
                    )}
                </div>
              </div>

              {sideBySide && (
                <aside
                  className="flex-shrink-0 flex flex-col gap-3 overflow-y-auto"
                  style={{ width: SIDE_COLUMN_WIDTH }}
                  data-testid="side-controls"
                >
                  {transport}
                  {looks}
                </aside>
              )}
            </div>
          )}

          {/* Stacked under a landscape clip, where the width is the plentiful
              dimension. A vertical clip puts these in the column instead. */}
          {hasVideo && !sideBySide && (
            <div>
              {transport}
              {looks}
            </div>
          )}
        </div>

        {/* AI Chat Sidebar */}
        <div className="w-full lg:w-[400px] border-l border-white/10 bg-background/80 backdrop-blur-xl flex flex-col z-20 shadow-[-20px_0_40px_rgba(0,0,0,0.5)]">
          {/* Noah header */}
          <div className="p-4 border-b border-white/10 flex items-center gap-3">
            <div className="relative flex-shrink-0">
              <img
                src="/noah-avatar.jpg"
                alt="Noah"
                className="w-10 h-10 rounded-full object-cover shadow-[0_0_12px_rgba(108,59,255,0.5)] ring-2 ring-primary/30"
              />
              <span className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full bg-green-400 border-2 border-background shadow-[0_0_6px_rgba(74,222,128,0.8)]" />
            </div>
            <div>
              <h2 className="font-semibold text-sm leading-tight">Noah</h2>
              <p className="text-xs text-muted-foreground">Your AI editor</p>
            </div>
          </div>
          
          <ScrollArea ref={scrollAreaRef} className="flex-1 p-4">
            <div className="space-y-5 flex flex-col">
              {/* Welcome message — only shown when no messages exist yet */}
              {!isMessagesLoading && (!messages || messages.length === 0) && (
              <div className="flex gap-3 items-start">
                <img
                  src="/noah-avatar.jpg"
                  alt="Noah"
                  className="w-10 h-10 rounded-full object-cover flex-shrink-0 shadow-[0_2px_10px_rgba(0,0,0,0.4)] ring-1 ring-white/10"
                />
                <div className="flex flex-col gap-1 min-w-0">
                  <span className="text-xs font-semibold text-purple-300 px-1">Noah</span>
                  <div className="bg-white/5 border border-white/10 rounded-2xl rounded-tl-sm px-4 py-3 text-sm leading-relaxed">
                    Hey, I'm Noah 👋<br />Your AI video editor.<br /><br />Upload your video and tell me the vibe — I'll turn it into a viral clip.
                  </div>
                </div>
              </div>
              )}

              {/* Messages */}
              {isMessagesLoading ? (
                <div className="flex gap-3 items-start">
                  <Skeleton className="w-10 h-10 rounded-full flex-shrink-0" />
                  <div className="flex flex-col gap-1 flex-1">
                    <Skeleton className="h-3 w-10 rounded" />
                    <Skeleton className="h-16 w-3/4 rounded-2xl" />
                  </div>
                </div>
              ) : (
                messages?.map(msg => (
                  <div key={msg.id} className={`message-appear flex gap-3 items-start ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
                    {msg.role === 'assistant' && (
                      <img
                        src="/noah-avatar.jpg"
                        alt="Noah"
                        className="w-10 h-10 rounded-full object-cover flex-shrink-0 shadow-[0_2px_10px_rgba(0,0,0,0.4)] ring-1 ring-white/10"
                      />
                    )}
                    <div className={`flex flex-col gap-1 min-w-0 ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                      {msg.role === 'assistant' && (
                        <span className="text-xs font-semibold text-purple-300 px-1">Noah</span>
                      )}
                      <div className={`px-4 py-3 text-sm leading-relaxed ${
                        msg.role === 'user'
                          ? 'bg-primary/20 border border-primary/30 rounded-2xl rounded-tr-sm text-foreground max-w-[85%]'
                          : 'bg-white/5 border border-white/10 rounded-2xl rounded-tl-sm'
                      }`}>
                        {msg.content}
                      </div>
                    </div>
                  </div>
                ))
              )}

              {/* Typing state — Noah is thinking or responding */}
              {(isNoahThinking || sendMessage.isPending) && (
                <div className="flex gap-3 items-start">
                  <img
                    src="/noah-avatar.jpg"
                    alt="Noah"
                    className="w-10 h-10 rounded-full object-cover flex-shrink-0 shadow-[0_2px_10px_rgba(0,0,0,0.4)] ring-1 ring-white/10"
                  />
                  <div className="flex flex-col gap-1">
                    <span className="text-xs font-semibold text-purple-300 px-1">Noah</span>
                    <div className="bg-white/5 border border-white/10 rounded-2xl rounded-tl-sm px-4 py-3 flex items-center gap-1.5">
                      <span className="typing-dot w-1.5 h-1.5 rounded-full bg-purple-400 inline-block" />
                      <span className="typing-dot w-1.5 h-1.5 rounded-full bg-purple-400 inline-block" />
                      <span className="typing-dot w-1.5 h-1.5 rounded-full bg-purple-400 inline-block" />
                    </div>
                  </div>
                </div>
              )}

              {/* Live render progress, reported by the worker itself */}
              {(isProcessingEdit || renderJob?.status === "failed") && (
                <div className="flex gap-3 items-start">
                  <img
                    src="/noah-avatar.jpg"
                    alt="Noah"
                    className="w-10 h-10 rounded-full object-cover flex-shrink-0 shadow-[0_2px_10px_rgba(0,0,0,0.4)] ring-1 ring-white/10"
                  />
                  <div className="flex flex-col gap-1 flex-1">
                    <span className="text-xs font-semibold text-purple-300 px-1">Noah</span>
                    <div className="bg-white/5 border border-secondary/30 rounded-2xl rounded-tl-sm px-4 py-3 text-sm w-full shadow-[0_0_15px_rgba(155,107,255,0.1)]">
                      {renderJob?.status === "failed" ? (
                        <>
                          <p className="font-semibold text-destructive mb-1">That render didn't finish.</p>
                          <p className="text-xs text-muted-foreground" data-testid="text-render-error">
                            {renderJob.error ?? "Something went wrong on our side."}
                          </p>
                        </>
                      ) : (
                        <>
                          <p className="font-semibold text-secondary mb-3 flex items-center gap-2">
                            <Loader2 className="w-4 h-4 animate-spin" />
                            {renderJob?.status === "queued" ? "Waiting for a free slot…" : (renderJob?.stage ?? "Working on it…")}
                          </p>
                          <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-secondary transition-all duration-500"
                              style={{ width: `${renderJob?.progress ?? 0}%` }}
                              data-testid="bar-render-progress"
                            />
                          </div>
                          <p className="text-xs text-muted-foreground mt-2">
                            {renderJob?.progress ?? 0}% · you can close this page, it keeps going
                          </p>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )}

            </div>
          </ScrollArea>

          <div className="p-4 border-t border-white/10 bg-black/20">
            <form 
              onSubmit={(e) => { e.preventDefault(); handleSendChat(); }}
              className="relative"
            >
              <Input
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                placeholder="Describe your edit..."
                className="input-chat-glow pr-12 bg-white/5 border-white/10 rounded-full h-12"
                disabled={!hasVideo || isNoahThinking || sendMessage.isPending || isProcessingEdit}
                data-testid="input-chat"
              />
              <Button 
                type="submit"
                size="icon"
                disabled={!chatInput.trim() || !hasVideo || isNoahThinking || sendMessage.isPending || isProcessingEdit}
                className="absolute right-1 top-1 h-10 w-10 rounded-full bg-secondary text-white hover:bg-secondary/90 hover:shadow-[0_0_15px_rgba(155,107,255,0.6)] transition-all"
                data-testid="button-send-message"
              >
                <Send className="w-4 h-4" />
              </Button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
