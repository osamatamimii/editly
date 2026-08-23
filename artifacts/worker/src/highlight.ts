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
): HighlightChoice {
  // A clip no longer than the ask IS the highlight. Cutting it would remove
  // something the person did not ask to lose.
  if (duration <= targetSeconds + 0.05) {
    return { window: { start: 0, end: duration }, how: "whole" };
  }

  const spoken = (words ?? []).filter((w) => w.end > w.start);
  if (spoken.length === 0) {
    const start = (duration - targetSeconds) / 2;
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
  const starts = new Set<number>([0]);
  for (const word of spoken) {
    if (word.start + targetSeconds <= duration) starts.add(word.start);
  }
  // The tail window too, or a clip whose best material is at the end could
  // never be chosen in full.
  starts.add(Math.max(0, duration - targetSeconds));

  for (const start of starts) {
    const candidate = { start, end: Math.min(duration, start + targetSeconds) };
    const value = score(candidate);
    // Ties break toward the earlier window: with nothing to separate them,
    // the one that keeps more of the setup reads less like a jump cut.
    if (value > bestScore + 1e-9) {
      bestScore = value;
      best = candidate;
    }
  }

  return { window: best ?? { start: 0, end: targetSeconds }, how: "speech" };
}
