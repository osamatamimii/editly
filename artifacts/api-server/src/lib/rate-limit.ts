/**
 * Stopping one person from spending everybody's money.
 *
 * The plan limits cap **minutes of finished video**, which is the expensive
 * thing and the thing customers understand. They cap nothing else, and two
 * endpoints spend real money without producing a minute of video:
 *
 *   - `POST /projects/:id/messages` calls a paid model to turn a sentence into
 *     an edit plan. Nothing limited it at all. A free account could send ten
 *     thousand of them in an afternoon and every one would be billed to us.
 *   - `POST /projects/:id/render` is guarded to one active job *per project*,
 *     which a loop that creates ten thousand projects walks straight past.
 *
 * This is not a scale problem. It bites at one determined user, long before it
 * bites at a thousand ordinary ones — which is why it belongs before launch and
 * not after.
 *
 * Three decisions worth stating.
 *
 * **The state is shared, because ours cannot be private.** Vercel runs many
 * short-lived copies of this app; a counter in a module variable counts only
 * that copy's requests, which is not a limit, it is a decoration. Postgres is
 * already on the path of every authenticated request and one upsert is far
 * cheaper than the model call it protects.
 *
 * **Fixed windows, not sliding.** Sliding needs a row per request; fixed needs
 * one row per person per endpoint, forever. The price is that somebody can send
 * a full window at the end of one and again at the start of the next, so every
 * limit below is set assuming that doubling.
 *
 * **It fails open.** If the limiter itself cannot reach the database, the
 * request proceeds. A limiter that fails closed turns a database blip into a
 * total outage — trading a bounded, unlikely cost for an unbounded, certain
 * one. It is logged loudly instead.
 */
import type { RequestHandler, Request, Response, NextFunction } from "express";
import { currentUserId } from "../middlewares/auth";
import { logger } from "./logger";

export interface Verdict {
  allowed: boolean;
  /** How many are left in this window after this request. */
  remaining: number;
  /** Seconds until the window resets. Sent as `Retry-After`. */
  retryAfterSeconds: number;
}

/**
 * The decision, given what the database came back with. Pure, so the arithmetic
 * — which is the part that is easy to get subtly wrong — can be checked without
 * a database, a clock, or an HTTP server.
 */
export function verdictFor(
  count: number,
  windowStart: Date | string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): Verdict {
  const started = new Date(windowStart).getTime();
  const elapsed = Number.isFinite(started) ? now - started : windowMs;
  // Never negative, and never longer than the window: a row whose timestamp is
  // in the future (clock skew between Postgres and the function) must not turn
  // into an hour-long lockout.
  const remainingMs = Math.max(0, Math.min(windowMs, windowMs - elapsed));
  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)),
  };
}

/**
 * Counts this request and says whether it is allowed.
 *
 * One statement. The `CASE` is what makes the window roll without a read first:
 * a row older than the window is reset to 1 rather than incremented, and both
 * decisions are made inside the same atomic update, so two requests arriving
 * together cannot both decide they are the first of a new window.
 */
export async function consume(
  bucket: string,
  limit: number,
  windowMs: number,
): Promise<Verdict> {
  const { pool } = await import("@workspace/db");
  const { rows } = await pool.query<{ count: number; window_start: Date }>(
    `INSERT INTO rate_limits (bucket, window_start, count)
     VALUES ($1, now(), 1)
     ON CONFLICT (bucket) DO UPDATE SET
       count = CASE
         WHEN rate_limits.window_start < now() - ($2 || ' milliseconds')::interval THEN 1
         ELSE rate_limits.count + 1
       END,
       window_start = CASE
         WHEN rate_limits.window_start < now() - ($2 || ' milliseconds')::interval THEN now()
         ELSE rate_limits.window_start
       END
     RETURNING count, window_start`,
    [bucket, String(Math.round(windowMs))],
  );

  const row = rows[0];
  if (!row) return { allowed: true, remaining: limit, retryAfterSeconds: 1 };
  return verdictFor(Number(row.count), row.window_start, limit, windowMs);
}

export interface LimitOptions {
  /** Appears in the bucket key, so each endpoint gets its own budget. */
  name: string;
  limit: number;
  windowMs: number;
  /** Shown to the person. Says what they hit and what to do, never a number of milliseconds. */
  message: string;
}

/** The sentence for a limit that has been hit. */
export function tooManyMessage(options: LimitOptions): string {
  return options.message;
}

export function rateLimit(options: LimitOptions): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    let userId: string;
    try {
      userId = currentUserId(req);
    } catch {
      // Not behind requireAuth. Nothing to key on, so nothing to limit — and
      // saying so is better than silently letting it through unmarked.
      logger.warn({ path: req.path }, "rate limit on a route with no authenticated user");
      next();
      return;
    }

    let verdict: Verdict;
    try {
      verdict = await consume(`${userId}:${options.name}`, options.limit, options.windowMs);
    } catch (error) {
      logger.error({ err: error, name: options.name }, "rate limiter unavailable — allowing the request");
      next();
      return;
    }

    res.setHeader("X-RateLimit-Limit", String(options.limit));
    res.setHeader("X-RateLimit-Remaining", String(verdict.remaining));

    if (verdict.allowed) {
      next();
      return;
    }

    res.setHeader("Retry-After", String(verdict.retryAfterSeconds));
    req.log?.warn({ userId, name: options.name }, "rate limited");
    res.status(429).json({
      error: options.message,
      retryAfterSeconds: verdict.retryAfterSeconds,
      rateLimited: true,
    });
  };
}

/**
 * The limits themselves, in one place so they can be read as a policy rather
 * than found one route at a time.
 *
 * Every number is set well above what the product's own copy invites. Nobody
 * doing the thing the page describes will meet one of these; the only person
 * who does is the one writing a loop.
 */
export const LIMITS = {
  /** The one that had nothing at all, and the one that costs money per call. */
  chat: {
    name: "chat",
    limit: 40,
    windowMs: 10 * 60 * 1000,
    message:
      "You're sending messages faster than we can think. Give it a minute — nothing you've asked for has been lost.",
  },
  /** Queuing work. The per-project guard does not stop a loop over new projects. */
  render: {
    name: "render",
    limit: 30,
    windowMs: 10 * 60 * 1000,
    message:
      "That's a lot of renders at once. Give it a few minutes — the ones already queued are still running.",
  },
  /** Creating projects, which is the loop that walks past the per-project guard. */
  createProject: {
    name: "create-project",
    limit: 60,
    windowMs: 10 * 60 * 1000,
    message: "You've created a lot of projects very quickly. Give it a few minutes.",
  },
  /** Cheap, but the path that mints signed storage URLs, so worth a ceiling. */
  write: {
    name: "write",
    limit: 300,
    windowMs: 10 * 60 * 1000,
    message: "Too many changes at once. Give it a moment and try again.",
  },
} as const satisfies Record<string, LimitOptions>;
