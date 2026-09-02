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
  /**
   * How many times one person doing the thing the page describes plausibly
   * needs to do it in this window.
   *
   * Recorded because the ceiling is meaningless without it. "Forty is a lot"
   * is true of joining a waiting list and false of sending chat messages, and
   * a policy check that asserts a flat floor across both is asserting a number
   * rather than the rule the number came from. The rule is: every limit sits
   * at least five times above this, so the only person who meets one is the
   * one writing a loop.
   */
  perPerson: number;
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
      logger.error({ err: error, name: options.name }, "rate limiter unavailable. Allowing the request");
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
 * The same limiter, for a route with nobody signed in.
 *
 * `rateLimit` keys on the authenticated user and, on a public route, finds
 * none — so it logs and lets the request through. That is the right answer for
 * a route that was *supposed* to be behind auth, and the wrong one for a route
 * that is public on purpose: the waiting-list signup is open to the internet by
 * design, and open with no limit is an invitation to fill the table.
 *
 * The key is the client address. It is a weak identity — a shared office is one
 * key, a phone changes keys between rooms — and that is acceptable here because
 * the limit is set where no person reaches it and only a script does. Behind
 * Vercel the address arrives in `x-forwarded-for`, whose first entry is the
 * client and whose remainder is the chain of proxies; taking the last would key
 * every request in the world to one edge node.
 */
