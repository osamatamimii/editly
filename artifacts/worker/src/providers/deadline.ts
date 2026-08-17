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
