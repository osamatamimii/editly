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

/**
 * What the finished frame is shaped for.
 *
 * Three of these are platforms and two are shapes, which looks inconsistent
 * until you notice that is exactly how creators talk: "for TikTok" names a
 * place, "square" and "16:9" name a picture. The three vertical entries stay
 * separate because their safe areas differ — Reels reserves a taller caption
 * sheet than Shorts — while "square" is one shape several feeds share, and
 * "youtube" is the widescreen every long-form player expects.
 *
 * The list existed as vertical-only while the pricing page sold Pro as
 * "Long-form: YouTube and podcasts". That was a promise the renderer could
 * not keep.
 */
export const Platform = z.enum(["tiktok", "reels", "shorts", "youtube", "square"]);
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
  /**
   * How long the finished edit is, measured by the worker from the file it
   * produced. Null until a render has finished.
   *
   * Not the source length. The scheduling screen judges a post against each
   * platform's duration limit, and the only number it had was the upload's —
   * so a three-minute take cut to ninety seconds was refused for X on a limit
   * it does not break. Nothing errors when a limit is too strict; the person
   * just quietly cannot post something that would have been fine.
   */
  outputSeconds: z.number().nullable().optional(),
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
  /** Of `minutesIncluded`, how much was granted by hand this month rather than paid for. */
  minutesGranted: z.number().default(0),
  minutesUsedThisMonth: z.number(),
  minutesRemaining: z.number(),
  maxUploadMinutes: z.number(),
  /**
   * And the ceiling that is actually enforced, in bytes, read from Storage.
   *
   * `maxUploadMinutes` is our rule and this is somebody else's: a bucket
   * refuses an object over its own limit whatever the plan says, and on
   * Supabase's free plan that limit is 50 MB — around ninety seconds of what
   * this renderer encodes, against a page that sells four-hour episodes.
   *
   * It is sent rather than compiled into the front end because the front end's
   * copy was a build-time variable whose own comment claimed that moving the
   * ceiling would need no code change. It would have needed a redeploy, and
   * until somebody did one, uploads would go on being refused for a limit that
   * no longer existed.
   */
  maxUploadBytes: z.number(),
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
      /**
       * Whether anyone is on the operations console's allowlist.
       *
       * A boolean, never the ids and never the count: the only question it
       * answers is whether `ADMIN_USER_IDS` reached this deployment, because a
       * console that answers 404 to its own owner looks identical whether the
       * list is missing, empty, or simply does not name them.
       */
      admins: z.boolean().default(false),
    })
    .optional(),
  /**
   * Whether a machine that can actually render is listening.
   *
   * Everything else on this endpoint describes the API. This describes the
   * *product*: with no worker beating, every render queues and none of them
   * starts, and the API keeps answering 200 to everything because nothing is
   * wrong with the API. That is exactly the outage of 12 August, which ran for
   * two days because the only thing that would have noticed was somebody
   * choosing to look.
   *
   * It is reported rather than turned into a 503 on purpose. The two failures
   * send you to different places — one is Vercel and a migration, the other is
   * Fly and a machine — and a 503 here would also tell every uptime check and
   * every deploy gate that the API is down, which would not be true. Something
   * has to read this field for it to mean anything, and something does:
   * `.github/workflows/watch.yml` reads it every fifteen minutes and fails the
   * run when it is false, which is the alert.
   *
   * Absent — not false — when the heartbeat table could not be read: "no
   * evidence" and "evidence of absence" are different answers, and only one of
   * them should wake somebody up.
   */
  worker: z
    .object({
      online: z.boolean(),
      /** Whole seconds since the last beat, or null if there has never been one. */
      lastSeenAgoSeconds: z.number().nullable(),
    })
    .optional(),
  /**
   * Which ways of signing in are switched on for this project.
   *
   * Not a health signal — email sign-in is a complete product and Google being
   * off breaks nothing. It is here because turning Google on is four steps
   * across two dashboards and every one of them fails the same way from the
   * outside: you click "Continue with Google", you go away, you come back to a
   * login form. This makes "is it on in production" a question with an answer,
   * from anywhere, without an account.
   *
   * `known` is the whole point of the shape. It is false when Supabase could
   * not be asked, and then the providers are false too — meaning "we do not
   * know", not "they are off". Reporting the second when it means the first
   * would send somebody to re-enter credentials that were already right.
   *
   * Booleans only. No key name, no key value: this endpoint is public, and the
   * login page shows every visitor these same buttons anyway.
   */
  signIn: z
    .object({
      google: z.boolean(),
      apple: z.boolean(),
      known: z.boolean(),
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
   * Height of the exported frame. The width follows from the platform's
   * shape: 1920 vertical is 1080x1920, 1080 square is 1080x1080, and 1080
   * widescreen is 1920x1080.
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
  /**
   * What "choose for me" means.
   *
   * `emphasis` is the original and the default: the moments the speaker leaned
   * on a word, read out of the transcript. `beat` is the other thing people
   * mean by an edit with rhythm — the punches land on the music instead of on
   * the voice — and it needs a bed to land on, so the renderer says so out loud
   * when there is none rather than falling back to a different edit silently.
   *
   * It only has any meaning when `at` is empty. A plan that names its own
   * moments has already answered this question.
   */
  on: z.enum(["emphasis", "beat"]).default("emphasis"),
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
/**
 * A named look, for people who cannot hand us a reference clip.
 *
 * Matching a reference is the better answer and came first: it is measured
 * against footage the person actually chose, so it cannot be wrong about their
 * taste. But most people asking for "make it cinematic" have no reference to
 * give, and the honest reply to them was a refusal.
 *
 * These five are deliberately few and deliberately gentle. A look is a
 * suggestion about mood, not a costume: the fastest way to make footage look
 * cheap is to over-grade it, and the second fastest is to offer forty presets
 * so the choice feels like the product.
 */
export const GradeLook = z.enum(["none", "warm", "cool", "cinematic", "mono", "punch"]);
export type GradeLook = z.infer<typeof GradeLook>;

export const GradeOperation = z.object({
  type: z.literal("grade"),
  /** 1 leaves the picture alone. Below 1 drains colour, above 1 pushes it. */
  saturation: z.number().min(0.5).max(1.5).default(1),
  /**
   * Applied before the saturation multiplier, so a look and a reference match
   * compose instead of fighting: the look decides the mood, the reference
   * decides how much colour.
   */
  look: GradeLook.default("none"),
});

/**
 * Bring the audio to the level every social platform normalises to, so they
 * leave it alone instead of pulling it around on upload.
 */
export const NormalizeLoudnessOperation = z.object({
  type: z.literal("normalizeLoudness"),
  targetLufs: z.number().min(-30).max(-8).default(-14),
  /**
   * The clip is somebody talking, so take out what sits below their voice.
   *
   * A phone or a laptop records the room as well as the person: a fridge, a
   * fan, traffic through a window, the desk the microphone is on. Almost all
   * of it lives below 80Hz, where no speech does — the lowest voices start
   * around 85 — so it carries none of the words and quite a lot of the energy.
   * Measured on a take with room tone under it: the rumble drops 7.6dB and the
   * voice band comes out *very slightly louder*, because levelling no longer
   * spends headroom on sound nobody can hear as anything.
   *
   * Off by default and set per look rather than always on, because the same
   * filter is wrong for music: the bottom octave of a kick drum is exactly
   * what it would remove. A look with a track under it leaves this alone.
   */
  voice: z.boolean().default(false),
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
/**
 * Lay a music bed under the whole edit.
 *
 * The asset is named by id, like b-roll and overlays, and for the same reason:
 * an id is checked against the project's own library, a path is a request to
 * render whatever the caller can spell. The library is also the *only* source
 * of music here. We ship no catalogue, and we will not, because a track we
 * hand you is a licence we would have to have bought on your behalf — so this
 * operation carries what the person already owns, and nothing else.
 *
 * It has no `at`: a bed runs the length of the edit by definition. Everything
 * else in this file is placed on the source clock and moved through the cut
 * map; this one is placed on the *output* clock, because it is scored to the
 * finished thing, not to a moment in the recording.
 */
export const AddMusicOperation = z.object({
  type: z.literal("addMusic"),
  assetId: z.string().min(1),
  /**
   * How far under the programme the bed sits. -18 dB is a bed you feel and
   * stop hearing, which is what a bed is for; 0 would put the music level with
   * the voice and make the edit unwatchable.
   */
  gainDb: z.number().min(-40).max(0).default(-18),
  /**
   * Pull the music down further whenever someone is speaking, and let it back
   * up in the gaps. On a clip with no speech there is nothing to duck under,
   * and the render says so rather than pretending it happened.
   */
  duck: z.boolean().default(true),
  /** Ease the bed in at the start and out at the end. */
  fadeSeconds: z.number().min(0).max(5).default(1.5),
  /** Start the track somewhere other than its first second — songs have intros. */
  fromSeconds: z.number().min(0).max(3600).default(0),
  /** Repeat the track if it runs out before the edit does. */
  loop: z.boolean().default(true),
});

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
  /** A frame from the middle of the clip. Null when none could be made. */
  thumbnailPath: z.string().nullable(),
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
   * name or label that does not interrupt; "word" is kinetic type — bigger and
   * shorter than either, and its words arrive **one at a time**, in the order
   * the line is read rather than the order it was written, so an Arabic line
   * fills in from the right.
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
 * Fade in from black and out to black — the transition at the ends.
 *
 * Deliberately the ends only, and deliberately symmetric: a fade at the ends
 * touches no clock at all — the video is exactly as long with it as without
 * it — so it composes with everything else for free. One duration for both
 * ends because an edit whose opening and closing disagree reads as an
 * accident, not a choice. Softening the joins *inside* the cut is a different
 * operation with a different cost; see `TransitionOperation`.
 */
export const FadeOperation = z.object({
  type: z.literal("fade"),
  /** How long each fade runs. Bounded: past 2s a fade is a scene, not a transition. */
  durationMs: z.number().min(100).max(2000).default(500),
});

/**
 * Dissolve between the cuts — one shot melting into the next.
 *
 * The transition the fade deliberately was not. Where `fade` touches only the
 * two ends and therefore no clock, a dissolve overlaps every join: each pair
 * of kept stretches plays its last `durationMs` on top of the next one's
 * first, so the edit comes out `(joins × durationMs)` shorter than the sum of
 * its parts.
 *
 * That shortening is the whole difficulty, and it is why this arrived after
 * everything else rather than before. Captions, punch-ins, overlays and titles
 * are all placed by moving a source timestamp onto the edited clock, and that
 * clock now runs at a different rate through every join. The answer is not to
 * approximate it: the overlap is a single number, it is known before a frame
 * is rendered, and it is handed to the same mapping every one of those
 * features already uses — so a caption written at 0:41 of the recording still
 * lands on the syllable it was written for.
 *
 * Bounded well under the fade's ceiling because a dissolve is a join, not a
 * scene: past about a second it stops reading as one shot becoming another and
 * starts reading as two videos playing at once. It also has to fit inside the
 * shortest thing it joins, so the renderer may shorten it further and say so.
 */
/**
 * How one shot becomes the next.
 *
 * Ten styles, and they are the ffmpeg names one-to-one on purpose: a style and
 * a direction as two fields would let `{ style: "dissolve", direction: "up" }`
 * be written down, and a field that is silently ignored for half the values it
 * accepts is a field that will be set wrongly and never noticed. Every value
 * here is a thing that happens.
 *
 * Deliberately not all fifty-eight ffmpeg offers. The rest are pixelate,
 * squeeze, spiral, hexagonal — effects that read as a video editor showing off
 * rather than as an edit, and the product is not richer for a menu nobody
 * should pick from.
 */
export const TransitionStyle = z.enum([
  /** The two shots mix. The one everything else is measured against. */
  "dissolve",
  "wipeLeft",
  "wipeRight",
  "wipeUp",
  "wipeDown",
  "slideLeft",
  "slideRight",
  "slideUp",
  "slideDown",
  /** Through white. The short-form cut that reads as energy rather than as time passing. */
  "flash",
]);
export type TransitionStyle = z.infer<typeof TransitionStyle>;

/**
 * The transition between the cuts.
 *
 * This shipped as `dissolve` and was renamed the same day, before anything had
 * been stored under the old name — the plan column was checked, and no job in
 * the database carried one. That is the only reason the rename was allowed: a
 * type that appears in saved plans is a type that has to keep working, because
 * a job row is a billing record and replaying it must produce what was paid
 * for. Nothing was owed here, so the honest name won.
 *
 * `dissolve` is now one style among ten rather than the name of the whole
 * idea, which is what it always was.
 */
export const TransitionOperation = z.object({
  type: z.literal("transition"),
  style: TransitionStyle.default("dissolve"),
  /** How long each join overlaps. */
  durationMs: z.number().min(80).max(1000).default(250),
});

/**
 * Open on the strongest moment, then play from the top without it.
 *
 * The thing every short-form editor does by hand and calls a hook: the best
 * line is lifted out of the middle and becomes the first thing anyone hears,
 * because the first two seconds are the only two seconds you are given for
 * free.
 *
 * It **moves** the moment rather than copying it. A copy would be the more
 * obvious reading of "hook", and it would put the same sentence on screen
 * twice — but more importantly it would break the one property the whole
 * timeline rests on: that every source moment appears exactly once in the
 * output, which is what lets captions and punch-ins be moved with arithmetic
 * instead of guesswork. Moving keeps that, and a cold open is a real edit in
 * its own right.
 */
export const ColdOpenOperation = z.object({
  type: z.literal("coldOpen"),
  /** How much of the strongest moment to open on. */
  seconds: z.number().min(1).max(15).default(4),
});

export const EditOperation = z.discriminatedUnion("type", [
  RemoveSilenceOperation,
  ExtractHighlightOperation,
  ExtractRangeOperation,
  ExtractClipsOperation,
  ColdOpenOperation,
  FadeOperation,
  TransitionOperation,
  FormatForPlatformOperation,
  BurnCaptionsOperation,
  AutoCaptionsOperation,
  WatermarkOperation,
  KenBurnsOperation,
  ZoomPunchOperation,
  NormalizeLoudnessOperation,
  GradeOperation,
  InsertBRollOperation,
  AddMusicOperation,
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
  /**
   * A file the look cannot be built without, or null.
   *
   * On the wire so the button can say so before it is pressed. A template that
   * needs a track and is offered identically to one that does not is a button
   * whose only feedback is an error, and an error after a click is a worse
   * place to learn a requirement than the label.
   */
  needs: z.enum(["music"]).nullable().default(null),
});
export type TemplateSummary = z.infer<typeof TemplateSummary>;

export const ListTemplatesResponse = z.array(TemplateSummary);
export type ListTemplatesResponse = z.infer<typeof ListTemplatesResponse>;

// ---------------------------------------------------------------------------
// the admin console
//
// Operations, not surveillance. Everything below is metadata the platform
// already holds about itself: how the queue is doing, who signed up, which
// renders failed and why, what is being paid. There is deliberately no shape
// here that carries a customer's video, a signed URL to one, or anything that
// would let the console act as that customer — see admin-console.md for why
// that is a product boundary and not an unfinished feature.
// ---------------------------------------------------------------------------

/** How the platform is doing right now — the row of cards at the top. */
/**
 * A fortnight of one number, and the two weeks it splits into.
 *
 * `daily` is always exactly fourteen entries, oldest first, including the days
 * with nothing in them — a series that drops its empty days draws a busy week
 * and a dead one as the same shape.
 */
export const AdminTrend = z.object({
  daily: z.array(z.number()),
  thisWeek: z.number(),
  lastWeek: z.number(),
});
export type AdminTrend = z.infer<typeof AdminTrend>;

export const AdminOverview = z.object({
  queue: z.object({
    /** Being worked on by a live machine. */
    processing: z.number().int(),
    /** Queued behind a live machine. Waiting is normal; unattended is not. */
    waiting: z.number().int(),
    /** Queued with nothing listening. This is the number that means something is wrong. */
    unattended: z.number().int(),
    failedLastDay: z.number().int(),
    doneLastDay: z.number().int(),
  }),
  worker: WorkerStatus,
  accounts: z.object({
    total: z.number().int(),
    newLastWeek: z.number().int(),
  }),
  /** Subscribers per plan, and what they add up to per month. */
  revenue: z.object({
    byPlan: z.array(z.object({ plan: SubscriptionPlan, count: z.number().int() })),
    monthlyRecurringUsd: z.number(),
  }),
  /**
   * The most recent billing events, so a payment that did not land somewhere
   * can be seen rather than deduced. No amounts, no payment details: Freemius
   * is the merchant of record and what we do not store we cannot leak.
   */
  billing: z.array(
    z.object({
      eventId: z.string(),
      type: z.string(),
      email: z.string().nullable(),
      plan: SubscriptionPlan.nullable(),
      receivedAt: z.string(),
      applied: z.boolean(),
      outcome: z.string().nullable(),
    }),
  ),
  /** Seconds rendered this month across everyone — what the platform is actually doing. */
  minutesRenderedThisMonth: z.number(),
  /**
   * The other queue: posts waiting to go out.
   *
   * It shares nothing with the render queue except a worker, and it fails in a
   * way the render queue does not. A render nobody claims makes somebody wait
   * and then complain. A *post* nobody claims is simply not published, at a
   * time the person chose and is not watching — they find out days later, from
   * a feed with a hole in it, and there is no error anywhere to find.
   *
   * `overdue` is therefore the number that matters here, and it is the exact
   * counterpart of `queue.unattended`: rows past their time and still marked
   * `scheduled`, which can only mean the sweep is not running.
   *
   * Optional, so a console talking to an API that predates it draws the rest of
   * the page rather than failing to render — which is the failure mode a
   * required field produces on precisely the screen somebody opens when
   * something is already wrong.
   */
  posting: z
    .object({
      /** Due to go out in the next hour. Context for the numbers beside it. */
      dueSoon: z.number().int(),
      /** Past their time and still unclaimed. Anything above zero is a fault. */
      overdue: z.number().int(),
      /** Claimed by a publisher that never came back. Each one needs a person. */
      stranded: z.number().int(),
      publishedLastDay: z.number().int(),
      failedLastDay: z.number().int(),
      /** Not sent because they were too late. Not a failure; still worth seeing. */
      missedLastDay: z.number().int(),
      /** Accounts whose token the platform has stopped accepting. */
      accountsNeedingReconnect: z.number().int(),
    })
    .optional(),
  /**
   * Fourteen days of the numbers the cards show one of.
   *
   * Optional so a deployment whose API predates it still parses — the console
   * draws the cards without the lines rather than failing to render at all,
   * which is the failure mode a required field would have produced on exactly
   * the screen somebody opens when something is already wrong.
   */
  trends: z
    .object({
      signups: AdminTrend,
      renders: AdminTrend,
      minutes: AdminTrend,
      failures: AdminTrend,
    })
    .optional(),
});
export type AdminOverview = z.infer<typeof AdminOverview>;

export const GetAdminOverviewResponse = AdminOverview;
export type GetAdminOverviewResponse = z.infer<typeof GetAdminOverviewResponse>;

export const AdminAccount = z.object({
  userId: z.string(),
  email: z.string().nullable(),
  createdAt: z.string(),
  lastSignInAt: z.string().nullable(),
  plan: SubscriptionPlan,
  projectCount: z.number().int(),
  minutesUsedThisMonth: z.number(),
  minutesIncluded: z.number(),
});
export type AdminAccount = z.infer<typeof AdminAccount>;

export const ListAdminAccountsResponse = z.object({
  accounts: z.array(AdminAccount),
  /** The real total, counted independently of the page — a total derived from a page is a lie on page two. */
  total: z.number().int(),
});
export type ListAdminAccountsResponse = z.infer<typeof ListAdminAccountsResponse>;

/**
 * One render, as operations sees it.
 *
 * `error` is the sentence the customer was given, and `errorDetail` is what
 * actually happened. Both, because they answer different questions — "what
 * does this person think went wrong" and "what went wrong" — and for months
 * only the first was here while the schema claimed it was the second. The
 * whole value of this screen is turning "my video did not work" into an answer
 * in ten seconds, and a message rewritten for reassurance is a message that
 * has had the answer taken out of it.
 */
export const AdminJob = z.object({
  id: z.string(),
  userId: z.string(),
  projectId: z.string(),
  status: z.string(),
  progress: z.number().int(),
  stage: z.string().nullable(),
  error: z.string().nullable(),
  /**
   * The same failure, unedited.
   *
   * `error` is what the customer was told, and for anything that is not a plan
   * problem, a length problem or a transfer problem that sentence is
   * "Rendering failed. We are looking into it." This screen was showing that
   * to the operator and calling it the error — so every failure worth opening
   * the console for arrived here already stripped of its answer, which sat in
   * a log line on Fly instead.
   *
   * Null on rows that failed before the column existed, and on every row that
   * did not fail.
   */
  errorDetail: z.string().nullable(),
  attempts: z.number().int(),
  billedSeconds: z.number().nullable(),
  createdAt: z.string(),
  lockedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  /** Queued, unclaimed, and nothing is listening. */
  unattended: z.boolean(),
  /**
   * What the renderer said it did, in its own words.
   *
   * The console could see that a render succeeded and could see the message
   * when one failed, and had nothing at all for the case that actually
   * arrives in support: it worked, and it did not do what the person asked.
   * The notes are the only record of that — "there is no music under this
   * edit", "dropped a title whose moment did not survive the cut", "could not
   * find a steady beat in that track". Every one of those is a finished render
   * with an unhappy customer and, until now, no explanation this side of the
   * worker's logs.
   *
   * They are the renderer's own sentences about its own decisions: counts,
   * seconds, and values out of the plan the account itself wrote. Nothing from
   * inside the video — no transcript, no caption text — which is the same line
   * the rest of the console holds.
   */
  notes: z.array(z.string()).nullable(),
});
export type AdminJob = z.infer<typeof AdminJob>;

export const ListAdminJobsResponse = z.object({
  jobs: z.array(AdminJob),
  total: z.number().int(),
});
export type ListAdminJobsResponse = z.infer<typeof ListAdminJobsResponse>;

/**
 * One act of the console.
 *
 * `reason` is not optional anywhere — not in the schema, not in the routes.
 * It is the only part of an audit row a future reader cannot reconstruct from
 * the rest of the database, which makes it the only part worth insisting on.
 */
export const AdminActionRecord = z.object({
  id: z.string(),
  actorUserId: z.string(),
  /** requeue_job · grant_minutes · set_plan · set_suspended */
  action: z.string(),
  subjectUserId: z.string().nullable(),
  subjectJobId: z.string().nullable(),
  reason: z.string(),
  detail: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
});
export type AdminActionRecord = z.infer<typeof AdminActionRecord>;

export const ListAdminActionsResponse = z.object({
  actions: z.array(AdminActionRecord),
  total: z.number().int(),
});
export type ListAdminActionsResponse = z.infer<typeof ListAdminActionsResponse>;

/** Every action body carries one. Six characters, because a bar people route around is worse than a low one. */
export const AdminReasonBody = z.object({ reason: z.string().min(6).max(500) });

export const GrantMinutesBody = AdminReasonBody.extend({ minutes: z.number().min(1).max(600) });
export type GrantMinutesBody = z.infer<typeof GrantMinutesBody>;

export const SetPlanBody = AdminReasonBody.extend({ plan: SubscriptionPlan });
export type SetPlanBody = z.infer<typeof SetPlanBody>;

export const SetSuspendedBody = AdminReasonBody.extend({ suspended: z.boolean() });
export type SetSuspendedBody = z.infer<typeof SetSuspendedBody>;

export const RequeueJobBody = AdminReasonBody;
export type RequeueJobBody = z.infer<typeof RequeueJobBody>;

// ---------------------------------------------------------------------------
// the waiting list
//
// The only public write in the product: the person signing up does not have an
// account yet, which is the entire point of a waiting list.
// ---------------------------------------------------------------------------

export const JoinWaitlistBody = z.object({
  email: z.string().trim().min(3).max(320).email(),
  /**
   * Which page they signed up from.
   *
   * Sent by the page rather than inferred from the Origin header, because the
   * two answer different questions — the header says which host served the
   * script, this says which promise the person was reading. Bounded and
   * trimmed server-side; it is a label, not a payload.
   */
  source: z.string().max(120).optional(),
});
export type JoinWaitlistBody = z.infer<typeof JoinWaitlistBody>;

export const JoinWaitlistResponse = z.object({
  joined: z.literal(true),
  /**
   * How many people are on the list, not this person's index in it.
   *
   * An index is a promise about order, and nothing stops us admitting people
   * out of order. A number we would have to break later is worth less than the
   * honest one.
   */
  total: z.number().int(),
});
export type JoinWaitlistResponse = z.infer<typeof JoinWaitlistResponse>;

export const WaitlistEntrySummary = z.object({
  email: z.string(),
  source: z.string().nullable(),
  createdAt: z.string(),
});
export type WaitlistEntrySummary = z.infer<typeof WaitlistEntrySummary>;

export const ListWaitlistResponse = z.object({
  entries: z.array(WaitlistEntrySummary),
  total: z.number().int(),
});
export type ListWaitlistResponse = z.infer<typeof ListWaitlistResponse>;

export * from "./social";
export * from "./limits";
