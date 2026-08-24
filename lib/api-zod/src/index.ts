/**
 * Zod validation schemas for the Editly API.
 * Derived from lib/api-spec/openapi.yaml (source of truth).
 */
import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

export const ProjectStatus = z.enum([
  "uploading",
  "ready",
  "processing",
  "done",
  "failed",
]);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

export const Platform = z.enum(["tiktok", "reels", "shorts"]);
export type Platform = z.infer<typeof Platform>;

export const Project = z.object({
  id: z.string(),
  title: z.string(),
  status: ProjectStatus,
  thumbnailUrl: z.string().nullable(),
  videoUrl: z.string().nullable(),
  editedVideoUrl: z.string().nullable(),
  videoPath: z.string().nullable(),
  editedVideoPath: z.string().nullable(),
  thumbnailPath: z.string().nullable(),
  /**
   * A video whose look this project should be edited to match.
   *
   * Uploaded, never fetched from a link: pulling someone's TikTok down to
   * analyse it breaks that platform's terms, and the exposure would be ours
   * rather than the user's.
   */
  referenceVideoPath: z.string().nullable(),
  duration: z.number().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  /**
   * The *edited* file's dimensions, measured by the worker from the file it
   * produced. A landscape upload rendered for a vertical platform makes these
   * disagree with `width`/`height`, and the player draws whichever file it is
   * actually showing.
   */
  editedWidth: z.number().nullable(),
  editedHeight: z.number().nullable(),
  platform: Platform.nullable(),
  /**
   * True when this project's render has been sitting unclaimed long enough that
   * no worker is running. The status alone cannot say whether the queue is busy
   * or empty, and those mean opposite things to whoever is waiting.
   */
  renderStalled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Project = z.infer<typeof Project>;

export const Message = z.object({
  id: z.string(),
  projectId: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  createdAt: z.string(),
});
export type Message = z.infer<typeof Message>;

export const ExportStep = z.object({
  label: z.string(),
  status: z.enum(["pending", "active", "done"]),
});
export type ExportStep = z.infer<typeof ExportStep>;

export const ExportJob = z.object({
  id: z.string(),
  projectId: z.string(),
  status: z.enum(["pending", "processing", "done", "failed"]),
  platform: Platform,
  downloadUrl: z.string().nullable(),
  /**
   * The storage key of the file this export produced, which the browser signs
   * for itself. Null until there is one.
   *
   * It is here rather than being read off the project because the project's
   * `editedVideoPath` is a *cache* of the newest render, and the export screen
   * was reading a copy of it fetched before this export existed — so "Download
   * Video" handed people their original upload under a card saying the edit was
   * ready. A path that arrives with the status it belongs to cannot be stale.
   */
  outputPath: z.string().nullable().optional(),
  steps: z.array(ExportStep),
  /**
   * What the render did that the person should know about: captions skipped for
   * want of a key, punches dropped because the words they landed on were cut,
   * words the two speech models disagreed on.
   *
   * The pipeline has produced these all along and thrown them into a log line.
   * A render that quietly did less than it was asked to, and looks identical to
   * one that did everything, is the failure this whole product is built against.
   */
  notes: z.array(z.string()).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ExportJob = z.infer<typeof ExportJob>;

export const SubscriptionPlan = z.enum(["free", "creator", "pro", "studio"]);
export type SubscriptionPlan = z.infer<typeof SubscriptionPlan>;

/**
 * What the meter says.
 *
 * Minutes of finished video, not videos: the old counter charged the same for
 * a nine-second hook and a ninety-minute episode. `maxUploadMinutes` is here
 * because it is the number that actually separates the tiers — a podcaster
 * upgrades to upload a whole episode as one file, not to buy minutes they will
 * never use.
 */
export const SubscriptionUsage = z.object({
  plan: SubscriptionPlan,
  minutesIncluded: z.number(),
  minutesUsedThisMonth: z.number(),
  minutesRemaining: z.number(),
  maxUploadMinutes: z.number(),
  watermark: z.boolean(),
  referenceStyle: z.boolean(),
  pricePerMonth: z.number(),
});
export type SubscriptionUsage = z.infer<typeof SubscriptionUsage>;

export const ErrorResponse = z.object({
  error: z.string(),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;

const IdParams = z.object({ id: z.string().min(1) });

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

/**
 * `ok` | `behind` | `unreachable`.
 *
 * Three states rather than a boolean because they are three different jobs for
 * whoever is reading: nothing, run the migrations, check the connection. The
 * missing columns are named, since "the database is behind" without saying how
 * is a sentence that still costs an afternoon.
 */
export const HealthCheckResponse = z.object({
  status: z.string(),
  database: z.object({
    reachable: z.boolean(),
    missingColumns: z.array(z.string()),
  }),
  /**
   * Which optional parts of the product this deployment actually has.
   *
   * Booleans, never key names and never key values — this endpoint is public.
   * It exists because the recurring question on this project has not been "is
   * the server up" but "is the thing we built actually switched on", and that
   * was previously only answerable by reading a dashboard or waiting for a
   * customer to hit a 503.
   *
   * `storageAdmin` false is the sharp one: account deletion is refused while it
   * is, because deleting the rows without reclaiming the bytes would be an
   * orphaning dressed up as a deletion.
   */
  capabilities: z
    .object({
      /** Reclaiming stored video. Account deletion is refused without it. */
      storageAdmin: z.boolean(),
      /**
       * Whether that key actually authenticates, asked of Storage rather than
       * assumed: "ok" | "unauthorized" | "unreachable" | "not-configured".
       * A present-but-wrong key looks identical to a right one until the moment
       * a customer asks to delete their account.
       */
      storageCheck: z.string(),
      /** A model choosing operations. Without it, keyword matching does. */
      planner: z.boolean(),
      /** Searching free stock clips and photographs from inside a project. */
      stockLibrary: z.boolean(),
      /** Merchant of record. Without it the webhook refuses every payment. */
      billing: z.boolean(),
    })
    .optional(),
  message: z.string().optional(),
});
export type HealthCheckResponse = z.infer<typeof HealthCheckResponse>;

// ---------------------------------------------------------------------------
// projects
// ---------------------------------------------------------------------------

export const ListProjectsResponse = z.array(Project);
export type ListProjectsResponse = z.infer<typeof ListProjectsResponse>;

export const CreateProjectBody = z.object({ title: z.string().min(1) });
export type CreateProjectBody = z.infer<typeof CreateProjectBody>;

export const CreateProjectResponse = Project;
export type CreateProjectResponse = z.infer<typeof CreateProjectResponse>;

export const GetProjectParams = IdParams;
export type GetProjectParams = z.infer<typeof GetProjectParams>;

export const GetProjectResponse = Project;
export type GetProjectResponse = z.infer<typeof GetProjectResponse>;

export const UpdateProjectParams = IdParams;
export type UpdateProjectParams = z.infer<typeof UpdateProjectParams>;

export const UpdateProjectBody = z.object({
  title: z.string().min(1).optional(),
  status: ProjectStatus.optional(),
  thumbnailUrl: z.string().optional(),
  videoUrl: z.string().optional(),
  editedVideoUrl: z.string().optional(),
  videoPath: z.string().optional(),
  editedVideoPath: z.string().optional(),
  thumbnailPath: z.string().optional(),
  /** Null clears it. Gated on the plan — see routes/projects.ts. */
  referenceVideoPath: z.string().nullable().optional(),
  duration: z.number().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  platform: Platform.optional(),
});
export type UpdateProjectBody = z.infer<typeof UpdateProjectBody>;

export const UpdateProjectResponse = Project;
export type UpdateProjectResponse = z.infer<typeof UpdateProjectResponse>;

export const DeleteProjectParams = IdParams;
export type DeleteProjectParams = z.infer<typeof DeleteProjectParams>;

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

export const ListMessagesParams = IdParams;
export type ListMessagesParams = z.infer<typeof ListMessagesParams>;

export const ListMessagesResponse = z.array(Message);
export type ListMessagesResponse = z.infer<typeof ListMessagesResponse>;

export const SendMessageParams = IdParams;
export type SendMessageParams = z.infer<typeof SendMessageParams>;

export const SendMessageBody = z.object({ content: z.string().min(1) });
export type SendMessageBody = z.infer<typeof SendMessageBody>;

export const MessagePair = z.object({
  userMessage: Message,
  aiMessage: Message,
});
export type MessagePair = z.infer<typeof MessagePair>;

// SendMessageResponse is defined after RenderJob, because sending a message
// can now *start a render* — see routes/messages.ts — and the response carries
// the job it started.

// ---------------------------------------------------------------------------
// exports
// ---------------------------------------------------------------------------

export const StartExportParams = IdParams;
export type StartExportParams = z.infer<typeof StartExportParams>;

export const StartExportBody = z.object({ platform: Platform });
export type StartExportBody = z.infer<typeof StartExportBody>;

export const StartExportResponse = ExportJob;
export type StartExportResponse = z.infer<typeof StartExportResponse>;

export const GetExportStatusParams = IdParams;
export type GetExportStatusParams = z.infer<typeof GetExportStatusParams>;

export const GetExportStatusResponse = ExportJob;
export type GetExportStatusResponse = z.infer<typeof GetExportStatusResponse>;

// ---------------------------------------------------------------------------
// subscription
// ---------------------------------------------------------------------------

export const GetSubscriptionResponse = SubscriptionUsage;
export type GetSubscriptionResponse = z.infer<typeof GetSubscriptionResponse>;

export const UpdateSubscriptionBody = z.object({ plan: SubscriptionPlan });
export type UpdateSubscriptionBody = z.infer<typeof UpdateSubscriptionBody>;

export const UpdateSubscriptionResponse = SubscriptionUsage;
export type UpdateSubscriptionResponse = z.infer<typeof UpdateSubscriptionResponse>;

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

/**
 * Whether anything is listening, and what it can do.
 *
 * The queue can say a render is stuck. It cannot say whether a worker exists —
 * not for the first five minutes, and not at all when nothing is queued. This
 * is the fact rather than the inference. The worker's id is not here: it
 * carries a hostname and answers no question anybody outside is asking.
 */
export const WorkerStatus = z.object({
  online: z.boolean(),
  lastSeenAt: z.string().nullable(),
  /** The model's name, never a key. Null means the worker has none configured. */
  transcription: z.string().nullable(),
  vision: z.string().nullable(),
});
export type WorkerStatus = z.infer<typeof WorkerStatus>;

export const DashboardStats = z.object({
  totalProjects: z.number(),
  /** Renders a worker is actually working on. Excludes the stalled ones. */
  processingCount: z.number(),
  /** Renders queued with nobody to run them. */
  stalledCount: z.number(),
  doneCount: z.number(),
  recentProjects: z.array(Project),
  /** Whether anything is listening. See WorkerStatus. */
  worker: WorkerStatus,
});
export type DashboardStats = z.infer<typeof DashboardStats>;

export const GetDashboardStatsResponse = DashboardStats;
export type GetDashboardStatsResponse = z.infer<typeof GetDashboardStatsResponse>;

// ---------------------------------------------------------------------------
// render jobs
//
// The edit plan is the contract between the API and the ffmpeg worker. Keeping
// it declarative — a list of named operations with explicit parameters — means
// the worker never interprets natural language, and a plan can be replayed,
// diffed, or saved as a template. Phase 4's AI produces one of these; it does
// not get to invent new operations.
// ---------------------------------------------------------------------------

/**
 * Drop stretches of near-silence. This is the operation that actually saves the
 * three hours: it is what a creator would otherwise do by hand, cut by cut.
 */
export const RemoveSilenceOperation = z.object({
  type: z.literal("removeSilence"),
  /** Anything quieter than this counts as silence. */
  thresholdDb: z.number().min(-80).max(0).default(-32),
  /** Silences shorter than this are left alone — speech has natural gaps. */
  minSilenceMs: z.number().int().min(100).max(10_000).default(500),
  /** Kept on each side of a cut so words are not clipped. */
  paddingMs: z.number().int().min(0).max(1000).default(80),
  /**
   * Stretches of the source that must survive intact, in source milliseconds.
   *
   * Silence removal cannot tell a dead pause from a deliberate one. A demo
   * running on screen, a reveal, a beat held before a punchline — all of them
   * are quiet, and all of them are the moment the clip exists for. Cutting one
   * out does not look like an aggressive edit; it looks like the video is
   * broken.
   *
   * The API cannot fill this in: it needs someone to have watched the video.
   * The worker's scene reader does, and writes what it found here, so the
   * protection is part of the plan and therefore replayable and inspectable
   * rather than a hidden step inside the renderer.
   */
  protect: z
    .array(z.object({ startMs: z.number().min(0), endMs: z.number().min(0) }))
    .max(60)
    .optional(),
});

/** Reframe to a platform's aspect ratio by cropping to the centre. */
export const FormatForPlatformOperation = z.object({
  type: z.literal("formatForPlatform"),
  platform: Platform,
  /**
   * Height of the exported frame. The width follows from 9:16, so 1920 is
   * 1080x1920 and 2160 is 1216x2160.
   *
   * Requesting one is not the same as getting it. The plan clamps it — nothing
   * the client sends widens what the tier allows — and the renderer clamps it
   * again against what the source can actually fill, because a 1080p camera
   * scaled to 2160 is four times the file for exactly the same detail. Both
   * clamps say so rather than quietly obeying.
   */
  maxHeight: z.number().int().min(720).max(2160).optional(),
});

export const CaptionWord = z.object({
  startMs: z.number().min(0),
  endMs: z.number().min(0),
  text: z.string().min(1).max(60),
});
export type CaptionWord = z.infer<typeof CaptionWord>;

/**
 * Burn subtitles into the picture.
 *
 * `words` is optional because not every source of cues knows per-word timing —
 * but karaoke is only honest with it, so the renderer falls back to a plain
 * fade when it is absent rather than faking a rhythm.
 */
export const BurnCaptionsOperation = z.object({
  type: z.literal("burnCaptions"),
  cues: z
    .array(
      z.object({
        startMs: z.number().min(0),
        endMs: z.number().min(0),
        text: z.string().min(1).max(300),
        words: z.array(CaptionWord).optional(),
      }),
    )
    .min(1),
  style: z.enum(["bold-white", "bold-yellow", "karaoke-box"]).default("bold-white"),
  animation: z.enum(["none", "pop", "karaoke"]).default("pop"),
});

/**
 * Captions whose words are not known yet.
 *
 * `burnCaptions` needs cues, and the API has none: the words live in the video,
 * and only the worker has both the file and the recogniser. So a plan says
 * *that* it wants captions and how they should look, and the worker replaces
 * this with a real `burnCaptions` once it has a transcript — or drops it and
 * says why, when no recogniser is configured.
 *
 * The renderer never sees this operation. Keeping the expansion in the worker
 * rather than the renderer means a plan stays replayable: the same plan against
 * the same video produces the same captions, and against a different video
 * produces that video's words.
 */
export const AutoCaptionsOperation = z.object({
  type: z.literal("autoCaptions"),
  style: z.enum(["bold-white", "bold-yellow", "karaoke-box"]).default("bold-white"),
  animation: z.enum(["none", "pop", "karaoke"]).default("pop"),
  /** Leave "um" and "uh" out of what is burnt in. */
  dropFillers: z.boolean().default(true),
  /** BCP-47 hint. Omit to let the recogniser detect the language. */
  language: z.string().min(2).max(16).optional(),
});

/** The growth loop: free-plan renders carry a mark. */
export const WatermarkOperation = z.object({
  type: z.literal("watermark"),
  text: z.string().min(1).max(60).default("Edited with Editly"),
  position: z.enum(["bottom-right", "bottom-center", "top-right"]).default("bottom-right"),
});

/**
 * A slow continuous push. On a locked-off talking head this is the difference
 * between "a video" and "a shot" — it costs nothing and stops the frame reading
 * as a still image.
 */
export const KenBurnsOperation = z.object({
  type: z.literal("kenBurns"),
  /** Zoom reached by the end of the clip. 1.08 is a push you feel but do not notice. */
  to: z.number().min(1.01).max(1.5).default(1.08),
});

/** Punch in at chosen moments — emphasis on a line, or on a cut. */
export const ZoomPunchOperation = z.object({
  type: z.literal("zoomPunch"),
  /**
   * Seconds into the *source* — the file as it was uploaded, before silence is
   * cut. Emphasis is measured against the recording, so that is the clock every
   * producer of these numbers is reading; the renderer converts them once, in
   * its critic pass, and drops any whose moment did not survive the cut.
   *
   * Empty means "choose for me".
   */
  at: z.array(z.number().min(0)).max(40),
  amount: z.number().min(0.02).max(0.6).default(0.12),
  holdMs: z.number().int().min(200).max(6000).default(1200),
});

/**
 * Push the colour toward a reference's.
 *
 * A ratio rather than an absolute, because "0.31 saturation" means nothing
 * without knowing what the footage measured to begin with — the same number is
 * a lift for flat log footage and a cut for something already graded. The
 * multiplier is produced by comparing the two, and it is clamped hard: over-
 * saturation is the fastest way to make footage look cheap, and it is the first
 * thing anyone notices when an automatic edit has been over-eager.
 */
export const GradeOperation = z.object({
  type: z.literal("grade"),
  /** 1 leaves the picture alone. Below 1 drains colour, above 1 pushes it. */
  saturation: z.number().min(0.5).max(1.5).default(1),
});

/**
 * Bring the audio to the level every social platform normalises to, so they
 * leave it alone instead of pulling it around on upload.
 */
export const NormalizeLoudnessOperation = z.object({
  type: z.literal("normalizeLoudness"),
  targetLufs: z.number().min(-30).max(-8).default(-14),
});

/**
 * A project's library entry: something the render can put *on screen*, as
 * opposed to the one video it is editing.
 */
export const Asset = z.object({
  id: z.string(),
  projectId: z.string(),
  kind: z.enum(["video", "image", "audio"]),
  label: z.string().nullable(),
  bytes: z.number(),
  durationSeconds: z.number().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  createdAt: z.string(),
  /** Short-lived signed URL for the library thumbnail. Never the raw path. */
  url: z.string().nullable(),
});
export type Asset = z.infer<typeof Asset>;

/**
 * Cut a second clip in over the main one — b-roll.
 *
 * The asset is named by id, never by path: an id is checked against the
 * project's own library, and a path would be a request to render whatever the
 * caller can spell.
 *
 * `at` is on the *source* clock, like every other timing in this file, so the
 * producer and the critic are reading the same tape.
 */
export const InsertBRollOperation = z.object({
  type: z.literal("insertBRoll"),
  assetId: z.string().min(1),
  at: z.number().min(0),
  durationSeconds: z.number().min(0.2).max(30).default(3),
  /**
   * "cover" fills the frame and crops the overflow — right for footage.
   * "contain" fits the whole thing inside and letterboxes — right for a
   * screenshot, where cropping the edges destroys the point of showing it.
   */
  fit: z.enum(["cover", "contain"]).default("cover"),
  /** Keep the main audio under the b-roll, which is what a cutaway is. */
  keepSourceAudio: z.boolean().default(true),
});

/**
 * Lay an image over the frame: a logo, a screenshot, a product shot, an arrow.
 *
 * Scale is a fraction of frame width rather than pixels, because the same plan
 * renders to 1080×1920 and 1080×1350 and a pixel size that is right for one is
 * wrong for the other.
 */
export const OverlayImageOperation = z.object({
  type: z.literal("overlayImage"),
  assetId: z.string().min(1),
  at: z.number().min(0),
  durationSeconds: z.number().min(0.2).max(60).default(3),
  position: z
    .enum(["top-left", "top-center", "top-right", "center", "bottom-left", "bottom-center", "bottom-right"])
    .default("center"),
  /** Fraction of the frame's width. 0.4 is a comfortable inset graphic. */
  scale: z.number().min(0.05).max(1).default(0.4),
  opacity: z.number().min(0.05).max(1).default(1),
});

export const ListAssetsParams = z.object({ id: z.string().min(1) });
export const ListAssetsResponse = z.array(Asset);

export const RegisterAssetParams = z.object({ id: z.string().min(1) });
export const RegisterAssetBody = z.object({
  /** Storage object path, `<userId>/<projectId>/<name>`. Checked, not trusted. */
  path: z.string().min(3).max(400),
  kind: z.enum(["video", "image", "audio"]),
  label: z.string().max(200).optional(),
  bytes: z.number().int().min(0).max(50_000_000_000).default(0),
  durationSeconds: z.number().min(0).max(86_400).optional(),
  width: z.number().int().min(0).max(20_000).optional(),
  height: z.number().int().min(0).max(20_000).optional(),
});
export const RegisterAssetResponse = Asset;

export const DeleteAssetParams = z.object({ id: z.string().min(1), assetId: z.string().min(1) });

/**
 * One piece a clips render cut from the source.
 *
 * Unlike an Asset, the storage path IS returned: the worker wrote this file,
 * so the browser has no other way to learn where it is — and it goes only to
 * the verified owner of the project, exactly as `editedVideoPath` already
 * does on the project itself. The browser signs its own playback URL from it
 * with its own session, the same way it plays everything else.
 */
export const Clip = z.object({
  id: z.string(),
  projectId: z.string(),
  /** Which render produced it — clips from one ask share a jobId. */
  jobId: z.string(),
  /** 1-based position in its set, in source order. */
  idx: z.number(),
  /** The stretch of the source it came from, seconds on the source clock. */
  startSeconds: z.number(),
  endSeconds: z.number(),
  outputPath: z.string(),
  outputSeconds: z.number().nullable(),
  /** The worker's one line about this clip. */
  note: z.string().nullable(),
  /**
   * The opening words spoken in this clip's window, from the transcript.
   * Null when nothing was heard — a title the product invented would be a
   * title the speaker never said.
   */
  title: z.string().nullable(),
  createdAt: z.string(),
});
export type Clip = z.infer<typeof Clip>;

export const ListClipsParams = z.object({ id: z.string().min(1) });
export const ListClipsResponse = z.array(Clip);

export const DeleteClipParams = z.object({ id: z.string().min(1), clipId: z.string().min(1) });

/**
 * Opening a clip as its own project: same identifiers as deleting one, and
 * deliberately no body. Everything the new project needs — its length, its
 * frame, the words it opens with — is already known from the clip and the
 * project it came from, and a body would only be a chance for the browser to
 * disagree with the row.
 */
export const PromoteClipParams = DeleteClipParams;

/**
 * Type that arrives with weight.
 *
 * Rendered in a browser rather than by a filter, because a spring — overshoot
 * then settle — is a curve `cubic-bezier` cannot describe, and because the
 * difference between "a caption" and "a title" is entirely in that curve.
 *
 * `at` is on the source clock like every other timing here.
 */
export const MotionTitleOperation = z.object({
  type: z.literal("motionTitle"),
  text: z.string().min(1).max(120),
  at: z.number().min(0),
  durationSeconds: z.number().min(0.4).max(20).default(2.5),
  /**
   * "card" is a full statement held in the middle of frame; "lower-third" is a
   * name or label that does not interrupt; "word" is one emphasised word,
   * bigger and shorter than either.
   */
  style: z.enum(["card", "lower-third", "word"]).default("card"),
  position: z.enum(["top", "center", "bottom"]).default("center"),
});

/**
 * Keep only the strongest stretch of the clip — the highlight.
 *
 * The person asks for a length, not for timestamps: "give me the best 30
 * seconds" is a sentence about the result, and where those seconds live is
 * exactly the judgement they are paying the product to make. The worker
 * chooses the window from the transcript — the densest, least-hesitant run
 * of speech — and falls back to the middle of the clip when nothing can be
 * heard, saying so in the notes either way.
 *
 * Composes with everything else the way a cut must: chosen first, so
 * captions, punches and framing are laid onto the clip that will actually
 * exist. When silence removal is also asked for, the silences are cut
 * *within* the chosen window rather than fighting it for the timeline.
 */
export const ExtractHighlightOperation = z.object({
  type: z.literal("extractHighlight"),
  /** How long the finished highlight should be, in seconds. */
  targetSeconds: z.number().min(5).max(120).default(30),
});

/**
 * Keep exactly the stretch the person named — "from 1:20 to 2:10".
 *
 * The mirror image of `extractHighlight`: there the caller names a length and
 * the product chooses the moments; here the caller names the moments and no
 * judgement is invited. It exists because "cut minute two to minute three" is
 * among the first sentences anyone says to an editor, and because a clip
 * chosen by someone who watched the footage beats any heuristic we own.
 *
 * It is also the substrate the clipping feature stands on: a "clip" is
 * nothing more than a range some chooser decided on, so every path this
 * operation exercises — the cut, the intersection with silence removal, the
 * honest clamping notes — is the path multi-clip renders will ride later.
 *
 * Both ends are on the source clock. An end past the file's real length is
 * clamped rather than refused, with a note; an empty or inverted window is
 * the renderer's to drop, also with a note.
 */
export const ExtractRangeOperation = z.object({
  type: z.literal("extractRange"),
  /** Where the kept stretch begins, in seconds on the source clock. */
  startSeconds: z.number().min(0).max(86400),
  /** Where it ends. Clamped to the file's real length at render time. */
  endSeconds: z.number().min(0).max(86400),
});

/**
 * Cut the video into several separate clips — the clipping feature's front
 * door.
 *
 * The person asks for a number of pieces; where each piece lives is the same
 * judgement `extractHighlight` already makes, made several times over with
 * the windows kept apart. The worker expands this one operation into one
 * render per clip — each an `extractRange` it chose — and the rest of the
 * plan (reframe, captions, levelling, the watermark policy added) applies to
 * every clip alike. The outputs land in the `clips` table as their own
 * artifacts; the project's own pointer keeps meaning "the latest whole-video
 * render" and is not touched.
 */
export const ExtractClipsOperation = z.object({
  type: z.literal("extractClips"),
  /** How many pieces to cut. Bounded because each one is a full render. */
  count: z.number().int().min(2).max(6).default(3),
  /** How long each piece should be, in seconds. */
  targetSeconds: z.number().min(5).max(120).default(30),
});

/**
 * Fade in from black and out to black — the first transition.
 *
 * Deliberately the ends only, and deliberately symmetric: fading the joins
 * *inside* a silence-removed cut would overlap segments and shift every
 * timestamp after the first join, which is the clock captions and punches
 * live on. A fade at the ends touches no clock at all — the video is exactly
 * as long with it as without it — so it composes with everything else for
 * free. One duration for both ends because an edit whose opening and closing
 * disagree reads as an accident, not a choice.
 */
export const FadeOperation = z.object({
  type: z.literal("fade"),
  /** How long each fade runs. Bounded: past 2s a fade is a scene, not a transition. */
  durationMs: z.number().min(100).max(2000).default(500),
});

export const EditOperation = z.discriminatedUnion("type", [
  RemoveSilenceOperation,
  ExtractHighlightOperation,
  ExtractRangeOperation,
  ExtractClipsOperation,
  FadeOperation,
  FormatForPlatformOperation,
  BurnCaptionsOperation,
  AutoCaptionsOperation,
  WatermarkOperation,
  KenBurnsOperation,
  ZoomPunchOperation,
  NormalizeLoudnessOperation,
  GradeOperation,
  InsertBRollOperation,
  OverlayImageOperation,
  MotionTitleOperation,
]);
export type EditOperation = z.infer<typeof EditOperation>;

export const EditPlan = z.object({
  version: z.literal(1),
  operations: z.array(EditOperation).min(1).max(12),
});
export type EditPlan = z.infer<typeof EditPlan>;

export const JobStatus = z.enum(["queued", "running", "done", "failed"]);
export type JobStatus = z.infer<typeof JobStatus>;

export const RenderJob = z.object({
  id: z.string(),
  projectId: z.string(),
  status: JobStatus,
  progress: z.number(),
  stage: z.string().nullable(),
  error: z.string().nullable(),
  plan: EditPlan,
  outputPath: z.string().nullable(),
  /** See ExportJob.notes — what was done, and what could not be. */
  notes: z.array(z.string()).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RenderJob = z.infer<typeof RenderJob>;

/**
 * What a sent message comes back with. `plan` is what the sentence was
 * understood to mean; `render` is the job that understanding started, when it
 * started one — the product's promise is one prompt and the work begins, so
 * the response has to be able to say "and it has begun".
 */
export const SendMessageResponse = MessagePair.extend({
  plan: EditPlan.nullable().optional(),
  render: RenderJob.nullable().optional(),
});
export type SendMessageResponse = z.infer<typeof SendMessageResponse>;

export const StartRenderParams = z.object({ id: z.string() });
export type StartRenderParams = z.infer<typeof StartRenderParams>;

/**
 * Either a plan built by the caller, or the id of a saved one. A template is
 * resolved on the server so the numbers behind a named look live in one place.
 */
export const StartRenderBody = z.union([
  z.object({ plan: EditPlan }),
  z.object({ templateId: z.string().min(1) }),
]);
export type StartRenderBody = z.infer<typeof StartRenderBody>;

export const StartRenderResponse = RenderJob;
export type StartRenderResponse = z.infer<typeof StartRenderResponse>;

export const GetRenderStatusParams = z.object({ id: z.string() });
export type GetRenderStatusParams = z.infer<typeof GetRenderStatusParams>;

export const GetRenderStatusResponse = RenderJob.nullable();
export type GetRenderStatusResponse = z.infer<typeof GetRenderStatusResponse>;

/**
 * Narrows a plan name read out of the database. Lives here rather than in the
 * API server so the export route and the billing route agree on what counts as
 * a known plan.
 */
export function isPlanKeyGuard(value: string): value is z.infer<typeof SubscriptionPlan> {
  return SubscriptionPlan.safeParse(value).success;
}

export const TemplateSummary = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  bestFor: z.string(),
});
export type TemplateSummary = z.infer<typeof TemplateSummary>;

export const ListTemplatesResponse = z.array(TemplateSummary);
export type ListTemplatesResponse = z.infer<typeof ListTemplatesResponse>;
