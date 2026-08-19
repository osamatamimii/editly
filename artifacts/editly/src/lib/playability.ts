/**
 * Is this file playing, still arriving, or genuinely broken?
 *
 * The editor used to answer that with a single timer: fifteen seconds after the
 * URL changed, if the element had not decoded anything yet, print "This file
 * will not play in the browser" — and then never look again. On a live project
 * the element was mid-load with no error at all, the signed URL was serving
 * 206s of `video/mp4`, and the product had already told its owner their footage
 * was unplayable. The verdict could not be taken back, so a slow network was
 * indistinguishable from a dead codec, permanently.
 *
 * A message that cannot retract itself is worse than a slow one. So the verdict
 * is derived from what the element reports, on every tick, and is allowed to
 * change its mind in both directions:
 *
 *   - the element's own `error` is the browser saying it failed. Believe it.
 *   - NETWORK_NO_SOURCE means it tried every source and has none left. Failed,
 *     immediately — no reason to make anyone wait out a timer for that.
 *   - `readyState > 0` means metadata decoded. It plays. This clears a verdict
 *     already on screen, which is the half that was missing.
 *   - anything else is still in progress until the hard ceiling, because
 *     NETWORK_LOADING with no error is a file arriving, not a file refusing.
 */

/** HTMLMediaElement.networkState, named. */
export const NETWORK_EMPTY = 0;
export const NETWORK_IDLE = 1;
export const NETWORK_LOADING = 2;
export const NETWORK_NO_SOURCE = 3;

/**
 * How long a load may make no progress before we call it.
 *
 * A minute is long for a spinner and short for a 300 MB take on hotel wifi, and
 * it is only reached when the browser has reported *nothing* — no error, no
 * metadata, no source exhaustion — for the whole of it. Everything decisive
 * short-circuits well before it, in either direction.
 */
export const PLAYBACK_CEILING_MS = 60_000;

/** How often the verdict is recomputed while it is still pending. */
export const PLAYBACK_POLL_MS = 1_000;

export type PlaybackVerdict = "pending" | "playable" | "failed";

/** The parts of a media element this decision reads. */
export interface MediaFacts {
  readyState: number;
  networkState: number;
  error: unknown;
}

/**
 * How long a *preview* waits before giving up.
 *
 * Much shorter than the ceiling above, and for a different reason: the editor's
 * ceiling covers someone's own footage arriving over their own connection,
 * where waiting is right. A stock preview is a few hundred kilobytes that we
 * already hold — if it has not decoded in this long, it is not going to, and
 * the person is standing there deciding.
 */
export const PREVIEW_CEILING_MS = 8_000;

export function playbackVerdict(
  el: MediaFacts | null | undefined,
  elapsedMs: number,
  ceilingMs: number = PLAYBACK_CEILING_MS,
): PlaybackVerdict {
  // No element yet is not a failing element. The React ref is null for the
  // first paint of every project that has a video, and treating that as
  // anything but "wait" would fail every clip on a fast machine.
  if (!el) return "pending";

  // Checked before readyState: a decode error part-way through a file leaves
  // metadata behind it, so an element can be both errored and ready-ish. What
  // the person sees in that case is a stuck picture, which is a failure.
  if (el.error) return "failed";

  // Metadata decoded — there is a picture. This is what retracts a verdict that
  // a slow first minute put on screen.
  if (el.readyState > 0) return "playable";

  if (el.networkState === NETWORK_NO_SOURCE) return "failed";

  if (elapsedMs >= ceilingMs) return "failed";

  return "pending";
}
