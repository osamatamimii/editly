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

export const SendMessageResponse = MessagePair;
export type SendMessageResponse = z.infer<typeof SendMessageResponse>;

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

export const EditOperation = z.discriminatedUnion("type", [
  RemoveSilenceOperation,
  FormatForPlatformOperation,
  BurnCaptionsOperation,
  AutoCaptionsOperation,
  WatermarkOperation,
  KenBurnsOperation,
  ZoomPunchOperation,
  NormalizeLoudnessOperation,
  GradeOperation,
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
