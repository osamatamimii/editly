/**
 * "You have nothing" and "we could not read your things" are different
 * sentences, and this product spent two days saying the first when it meant the
 * second.
 *
 * On 12 August every query against the database failed. What the dashboard
 * rendered was `Nothing here yet` over an empty grid — because the only two
 * states any screen here distinguished were loading and loaded, and a failed
 * query is neither: it leaves `data` undefined, which reads as an empty list.
 * The person's projects were all still there. Nothing on the screen suggested
 * anything was wrong, so nothing got reported, so it ran for two days.
 *
 * The migration was the cause; this was the reason nobody noticed. Fixing only
 * the cause would leave the next outage just as quiet.
 *
 * So every screen that can show an empty state goes through here first, and the
 * order is the whole point: failure is checked before emptiness, because an
 * empty answer and no answer look identical once the data is gone.
 */

export type LoadState = "loading" | "failed" | "empty" | "ready";

export interface Loadable<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
}

/**
 * `isEmpty` describes what emptiness means for this particular thing — no
 * projects, no messages — and is omitted when the thing cannot be empty, only
 * present or not.
 *
 * A failed *refetch* while data is already on screen is deliberately not a
 * failure: the numbers are a moment stale, and replacing a working screen with
 * an error because a background poll missed is worse than the staleness. The
 * failure state is for having nothing to show.
 */
export function loadState<T>(query: Loadable<T>, isEmpty?: (data: T) => boolean): LoadState {
  if (query.data !== undefined) {
    return isEmpty?.(query.data) ? "empty" : "ready";
  }
  if (query.isError) return "failed";
  if (query.isLoading) return "loading";

  // No data, not loading, and no error flag. This should not happen — and it is
  // precisely the shape the outage took, so it is named rather than falling
  // through to "empty". Saying "could not load" when the truth is "empty" costs
  // a moment of confusion; the reverse cost two days.
  return "failed";
}

/** Convenience for the common `state === "failed"` read. */
export const isFailed = (state: LoadState): boolean => state === "failed";

/**
 * What the screen says when it could not read something.
 *
 * Deliberately not "Something went wrong": the person needs to know their work
 * is not gone, and that the thing to do is wait a moment rather than start
 * again from scratch.
 */
export const COULD_NOT_LOAD = "We couldn't load this. Your work is safe — this is on our side.";
