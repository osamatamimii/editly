/**
 * Where the best N seconds of a clip live.
 *
 * The person asked for a length, not for timestamps — "give me the strongest
 * 30 seconds" is a sentence about the result, and choosing *which* seconds is
 * the judgement they are paying for. This module makes that judgement from
 * the transcript alone, deterministically: the same words always pick the
 * same window, which is what lets a person re-render and compare.
 *
 * The heuristic is speech density with hesitation held against it. A stretch
 * where someone is actually saying things scores by how much of it is spoken;
 * every "um" in it pays that time back and then the same again as a penalty,
 * because a highlight full of hesitation is the opposite of a highlight. No
 * model is consulted — the transcript already cost one, and density is the
 * signal the quality plan's own research pointed at (the strongest moments of
 * talking-head footage are where the talking is).
 *
 * When there is no transcript at all, the middle of the clip wins by default:
 * openings ramp up and endings trail off, and the middle is the least-wrong
 * guess a machine can make without ears. The caller says which of the two
 * answers it got, in the notes, so nobody mistakes the fallback for the
 * judgement.
 */
import type { Segment, SpokenWord } from "./timeline";

export interface HighlightChoice {
  window: Segment;
  /** How the window was chosen — the note the render writes depends on it. */
  how: "speech" | "centered" | "whole";
}

/**
 * Slide a window of `targetSeconds` across the clip and keep the one whose
 * speech scores highest. Windows start at word starts — an optimum never
 * needs to start mid-pause, because sliding right to the next word start
 * loses nothing and gains whatever enters on the right.
 */
export function chooseHighlight(
  duration: number,
  targetSeconds: number,
  words: SpokenWord[] | undefined,
  /**
   * The stretch of the recording the window has to come out of.
   *
   * Defaults to all of it, which is right for "the best thirty seconds of this
   * video" and wrong for everything else that calls this. A cold open picks
   * its hook out of whatever the edit still holds — and it was picking it out
   * of the whole source, so inside `extractRange 60→90` the hook was chosen
   * from the strongest thirty seconds of the *recording*, found no
   * intersection with the range, and the render said "could not find a moment
   * strong enough to open on" about a stretch it had never looked at. The
   * clips path made that the normal case: a cold open rides into every
   * per-clip plan, and at most one clip of six can contain the source's
   * globally strongest window, so five of them reported failure.
   */
  within?: Segment,
): HighlightChoice {
  const lo = Math.max(0, within?.start ?? 0);
  const hi = Math.min(duration, within?.end ?? duration);
  const span = hi - lo;

  // A stretch no longer than the ask IS the highlight. Cutting it would remove
  // something the person did not ask to lose.
  if (span <= targetSeconds + 0.05) {
    return { window: { start: lo, end: hi }, how: "whole" };
  }

  const spoken = (words ?? []).filter((w) => w.end > w.start && w.end > lo && w.start < hi);
  if (spoken.length === 0) {
    const start = lo + (span - targetSeconds) / 2;
    return { window: { start, end: start + targetSeconds }, how: "centered" };
  }

  const score = (window: Segment): number => {
    let value = 0;
    for (const word of spoken) {
      const overlap = Math.min(word.end, window.end) - Math.max(word.start, window.start);
      if (overlap <= 0) continue;
      // A filler pays back its own time and the same again: "um" is worse
      // than silence in a highlight, because silence at least isn't fumbling.
      value += word.filler ? -overlap : overlap;
    }
    return value;
  };

  let best: Segment | null = null;
  let bestScore = -Infinity;
  const starts = new Set<number>([lo]);
  for (const word of spoken) {
    if (word.start >= lo && word.start + targetSeconds <= hi) starts.add(word.start);
  }
  // The tail window too, or a clip whose best material is at the end could
  // never be chosen in full.
  starts.add(Math.max(lo, hi - targetSeconds));

  for (const start of starts) {
    const candidate = { start, end: Math.min(hi, start + targetSeconds) };
    const value = score(candidate);
    // Ties break toward the earlier window: with nothing to separate them,
    // the one that keeps more of the setup reads less like a jump cut.
    if (value > bestScore + 1e-9) {
      bestScore = value;
      best = candidate;
    }
  }

  return { window: best ?? { start: lo, end: Math.min(hi, lo + targetSeconds) }, how: "speech" };
}

