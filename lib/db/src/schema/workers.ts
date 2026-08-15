import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";

/**
 * One row per running worker.
 *
 * The queue can tell you a render is stuck. It cannot tell you whether anything
 * is listening — not for five minutes, and not at all when the queue is empty.
 * That gap is widest exactly when it matters most: you have just deployed the
 * worker, nothing is queued, and the only way to check is to upload a video.
 *
 * So the worker writes here as it polls, and presence is a fact rather than an
 * inference. The two provider names are the ones it resolved at startup, so
 * "why are my captions missing" is answerable from the product instead of from
 * a log line only one person can read.
 */
export const workerHeartbeatsTable = pgTable(
  "worker_heartbeats",
  {
    /** Hostname plus a random suffix — several copies run at once. */
    workerId: text("worker_id").primaryKey(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    /** The model's name, never a key. Null means it came up without one. */
    transcription: text("transcription"),
    vision: text("vision"),
  },
  (t) => [index("worker_heartbeats_last_seen_idx").on(t.lastSeenAt.desc())],
);

export type WorkerHeartbeat = typeof workerHeartbeatsTable.$inferSelect;
