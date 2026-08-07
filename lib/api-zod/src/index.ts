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
