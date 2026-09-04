/**
 * Every request to somebody else's server gets a deadline.
 *
 * Node's `fetch` has no default timeout. A connection that is accepted and then
 * never answered — which is what an overloaded provider, a dropped route, or a
 * middlebox holding a socket open looks like — waits forever, and the await
 * that is waiting on it is inside `processJob`. So the job stays `running`, the
 * worker never returns to its loop, and therefore never beats, never sweeps,
 * and never claims another job. One silent socket takes a whole render machine
 * out of service, and the only thing that eventually notices is the stale-lock
 * sweeper, which requeues the job and does it all again.
 *
 * The API's planner already got this right (`lib/planner.ts` aborts after its
 * own timeout). This is the same rule for the worker's three providers, applied
 * at the one place all of their traffic goes through, so a new call site cannot
 * forget it.
 *
 * The caller's own signal still wins if it fires first — cancelling a job must
 * stay instant, not wait out the deadline.
 */

/** Long enough for a ten-minute proxy to upload on a bad link; short enough to be a bug report rather than a mystery. */
export const PROVIDER_TIMEOUT_MS = Number(process.env["PROVIDER_TIMEOUT_MS"] ?? 300_000);

/**
 * The publishers, which send a finished master and need much longer.
 *
 * Same rule, different number. A YouTube upload is the whole render streamed to
 * Google, and five minutes is a real upload on a modest link, so the provider
 * ceiling would abort healthy work. Thirty is past anything this product's
 * plans can produce and still a fraction of the time it takes a person to
 * notice a queue has stopped.
 *
 * These six call sites had no deadline at all, which is worse than either
 * number. They are also the ones where it hurts most: the scheduled-post sweep
 * runs on its own timer so a post is never stuck behind a render, and one hung
 * upload holds that timer for as long as this number allows.
 *
 * ## And it has to be under the lateness ceiling
 *
 * `TOO_LATE_MINUTES` is 20: a post more than twenty minutes past its time is
 * marked `missed` and never sent, on the grounds that putting it in front of
 * people at a time nobody chose is worse than not posting it. Thirty minutes
 * here was therefore a number that could refuse work by itself — one upload
 * hanging for its full budget meant everything due in the next half hour came
 * back too late, permanently, with no error anywhere. Fifteen is comfortably
 * past every provider deadline inside it (Meta waits 8 minutes for a container,
 * TikTok 10 for a status) and comfortably under the ceiling, and an override
 * that puts it back over the ceiling is clamped rather than obeyed.
 */
const PUBLISH_TIMEOUT_CEILING_MS = 18 * 60_000;
const requestedPublishTimeoutMs = Number(process.env["PUBLISH_TIMEOUT_MS"] ?? 15 * 60_000);
export const PUBLISH_TIMEOUT_MS =
  Number.isFinite(requestedPublishTimeoutMs) && requestedPublishTimeoutMs > 0
    ? Math.min(requestedPublishTimeoutMs, PUBLISH_TIMEOUT_CEILING_MS)
    : 15 * 60_000;

export function withDeadline(impl: typeof fetch, timeoutMs = PROVIDER_TIMEOUT_MS): typeof fetch {
  return async (input, init) => {
    // A plain timer rather than `AbortSignal.timeout`, which is unref'd: it
    // does not hold the event loop open, so a process with nothing else to do
    // exits before the deadline it was told to enforce. That is exactly the
    // shape of bug this file exists to prevent, so it should not be in it.
    const controller = new AbortController();
    let expiredNaturally = false;
    const timer = setTimeout(() => {
      expiredNaturally = true;
      controller.abort();
    }, timeoutMs);

    const caller = init?.signal ?? undefined;
    const signal = caller ? AbortSignal.any([caller, controller.signal]) : controller.signal;

    const expired = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () =>
        reject(new Error(`no response within ${Math.round(timeoutMs / 1000)}s`)),
      );
    });

    try {
      // Raced rather than left to the signal alone. Passing the signal is what
      // actually tears the socket down, and real `fetch` honours it — but the
      // whole point of this wrapper is that a render machine must not be able
      // to wedge, and "the transport always respects abort" is precisely the
      // assumption that would have to hold for it to wedge. So the deadline is
      // enforced by this function whether or not anything downstream cooperates.
      return await Promise.race([impl(input, { ...init, signal }), expired]);
    } catch (error) {
      // An abort raised by the transport, when the abort was ours, is the
      // deadline — said in a way that names the limit rather than leaving
      // "AbortError" for somebody to interpret.
      if (expiredNaturally) throw new Error(`no response within ${Math.round(timeoutMs / 1000)}s`);
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new Error(`no response within ${Math.round(timeoutMs / 1000)}s`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
}
