/**
 * A number that rolls to its new value instead of being replaced by it.
 *
 * The pricing page used to swap the text and put a CSS transition on the
 * element, which does nothing at all: `transition` interpolates properties, and
 * the text content of a node is not one. `$12` became `$115` between two
 * frames, and the yearly toggle — the one interaction on that whole section —
 * had no feedback beyond a number being different afterwards.
 *
 * This is an odometer. Each digit is its own column holding 0-9 stacked
 * vertically inside a one-line window; changing the value slides the column.
 * That is the entire mechanism, and it is worth saying why it is not a
 * cross-fade or a count-up loop:
 *
 *   - A cross-fade tells you the number changed. A roll tells you *which way*,
 *     which on a pricing page is the whole point: yearly is cheaper and the
 *     digits going down says so before you have read them.
 *   - A count-up animates on a timer, which means JavaScript running every
 *     frame for every price on the page. This is one transform per digit,
 *     handed to the compositor, and it costs nothing after it is set.
 *
 * The columns are staggered left to right so it reads as one movement rather
 * than four things happening at once, and the easing overshoots very slightly
 * so each column settles the way a mechanical wheel does.
 *
 * Only digits roll. A currency sign, a decimal point and a separator are not
 * part of the counter and jumping them around would be motion for its own
 * sake.
 */
import { useEffect, useState } from "react";

const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

function Digit({ value, delayMs }: { value: number; delayMs: number }) {
  /**
   * The first render is the *old* position, so there is something to roll from.
   *
   * Mounting straight onto the target means the transition has nowhere to go
   * and the digit simply appears — which is what makes a "why is my animation
   * not running" bug look like a design decision. A digit that mounts for the
   * first time has no previous value and should not roll at all, so it starts
   * where it belongs; only a digit that *changes* animates, and React gives us
   * that for free by keeping the element between renders.
   */
  return (
    <span className="rolling-digit" aria-hidden="true">
      <span
        className="rolling-strip"
        style={{ transform: `translateY(${-value * 10}%)`, transitionDelay: `${delayMs}ms` }}
      >
        {DIGITS.map((d) => (
          <span key={d} className="rolling-cell">
            {d}
          </span>
        ))}
      </span>
    </span>
  );
}

export function RollingNumber({
  value,
  className = "",
  testId,
}: {
  /** Already formatted — "12", "115", "9.99". Everything that is not 0-9 is drawn still. */
  value: string;
  className?: string;
  testId?: string;
}) {
  /**
   * Whether this instance has ever changed.
   *
   * A page that rolls every price from zero the moment it loads is a slot
   * machine, not a price list. The first value is drawn where it belongs and
   * the rolling starts from the first real change — which, here, is somebody
   * pressing the yearly toggle.
   */
  const [settled, setSettled] = useState(false);
  const [previous, setPrevious] = useState(value);
  useEffect(() => {
    if (value !== previous) {
      setPrevious(value);
      setSettled(true);
    }
  }, [value, previous]);

  const characters = [...value];
  let digitIndex = 0;

  return (
    <span className={`rolling-number ${settled ? "rolling-live" : ""} ${className}`} data-testid={testId}>
      {/* The real value, for anything that reads rather than looks. The strip
          above is a column of ten digits and would be read as one. */}
      <span className="sr-only">{value}</span>
      {characters.map((character, i) => {
        if (character >= "0" && character <= "9") {
          const delay = digitIndex * 45;
          digitIndex += 1;
          return <Digit key={`${i}-d`} value={Number(character)} delayMs={delay} />;
        }
        return (
          <span key={`${i}-s`} aria-hidden="true" className="rolling-still">
            {character}
          </span>
        );
      })}
    </span>
  );
}
