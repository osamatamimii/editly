import { pgTable, text, timestamp, jsonb, uuid, integer, real, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * The render queue.
 *
 * Video processing cannot run inside a Vercel function — no ffmpeg binary, a
 * 250 MB bundle ceiling, and a timeout that expires long before any real render
 * finishes. So the API only ever enqueues here, and a dedicated worker claims
 * rows and does the work.
 *
 * Postgres is the queue rather than Redis or SQS: the database already exists,
 * `FOR UPDATE SKIP LOCKED` gives exactly the claim semantics needed, and one
 * fewer provider is one fewer thing to pay for and reason about.
 */
export const jobsTable = pgTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    /** Denormalised from the parent project so ownership checks never need a join. */
    userId: uuid("user_id").notNull(),
    projectId: text("project_id").notNull(),

    /** queued → running → done | failed */
    status: text("status").notNull().default("queued"),

    /** The edit plan the worker executes. See lib/api-zod EditPlan. */
    plan: jsonb("plan").notNull(),

    /** Storage object keys, in the private "videos" bucket. */
    inputPath: text("input_path").notNull(),
    outputPath: text("output_path"),

    /** 0–100, written by the worker as it goes so the UI can show real progress. */
    progress: integer("progress").notNull().default(0),
    /** Human-readable description of what the worker is doing right now. */
    stage: text("stage"),

    /** Set only on failure, and safe to show the user. */
    error: text("error"),

    /**
     * How long the finished video actually came out, in seconds, measured by
     * the worker after encoding. This is what the plan meter counts.
     *
     * Null means "not measured" rather than zero: jobs that predate
     * minute-based billing have no honest value, and a zero would tell the
     * quota those renders were free.
     */
    outputSeconds: real("output_seconds"),

    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),

    /**
     * Claim bookkeeping. A worker that dies mid-job leaves lockedAt behind;
     * the sweep in the worker returns such rows to the queue.
     */
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("jobs_user_project_idx").on(t.userId, t.projectId, t.createdAt),
    // The claim query orders queued rows by age; this is the index it uses.
    index("jobs_queue_idx").on(t.status, t.createdAt),
  ],
);

export const insertJobSchema = createInsertSchema(jobsTable).omit({ createdAt: true, updatedAt: true });
export type InsertJob = z.infer<typeof insertJobSchema>;
export type Job = typeof jobsTable.$inferSelect;
