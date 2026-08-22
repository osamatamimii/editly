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
  getRenderStatusQueryKey,
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
  Video, Sparkles
} from "lucide-react";
import { BackButton } from "@/components/back-button";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { loadState } from "@/lib/load-state";
import { playbackVerdict, PLAYBACK_POLL_MS } from "@/lib/playability";
import { LoadFailed } from "@/components/load-failed";
import { supabase } from "@/lib/supabase";
import {
  uploadProjectVideo,
  uploadReferenceVideo,
  MAX_REFERENCE_BYTES,
  usePlayableVideo,
  ACCEPTED_VIDEO_TYPES,
  MAX_UPLOAD_BYTES,
  formatBytes,
  readVideoFacts,
  captureThumbnail,
  captureFrameFrom,
  uploadThumbnail,
} from "@/lib/video-storage";
import { ToastAction } from "@/components/ui/toast";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ProjectLibrary } from "@/components/project-library";
import { takePendingUpload } from "@/lib/pending-upload";

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
  /**
   * Which half of the upload is running.
   *
   * "sending" is bytes on the wire. "finishing" is everything after they have
   * landed — reading the clip's length and grabbing a poster frame, both
   * best-effort and both with timeouts measured in tens of seconds. The screen
   * used to say "Uploading Video…" through all of it, so a bar reading
   * "100% · 252 KB of 252 KB" sat under a heading claiming the transfer was
   * still going. The file was already stored; only the trimmings were pending.
   */
  const [uploadPhase, setUploadPhase] = useState<"sending" | "finishing">("sending");
  const cancelUploadRef = useRef<(() => void) | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isNoahThinking, setIsNoahThinking] = useState(false);
  const [isAttachingReference, setIsAttachingReference] = useState(false);
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

  const projectQuery = useGetProject(id, {
    query: { enabled: !!id, queryKey: getGetProjectQueryKey(id) }
  });

  const messagesQuery = useListMessages(id, {
    query: { enabled: !!id, queryKey: getListMessagesQueryKey(id) }
  });

  const { data: project } = projectQuery;
  const { data: messages } = messagesQuery;

  // Failure is checked before absence. "Project not found" in response to a
  // read that failed tells someone their work is gone when it is sitting right
  // there — which is worse than any error message.
  const projectState = loadState(projectQuery);
  const messagesState = loadState(messagesQuery, (list) => list.length === 0);

  const updateProject = useUpdateProject();
  const sendMessage = useSendMessage();
  const startRender = useStartRender();
  const { data: subscription } = useGetSubscription();
  const { data: templates } = useTemplates();
  const { user } = useAuth();

  // The worker is the source of truth for what is happening to this video.
  const { data: renderJob } = useRenderStatus(id, { enabled: !!id });
  const isProcessingEdit = isRenderInFlight(renderJob);

  /**
   * The render settled, so the project row is now out of date. Refetch it.
   *
   * Without this the page rewards the person who stays and watches, with the
   * worse experience. The bar reaches 100%, the progress block disappears, and
   * Noah posts "Here's what I did" with the worker's notes — while the cached
   * project is still the copy fetched before the render started. So
   * `editedVideoPath` is null, the player is still pointed at the *original*
   * upload, the header pill still says `processing`, and the "AI Edited" badge
   * never arrives. They press play, watch their raw take with every um still in
   * it under a message claiming the silences were cut, and report that the edit
   * did nothing. Anyone who walked away and came back saw the right thing,
   * because react-query refetches on window focus.
   *
   * `export.tsx` has done this from the start, with a comment saying exactly
   * why. This is the same two lines on the screen people actually use.
   */
  const settledJobRef = useRef<string | null>(null);
  useEffect(() => {
    const status = renderJob?.status;
    if (status !== "done" && status !== "failed") return;
    const key = `${renderJob?.id ?? id}:${status}`;
    if (settledJobRef.current === key) return;
    settledJobRef.current = key;
    queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(id) });
    queryClient.invalidateQueries({ queryKey: getListMessagesQueryKey(id) });
  }, [renderJob?.id, renderJob?.status, id, queryClient]);

  // The bucket is private, so playback needs a freshly signed URL.
  const { url: playbackUrl, previewUrl } = usePlayableVideo(
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
  const showingEdited = Boolean(project?.editedVideoPath);
  const aspect =
    decodedAspect ??
    (showingEdited && project?.editedWidth && project?.editedHeight
      ? project.editedWidth / project.editedHeight
      : project?.width && project?.height
        ? project.width / project.height
        : null);

  /**
   * A vertical clip leaves a wide empty column beside it, so the looks move
   * there and get room to be read rather than squeezed into pills. The scrubber
   * stays directly under the picture in both orientations — that is where a
   * timeline belongs, against the frame it scrubs.
   *
   * Below 820px of stage there is no column to move into, so it stays stacked.
   */
  const SIDE_COLUMN_WIDTH = 320;
  const SIDE_COLUMN_GAP = 16;
  const sideBySide = Boolean(aspect && aspect < 1 && stage.w >= 820);

  /** Measured, because guessing it would either crop the picture or leave a gap. */
  const transportRef = useRef<HTMLDivElement>(null);
  const [transportHeight, setTransportHeight] = useState(0);
  const TRANSPORT_GAP = 12;

  /**
   * The picture, fitted to what is left of the stage once the scrubber beneath
   * it has taken its share.
   *
   * Done in JS rather than CSS because `aspect-ratio` fights `max-width` and
   * `max-height`: whichever constraint bites, the box keeps the dimension that
   * did not, and ends up larger than the picture inside it — which puts the
   * play button and the badges over empty black rather than over the video.
   */
  const picture = (() => {
    const ratio = aspect ?? 16 / 9;
    const availableW = stage.w - (sideBySide ? SIDE_COLUMN_WIDTH + SIDE_COLUMN_GAP : 0);
    const availableH = stage.h - (transportHeight ? transportHeight + TRANSPORT_GAP : 0);
    if (availableW <= 0 || availableH <= 0) return null;
    const width = Math.min(availableW, availableH * ratio);
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
      const bar = transportRef.current?.getBoundingClientRect().height ?? 0;
      setTransportHeight((previous) => (Math.abs(previous - bar) < 0.5 ? previous : bar));
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

  /**
   * Projects made before posters existed have none, and the dashboard shows
   * them as grey rectangles forever. Opening one now gives it a poster from the
   * clip it already has — once per project, quietly, and never at the cost of
   * anything the user is waiting on.
   *
   * Done here rather than on the dashboard on purpose: this page is a single
   * project the user chose to open, so it fetches one clip. The dashboard would
   * be pulling every clip in the library at once to draw its own cards.
   */
  const posterAttemptedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!project || !user || !playbackUrl) return;
    if (project.thumbnailPath) return;
    if (posterAttemptedFor.current === project.id) return;
    posterAttemptedFor.current = project.id;

    let cancelled = false;
    (async () => {
      try {
        const blob = await captureFrameFrom(playbackUrl);
        if (cancelled) return;
        const { data } = await supabase.auth.getSession();
        const accessToken = data.session?.access_token;
        if (!accessToken) return;
        const thumbnailPath = await uploadThumbnail({
          blob,
          userId: user.id,
          projectId: project.id,
          accessToken,
        });
        if (cancelled) return;
        await updateProject.mutateAsync({ id: project.id, data: { thumbnailPath } });
        queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(project.id) });
      } catch {
        // Best effort by design: a project without a poster is a duller card,
        // not a broken one, and this must never interrupt the editor.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [project?.id, project?.thumbnailPath, playbackUrl, user?.id]);

  // A new URL deserves a fresh attempt. A stalled load also has to be caught:
  // a browser that cannot decode a file often never fires `error`, it simply
  // sits in NETWORK_LOADING forever, which on screen is just a black rectangle.
  //
  // But it is asked repeatedly rather than once, and the answer is allowed to
  // go back to "fine". The single fifteen-second timer this replaces told the
  // owner of a perfectly good file that it would not play — while the element
  // was still loading it, with no error — and nothing could ever undo that.
  useEffect(() => {
    setPlaybackFailed(false);
    setDecodedAspect(null);
    setCurrentTime(0);
    if (!playbackUrl) return;
    const startedAt = Date.now();
    const tick = () => {
      const verdict = playbackVerdict(videoRef.current, Date.now() - startedAt);
      if (verdict === "pending") return;
      setPlaybackFailed(verdict === "failed");
      clearInterval(timer);
    };
    const timer = setInterval(tick, PLAYBACK_POLL_MS);
    tick();
    return () => clearInterval(timer);
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
    setUploadPhase("sending");
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
      // The bytes are committed from here on. Nothing below can lose the file,
      // so nothing below may keep saying it is being uploaded.
      cancelUploadRef.current = null;
      setUploadPhase("finishing");
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
          // Each fact travels on its own: a clip can have good dimensions and
          // an unreadable duration, and losing the pair because of the one
          // would leave the player guessing at the shape.
          ...(videoFacts && videoFacts.duration > 0 ? { duration: videoFacts.duration } : {}),
          ...(videoFacts && videoFacts.width > 0 && videoFacts.height > 0
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

  /**
   * A video chosen on the dashboard arrives here as a stashed File: the
   * project was created from it one page ago, and this is the first moment
   * the upload pipeline exists to receive it. `takePendingUpload` deletes on
   * read, so a re-mount cannot start the same upload twice.
   *
   * Waits for the project row and the signed-in user, because the upload needs
   * both — and does nothing for a project that already has footage, so a stale
   * stash can never overwrite a video.
   */
  useEffect(() => {
    if (!id || !user || !project || project.videoPath || isUploading) return;
    const file = takePendingUpload(id);
    if (file) void validateAndUpload(file);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once, when the pieces are all present
  }, [id, user, project?.id, project?.videoPath]);

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
      }) as unknown as { plan?: EditPlan | null; render?: { id: string } | null };
      // Whatever the reply promised is exactly what Generate Edit will build.
      if (result?.plan) setChatPlan(result.plan);
      queryClient.invalidateQueries({ queryKey: getListMessagesQueryKey(id) });
      // The sentence may have *started the render* — that is the product's
      // promise, one prompt and the work begins. The server already queued it;
      // all the editor has to do is stop showing yesterday and start showing
      // the progress this message just caused.
      if (result?.render) {
        queryClient.invalidateQueries({ queryKey: getRenderStatusQueryKey(id) });
        queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(id) });
      }
    } catch (error: unknown) {
      // There is deliberately no "you have used all your edits" branch here.
      // The messages route has no cap and cannot return 429, and the pricing
      // page promises unlimited edits — asking again is the loop this product
      // is built around, so a toast implying otherwise was both dead and wrong.
      {
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
   * Attaches a video whose look this edit should match.
   *
   * The whole feature is one file and one column: the worker measures the
   * reference — how often it cuts, how much silence it leaves, how loud and how
   * saturated it ends up — and sets the numbers inside the plan to match. It
   * never invents operations the plan did not ask for, so attaching a reference
   * cannot turn a quiet edit into a frantic one.
   */
  const handleAttachReference = async (file: File) => {
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData.session?.access_token;
    if (!user || !accessToken || !project) return;

    setIsAttachingReference(true);
    try {
      const referenceVideoPath = await uploadReferenceVideo({
        file,
        userId: user.id,
        projectId: project.id,
        accessToken,
      });
      await updateProject.mutateAsync({ id: project.id, data: { referenceVideoPath } });
      queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(id) });
      toast({
        title: "Reference attached",
        description: "Your next render will be edited to match it.",
      });
    } catch (error: unknown) {
      const status = (error as { status?: number })?.status;
      toast({
        // 402 is the plan speaking, and it has already written the sentence.
        title: status === 402 ? "That's a paid feature" : "Could not attach that reference",
        description:
          (error as { data?: { error?: string } })?.data?.error ??
          (error instanceof Error ? error.message : undefined),
        variant: "destructive",
        ...(status === 402
          ? {
              action: (
                <ToastAction altText="See plans" onClick={() => { window.location.href = "/#pricing"; }}>
                  See plans
                </ToastAction>
              ),
            }
          : {}),
      });
    } finally {
      setIsAttachingReference(false);
    }
  };

  const handleClearReference = async () => {
    if (!project) return;
    try {
      await updateProject.mutateAsync({ id: project.id, data: { referenceVideoPath: null } });
      queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(id) });
    } catch {
      toast({ title: "Could not remove the reference", variant: "destructive" });
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
      const said = (error as { data?: { error?: string } })?.data?.error;
      // 429 and 413 are policy, not failure: the server has already written a
      // sentence naming the minutes or the length and what to do about it, so
      // it is shown as-is rather than replaced with a generic apology. This is
      // also the one place an upgrade button belongs — it used to sit on a
      // dead branch for a limit that does not exist.
      const isPolicy = status === 429 || status === 413;
      toast({
        title:
          status === 409
            ? "Already rendering"
            : status === 429
              ? "Not enough minutes left"
              : status === 413
                ? "That file is too long for this plan"
                : "Could not start the render",
        description: status === 409 ? "This project has a render in progress." : said,
        variant: "destructive",
        ...(isPolicy
          ? {
              action: (
                <ToastAction altText="See plans" onClick={() => { window.location.href = "/#pricing"; }}>
                  See plans
                </ToastAction>
              ),
            }
          : {}),
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

    // The mark is not sent from here, and deliberately so. It used to be, with
    // a comparison against a plan name that no longer exists — so after the
    // rename every free render quietly came out clean. Worse, it meant the
    // growth loop was enforced in a browser, where anyone can edit the request.
    // The server adds it from the subscription now, on every render path.

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

  if (projectState === "loading") {
    return (
      <div className="w-full h-screen flex flex-col">
        <div className="h-16 border-b border-hairline-faint flex items-center px-6">
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

  if (projectState === "failed") {
    return (
      <div className="w-full max-w-3xl mx-auto px-6 py-24">
        <LoadFailed what="this project" onRetry={() => projectQuery.refetch()} testId="project-failed" />
      </div>
    );
  }

  if (projectState === "missing" || !project) {
    return <div className="p-12 text-center">Project not found</div>;
  }

  /**
   * Play, scrub, timecode — always directly under the picture, as wide as the
   * picture, whatever shape the clip is. A timeline that sits anywhere else is
   * a timeline you have to go looking for.
   */
  const transport = (
    <div ref={transportRef} className="rounded-xl glass-panel border border-hairline px-4 py-3">
      <div className="flex items-center gap-3">
        <button
          onClick={togglePlay}
          className="w-9 h-9 flex-shrink-0 rounded-full bg-surface-2 hover:bg-surface-2 flex items-center justify-center transition-colors"
          aria-label={isPlaying ? "Pause" : "Play"}
          data-testid="button-scrub-play"
        >
          {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
        </button>

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
          className="flex-1 min-w-0 h-1.5 appearance-none rounded-full bg-surface-2 accent-primary cursor-pointer
                     [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5
                     [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full
                     [&::-webkit-slider-thumb]:bg-secondary
                     [&::-webkit-slider-thumb]:shadow-[0_0_8px_rgba(155,107,255,0.8)]"
          data-testid="input-scrubber"
        />

        <span className="text-xs tabular-nums text-muted-foreground flex-shrink-0" data-testid="text-timecode">
          {formatTimecode(currentTime)} / {formatTimecode(playerDuration || project.duration || 0)}
        </span>
      </div>
    </div>
  );

  /**
   * One-click looks — each a saved edit plan, so the name is what you get.
   *
   * In the side column they are proper cards with the description showing:
   * "High energy" alone does not tell you what it will do to your footage, and
   * a tooltip you have to hover to find is not an answer. Squeezed into a row
   * under a landscape clip there is no room for that, so they stay as pills
   * with the description in the tooltip.
   */
  /**
   * The reference video: "edit this like that one".
   *
   * It sits with the looks because it is the same kind of decision — a saved
   * style versus a measured one — and because the honest way to describe it is
   * next to four named alternatives, so nobody thinks it does more than it does.
   */
  const reference = project && (
    <div
      className={`rounded-xl glass-panel border border-hairline ${
        sideBySide ? "flex flex-col gap-2 px-4 py-4" : "mt-3 px-3 py-2.5"
      }`}
      data-testid="panel-reference"
    >
      <div className="flex items-center gap-2 mb-1">
        <Sparkles className={`text-secondary flex-shrink-0 ${sideBySide ? "w-4 h-4" : "w-3.5 h-3.5"}`} />
        <span className={`font-medium text-muted-foreground ${sideBySide ? "text-sm" : "text-xs"}`}>
          Match another video
        </span>
      </div>

      {project.referenceVideoPath ? (
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground leading-snug">
            Your next render is edited to match the clip you attached — its pace, how much
            silence it keeps, its level and its colour.
          </span>
          <button
            onClick={handleClearReference}
            className="flex-shrink-0 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            data-testid="button-clear-reference"
          >
            Remove
          </button>
        </div>
      ) : (
        <>
          <p className="text-[11px] leading-snug text-muted-foreground mb-2">
            Upload a short clip in the style you want and we read it: how often it cuts, how
            much silence it leaves, how loud and how graded it ends up. Under{" "}
            {formatBytes(MAX_REFERENCE_BYTES)} — we only look at the first two minutes.
          </p>
          <label
            className={`inline-flex items-center justify-center gap-2 rounded-xl border border-hairline bg-surface-1 px-4 py-2.5 text-xs font-medium cursor-pointer transition-all hover:border-primary/40 hover:bg-white/[0.06] ${
              isAttachingReference ? "opacity-50 pointer-events-none" : ""
            }`}
            data-testid="button-attach-reference"
          >
            {isAttachingReference ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Uploading…
              </>
            ) : (
              "Choose a reference clip"
            )}
            <input
              type="file"
              accept={ACCEPTED_VIDEO_TYPES.join(",")}
              className="hidden"
              disabled={isAttachingReference}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void handleAttachReference(file);
              }}
            />
          </label>
        </>
      )}
    </div>
  );

  // Shown whenever there is a project to hold files, not only once a source
  // video exists: gathering the b-roll before the take is a normal order of
  // operations, and a panel that appears only after the upload teaches people
  // the library is an afterthought.
  const library = project && user?.id && (
    <ProjectLibrary projectId={project.id} userId={user.id} />
  );

  const looks = templates && templates.length > 0 && (
    <div
      className={`rounded-xl glass-panel border border-hairline ${
        sideBySide
          ? "flex flex-col gap-2 items-stretch px-4 py-4"
          : "mt-3 flex items-center gap-2 overflow-x-auto px-3 py-2"
      }`}
    >
      <div className={`flex items-center gap-2 flex-shrink-0 ${sideBySide ? "mb-1" : ""}`}>
        <Wand2 className={`text-secondary flex-shrink-0 ${sideBySide ? "w-4 h-4" : "w-3.5 h-3.5"}`} />
        <span className={`font-medium text-muted-foreground ${sideBySide ? "text-sm" : "text-xs"}`}>
          {sideBySide ? "One-click looks" : "Looks"}
        </span>
      </div>
      {templates.map((template) => (
        <button
          key={template.id}
          onClick={() => handleApplyTemplate(template.id)}
          disabled={isProcessingEdit || startRender.isPending}
          title={`${template.description} — ${template.bestFor}`}
          className={`flex-shrink-0 border border-hairline bg-surface-1 font-medium transition-all hover:border-primary/40 hover:bg-white/[0.06] disabled:opacity-40 disabled:cursor-not-allowed ${
            sideBySide ? "rounded-xl px-4 py-3 text-left" : "rounded-full px-3 py-1.5 text-xs"
          }`}
          data-testid={`button-template-${template.id}`}
        >
          {sideBySide ? (
            <>
              <span className="block text-sm font-semibold">{template.name}</span>
              <span className="block text-[11px] leading-snug text-muted-foreground mt-0.5">
                {template.description}
              </span>
            </>
          ) : (
            template.name
          )}
        </button>
      ))}
    </div>
  );

  return (
    <div className="w-full h-screen flex flex-col bg-background overflow-hidden">
      {/* Topbar */}
      <header className="h-16 flex-shrink-0 border-b border-hairline bg-background/50 backdrop-blur-md flex items-center justify-between px-6 z-10">
        <div className="flex items-center gap-4">
          <BackButton fallback="/dashboard" />
          <div className="h-6 w-px bg-surface-2" />
          <h1 className="font-semibold text-lg" data-testid="text-editor-title">{project.title}</h1>
          <span className="px-2 py-0.5 rounded-full bg-surface-1 border border-hairline text-xs text-muted-foreground">
            {project.status}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <Button 
            variant="outline" 
            className="border-hairline"
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
            <div className="flex-1 relative rounded-2xl overflow-hidden glass-panel border border-hairline bg-band flex flex-col">
              <div className="absolute inset-0 flex flex-col items-center justify-center p-8 text-center">
                {isUploading ? (
                  <div className="flex flex-col items-center w-full max-w-sm">
                    <Loader2 className="w-12 h-12 text-primary animate-spin mb-4" />
                    <h3 className="text-xl font-semibold mb-2" data-testid="text-upload-heading">
                      {uploadPhase === "finishing" ? "Finishing up..." : "Uploading Video..."}
                    </h3>
                    <div className="w-full h-2 bg-surface-2 rounded-full overflow-hidden mb-2">
                      <div className="h-full bg-primary transition-all duration-300" style={{ width: `${uploadProgress}%` }} />
                    </div>
                    {uploadPhase === "finishing" ? (
                      <p className="text-sm text-muted-foreground" data-testid="text-upload-progress">
                        Your video is stored. Reading its length and taking a poster frame.
                      </p>
                    ) : (
                      <p className="text-sm text-muted-foreground" data-testid="text-upload-progress">
                        {uploadProgress}%{totalBytes > 0 && ` · ${formatBytes(uploadedBytes)} of ${formatBytes(totalBytes)}`}
                      </p>
                    )}
                  </div>
                ) : (
                  <div 
                    className={`flex flex-col items-center justify-center border-2 border-dashed rounded-2xl w-full max-w-lg aspect-video cursor-pointer transition-all group ${isDragOver ? 'border-primary bg-primary/10 scale-[1.02]' : 'border-hairline-strong hover:border-primary/50 hover:bg-primary/5'}`}
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                  >
                    <div className="w-16 h-16 rounded-full bg-surface-1 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
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
               rounded corners now wrap the picture itself, the scrubber sits
               directly under it at exactly its width, and on a vertical clip the
               looks move into the column beside it rather than eating the height
               the clip needs. */
            <div ref={stageRef} className="flex-1 min-h-0 flex items-stretch justify-center gap-4">
              {/* Content-width, not flex-1: the frame and its controls read as
                  one object centred in the space, rather than the frame drifting
                  to one edge with a gap between them. */}
              <div className="min-w-0 flex flex-col items-center justify-center gap-3">
                <div
                  className="force-dark relative rounded-2xl overflow-hidden glass-panel border border-hairline text-foreground"
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
                      // The key forces a reload when the URLs change: unlike
                      // `src`, swapping <source> children does not make the
                      // element look again on its own.
                      key={previewUrl ?? playbackUrl ?? "empty"}
                      className="w-full h-full object-contain"
                      controls={false}
                      preload="metadata"
                      onLoadedMetadata={(e) => {
                        const el = e.currentTarget;
                        // There is a picture. Whatever we decided while it was
                        // arriving is now wrong, so take it back.
                        setPlaybackFailed(false);
                        if (el.videoWidth && el.videoHeight) setDecodedAspect(el.videoWidth / el.videoHeight);
                        if (Number.isFinite(el.duration)) setPlayerDuration(el.duration);
                      }}
                      onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                      onEnded={() => setIsPlaying(false)}
                      onError={() => setPlaybackFailed(true)}
                      data-testid="video-preview"
                    >
                      {/* VP9 first: it decodes in software in every browser,
                          while the H.264 master leans on an OS codec that we
                          have watched be broken on a real machine. A browser
                          that handles both loses a little preview quality; a
                          browser that cannot decode H.264 keeps the product. */}
                      {previewUrl && <source src={previewUrl} type="video/webm" />}
                      {playbackUrl && <source src={playbackUrl} type="video/mp4" />}
                    </video>

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
                      <div className="w-16 h-16 rounded-full bg-black/50 backdrop-blur-sm border border-hairline flex items-center justify-center text-white">
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

                {/* Exactly the picture's width, so the scrubbable length and the
                    thing being scrubbed line up edge to edge. */}
                <div style={{ width: picture ? `${picture.width}px` : "100%" }}>
                  {transport}
                </div>
              </div>

              {sideBySide && (
                <aside
                  className="flex-shrink-0 flex flex-col gap-3 overflow-y-auto"
                  style={{ width: SIDE_COLUMN_WIDTH }}
                  data-testid="side-controls"
                >
                  {looks}
                  {library}
                  {reference}
                </aside>
              )}
            </div>
          )}

          {/* Under a landscape clip the width is the plentiful dimension, so the
              looks sit below as a row. A vertical clip puts them in the column. */}
          {hasVideo && !sideBySide && <div>{looks}{library}{reference}</div>}
        </div>

        {/* AI Chat Sidebar */}
        <div className="w-full lg:w-[400px] border-l border-hairline bg-background/80 backdrop-blur-xl flex flex-col z-20 shadow-[-20px_0_40px_rgba(0,0,0,0.5)]">
          {/* Noah header */}
          <div className="p-4 border-b border-hairline flex items-center gap-3">
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
              {messagesState === "empty" && (
              <div className="flex gap-3 items-start">
                <img
                  src="/noah-avatar.jpg"
                  alt="Noah"
                  className="w-10 h-10 rounded-full object-cover flex-shrink-0 shadow-[0_2px_10px_rgba(0,0,0,0.4)] ring-1 ring-hairline"
                />
                <div className="flex flex-col gap-1 min-w-0">
                  <span className="text-xs font-semibold text-purple-300 px-1">Noah</span>
                  <div className="bg-surface-1 border border-hairline rounded-2xl rounded-tl-sm px-4 py-3 text-sm leading-relaxed">
                    Hey, I'm Noah 👋<br />Your AI video editor.<br /><br />Upload your video and tell me the vibe — I'll turn it into a viral clip.
                  </div>
                </div>
              </div>
              )}

              {/* Messages */}
              {messagesState === "failed" ? (
                <LoadFailed
                  what="this conversation"
                  compact
                  onRetry={() => messagesQuery.refetch()}
                  testId="messages-failed"
                />
              ) : messagesState === "loading" ? (
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
                        className="w-10 h-10 rounded-full object-cover flex-shrink-0 shadow-[0_2px_10px_rgba(0,0,0,0.4)] ring-1 ring-hairline"
                      />
                    )}
                    <div className={`flex flex-col gap-1 min-w-0 ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                      {msg.role === 'assistant' && (
                        <span className="text-xs font-semibold text-purple-300 px-1">Noah</span>
                      )}
                      {/* pre-line: the worker's summary arrives as one message
                          with a line per note, and collapsing those lines into
                          a paragraph turns a list of decisions into mush. */}
                      <div className={`px-4 py-3 text-sm leading-relaxed whitespace-pre-line ${
                        msg.role === 'user'
                          ? 'bg-primary/20 border border-primary/30 rounded-2xl rounded-tr-sm text-foreground max-w-[85%]'
                          : 'bg-surface-1 border border-hairline rounded-2xl rounded-tl-sm'
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
                    className="w-10 h-10 rounded-full object-cover flex-shrink-0 shadow-[0_2px_10px_rgba(0,0,0,0.4)] ring-1 ring-hairline"
                  />
                  <div className="flex flex-col gap-1">
                    <span className="text-xs font-semibold text-purple-300 px-1">Noah</span>
                    {/* Glowing only while he is actually working — see the
                        .noah-working note in index.css. */}
                    <div className="noah-working bg-surface-1 border border-hairline rounded-2xl rounded-tl-sm px-4 py-3 flex items-center gap-1.5">
                      <span className="typing-dot w-1.5 h-1.5 rounded-full bg-purple-400 inline-block" />
                      <span className="typing-dot w-1.5 h-1.5 rounded-full bg-purple-400 inline-block" />
                      <span className="typing-dot w-1.5 h-1.5 rounded-full bg-purple-400 inline-block" />
                    </div>
                  </div>
                </div>
              )}

              {/* "Here's what I did" is no longer synthesised here from the
                  latest job's notes — the worker writes it into the
                  conversation itself when the render finishes, so the third
                  edit of the afternoon no longer erases the answers to the
                  first two. The settle effect above invalidates the messages
                  list, which is what makes the summary appear without a
                  refresh. */}

              {/* Live render progress, reported by the worker itself */}
              {(isProcessingEdit || renderJob?.status === "failed") && (
                <div className="flex gap-3 items-start">
                  <img
                    src="/noah-avatar.jpg"
                    alt="Noah"
                    className="w-10 h-10 rounded-full object-cover flex-shrink-0 shadow-[0_2px_10px_rgba(0,0,0,0.4)] ring-1 ring-hairline"
                  />
                  <div className="flex flex-col gap-1 flex-1">
                    <span className="text-xs font-semibold text-purple-300 px-1">Noah</span>
                    {/* Breathing while the render runs, still when it has
                        failed — a failure is not work in progress. */}
                    <div
                      className={`bg-surface-1 border border-secondary/30 rounded-2xl rounded-tl-sm px-4 py-3 text-sm w-full ${
                        renderJob?.status === "failed"
                          ? "shadow-[0_0_15px_rgba(155,107,255,0.1)]"
                          : "noah-working"
                      }`}
                    >
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
                          <div className="h-1.5 bg-surface-2 rounded-full overflow-hidden">
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

          <div className="p-4 border-t border-hairline bg-band">
            <form 
              onSubmit={(e) => { e.preventDefault(); handleSendChat(); }}
              className="relative"
            >
              <Input
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                placeholder="Describe your edit..."
                className="input-chat-glow pr-12 bg-surface-1 border-hairline rounded-full h-12"
                disabled={!hasVideo || isNoahThinking || sendMessage.isPending || isProcessingEdit}
                data-testid="input-chat"
              />
              <Button 
                type="submit"
                size="icon"
                disabled={!chatInput.trim() || !hasVideo || isNoahThinking || sendMessage.isPending || isProcessingEdit}
                className="absolute right-1 top-1 h-10 w-10 rounded-full bg-secondary text-secondary-foreground hover:bg-secondary/90 hover:shadow-[0_0_15px_rgba(155,107,255,0.6)] transition-all"
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
