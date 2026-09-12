/**
 * Where a scroll position lands inside a pinned section.
 *
 * The section this serves is tall — one viewport of scroll per feature — and
 * its contents are held still with `position: sticky` while that height passes.
 * The effect is that scrolling keeps handing you the next feature without ever
 * taking the scroll away from you: no wheel listener, no `scrollTo`, nothing
 * that fights the trackpad. The page scrolls exactly as fast as the person
 * scrolls it. What changes is only which of five panels is on screen.
 *
 * That distinction is the whole reason this is a module rather than four lines
 * inside a component. "Scroll-jacking" and "a sticky section" look identical in
 * a recording and are opposite things to use: one overrides the input, the
 * other just makes the page taller. The arithmetic that maps one to the other
 * is small, exact, and easy to get subtly wrong at the edges — so it lives here
 * where a suite can drive it through a whole page of scroll positions without a
 * browser.
 */

/** What the browser hands back, narrowed to the two numbers this needs. */
export interface PinnedRect {
  /** `getBoundingClientRect().top` of the tall section. */
  top: number;
  /** Its full height, including the extra viewports that drive the pin. */
  height: number;
  /** The visible height the contents are pinned into. */
  viewport: number;
}

/**
 * How far through the pin the page is, from 0 to 1.
 *
 * Zero while the section is still below the fold *and* at the exact moment its
 * top reaches the top of the screen; one when its last viewport has been
 * scrolled past. The travel is `height - viewport` because the final viewport
 * of the section is the one still on screen when the pin ends — counting it
 * would mean the last feature was never reached, which is the bug this shape
 * exists to avoid.
 */
export function pinProgress({ top, height, viewport }: PinnedRect): number {
  const travel = height - viewport;
  if (!Number.isFinite(travel) || travel <= 0) return 0;
  return clamp01(-top / travel);
}

/**
 * Which feature that progress is showing.
 *
 * Each feature owns an equal slice. `1` lands exactly on the boundary of the
 * last slice, so it is clamped rather than allowed to index past the end — the
 * one input that reliably produces `undefined` at the bottom of a page.
 */
export function activeFromProgress(progress: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, Math.floor(clamp01(progress) * count)));
}

/** The two together, which is what the component actually asks. */
export function activeFromRect(rect: PinnedRect, count: number): number {
  return activeFromProgress(pinProgress(rect), count);
}

/**
 * Where the page has to be for a feature to be the one showing.
 *
 * The mirror of the arithmetic above, and it exists so the names in the list
 * can be *pressed*. The reference this was built from leaves them inert: the
 * only way to see the fourth thing a product does is to scroll through the
 * first three, which is fine for a demo and rude to somebody who came looking
 * for one specific answer.
 *
 * Aimed at the middle of the slice rather than its start, so a click does not
 * land a pixel from the boundary where the next scroll event flips it to the
 * neighbour.
 */
export function scrollTopForIndex(
  index: number,
  count: number,
  { sectionTop, height, viewport }: { sectionTop: number; height: number; viewport: number },
): number {
  const travel = Math.max(0, height - viewport);
  if (count <= 0) return sectionTop;
  const middle = (Math.min(count - 1, Math.max(0, index)) + 0.5) / count;
  return sectionTop + travel * middle;
}

/**
 * Into 0..1, with the one input that has no answer sent to 0.
 *
 * `NaN` is a measurement that did not happen - a rectangle read before layout,
 * a height divided by a zero viewport - and there is no defensible place on the
 * range to put it, so it goes to the start, where the effect is that the
 * section shows its first feature.
 *
 * An infinity is not that. It arrives with a *direction*: `-Infinity` for a
 * section scrolled past on a page that never ends, `Infinity` for one still
 * below. Folding both into 0 was the earlier spelling and it was wrong in the
 * quiet way this file exists to avoid - a section far above the fold reporting
 * that it had not started, which reads as the first feature waiting patiently
 * on a screen nobody is looking at. `Math.min`/`Math.max` already answer it
 * correctly; the guard just has to stop taking the question away from them.
 */
function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
