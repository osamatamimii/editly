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
}

/**
 * Starts the listener and hands back the two setters and a way to stop.
 *
 * The state lives in this closure rather than in a module-level variable so a
 * test can run two of these without them sharing an answer.
 */
export function serveHealth(
  port = HEALTH_PORT,
  onError?: (error: unknown) => void,
): {
  ready: () => void;
  leaving: () => void;
  state: () => Health;
  close: () => Promise<void>;
} {
  const health: Health = { ready: false, leaving: false };

  const server = http.createServer((req, res) => {
    if (req.url !== "/healthz") {
      res.writeHead(404, { "content-type": "text/plain" }).end("no");
      return;
    }
    const ok = health.ready && !health.leaving;
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
      health.ready = true;
    },
    leaving: () => {
      health.leaving = true;
    },
    state: () => ({ ...health }),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}
