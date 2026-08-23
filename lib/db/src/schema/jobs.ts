import { pgTable, text, timestamp, jsonb, uuid, integer, real, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { sql } from "drizzle-orm";
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

    /**
     * The reference video this render was queued against, if any.
     *
     * Snapshotted onto the job rather than read from the project when the job
     * is claimed, so changing or clearing the reference while a render sits in
     * the queue cannot quietly alter a render already accepted.
     */
    referencePath: text("reference_path"),

    /** 0–100, written by the worker as it goes so the UI can show real progress. */
    progress: integer("progress").notNull().default(0),
    /** Human-readable description of what the worker is doing right now. */
    stage: text("stage"),

    /** Set only on failure, and safe to show the user. */
    error: text("error"),

    /**
     * What the render did that the person should know about, in their language:
     * captions skipped for want of a key, punches dropped because the words
     * they landed on were cut, words the two speech models disagreed on.
     *
     * The worker has produced these from the beginning and written them to a
     * log line. A render that quietly did less than it was asked to, and looks
     * from the outside exactly like one that did everything, is the failure
     * this product is built against — so they live on the row and reach the UI.
     */
    notes: jsonb("notes").$type<string[]>(),

    /**
     * How long the finished video actually came out, in seconds, measured by
     * the worker after encoding. This is what the plan meter counts.
     *
     * Null means "not measured" rather than zero: jobs that predate
     * minute-based billing have no honest value, and a zero would tell the
     * quota those renders were free.
     */
    outputSeconds: real("output_seconds"),

    /**
     * Seconds the meter charges for this job — separated from what it
     * produced, because clips broke the equivalence: a clips render reads and
     * transcribes the whole source to produce a few pieces of it, so it is
     * billed at the source it read, said openly in its notes. A single render
     * is billed at what it produced, as always. Null on rows from before this
     * column existed; the meter falls back to `outputSeconds` for those,
     * which is exactly what they were billed at the time.
     */
    billedSeconds: real("billed_seconds"),

    /**
     * How that number was arrived at: `probe` (read from the finished file),
     * `estimate` (the plan's arithmetic, when ffprobe would not answer) or
     * `fallback` (the source length, when nothing else was available).
     *
     * It exists because a measurement and a guess used to be indistinguishable
     * once written, and the guess used to be `null` — which SUM() skips, so a
     * render nobody could measure was silently free.
     */
    outputSecondsSource: text("output_seconds_source"),

    /**
     * Length of the uploaded file, measured by the worker from the file itself.
     *
     * This is the trusted number. `projects.duration` is written by the browser
     * and is for display; enforcing a paid ceiling against it meant the ceiling
     * could be removed by omitting a field.
     */
    sourceSeconds: real("source_seconds"),

    /**
     * The longest source this job's plan allowed at the moment it was queued.
     *
     * Carried on the row rather than looked up at render time for two reasons:
     * the worker can enforce it without knowing anything about billing, and a
     * plan change while the job sat in the queue cannot retroactively refuse
     * work that was accepted under the old one.
     */
    maxSourceSeconds: real("max_source_seconds"),

    /**
     * What was left of the month's allowance when this job was accepted.
     *
     * The same trick as the ceiling above, for the number the ceiling could not
     * cover. The policy layer refuses a render whose source would overrun the
     * balance — but only when it has a source length, and `projects.duration`
     * comes from the browser and is nullable. When it is missing the refusal is
     * skipped entirely, so a five-minute plan with one minute left would happily
     * accept a nine-minute file and discover the overrun only after paying for
     * the encode.
     *
     * The worker measures the file for real. With this on the row it can apply
     * the rule to that measurement without knowing what a plan is.
     *
     * NULL means unlimited, for rows queued before the column existed.
     */
    remainingSeconds: real("remaining_seconds"),

    /**
     * Higher is claimed first, within the queued rows.
     *
     * Set from the plan when the job is written, not joined from the
     * subscription at claim time: the claim must stay one atomic statement, the
     * worker should need to know nothing about billing, and the deal someone
     * was on when they queued the work is the one to honour — upgrading does
     * not reach back and reorder a queue, and downgrading does not demote work
     * already accepted.
     */
    priority: integer("priority").notNull().default(0),

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
    // The claim query orders queued rows by priority then age; this is the
    // index it uses, and the column order has to match or every claim sorts in
    // memory.
    index("jobs_queue_idx").on(t.status, t.priority.desc(), t.createdAt),
    // The invariant both queueing routes check by hand and neither could hold:
    // a project may have at most one job that is queued or running. Declared
    // here so the schema check knows it exists; created by
    // 0013_one_active_job_per_project.sql, which is what actually runs.
    uniqueIndex("jobs_one_active_per_project")
      .on(t.projectId)
      .where(sql`status IN ('queued', 'running')`),
  ],
);

export const insertJobSchema = createInsertSchema(jobsTable).omit({ createdAt: true, updatedAt: true });
export type InsertJob = z.infer<typeof insertJobSchema>;
export type Job = typeof jobsTable.$inferSelect;
