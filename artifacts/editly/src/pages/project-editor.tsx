import { useState, useEffect, useLayoutEffect, useRef, useCallback } from "react";
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
  Video, Sparkles, VideoOff, ChevronUp, ChevronDown, Scissors, FolderOpen,
  Maximize2, Minimize2, Type } from "lucide-react";
import { BackButton } from "@/components/back-button";
import { FontPicker, DEFAULT_FONTS, type ChosenFonts } from "@/components/font-picker";
import type { UploadedFace } from "@/components/font-upload";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { loadState } from "@/lib/load-state";
import { playbackVerdict, PLAYBACK_POLL_MS } from "@/lib/playability";
import { LoadFailed } from "@/components/load-failed";
import { supabase } from "@/lib/supabase";
import { apiFetch } from "@/lib/api-fetch";
import {
  uploadProjectVideo,
  uploadReferenceVideo,
  MAX_REFERENCE_BYTES,
  usePlayableVideo,
  ACCEPTED_VIDEO_TYPES,
  uploadCeiling,
  formatBytes,
  readVideoFacts,
  captureThumbnail,
  captureFrameFrom,
  uploadThumbnail,
} from "@/lib/video-storage";
import { ToastAction } from "@/components/ui/toast";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ProjectLibrary } from "@/components/project-library";
import { ProjectClips, getListClipsQueryKey } from "@/components/project-clips";
import { takePendingUpload } from "@/lib/pending-upload";
import { VoiceInput, SpeechLanguageToggle } from "@/components/voice/voice-input";
import { guessSpeechLanguage, type SpeechLanguage } from "@/components/voice/speech-language";
import { MomentMarks, marksToSentence, type Mark } from "@/components/moment-marks";