/**
 * Where `count` separate clips of the video live.
 *
 * The same judgement as `chooseHighlight`, made several times over with the
 * windows kept apart: pick the strongest window, remove everything it covers
 * from contention, pick the strongest of what remains. Greedy is right here —
 * the person asked for the best pieces, and the best piece of what is left
 * after taking the best piece is exactly what "second-best clip" means to a
 * human. Deterministic, like everything in this file: ties break earlier.
 *
 * With no transcript the clip is divided evenly, skipping the very ends —
 * openings ramp up and endings trail off — and the caller says it was a
 * division, not a judgement. Returned in source order either way, because
 * "clip 2" should come after "clip 1" in the video, whatever their scores.
 *
 * A short clip yields fewer windows rather than overlapping ones: three
 * thirty-second clips of a fifty-second video is not a thing that exists.
 */
export function chooseClips(
  duration: number,
  count: number,
  targetSeconds: number,
  words: SpokenWord[] | undefined,
): { windows: Segment[]; how: "speech" | "divided" } {
  const fit = Math.max(1, Math.min(count, Math.floor(duration / Math.max(1, targetSeconds))));

  const spoken = (words ?? []).filter((w) => w.end > w.start);
  if (spoken.length === 0) {
    // Divide what can be divided, keeping clear of the first and last few
    // seconds when there is room to.
    const margin = duration > fit * targetSeconds + 4 ? 2 : 0;
    const usable = duration - margin * 2;
    const gap = (usable - fit * targetSeconds) / Math.max(1, fit + 1);
    const windows: Segment[] = [];
    for (let i = 0; i < fit; i += 1) {
      const start = margin + gap * (i + 1) + targetSeconds * i;
      windows.push({ start: round2(start), end: round2(start + targetSeconds) });
    }
    return { windows, how: "divided" };
  }

  const score = (window: Segment, taken: Segment[]): number => {
    // A window that touches an already-chosen clip is out: two clips sharing
    // a sentence would read as the same clip posted twice.
    if (taken.some((t) => window.start < t.end && window.end > t.start)) return -Infinity;
    let value = 0;
    for (const word of spoken) {
      const overlap = Math.min(word.end, window.end) - Math.max(word.start, window.start);
      if (overlap <= 0) continue;
      value += word.filler ? -overlap : overlap;
    }
    return value;
  };

  const starts = new Set<number>([0, Math.max(0, duration - targetSeconds)]);
  for (const word of spoken) {
    if (word.start + targetSeconds <= duration) starts.add(word.start);
  }
  const ordered = [...starts].sort((a, b) => a - b);

  const taken: Segment[] = [];
  for (let i = 0; i < fit; i += 1) {
    let best: Segment | null = null;
    let bestScore = -Infinity;
    for (const start of ordered) {
      const candidate = { start, end: Math.min(duration, start + targetSeconds) };
      const value = score(candidate, taken);
      if (value > bestScore + 1e-9) {
        bestScore = value;
        best = candidate;
      }
    }
    // Nothing left that does not overlap, or nothing with any speech in it:
    // fewer clips, honestly, rather than padding with pieces of nothing.
    if (!best || bestScore <= 0) break;
    taken.push(best);
  }

  if (taken.length === 0) {
    // Speech existed but every window scored zero or less (all filler, say).
    // Fall back to division rather than returning nothing.
    return chooseClips(duration, count, targetSeconds, undefined);
  }

  taken.sort((a, b) => a.start - b.start);
  return { windows: taken, how: "speech" };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
