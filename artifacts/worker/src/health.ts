/**
 * The one thing this process serves, so a bad deploy does not become a stopped
 * queue.
 *
 * `fly.toml` said "a deploy that cannot pass its health window is rolled back",
 * and there was no health check anywhere, so there was no window and nothing to
 * pass. Fly promoted whatever the image did as long as the process had not
 * exited yet. A worker that started, failed to reach the database, and sat in
 * its own retry loop was a successful deploy — and the queue stopped, silently,
 * exactly the way it did on 12 August.
 *
 * ## Why a socket rather than the heartbeat row
 *
 * The heartbeat is the right signal for "is a worker alive right now", and
 * `watch.yml` already reads it through the API every fifteen minutes. It is the
 * wrong signal for a deploy, because it is written by the *old* machine too:
 * during a rolling deploy the row from the copy that is still running says yes
 * while the new one is failing to start. A check has to be answered by the
 * process being checked.
 *
 * ## What it answers
 *
 * 200 once the loop has started and the database has answered at least once,
 * 503 before that and while shutting down. Not "is a render in progress" and
 * not "is the queue empty": a worker with nothing to do is healthy, and a
 * worker three minutes into a render is very healthy. What this reports is the
 * only thing a deploy can act on — whether this copy got far enough to be worth
 * keeping.
 *
 * It binds to `0.0.0.0` because Fly's checks come from outside the machine, and
 * it serves nothing else: any other path is 404, and there is no state on it to
 * read. The port is internal to the Fly private network unless `fly.toml`
 * publishes it, and it does not.
 */
import http from "node:http";

/** Fly's default internal port, and nothing else in this image uses it. */
export const HEALTH_PORT = Number(process.env["HEALTH_PORT"] ?? 8080);

export interface Health {
  /** The loop has started and the database answered. */
  ready: boolean;
  /** SIGTERM arrived; this copy is finishing its job and going. */
  leaving: boolean;
  /**
   * Why this worker is not working, when it is not. Null when it is.
   *
   * Alive and working are different facts, and until now this endpoint only
   * knew the first. A process whose render loop had stopped turning answered
   * 200 for as long as the process existed, which is how a stopped queue looks
   * identical to an idle one from outside.
   */
  stalled: null | "loop" | "job";
  /** How long the thing named by `stalled` has been that way. */
  stalledForMs: number;
}

/**
 * How long the loop may go without coming round before it is not turning.
 *
 * A multiple of the poll interval rather than a number of its own: the loop
 * sleeps exactly that long when there is nothing to claim, so anything under a
 * few multiples of it is a race with an idle worker. Five is comfortable and
 * still means a dead loop is visible inside half a minute at the default.
 */
export const LOOP_TURNS_WITHIN = 5;

/**
 * How long one job may be held before holding it is itself the fault.
 *
 * Deliberately the job ceiling in `deadline.ts` plus an hour, and deliberately
 * not tied to progress. A two-hour encode of a file ffmpeg cannot report
 * progress for is exactly the job that must not be declared dead — that
 * argument is written above `withLockKeptAlive` and it applies here word for
 * word. What this catches is the case no stall ceiling can: a job held past
 * every deadline that was supposed to end it.
 */
export const JOB_HELD_TOO_LONG_MS = 7 * 60 * 60_000;

/**
 * Starts the listener and hands back the two setters and a way to stop.
 *
 * The state lives in this closure rather than in a module-level variable so a
 * test can run two of these without them sharing an answer.
 */
export function serveHealth(
  port = HEALTH_PORT,
  onError?: (error: unknown) => void,
  options: {
    /** The loop's own sleep, which sets what "recently" means for it. */
    pollIntervalMs?: number;
    /** Injected so a test does not have to wait seven hours. */
    now?: () => number;
  } = {},
): {
  ready: () => void;
  leaving: () => void;
  /** The loop came round. Called once per turn, claiming or not. */
  turned: () => void;
  /** A job was claimed, or the held one settled. */
  holding: (jobId: string | null) => void;
  state: () => Health;
  close: () => Promise<void>;
} {
  const now = options.now ?? Date.now;
  const loopStaleAfterMs = (options.pollIntervalMs ?? 5000) * LOOP_TURNS_WITHIN;

  let ready = false;
  let leaving = false;
  let turnedAt = now();
  let holdingSince: number | null = null;

  /**
   * Two questions, and the order between them is the useful part.
   *
   * A job held past every ceiling is the more specific fact, so it is named
   * first: while a job is held the loop is *supposed* to be inside it and not
   * coming round, and reporting "the loop stopped" there would be true and
   * useless. With no job held, the loop not turning is the whole story.
   */
  const stallOf = (): { stalled: Health["stalled"]; stalledForMs: number } => {
    const at = now();
    if (holdingSince !== null) {
      const held = at - holdingSince;
      return held > JOB_HELD_TOO_LONG_MS ? { stalled: "job", stalledForMs: held } : { stalled: null, stalledForMs: 0 };
    }
    const since = at - turnedAt;
    return since > loopStaleAfterMs ? { stalled: "loop", stalledForMs: since } : { stalled: null, stalledForMs: 0 };
  };

  const read = (): Health => ({ ready, leaving, ...stallOf() });

  const server = http.createServer((req, res) => {
    if (req.url !== "/healthz") {
      res.writeHead(404, { "content-type": "text/plain" }).end("no");
      return;
    }
    const health = read();
    const ok = health.ready && !health.leaving && health.stalled === null;
    res
      .writeHead(ok ? 200 : 503, { "content-type": "application/json" })
      .end(JSON.stringify(health));
  });

  /*
    A port already in use must not take the worker down with it.

    The render loop is the product; this listener is how a deploy is judged.
    Getting that the wrong way round — throwing here and killing a process that
    could have been rendering — would turn a monitoring detail into an outage.
    It is logged and the worker carries on, and the deploy that follows will
    fail its check, which is the correct order of consequences.
  */
  server.on("error", (error) => onError?.(error));
  server.listen(port, "0.0.0.0");
  // Nothing should be kept alive by this. If the loop ends, the process ends.
  server.unref();

  return {
    ready: () => {
      ready = true;
      turnedAt = now();
    },
    leaving: () => {
      leaving = true;
    },
    turned: () => {
      turnedAt = now();
    },
    holding: (jobId) => {
      holdingSince = jobId === null ? null : now();
      turnedAt = now();
    },
    state: read,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}
