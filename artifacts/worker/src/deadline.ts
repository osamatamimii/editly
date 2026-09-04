/**
 * Nothing this worker starts may run forever.
 *
 * Every heavy thing here is a child process, and every one of them was spawned
 * with no ceiling of any kind. That is one bug, and it is the worst-shaped one
 * in this codebase, because of what happens *around* the hang rather than in
 * it.
 *
 * ## The shape of it
 *
 * A render calls ffmpeg. ffmpeg wedges — a truncated file whose demuxer blocks,
 * a filter graph that deadlocks waiting on a stream that never arrives, a
 * network-backed read that stalls with the socket still open. There is no exit
 * code and no error: the process simply sits there. So:
 *
 *   - `run()` awaits `close`, which never comes, so `processJob` never returns.
 *   - `withLockKeptAlive` is still running, so it goes on renewing the row's
 *     lock **and the worker's heartbeat**, on a timer, indefinitely.
 *   - `requeueStaleJobs` therefore never sees a stale lock, so the job is never
 *     handed to anybody else.
 *   - `/api/healthz` reads that heartbeat and answers `worker.online: true`.
 *   - `.github/workflows/watch.yml` — the monitor written *because of* the two
 *     day outage in August — reads that and reports the platform healthy.
 *   - Every other customer's render queues behind it. Forever.
 *
 * So a single hung subprocess is a total, permanent, invisible outage, and the
 * thing built to catch outages is green throughout. Nothing fails. That is the
 * whole failure.
 *
 * ## Two different questions
 *
 * A ceiling is easy to get wrong in the other direction: kill a Pro customer's
 * ninety-minute render at an hour and the bug is now ours and it bills them for
 * it. So this offers two limits, and the caller picks by what its child is
 * actually doing.
 *
 * **`stallMs` — no output for this long.** The right one wherever the child
 * talks while it works. ffmpeg writes `time=...` to stderr every fraction of a
 * second on any real render; the analysis passes stream raw frames on stdout.
 * A three-hour render that is genuinely rendering never goes quiet, and a
 * wedged one goes quiet immediately. This is the sharper question — it catches
 * a hang in minutes without ever putting a ceiling on honest work.
 *
 * **`totalMs` — this long, whatever happens.** For the children that say
 * nothing until they are done: ffprobe answering in one burst, an encode
 * running at `-loglevel error` straight to a file. Silence is normal there, so
 * only the clock can speak. Set generously; it is a backstop, not a schedule.
 *
 * Most callers want both — the stall limit to catch the hang, the total limit
 * to bound the case where a child is chattering but making no progress.
 *
 * ## SIGKILL, not SIGTERM
 *
 * ffmpeg handles SIGTERM by trying to finalise its output, which is exactly the
 * work it is currently stuck in the middle of. A process that is not responding
 * is not going to respond to a polite request; and the file it would finalise
 * is a half-render nobody wants. So the timer kills, and the caller throws.
 *
 * ## And the caller must throw
 *
 * Killing a child makes it emit `close` — which is the same event a *successful*
 * child emits. Any wrapper that resolves on `close` without asking this guard
 * whether it was killed will hand back a partial buffer as though it were a
 * finished one: half a video, an interest profile from four seconds of a
 * ninety-second clip, a beat grid from a fragment. That is the same class of
 * bug one layer down. Hence `expired`, and hence every wrapper in this worker
 * consults it before resolving.
 */
import type { ChildProcess } from "node:child_process";

/** Thrown when a child was killed for taking too long, rather than failing. */
export class TimedOutError extends Error {
  constructor(
    readonly what: string,
    readonly kind: "stalled" | "overran",
    readonly afterMs: number,
  ) {
    super(
      kind === "stalled"
        ? `${what} stopped producing output for ${Math.round(afterMs / 1000)}s and was stopped. ` +
          `That usually means the file it was reading is damaged in a way that makes it hang rather than fail.`
        : `${what} ran for ${Math.round(afterMs / 60000)} minutes without finishing and was stopped.`,
    );
    this.name = "TimedOutError";
  }
}