/** m:ss — anything longer than an hour is not what this product is for. */
function formatTimecode(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

/**
 * Below this, aligning the transport to the picture costs more than it buys.
 *
 * A play button, a scrubber and a timecode need about this much room before the
 * scrubber stops being a hairline you cannot hit. It is the width of the
 * controls, not a screen size: a portrait video does this on a desktop too.
 */
const USABLE_TRANSPORT_WIDTH = 280;

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
  /*
   * Moments somebody stopped on and gave a direction for.
   *
   * Held here rather than on the server: they are a way of composing the
   * sentence, not a second kind of instruction, and they are folded into the
   * chat input when the edit is generated. See `moment-marks.tsx`.
   */
  const [marks, setMarks] = useState<Mark[]>([]);
  /*
   * Why speaking did not work, if it did not.
   *
   * The first version kept this inside the listening sheet, which closed the
   * moment anything went wrong — so the commonest failure of all, a browser
   * quietly refusing the microphone, showed its reason for about a frame. It
   * belongs next to the input, where the person is already looking.
   */
  const [voiceError, setVoiceError] = useState<string | null>(null);

  const [playerDuration, setPlayerDuration] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  /* The picture itself, not the box it is centred in: what goes full screen is
     the frame, so our own controls and its edges go with it. */
  const pictureRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  /*
    The chosen caption faces, kept on this device.

    Not on the project row: it is a preference rather than a property of the
    video, the same person wants the same faces on the next project, and a
    column for it is a migration for a choice that has no consequences worth
    keeping on a server. `localStorage` in a try/catch, because a private
    window throws on read and a font picker is not worth a blank screen.
  */
  const [fonts, setFonts] = useState<ChosenFonts>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("editly:caption-fonts") ?? "null");
      if (saved && typeof saved.latin === "string" && typeof saved.arabic === "string") return saved;
    } catch {
      /* Private window, cleared storage, or a value from an older shape. */
    }
    return DEFAULT_FONTS;
  });
  const chooseFonts = (next: ChosenFonts) => {
    setFonts(next);
    try {
      localStorage.setItem("editly:caption-fonts", JSON.stringify(next));
    } catch {
      /* The choice still applies to this session; it just will not be here
         tomorrow. Better than refusing to change it. */
    }
  };
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

  /*
   * Which language the microphone listens for.
   *
   * Guessed once from what this person has already written in this project,
   * then left alone — re-guessing on every keystroke would change the language
   * out from under somebody mid-sentence. They can change it with the toggle,
   * and that choice sticks for the session.
   */
  const [speechLanguage, setSpeechLanguage] = useState<SpeechLanguage>("en");
  const languageGuessed = useRef(false);
  /*
    Whether we are actually full screen, asked of the browser rather than
    remembered from the click.

    Escape leaves fullscreen. So does the system player's Done button, and so
    does rotating an iPhone back. None of them tell this component anything, and
    an icon that says "exit full screen" over a video that is already inline is
    a control lying about the thing it controls.
  */
  useEffect(() => {
    const sync = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", sync);
    // Safari has never fired the unprefixed event; it fires this one instead,
    // and a browser that fires both simply calls `sync` twice with the same
    // answer.
    document.addEventListener("webkitfullscreenchange", sync);
    sync();
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
    };
  }, []);

  useEffect(() => {
    if (languageGuessed.current) return;
    const mine = (messages ?? []).filter((m) => m.role === "user").map((m) => m.content ?? "");
    // Wait for the conversation before guessing, unless there is none to wait
    // for: guessing from an empty list and then never revising is how this got
    // the answer wrong in the first place.
    if (!messagesQuery.isSuccess) return;
    languageGuessed.current = true;
    setSpeechLanguage(guessSpeechLanguage({ said: mine, typed: chatInput }));
    // Guessed once, deliberately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messagesQuery.isSuccess]);

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
    // One extra look at the queue: a settled render may have started the
    // follow-up promised while it ran, and polling stops on "done" — without
    // this the follow-up would render invisibly until the tab refocused.
    // Guarded by settledJobRef, so a settle without a follow-up asks once,
    // gets the same answer, and stops.
    queryClient.invalidateQueries({ queryKey: getRenderStatusQueryKey(id) });
    // A settled render may have been a clips render; the panel appears the
    // moment its rows exist rather than on the next hard refresh.
    queryClient.invalidateQueries({ queryKey: getListClipsQueryKey(id) });
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

  /**
   * A phone, decided by measuring the stage rather than by a breakpoint,
   * because it is the width the picture actually gets that causes this.
   *
   * On a phone the play/scrub/timecode row goes **over** the bottom of the
   * picture instead of under it. The comment further down says a timeline
   * belongs against the frame it scrubs, and it is right — but "under" and
   * "over" are both against it, and only one of them costs the picture 68px of
   * height it has none of. Every video app on a phone puts the controls on the
   * picture, and it is not a style choice: on a 390px screen the difference is
   * a 9:16 clip that fills the width and one that does not.
   */
  const controlsOnPicture = stage.w > 0 && stage.w < 560;

  /** Measured, because guessing it would either crop the picture or leave a gap. */
  const transportRef = useRef<HTMLDivElement>(null);
  const [transportHeight, setTransportHeight] = useState(0);

  /**
   * Whether the conversation is open. Only ever false below `lg`.
   *
   * The measurement that forced this: on a 390x852 phone the header takes 64,
   * the conversation took a fixed 45% — 383 — and the transport under the
   * picture takes about 130. What is left for the picture is roughly 230px of
   * height, and a 9:16 clip fitted into 230px of height is **129px wide** on a
   * 390px screen. Two thirds of the screen was being spent on everything except
   * the video the person is editing.
   *
   * A phone cannot show a tall video and a tall conversation at once; a desktop
   * can, and still does. So on a phone the conversation is a sheet: the input
   * stays — you can always talk to it, which is the whole product — and the
   * history folds away behind a tap. Folded, the picture gets about 540px of
   * height and lands near 300px wide. That is the same clip, more than twice
   * the size, on the screen it was made for.
   *
   * It opens itself when Noah says something, because a reply nobody can see
   * is the same as no reply.
   */
  /** Which of the four side panels is open, if any. See `panelRail`. */
  const [openPanel, setOpenPanel] = useState<"looks" | "type" | "clips" | "files" | "reference" | null>(null);

  /*
    The fonts this person has uploaded, and the token that lets them upload
    another.

    Fetched when the Type panel is first opened rather than with the project.
    Most sessions never open it, and a list of somebody's fonts is not worth a
    request on every project load — while the panel being open is exactly the
    moment the list has to be current, because `FontUpload` polls through this
    same callback while a font is being measured.
  */
  const [uploadedFaces, setUploadedFaces] = useState<UploadedFace[]>([]);
  const [uploadToken, setUploadToken] = useState<string | null>(null);
  const loadFaces = useCallback(async () => {
    const response = await apiFetch("/api/fonts");
    if (!response.ok) return;
    const body = (await response.json()) as { faces: UploadedFace[] };
    setUploadedFaces(body.faces);
  }, []);
  useEffect(() => {
    if (openPanel !== "type") return;
    void loadFaces();
    void supabase.auth.getSession().then(({ data }) => setUploadToken(data.session?.access_token ?? null));
  }, [openPanel, loadFaces]);


  const [chatOpen, setChatOpen] = useState(true);
  const [unreadFromNoah, setUnreadFromNoah] = useState(false);
  const seenMessageCount = useRef(0);
  useEffect(() => {
    const count = messages?.length ?? 0;
    const newest = messages?.[count - 1];
    const isNew = count > seenMessageCount.current && newest?.role === "assistant";
    seenMessageCount.current = count;
    if (!isNew) return;
    // Everything Noah says opens the sheet, except the one thing he says when
    // the edit is finished. That message arrives at the same moment the video
    // does, and opening on it would take the person from a full-width picture
    // of their finished edit to a 129px one under a wall of notes — undoing,
    // at the exact moment it matters most, the thing this sheet exists for.
    // The notes are a tap away and the header says they are there.
    if (project?.status === "done") setUnreadFromNoah(true);
    else setChatOpen(true);
  }, [messages, project?.status]);
  // The first video is the moment the screen stops being about the conversation
  // and starts being about the picture.
  const sawVideo = useRef(false);
  useEffect(() => {
    if (hasVideo && !sawVideo.current) setChatOpen(false);
    sawVideo.current = hasVideo;
  }, [hasVideo]);
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
    // Only what is actually *under* the picture is taken out of its height.
    // On a phone that is the note-a-moment row; the controls are on the frame
    // and cost it nothing.
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
   *
   * `controlsOnPicture` is there for exactly the same reason and is the same
   * kind of trap: it is *derived from* the measurement it then changes. The
   * box under the picture loses the play row when it flips, so the height read
   * a moment ago is the height of a box that no longer exists. One extra pass
   * settles it, because the new width does not cross the threshold back.
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
  }, [hasVideo, sideBySide, controlsOnPicture]);

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
    // Storage's ceiling, served from the subscription, not the one baked into
    // this bundle at build time.
    const ceiling = uploadCeiling(subscription);
    if (file.size > ceiling) {
      toast({
        title: "File too large",
        description: `That file is ${formatBytes(file.size)}. The current limit is ${formatBytes(ceiling)} per video.`,
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
    /*
     * The marks are folded in here, at the moment of sending, and this is the
     * only place they exist as words.
     *
     * They go in front of whatever was typed, because they are the specific
     * instructions and the sentence is the general one — "At 0:12 punch in. At
     * 0:45 punch in. And cut the dead air" reads in the order the person meant
     * it. Both heads of the planner parse `at m:ss`, so this needs no transport
     * of its own and inherits every rule the typed path already has.
     *
     * Sending with marks and no sentence is legitimate: pointing at three
     * moments *is* the instruction.
     */
    const spoken = marksToSentence(marks);
    const content = [spoken, chatInput.trim()].filter(Boolean).join(" ");
    if (!content || !id) return;

    setChatInput("");
    setMarks([]);

    setIsNoahThinking(true);
    try {
      const result = await sendMessage.mutateAsync({
        id,
        // The chosen faces travel with the sentence too: a plan reaches the
        // queue through this door as often as through a template, and a
        // preference that only applies to one of them is a preference that
        // looks broken half the time.
        data: { content, fonts }
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
      await startRender.mutateAsync({ id, templateId, fonts });
      queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(id) });
      toast({ title: "Render queued", description: "You can leave this page. We'll keep working." });
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
          { type: "formatForPlatform", platform: (project?.platform ?? "tiktok") as "tiktok" | "reels" | "shorts" | "youtube" | "square" },
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
        description: "You can leave this page. We'll keep working."
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
        {/* The skeleton has to be the shape of the thing it stands in for.
            The editor itself stacks below `lg` and puts the panel on the right
            above it; a skeleton that is always two columns puts a 400px block
            beside a flexible one on a 390px screen, which is a horizontal
            scrollbar for as long as the project takes to load. */}
        <div className="flex-1 flex flex-col lg:flex-row gap-4 lg:gap-6 p-4 lg:p-6 min-h-0">
          <div className="flex-1 min-h-0">
            <Skeleton className="w-full h-full min-h-[180px] rounded-2xl" />
          </div>
          <div className="w-full lg:w-[400px] flex-shrink-0 basis-[45%] lg:basis-auto min-h-0">
            <Skeleton className="w-full h-full min-h-[140px] rounded-2xl" />
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
   * Fill the screen, when they ask for it and not before.
   *
   * The other half of `playsInline`. That attribute stops iOS taking the whole
   * screen the moment somebody presses play, which is the right default and
   * leaves a real want unanswered: sometimes you *do* want the video big. So
   * the transport carries a button, and the two together mean the video is
   * inline until it is asked not to be.
   *
   * Two APIs, because iPhone Safari has no element fullscreen at all. On every
   * other browser the *stage* goes fullscreen, which keeps our own controls and
   * the frame's edges; on iPhone the only thing available is the system player
   * on the `<video>` itself, and half a feature there is better than a button
   * that does nothing.
   *
   * The state comes from the `fullscreenchange` event rather than from the
   * click, because Escape and the system player's own Done button both leave
   * fullscreen without telling this component — and an icon that says "exit"
   * over a video that is already inline is a control lying about the thing it
   * controls.
   */
  const toggleFullscreen = () => {
    const stage = pictureRef.current;
    const video = videoRef.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
      return;
    }
    if (stage?.requestFullscreen) {
      void stage.requestFullscreen().catch(() => {
        // Refused, usually because the gesture was not trusted. The system
        // player is the fallback rather than a dead press.
        video?.webkitEnterFullscreen?.();
      });
      return;
    }
    video?.webkitEnterFullscreen?.();
  };

  /**
   * Play, scrubber, timecode. One set of controls, laid out two ways.
   *
   * A timeline belongs against the frame it scrubs — under it where there is
   * room, on it where there is not. The two differ in more than position:
   *
   * `onPicture` is not a skin. Over video a control has no idea what colour is
   * behind it, so the greys that read on the app's own surface read as nothing
   * on a bright frame; white on a known scrim always reads.
   *
   * And the arrangement changes, because the row does not fit. On one line
   * inside a 290px picture, the play button and the timecode leave the
   * scrubber 114px — a third of what it has under a landscape clip, and below
   * the width this suite calls scrubbable. So the scrubber takes its own line
   * and the play button and timecode sit under it, which is what every video
   * app on a phone does and for this reason.
   */
  const transportControls = (onPicture: boolean) => {
    const playButton = (
        <button
          onClick={togglePlay}
          className={`w-11 h-11 md:w-9 md:h-9 flex-shrink-0 rounded-full flex items-center justify-center transition-colors ${
            onPicture
              ? "bg-black/55 text-white backdrop-blur-md border border-white/20"
              : "bg-surface-2 hover:bg-surface-2"
          }`}
          aria-label={isPlaying ? "Pause" : "Play"}
          data-testid="button-scrub-play"
        >
          {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
        </button>
    );

    const scrubber = (
        /*
          The scrubber and the marks on it, in one box.
          A note pinned to 0:26 that shows only as a row of text underneath is
          a list of timecodes, not a timeline: you cannot see where in the video
          your notes are, or that two of them are next to each other. The pins
          are the point of stopping on a second.
        */
        <div className={`relative min-w-0 ${onPicture ? "w-full" : "flex-1"}`}>
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
          // A 6px-tall track is a fine drawing and an impossible target: a
          // fingertip is about 9mm, and this is one. The padding makes the
          // *hit* area 44px while `bg-clip-content` keeps the *paint* inside
          // the content box, so the scrubber still looks like a hairline and
          // is no longer a game of skill. The thumb grows on touch too.
          className={`w-full h-11 py-[1.15rem] md:h-1.5 md:py-0 bg-clip-content appearance-none rounded-full accent-primary cursor-pointer ${
            onPicture ? "bg-white/30" : "bg-surface-2"
          }
                     [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-5 md:[&::-webkit-slider-thumb]:w-3.5
                     [&::-webkit-slider-thumb]:h-5 md:[&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full
                     [&::-webkit-slider-thumb]:bg-secondary
                     [&::-webkit-slider-thumb]:shadow-[0_0_8px_rgba(155,107,255,0.8)]`}
          data-testid="input-scrubber"
        />

        {/* Pins. `pointer-events-none` on the strip so dragging the scrubber
            still works through them, and back on for each pin so it can be
            pressed. */}
        <div className="absolute inset-x-0 top-0 h-full pointer-events-none" aria-hidden={marks.length === 0}>
          {marks.map((m) => {
            const total = playerDuration || project.duration || 0;
            if (!(total > 0)) return null;
            const left = Math.min(100, Math.max(0, (m.at / total) * 100));
            return (
              <button
                key={`${m.at}-${m.say}`}
                type="button"
                onClick={() => {
                  setCurrentTime(m.at);
                  if (videoRef.current) videoRef.current.currentTime = m.at;
                }}
                title={`${formatTimecode(m.at)}: ${m.say}`}
                aria-label={`Go to the note at ${formatTimecode(m.at)}: ${m.say}`}
                style={{ left: `${left}%` }}
                className="pointer-events-auto absolute top-1/2 -translate-x-1/2 -translate-y-1/2
                           h-11 w-6 md:h-6 md:w-4 flex items-center justify-center group"
                data-testid="mark-pin"
              >
                <span className="block w-[3px] h-4 md:h-3.5 rounded-full bg-secondary shadow-[0_0_6px_rgba(155,107,255,0.9)]
                                 group-hover:h-5 transition-all" />
              </button>
            );
          })}
        </div>
        </div>
    );

    const timecode = (
        <span
          className={`text-xs tabular-nums flex-shrink-0 ${
            onPicture ? "text-white drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]" : "text-muted-foreground"
          }`}
          data-testid="text-timecode"
        >
          {formatTimecode(currentTime)} / {formatTimecode(playerDuration || project.duration || 0)}
        </span>
    );

    const fullscreenButton = (
      <button
        onClick={toggleFullscreen}
        className={`w-11 h-11 md:w-9 md:h-9 flex-shrink-0 rounded-full flex items-center justify-center transition-colors ${
          onPicture
            ? "bg-black/55 text-white backdrop-blur-md border border-white/20"
            : "bg-surface-2 text-muted-foreground hover:text-foreground"
        }`}
        aria-label={isFullscreen ? "Leave full screen" : "Fill the screen"}
        data-testid="button-fullscreen"
      >
        {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
      </button>
    );

    if (onPicture) {
      return (
        <div className="flex flex-col gap-0.5">
          {scrubber}
          <div className="flex items-center gap-3">
            {playButton}
            <span className="ml-auto">{timecode}</span>
            {fullscreenButton}
          </div>
        </div>
      );
    }

    return (
      <div className="flex items-center gap-3">
        {playButton}
        {scrubber}
        {timecode}
        {fullscreenButton}
      </div>
    );
  };

  const momentMarks = (
    <MomentMarks
      currentTime={currentTime}
      marks={marks}
      onChange={setMarks}
      disabled={isNoahThinking || sendMessage.isPending || isProcessingEdit}
      spaced={!controlsOnPicture}
    />
  );

  /**
   * What sits under the picture. On a phone that is the note-a-moment row
   * alone, because the controls are on the picture; everywhere else it is
   * both, in the panel it has always been in.
   *
   * `transportRef` stays on whichever of the two it is, because the stage
   * subtracts the measured height of *this* box from the room the picture
   * gets — and measuring the wrong box is how a picture ends up sized for
   * controls that are not there.
   */
  const transport = (
    <div
      ref={transportRef}
      className={
        controlsOnPicture
          ? "w-full"
          : "w-full rounded-xl glass-panel border border-hairline px-4 py-3"
      }
    >
      {!controlsOnPicture && transportControls(false)}
      {momentMarks}
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
            Your next render is edited to match the clip you attached: its pace, how much
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
          <p className="text-xs leading-snug text-muted-foreground mb-2">
            Upload a short clip in the style you want and we read it: how often it cuts, how
            much silence it leaves, how loud and how graded it ends up. Under{" "}
            {formatBytes(MAX_REFERENCE_BYTES)}, and we only look at the first two minutes.
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
    <ProjectLibrary projectId={project.id} userId={user.id} ceiling={uploadCeiling(subscription)} />
  );

  const clipsPanel = (
    <ProjectClips projectId={project.id} />
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
          title={`${template.description}. ${template.bestFor}${
            template.needs === "music" ? ". Needs a music file in this project" : ""
          }`}
          className={`flex-shrink-0 border border-hairline bg-surface-1 font-medium transition-all hover:border-primary/40 hover:bg-white/[0.06] disabled:opacity-40 disabled:cursor-not-allowed ${
            sideBySide ? "rounded-xl px-4 py-3 text-left" : "rounded-full px-3 min-h-11 md:min-h-0 md:py-1.5 text-xs"
          }`}
          data-testid={`button-template-${template.id}`}
        >
          {sideBySide ? (
            <>
              <span className="block text-sm font-semibold">{template.name}</span>
              <span className="block text-xs leading-snug text-muted-foreground mt-0.5">
                {template.description}
              </span>
              {/*
                A look that cannot be built without a file says so on the button.
                The server refuses it before anything is queued, and an error
                after a click is a worse place to learn a requirement than the
                label — the person has already committed to the edit by then.
              */}
              {template.needs === "music" ? (
                <span className="block text-xs leading-snug text-secondary/80 mt-0.5">
                  Needs a music file in this project
                </span>
              ) : null}
            </>
          ) : (
            template.name
          )}
        </button>
      ))}
    </div>
  );

  const typePanel = (
    <div className="rounded-xl glass-panel border border-hairline flex flex-col gap-3 px-4 py-4 mt-3">
      <div className="flex items-center gap-2">
        <Type className="w-4 h-4 text-secondary flex-shrink-0" />
        <span className="text-sm font-medium text-muted-foreground">Caption type</span>
      </div>
      <FontPicker
        value={fonts}
        onChange={chooseFonts}
        disabled={isProcessingEdit}
        uploaded={uploadedFaces}
        userId={user?.id}
        accessToken={uploadToken}
        onFontsChanged={() => void loadFaces()}
      />
    </div>
  );

  /**
   * The five panels, as five icons.
   *
   * Looks, clips, files and the reference clip each used to be a card, always
   * open, stacked one under the next. On a laptop that is a column of prose
   * beside the video — seven look cards with a sentence each, and you scroll
   * past all of it to reach the files. On a phone it is four screens below the
   * fold.
   *
   * None of them is something you read. Each is something you *go to*, once,
   * when you have decided to do that thing. So they are a row of icons, and
   * pressing one opens it — which is also the honest shape of the choice: they
   * are alternatives, not a list, and only one of them can be what you are
   * doing.
   *
   * Nothing is open to begin with, because what you are doing when you arrive
   * is watching the video.
   */
  const PANELS = [
    { key: "looks" as const, icon: Wand2, label: "Looks", available: Boolean(templates && templates.length > 0) },
    // Always available: a project with no video still has captions in its
    // future, and there is nothing here that depends on the file.
    { key: "type" as const, icon: Type, label: "Type", available: true },
    { key: "clips" as const, icon: Scissors, label: "Clips", available: true },
    { key: "files" as const, icon: FolderOpen, label: "Files", available: Boolean(project && user?.id) },
    { key: "reference" as const, icon: Sparkles, label: "Match", available: Boolean(project) },
  ].filter((p) => p.available);

  const panelRail = PANELS.length > 0 && (
    <div className={sideBySide ? "flex flex-col gap-2" : "mt-3"} data-testid="panel-rail">
      <div
        /* Wrapping on a phone too, now that there are five.

           It scrolled sideways before, and with four chips that was invisible
           because they fitted. The fifth starts at 381px of a 390px screen, so
           nine pixels of it are on the phone and the rest is behind a gesture
           nothing indicates — a panel that exists and cannot be found, which is
           the failure the whole rail was built to fix. Two rows of icons is not
           elegant and it is honest. */
        className="flex flex-wrap gap-2"
        role="tablist"
        aria-label="Editing panels"
      >
        {PANELS.map(({ key, icon: Icon, label }) => {
          const open = openPanel === key;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={open}
              onClick={() => setOpenPanel(open ? null : key)}
              className={`aura-chip no-default-hover-elevate flex-shrink-0 flex items-center gap-2 rounded-full px-3.5 min-h-11 md:min-h-9 text-xs font-medium ${
                open ? "text-foreground" : "text-muted-foreground"
              }`}
              style={open ? { boxShadow: "0 0 0 1px var(--aura-ring-strong), 0 4px 14px var(--aura-drop)" } : undefined}
              data-testid={`button-panel-${key}`}
            >
              <Icon className={`w-4 h-4 flex-shrink-0 ${open ? "text-secondary" : ""}`} />
              {label}
            </button>
          );
        })}
      </div>

      {openPanel === "looks" && looks}
      {openPanel === "type" && typePanel}
      {openPanel === "clips" && clipsPanel}
      {openPanel === "files" && library}
      {openPanel === "reference" && reference}
    </div>
  );


  return (
    <div className="w-full h-screen flex flex-col bg-background overflow-hidden">
      {/* Topbar */}
      {/* On a phone the title yields (truncates) and the buttons keep their
          icons but drop their words — the actions must stay reachable at
          390px, and a title that pushes them off the edge is a title read
          once at the cost of every edit after it. */}
      {/*
        px-4 on a phone, not px-3.

        `.aura-btn` draws its depth with a 5px box-shadow *spread*, and a
        spread is painted outside the element's box. Layout does not know about
        it, so every check passes — the button is inside its container, nothing
        overflows, nothing scrolls sideways — and the ring is shaved flat down
        the right edge of the screen. The one control on this header that is
        supposed to look raised looked cut out instead.
      */}
      <header className="h-16 flex-shrink-0 border-b border-hairline bg-background/50 backdrop-blur-md flex items-center justify-between gap-2 px-4 sm:px-6 z-10">
        <div className="flex items-center gap-2 sm:gap-4 min-w-0 flex-1">
          <BackButton fallback="/dashboard" />
          <div className="h-6 w-px bg-surface-2 hidden sm:block" />
          <h1 dir="auto" className="font-semibold text-lg truncate min-w-0" data-testid="text-editor-title">{project.title}</h1>
          <span className="px-2 py-0.5 rounded-full bg-surface-1 border border-hairline text-xs text-muted-foreground hidden sm:inline-block">
            {project.status}
          </span>
        </div>
        <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
          <Button
            variant="outline"
            className="border-hairline"
            disabled={!hasVideo}
            onClick={() => setLocation(`/export/${project.id}`)}
            data-testid="button-export"
          >
            <Download className="w-4 h-4 sm:mr-2" />
            <span className="hidden sm:inline">Export</span>
          </Button>
          <Button
            /* The default variant, which is `.aura-btn`. It was `glow-btn
               btn-gradient-cta` — the landing page's gradient CTA — so the most
               important button inside the app was the one control that did not
               match the app, and the two classes both wrote `box-shadow` with
               one silently winning. */
            disabled={!hasVideo || isProcessingEdit || project.status === 'uploading'}
            onClick={handleGenerateEdit}
            data-testid="button-generate-edit"
          >
            <Wand2 className="w-4 h-4 sm:mr-2" />
            <span className="hidden sm:inline">Generate Edit</span>
          </Button>
        </div>
      </header>

      <div className="flex-1 flex flex-col lg:flex-row overflow-hidden relative">
        {/* Main Editor Area. min-h-0: without it this flex child refuses to
            shrink below its content and the stacked mobile layout overflows
            the screen instead of sharing it. */}
        {/* `overflow-hidden` above `lg` only.
            On a phone the panels below the frame — looks, clips, the file
            library, the reference uploader — are taller than the space this
            column gets, and a hidden overflow does not make them smaller, it
            makes them unreachable: flexbox pays them their content height and
            takes it out of the one child that will shrink, which is the frame.
            The result was an editor whose video was a few pixels tall with
            three panels cut off below it and no way to scroll to them.
            Scrolling is the honest answer at this width; the desktop layout,
            which has the room to hold everything at once, is unchanged. */}
        <div className="flex-1 min-h-0 flex flex-col relative p-4 lg:p-6 pb-8 lg:pb-6 overflow-y-auto lg:overflow-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {/*
            A scroller that ends flush against the chat panel cuts whatever
            happens to be at the fold in half — on a phone that was the looks
            row, sliced through the middle of its chips, which reads as a
            broken layout rather than as "there is more below". The fade is
            the affordance: content dissolving into the edge is how a screen
            says it continues. Above `lg` nothing scrolls, so there is nothing
            to hint at and the gradient is not drawn at all.

            `sticky` rather than `absolute`, because an absolutely positioned
            child of a scroller scrolls away with the content it is meant to be
            hinting about. `-mb-8` pulls the following content back up under
            it so the fade costs no layout height, and `pb-8` above gives that
            content somewhere to go.
          */}
          
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
                    <p className="text-xs text-muted-foreground/60 mb-6">MP4, MOV or WebM &bull; up to {formatBytes(uploadCeiling(subscription))}</p>
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
            /* `min-h` so the frame keeps a shape inside a scrolling column:
               `flex-1` in a scroller means "whatever is left", and what is left
               under four panels is nothing. Above `lg` it goes back to taking
               the space it is given. */
            /* The stage's minimum height is what decides how big the video is,
               because inside a scrolling column `flex-1` resolves to content
               height and the minimum is all there is. A flat 23rem was that
               minimum on every phone, and 23rem minus the transport leaves a
               9:16 clip 129px wide on a 390px screen.
               It is a share of the viewport now, and which share depends on
               whether the conversation is open — that is the actual trade on a
               phone, and stating it here is better than picking a number that
               is wrong in one of the two states. */
            <div
              ref={stageRef}
              className={`flex-1 lg:min-h-[34rem] flex-shrink-0 lg:flex-shrink-0 flex items-stretch justify-center gap-4 ${
                chatOpen ? "min-h-[23rem]" : "min-h-[62dvh]"
              }`}
            >
              {/* Content-width, not flex-1: the frame and its controls read as
                  one object centred in the space, rather than the frame drifting
                  to one edge with a gap between them. */}
              {/*
                Full width, with only the *picture* keeping the video's shape.
                This column had no width of its own, so it shrank to fit the
                thing inside it — and the thing inside it is a 9:16 frame, which
                on a 390px phone is 169px wide. Everything under the video went
                with it: the scrubber, the timecode and the mark button were all
                crammed into 169px of a 390px screen, which is most of why this
                screen felt tight. Only the frame needs to be portrait; the
                controls belong to the screen.
              */}
              {/*
                Top of the stage on a phone, centre of it from a tablet up.

                The stage is `flex-1`, so it takes whatever height the sheet and
                the looks row leave — which is right for a 9:16 clip and wrong
                for a wide one. A 16:9 picture is 201px tall on a 390px screen,
                and centring it in 520px of stage put a 150px band of nothing
                above the video and another below it: a third of the phone
                spent on gaps that sit either side of the one thing being
                looked at.

                Aligning to the top collects that slack into one band above the
                looks row instead of two around the picture, so the video, its
                controls and the mark button read as a group starting where the
                header ends. On a wide screen there is no slack to collect and
                centred is right, so it stays centred there.
              */}
              <div className="w-full min-w-0 flex flex-col items-center justify-start lg:justify-center gap-3">
                <div
                  ref={pictureRef}
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
                      /*
                        `playsInline`, or iOS takes the screen.
                        
                        Safari on iPhone treats a `<video>` without it as a
                        request for the system player: pressing play throws the
                        clip into fullscreen, hides the editor, and hands the
                        person a set of controls that are not ours — mid-edit,
                        on the screen this product is mostly used on. Nothing
                        warns, nothing fails, and it is invisible in every
                        desktop browser and in headless Chromium, which is why
                        it survived. The webkit alias goes with it for the iOS
                        versions that predate the standard attribute.
                      */
                      playsInline
                      webkit-playsinline="true"
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
                      /*
                        Sized to fit the frame it is covering, which is not
                        always a wide one.
                        This was three lines of prose at body size centred in a
                        9:16 box. On a phone that box is 169px wide and 300 tall,
                        so the message overflowed it top and bottom and was
                        clipped mid-sentence — an explanation of a failure that
                        was itself unreadable. The type steps down with the
                        frame and the box scrolls rather than spilling, and the
                        sentence is shorter, because the long version was mostly
                        reassurance and the first line already carries the fact.
                      */
                      /*
                        And it leaves room for the transport underneath it.

                        The bar is `z-30` and this is `z-20`, so on a phone it
                        was drawn straight across the middle of the sentence
                        explaining why the frame is black. Raising this above
                        the bar only inverts the problem.

                        The transport stays, and that is the part worth writing
                        down: a scrubber over a video this browser cannot decode
                        looks useless and is not. The container's duration is
                        known even when its codec cannot be decoded, so the
                        playhead moves, the timecode is real, and "Note this
                        moment" still pins to the second somebody chose. Being
                        unable to *see* the frame does not stop anybody pointing
                        at it.

                        So this sits at the top of the frame on a phone and
                        centres from a tablet up. A 16:9 frame on a phone is
                        about 210px tall and the bar takes the bottom hundred of
                        it; centring what is left put the sentence back under
                        the scrubber, one line or two.
                      */
                      <div className="absolute inset-0 z-20 flex flex-col items-center justify-start sm:justify-center gap-1.5 overflow-y-auto bg-black/85 px-4 pt-4 sm:pt-6 pb-24 text-center">
                        <VideoOff className="w-5 h-5 text-muted-foreground flex-shrink-0" />
                        <p className="text-sm sm:text-base font-semibold leading-snug">
                          This file will not preview here
                        </p>
                        {/*
                          The reassurance only where there is room for it.

                          A 16:9 frame on a phone is about 210px tall, and once
                          the transport has its strip at the bottom there is not
                          enough left for two lines and an icon — the second one
                          came out clipped against the scrubber, which is an
                          apology for a failure delivered as another failure.
                          The headline carries the fact; this line carries
                          comfort, and comfort is the part that can wait for a
                          wider screen.
                        */}
                        <p className="hidden sm:block text-xs sm:text-sm text-muted-foreground leading-snug max-w-md">
                          It is stored safely, and it still edits and exports normally.
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

                    {/*
                      A badge over a video has no idea what is behind it. This
                      one was green text on a 20%-green wash, which is fine on
                      the dark footage it was designed against and unreadable on
                      anything bright — and "unreadable" here meant a green
                      smear across the top of the person's finished edit. The
                      scrim is opaque enough to be a floor under any frame, the
                      text is white because white on near-black always reads,
                      and the green is kept where colour is decoration rather
                      than information: the tick.
                    */}
                    {project.status === 'done' && (
                      <div className="absolute top-3 left-3 px-2.5 py-1 rounded-full bg-black/70 text-white border border-white/15 text-xs font-medium flex items-center backdrop-blur-md shadow-[0_2px_8px_rgba(0,0,0,0.4)]">
                        <CheckCircle2 className="w-3 h-3 mr-1.5 text-green-400" />
                        AI Edited
                      </div>
                    )}

                    {/* The controls, on the picture, on a phone. Above the
                        play/pause hover layer so a tap on the scrubber scrubs
                        rather than toggling playback, and inside a scrim
                        because a white control over an unknown frame is only
                        readable if something dark is put under it first. */}
                    {controlsOnPicture && (
                      <div className="absolute inset-x-0 bottom-0 z-30 px-2 pb-2 pt-10 bg-gradient-to-t from-black/70 to-transparent pointer-events-none">
                        {/* A bar rather than only a gradient. A gradient over
                            unknown footage gives an unknown contrast — over the
                            bright half of a frame the timecode was white on
                            pale grey — and "mostly readable" is not a floor.
                            The bar is one known colour under every control. */}
                        <div
                          className="pointer-events-auto rounded-2xl bg-black/55 backdrop-blur-md border border-white/10 px-3 py-2"
                          data-testid="transport-on-picture"
                        >
                          {transportControls(true)}
                        </div>
                      </div>
                    )}
                </div>

                {/*
                  The picture's width, so the scrubbable length and the thing
                  being scrubbed line up edge to edge — but not when that makes
                  the controls unusable.
                  A 9:16 picture on a 390px phone is 169px wide, and the whole
                  transport was inheriting that: a play button, a scrubber and a
                  timecode sharing 135px of a 390px screen, with the scrubber
                  itself down to a single pixel. The alignment is worth having
                  and it is not worth that, so it holds while the picture is
                  wide enough to hold it and the controls take the column when
                  it is not. Measured against the width of the control row
                  rather than a breakpoint, because it is the picture's shape
                  that causes this, not the size of the screen.
                */}
                <div
                  style={{
                    width:
                      !controlsOnPicture && picture && picture.width >= USABLE_TRANSPORT_WIDTH
                        ? `${picture.width}px`
                        : "100%",
                  }}
                >
                  {transport}
                </div>
              </div>

              {sideBySide && (
                <aside
                  className="flex-shrink-0 flex flex-col gap-3 overflow-y-auto"
                  style={{ width: SIDE_COLUMN_WIDTH }}
                  data-testid="side-controls"
                >
                  {panelRail}
                </aside>
              )}
            </div>
          )}

          {/* Under a landscape clip the width is the plentiful dimension, so the
              looks sit below as a row. A vertical clip puts them in the column. */}
          {hasVideo && !sideBySide && <div>{panelRail}</div>}

          <div
            aria-hidden
            className="lg:hidden sticky bottom-0 -mb-8 h-8 flex-shrink-0 pointer-events-none bg-gradient-to-t from-background to-transparent"
          />
        </div>

        {/* AI Chat Sidebar.

            On a phone this stacks under the player inside a viewport that
            never scrolls — so without a height of its own the chat's natural
            height is its whole history, and flexbox settles the fight by
            crushing the player to a sliver under an unscrollable wall of
            messages. A fixed share of the column gives both panes a shape:
            the player keeps the top, the chat scrolls inside the bottom. */}
        <div
          className={`w-full lg:w-[400px] flex-shrink-0 lg:basis-auto min-h-0 border-t lg:border-t-0 lg:border-l border-hairline bg-background/80 backdrop-blur-xl flex flex-col z-20 shadow-[-20px_0_40px_rgba(0,0,0,0.5)] ${
            chatOpen ? "basis-[52%]" : "basis-auto"
          }`}
          data-testid="chat-panel"
          data-open={chatOpen ? "true" : "false"}
        >
          {/* Noah header, and below `lg` the handle for the sheet. A header is
              the right target for this: it is the full width of the panel, it
              is already the thing that names what is behind it, and it means
              the sheet has no separate furniture of its own. */}
          <button
            type="button"
            onClick={() => { setChatOpen((open) => !open); setUnreadFromNoah(false); }}
            aria-expanded={chatOpen}
            aria-controls="noah-conversation"
            className="p-4 border-b border-hairline flex items-center gap-3 text-left w-full lg:pointer-events-none no-default-hover-elevate"
            data-testid="button-toggle-chat"
          >
            <div className="relative flex-shrink-0">
              <img
                src="/noah-avatar.jpg"
                alt="Noah"
                className="w-10 h-10 rounded-full object-cover shadow-[0_0_12px_rgba(108,59,255,0.5)] ring-2 ring-primary/30"
              />
              <span className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full bg-green-400 border-2 border-background shadow-[0_0_6px_rgba(74,222,128,0.8)]" />
            </div>
            <div className="min-w-0">
              <h2 className="font-semibold text-sm leading-tight">Noah</h2>
              <p className="text-xs text-muted-foreground truncate">
                {chatOpen
                  ? "Your AI editor"
                  : unreadFromNoah
                    ? "Tap to read what I did"
                    : "Tap to read the conversation"}
              </p>
            </div>
            <span className="ml-auto lg:hidden flex items-center gap-2 flex-shrink-0">
              {unreadFromNoah && !chatOpen && (
                <span
                  className="w-2 h-2 rounded-full bg-primary shadow-[0_0_8px_rgba(108,59,255,0.8)]"
                  data-testid="chat-unread"
                  aria-label="Noah has something new to say"
                />
              )}
              <span className="text-muted-foreground" aria-hidden>
                {chatOpen ? <ChevronDown className="w-5 h-5" /> : <ChevronUp className="w-5 h-5" />}
              </span>
            </span>
          </button>

          <ScrollArea
            ref={scrollAreaRef}
            id="noah-conversation"
            className={`flex-1 min-h-0 p-4 ${chatOpen ? "" : "hidden lg:block"}`}
          >
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
                    Hey, I'm Noah 👋<br />Your AI video editor.<br /><br />Upload your video and tell me the vibe, and I'll turn it into a viral clip.
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
                      <div dir="auto" className={`px-4 py-3 text-sm leading-relaxed whitespace-pre-line ${
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
              {/* dir="auto": typed Arabic reads right-to-left *as it is
                  typed*, not once it is sent. An input laid out the other way
                  puts the caret on the wrong side of the sentence someone is
                  in the middle of writing. */}
              <Input
                dir="auto"
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                placeholder="Describe your edit..."
                /* `md:h-12` because the Input component sets `md:h-9` for form fields and
                   twMerge keeps both — different breakpoints, no conflict to resolve — so
                   the chat bar quietly became 36px tall on a desktop while the buttons
                   inside it stayed 40px and bulged out of it. */
                className="input-chat-glow pr-32 bg-surface-1 border-hairline rounded-full h-12 md:h-12"
                disabled={!hasVideo || isNoahThinking || sendMessage.isPending || isProcessingEdit}
                data-testid="input-chat"
              />
              {/* Speech fills this same input, live, rather than sending on
                  its own — so everything the typed path already does applies to
                  it unchanged, and you can fix a misheard word before sending.
                  See `voice-input.tsx`. */}
              <SpeechLanguageToggle
                language={speechLanguage}
                onChange={setSpeechLanguage}
                disabled={isNoahThinking || sendMessage.isPending || isProcessingEdit}
              />
              <VoiceInput
                language={speechLanguage}
                onLanguageChange={setSpeechLanguage}
                disabled={isNoahThinking || sendMessage.isPending || isProcessingEdit}
                existing={chatInput}
                onTranscript={(text) => setChatInput(text)}
                onError={setVoiceError}
              />
              <Button 
                type="submit"
                size="icon"
                disabled={(!chatInput.trim() && marks.length === 0) || !hasVideo || isNoahThinking || sendMessage.isPending || isProcessingEdit}
                /* `.aura-btn` rather than a flat disc with a hover glow: the
                   ring is there at rest, which is the only state a phone has. */
                className="aura-btn no-default-hover-elevate absolute right-1 top-1 h-10 w-10 rounded-full bg-secondary text-secondary-foreground hover:bg-secondary"
                data-testid="button-send-message"
              >
                <Send className="w-4 h-4" />
              </Button>
            </form>
            {voiceError && (
              <p
                dir="auto"
                className="mt-2 text-xs text-destructive"
                role="status"
                data-testid="text-voice-error"
              >
                {voiceError}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