export function rateLimitByIp(options: LimitOptions): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    /*
      `x-vercel-forwarded-for` first, and that is not a preference.

      `x-forwarded-for` is a header the *client* can send, and this took its
      first entry — so anybody who set their own `X-Forwarded-For` got a fresh
      bucket on every request and walked past both public limiters. Express's
      `trust proxy` is never set here, so nothing was pinning it to the edge
      either.

      Vercel writes `x-vercel-forwarded-for` itself and strips any copy that
      arrives from outside, which makes it the one value on this request that a
      caller cannot choose. The fallback chain is deliberate and ordered by how
      much each can be trusted: the platform's header, then the forwarded chain,
      then the socket. `req.ip` is last rather than second on purpose — behind
      Vercel it is the *edge node*, and keying on it would put every request in
      the world into one bucket, which is a denial of service against the whole
      product rather than a stricter limit.

      In production the first branch always answers, so the second is unreachable
      there; it is what keeps this working against a local server and in the
      isolation suite, where nothing is forwarding anything.
    */
    const one = (value: string | string[] | undefined): string =>
      (Array.isArray(value) ? value[0] : value ?? "").split(",")[0]?.trim() ?? "";

    const address =
      one(req.headers["x-vercel-forwarded-for"]) ||
      one(req.headers["x-forwarded-for"]) ||
      req.ip ||
      "unknown";

    let verdict: Verdict;
    try {
      verdict = await consume(`ip:${address}:${options.name}`, options.limit, options.windowMs);
    } catch (error) {
      logger.error({ err: error, name: options.name }, "rate limiter unavailable. Allowing the request");
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
    req.log?.warn({ name: options.name }, "rate limited by address");
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
  /**
   * The only public write in the product, so the only one a stranger can loop.
   *
   * Six in ten minutes is far more than a person signing themselves up needs —
   * they need one, and a second if they typo'd — and far less than a script
   * filling the table is after.
   */
  waitlist: {
    name: "waitlist",
    limit: 6,
    windowMs: 10 * 60 * 1000,
    // One, and a second if they typo'd the first.
    perPerson: 1,
    message: "That's a lot of sign-ups from one place. Give it a few minutes.",
  },
  /** The one that had nothing at all, and the one that costs money per call. */
  chat: {
    name: "chat",
    limit: 40,
    windowMs: 10 * 60 * 1000,
    // A back-and-forth about one video in ten minutes.
    perPerson: 8,
    message:
      "You're sending messages faster than we can think. Give it a minute, nothing you've asked for has been lost.",
  },
  /** Queuing work. The per-project guard does not stop a loop over new projects. */
  render: {
    name: "render",
    limit: 30,
    windowMs: 10 * 60 * 1000,
    // Asking again is free, and people do — but not more than a handful of
    // times before they go and watch the result.
    perPerson: 6,
    message:
      "That's a lot of renders at once. Give it a few minutes. The ones already queued are still running.",
  },
  /** Creating projects, which is the loop that walks past the per-project guard. */
  createProject: {
    name: "create-project",
    // Uploading a batch of takes in one sitting.
    perPerson: 12,
    limit: 60,
    windowMs: 10 * 60 * 1000,
    message: "You've created a lot of projects very quickly. Give it a few minutes.",
  },
  /**
   * Scheduling posts, which is its own action and not a project being created.
   *
   * It borrowed `createProject`, and a borrowed limit is a limit that changes
   * when somebody tunes the other one — the two have nothing to do with each
   * other beyond both being writes that cost a row.
   *
   * A person planning a week of content schedules once per finished edit, not
   * once per destination: the route writes every account in a single request
   * and refuses the whole thing if any of them cannot take it. Ten in ten
   * minutes covers somebody working through a batch of clips in one sitting.
   */
  schedulePost: {
    name: "schedule-post",
    limit: 50,
    windowMs: 10 * 60 * 1000,
    perPerson: 10,
    message: "That's a lot of scheduling at once. Give it a few minutes; nothing already queued is affected.",
  },
  /**
   * Registering an uploaded font.
   *
   * Its own limit rather than a borrowed one, because what it protects is
   * unlike anything else here: each row is a few seconds of a *worker* — a
   * Python parse, a repair, and eight ffmpeg renders to measure the face — on
   * the same single-threaded process that renders video. A loop here does not
   * fill a table, it stops the queue.
   *
   * Six per person in ten minutes is a person uploading the family they use.
   * A brand has a typeface, not a folder.
   */
  registerFont: {
    name: "register-font",
    limit: 40,
    windowMs: 10 * 60 * 1000,
    perPerson: 6,
    message: "That's a lot of fonts at once. Give it a few minutes; the ones already sent are being prepared.",
  },
  /**
   * The stock library: somebody else's API, and bytes through ours.
   *
   * It borrowed `write`, whose own comment describes it as "renaming,
   * deleting, editing — the small writes of an ordinary session". These are
   * neither writes nor small. `/stock/search` spends a Pexels quota we do not
   * own, and `/stock/file/:id` proxies up to two hundred megabytes through
   * this server because a `<video>` cannot carry an Authorization header.
   *
   * Thirty is a real browse: a dozen searches and twenty previews while
   * looking for one shot. What it stops is a loop that spends the day's Pexels
   * allowance in a minute, or pulls a gigabyte through the proxy — neither of
   * which is a thing this deployment finds out about until it stops working.
   */
  stock: {
    name: "stock",
    limit: 150,
    windowMs: 10 * 60 * 1000,
    perPerson: 30,
    message: "That's a lot of searching at once. Give it a minute and carry on.",
  },
  /** Cheap, but the path that mints signed storage URLs, so worth a ceiling. */
  write: {
    name: "write",
    limit: 300,
    windowMs: 10 * 60 * 1000,
    // Renaming, deleting, editing — the small writes of an ordinary session.
    perPerson: 60,
    message: "Too many changes at once. Give it a moment and try again.",
  },
  /**
   * Crash reports from a browser, which is the second public write in the
   * product and the only one that exists because the app is broken.
   *
   * The thing being protected is a log rather than a bill, and the person
   * being protected from is the one filling it. Four is what a real crash loop
   * produces: somebody reloads into the same failure a few times before they
   * give up, and every one of those is an honest report we would rather have.
   */
  clientErrors: {
    name: "client-errors",
    limit: 20,
    windowMs: 10 * 60 * 1000,
    perPerson: 4,
    message: "That is a lot of crash reports from one place. Nothing else is affected.",
  },
} as const satisfies Record<string, LimitOptions>;