export interface Deadline {
  /** True once this guard has killed the child. Check before resolving. */
  readonly expired: boolean;
  /** Why it was killed, ready to throw. Null while it is still alive. */
  readonly error: TimedOutError | null;
  /** Call on every chunk of output, to say the child is still working. */
  touch(): void;
  /** Call from `close`/`error`, always, so the timers do not hold the loop. */
  clear(): void;
}

export interface Limits {
  /** Kill if no output arrives for this long. For children that talk. */
  stallMs?: number;
  /** Kill after this long regardless. For children that work in silence. */
  totalMs?: number;
  /** Named in the error, so a support answer is a sentence and not a code. */
  what: string;
}

/**
 * Arm the limits on a child.
 *
 * The timers are `unref`'d: a guard must never be the reason the process stays
 * alive, and every path through here also calls `clear()`.
 */
export function guard(child: ChildProcess, limits: Limits): Deadline {
  let expired = false;
  let error: TimedOutError | null = null;
  let lastOutput = Date.now();

  const stop = (kind: "stalled" | "overran", afterMs: number): void => {
    if (expired) return;
    expired = true;
    error = new TimedOutError(limits.what, kind, afterMs);
    // SIGKILL: see the note above. A child that has stopped answering will not
    // answer a request to tidy up either.
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone. The flag is what matters to the caller, not the signal.
    }
  };

  const timers: NodeJS.Timeout[] = [];

  if (limits.stallMs !== undefined) {
    const every = Math.max(1000, Math.floor(limits.stallMs / 4));
    const tick = setInterval(() => {
      const quietFor = Date.now() - lastOutput;
      if (quietFor >= limits.stallMs!) stop("stalled", quietFor);
    }, every);
    tick.unref?.();
    timers.push(tick);
  }

  if (limits.totalMs !== undefined) {
    const cap = setTimeout(() => stop("overran", limits.totalMs!), limits.totalMs);
    cap.unref?.();
    timers.push(cap);
  }

  return {
    get expired() {
      return expired;
    },
    get error() {
      return error;
    },
    touch() {
      lastOutput = Date.now();
    },
    clear() {
      for (const timer of timers) clearInterval(timer as NodeJS.Timeout);
    },
  };
}

/**
 * The ceilings, in one place.
 *
 * Named rather than inline because the argument for each number is different,
 * and a number with no argument attached to it is a number somebody will
 * "tidy" later.
 */
