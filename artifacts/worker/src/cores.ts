/**
 * How many cores this process actually has, which is not what it is told.
 *
 * ffmpeg with no `-threads` picks its own count, and what it counts is the
 * number of CPUs it can see — on Fly, the *host's*, not the machine's. A
 * `shared-cpu-1x` with `cpus = 1` sits on a host with dozens, so ffmpeg starts
 * dozens of frame threads on a box with one core and one gigabyte.
 *
 * The cost is not speed. Frame-level threading holds a decoded frame per
 * thread in flight, and at 1080p that is about 3 MB each before any filter
 * buffers — so the thread count is a multiplier on peak memory, on the machine
 * whose entire memory budget already has a table written about it in
 * `ffmpeg.ts`. The OOM killer takes the render with no error message, no
 * output and the customer's minute spent. Meanwhile thirty threads contending
 * for one core is slower than one thread having it.
 *
 * So the count is read from the cgroup, which is where the truth is, and
 * passed explicitly.
 */
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";

/**
 * cgroup v2 writes `<quota> <period>` here, or `max <period>` when there is
 * no limit. v1 splits it into two files. Both are read, because Fly has moved
 * between them and an image that guesses wrong guesses silently.
 */
function fromCgroup(): number | null {
  try {
    const v2 = readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim().split(/\s+/);
    if (v2[0] && v2[0] !== "max") {
      const quota = Number(v2[0]);
      const period = Number(v2[1] ?? 100_000);
      if (quota > 0 && period > 0) return quota / period;
    }
  } catch {
    /* not v2, or not in a container */
  }
  try {
    const quota = Number(readFileSync("/sys/fs/cgroup/cpu/cpu.cfs_quota_us", "utf8").trim());
    const period = Number(readFileSync("/sys/fs/cgroup/cpu/cpu.cfs_period_us", "utf8").trim());
    if (quota > 0 && period > 0) return quota / period;
  } catch {
    /* not v1 either */
  }
  return null;
}

/**
 * The number to hand ffmpeg. At least one, never more than the machine has.
 *
 * A fractional allowance — `shared-cpu-1x` is one whole core, but a future
 * `0.5` is expressible — rounds down to one rather than to zero: a render with
 * no threads is not a render.
 */
export function usableCores(): number {
  const limit = fromCgroup();
  if (limit !== null && Number.isFinite(limit)) return Math.max(1, Math.floor(limit));
  /*
    No cgroup to read: a developer's laptop, or CI.

    `availableParallelism` is the right fallback there and the wrong number in
    a container, which is exactly the case the branch above catches. Capped
    anyway, because a build machine with 64 cores would otherwise produce a
    render nobody can reproduce on the machine that will run it.
  */
  return Math.max(1, Math.min(availableParallelism(), MAX_CORES));
}

/**
 * Above this, more threads buy nothing this product renders.
 *
 * x264 at `veryfast` saturates around four threads for a single 1080p stream;
 * past that the encoder is waiting on the filter graph, which is where every
 * measurement in `ffmpeg.ts` says the time goes.
 */
export const MAX_CORES = 4;

/**
 * `-threads` and `-filter_complex_threads`, as ffmpeg wants them.
 *
 * Both, because they are separate pools: `-threads` is the codecs and
 * `-filter_complex_threads` is the graph, and leaving the second unset leaves
 * most of the memory this file exists to bound still unbounded.
 */
export function threadArgs(cores: number = usableCores()): string[] {
  const n = String(Math.max(1, Math.min(cores, MAX_CORES)));
  return ["-threads", n, "-filter_complex_threads", n, "-filter_threads", n];
}
