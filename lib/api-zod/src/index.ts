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
  duration: z.number().nullable(),
  platform: Platform.nullable(),
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
  steps: z.array(ExportStep),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ExportJob = z.infer<typeof ExportJob>;

export const SubscriptionPlan = z.enum(["starter", "pro", "scale"]);
export type SubscriptionPlan = z.infer<typeof SubscriptionPlan>;

export const SubscriptionUsage = z.object({
  plan: SubscriptionPlan,
  videoLimitPerMonth: z.number(),
  videosUsedThisMonth: z.number(),
  editsPerVideo: z.number().nullable(),
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

export const HealthCheckResponse = z.object({ status: z.string() });
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
  duration: z.number().optional(),
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

export const DashboardStats = z.object({
  totalProjects: z.number(),
  processingCount: z.number(),
  doneCount: z.number(),
  recentProjects: z.array(Project),
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
});

/** Reframe to a platform's aspect ratio by cropping to the centre. */
export const FormatForPlatformOperation = z.object({
  type: z.literal("formatForPlatform"),
  platform: Platform,
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
  /** Seconds into the *edited* clip. */
  /** Seconds into the *edited* clip. Empty means "choose for me". */
  at: z.array(z.number().min(0)).max(40),
  amount: z.number().min(0.02).max(0.6).default(0.12),
  holdMs: z.number().int().min(200).max(6000).default(1200),
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
  WatermarkOperation,
  KenBurnsOperation,
  ZoomPunchOperation,
  NormalizeLoudnessOperation,
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