export const LIMITS = {
  /** ffprobe. Answers in one burst; a second is normal, two minutes is broken. */
  probe: { totalMs: 2 * 60_000 },

  /**
   * The render itself.
   *
   * Stall-led on purpose. ffmpeg prints its `time=` line continuously — the
   * progress bar in the product is built from exactly those bytes — so silence
   * for ten minutes means it is not rendering. The total is the backstop.
   *
   * ## The sentence that used to be here was an assumption, and it is wrong
   *
   * It read: "the longest upload any plan allows is well under four hours of
   * *output*, and nothing here encodes slower than realtime by a factor of
   * two." Both halves have now been measured rather than assumed, and neither
   * survives.
   *
   * Measured on a real 1080p source with a vertical reframe and four punches —
   * one of the *simpler* plans this product renders, with no transcription, no
   * captions and no VP9 mirror in it:
   *
   *   two cores  1153 ms per second of source  (1.15× realtime)
   *   one core   2073 ms per second of source  (2.07× realtime)
   *
   * `fly.toml` is one shared CPU. So the factor of two is not a comfortable
   * bound, it is the number itself, exceeded by every plan that adds a filter.
   *
   * And "well under four hours" is not true of what is sold. See
   * `ENCODE_SECONDS_PER_SOURCE_SECOND` below for the arithmetic and for which
   * plans it makes undeliverable.
   */
  render: { stallMs: 10 * 60_000, totalMs: 4 * 60 * 60_000 },

  /**
   * The passes that read a clip to measure it — framing, subject tracking,
   * style, beats. Each is capped in *source* seconds by its own `-t`, so these
   * are small jobs; they stream raw frames, so silence is the tell.
   */
  analysis: { stallMs: 3 * 60_000, totalMs: 30 * 60_000 },

  /**
   * The VP9 mirror. Runs at `-loglevel error` straight to a file, so it says
   * nothing at all while it works and only the clock can judge it. Slow by
   * design — it is the copy that plays in browsers with no H.264 decoder — so
   * the ceiling is generous.
   */
  preview: { totalMs: 90 * 60_000 },

  /**
   * Pulling the audio out of a source, and cutting a proxy window out of one.
   *
   * Both run at `-loglevel error` straight to a file, so they say nothing while
   * they work and only the clock can judge them — a stall limit would fire on a
   * healthy job. Generous against what they are: a four-hour podcast decoded to
   * 16 kHz mono is minutes, not an hour.
   *
   * These three call sites had no deadline of any kind, which is the failure
   * the top of this file is about: a wedged ffmpeg emits no exit code and no
   * error, the `await` never returns, and `withLockKeptAlive` goes on renewing
   * the lock and the heartbeat, so nothing requeues the job and `/healthz`
   * reports the worker online for as long as it takes somebody to notice the
   * queue is not moving.
   */
  extract: { totalMs: 60 * 60_000 },

  /**
   * The whole job, from claim to finish.
   *
   * Every limit above bounds one *invocation*. Nothing bounded their sum — and
   * a clips job is `renderPlan` once per window, each with its own fresh
   * four-hour render ceiling, plus a review, plus a ninety-minute VP9 mirror,
   * plus a thirty-minute upload, six times over. On paper that is a day and a
   * half, during which `withLockKeptAlive` renews the lock every twenty
   * seconds so the stale sweep never looks at it, the heartbeat keeps writing,
   * `/healthz` answers 200, and — with `WORKER_COUNT` at its default of one —
   * every other customer's render waits behind it.
   *
   * Six hours is well past any job this product can honestly deliver: the
   * deliverable ceiling from `ENCODE_SECONDS_PER_SOURCE_SECOND` is under two
   * hours of source on this machine. A job that reaches this has stopped being
   * a render and become an outage.
   */
  job: { totalMs: 6 * 60 * 60_000 },
} as const;

/**
 * How long a second of source takes to render, on the machine we deploy.
 *
 * Measured, twice, on a 1080p source with a vertical reframe and four zoom
 * punches — no transcription, no captions, no VP9 mirror, so the real figure
 * for a full job is higher:
 *
 *   two cores  1153 ms   (1.15× realtime)
 *   one core   2073 ms   (2.07× realtime)
 *
 * `artifacts/worker/fly.toml` runs one shared CPU, so 2.07 is the number that
 * applies to production today, and it is the number `LIMITS.render.totalMs`
 * has to be read against.
 *
 * ## What it decides
 *
 * `deliverableSourceMinutes()` turns it into the longest upload a render can
 * actually finish before the deadline kills it. Against the four-hour backstop
 * that is **115 minutes** of source on the current machine — and the pricing
 * page sells 240 minutes on Pro and 600 on Studio.
 *
 * That contradiction is not reachable today: the `videos` bucket's own
 * `file_size_limit` is 50 MB and `uploadCeiling` bounds every plan by it, so
 * nothing longer than about a minute can be uploaded at all and the refusal
 * says which bound applied. Raising the bucket ceiling — the first thing
 * anybody does after upgrading Supabase — is what turns "you cannot upload
 * this" into "you uploaded it, waited four hours, and it was killed", which is
 * the worse of the two by a distance.
 *
 * Written down here, next to the deadline it is measured against, so that
 * whoever raises that ceiling meets this first.
 */
export const ENCODE_SECONDS_PER_SOURCE_SECOND = 2.073;

/** The longest source a render can finish inside its own deadline. */
export function deliverableSourceMinutes(
  encodeFactor = ENCODE_SECONDS_PER_SOURCE_SECOND,
  totalMs = LIMITS.render.totalMs ?? 0,
): number {
  if (!(encodeFactor > 0) || !(totalMs > 0)) return 0;
  return Math.floor(totalMs / 1000 / encodeFactor / 60);
}
