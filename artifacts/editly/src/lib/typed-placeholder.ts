import { useEffect, useState } from "react";

/**
 * The box in the hero, writing its own examples.
 *
 * A placeholder is one sentence, and one sentence teaches one thing. The whole
 * claim of this product is that a sentence is the interface, and the fastest
 * way to make that believable is to show somebody four of them being written
 * in the box they are about to type into. Osama asked for it and he is right:
 * a static example reads as a label, and a written one reads as a demonstration.
 *
 * ## The sentences are not written here
 *
 * They come from `first-run.ts`, and that is the point. Every one of those is
 * a sentence `tools/onboarding-test.mjs` runs through the **real** keyword
 * parser, in both languages, on every build. A placeholder invented for the
 * front page is a promise nobody checks — and the failure it produces is the
 * worst one this product has: the first thing a new person ever asks for comes
 * back refused, in the exact words the home page put in their mouth.
 *
 * ## Why this is cut on graphemes and not on characters
 *
 * Because the sentences are Arabic half the time, and Arabic marks are
 * separate code points that sit on the letter before them. `"اقصص".slice(0, 3)`
 * is fine; a sentence carrying a shadda or a tanween is not — cut between the
 * letter and its mark and the mark is rendered on its own, floating on a
 * dotted circle, for one frame of every cycle of every visit.
 *
 * It is one frame, which is exactly why it would never be caught by looking.
 * `Intl.Segmenter` knows the rule; the fallback below keeps combining marks
 * attached by hand, because the fallback in `caption-layout.ts` splits on code
 * points and says so — there, a word long enough to be cut never occurs, and
 * here every sentence is cut at every position by design.
 */

/**
 * Marks that belong to the letter before them.
 *
 * The Unicode property escape is the real rule and needs no list; the range is
 * the Arabic block's own marks, kept as a second answer for an engine that
 * refuses the property escape rather than as the primary one.
 */
const COMBINING = (() => {
  try {
    return new RegExp("^\\p{M}$", "u");
  } catch {
    return /^[ً-ْٓ-ٰٕۖ-ۭ̀-ͯ]$/;
  }
})();

/** One sentence, cut into the pieces a person would call letters. */
export function graphemes(text: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((s) => s.segment);
  }
  const out: string[] = [];
  for (const point of [...text]) {
    if (out.length > 0 && COMBINING.test(point)) out[out.length - 1] += point;
    else out.push(point);
  }
  return out;
}

/** What the box reads at one moment, and how long that moment lasts. */
export interface TypedStep {
  text: string;
  /** Milliseconds before the next step. */
  next: number;
  /** Where the walk is, handed back so the caller holds no arithmetic. */
  at: { sentence: number; shown: number; erasing: boolean };
}

/*
  Four numbers, and each one is a reading speed rather than a taste.

  Typing is slower than erasing because typing is the part being read and
  erasing is the part being got through. The hold is long enough to read a
  short sentence twice, because somebody arriving mid-cycle needs the whole of
  one to make sense of it.
*/
const TYPE_MS = 55;
const ERASE_MS = 26;
const HOLD_MS = 2100;
const BETWEEN_MS = 420;

/**
 * The next moment, from this one. Pure, so the whole cycle can be walked in a
 * test without a clock, a browser or a frame.
 */
export function nextStep(sentences: string[], at: TypedStep["at"]): TypedStep {
  if (sentences.length === 0) return { text: "", next: HOLD_MS, at };

  const index = ((at.sentence % sentences.length) + sentences.length) % sentences.length;
  const letters = graphemes(sentences[index] ?? "");

  if (!at.erasing) {
    if (at.shown < letters.length) {
      const shown = at.shown + 1;
      return {
        text: letters.slice(0, shown).join(""),
        next: shown === letters.length ? HOLD_MS : TYPE_MS,
        at: { sentence: index, shown, erasing: shown === letters.length },
      };
    }
    // Written out, and the hold already spent: start taking it back.
    return {
      text: letters.join(""),
      next: ERASE_MS,
      at: { sentence: index, shown: letters.length, erasing: true },
    };
  }

  const shown = at.shown - 1;
  if (shown <= 0) {
    return {
      text: "",
      next: BETWEEN_MS,
      at: { sentence: (index + 1) % sentences.length, shown: 0, erasing: false },
    };
  }
  return {
    text: letters.slice(0, shown).join(""),
    next: ERASE_MS,
    at: { sentence: index, shown, erasing: true },
  };
}

export const FIRST_STEP: TypedStep["at"] = { sentence: 0, shown: 0, erasing: false };

/**
 * The same walk, on a clock, for a component.
 *
 * Three things stop it, and each one is a rule rather than a nicety:
 *
 *   - **Somebody typing.** `enabled` goes false the moment the box has text in
 *     it. The placeholder is not drawn then anyway, so this is not about what
 *     is seen — it is about not running a timer for a person who is busy.
 *   - **`prefers-reduced-motion`.** Text that writes itself is motion, and a
 *     person who has asked their machine to stop things moving has asked for
 *     this too. They get the first sentence, whole and still, which is what the
 *     box said before any of this existed.
 *   - **A hidden tab.** Browsers throttle timers in background tabs rather than
 *     stopping them, so a tab left open all afternoon would wake up mid-word
 *     and race through a queue of missed steps.
 */
export function useTypedPlaceholder(sentences: string[], enabled: boolean): string {
  const still = useReducedMotion();
  const [shown, setShown] = useState("");

  /*
    The sentences are rebuilt on every render by their caller — they come out
    of a translation function — so the effect keys on what they *say* rather
    than on the array's identity. Without this the walk restarts on every
    render and the box never gets past its first letter.
  */
  const key = sentences.join(" ");

  useEffect(() => {
    if (!enabled || still || sentences.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let at = FIRST_STEP;
    let stopped = false;

    const tick = () => {
      if (stopped) return;
      if (typeof document !== "undefined" && document.hidden) {
        timer = setTimeout(tick, 400);
        return;
      }
      const step = nextStep(sentences, at);
      at = step.at;
      setShown(step.text);
      timer = setTimeout(tick, step.next);
    };

    timer = setTimeout(tick, BETWEEN_MS);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, still]);

  if (still || !enabled) return sentences[0] ?? "";
  return shown;
}

/** Whether this person has asked their machine to stop things moving. */
function useReducedMotion(): boolean {
  const [still, setStill] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const read = () => setStill(query.matches);
    query.addEventListener("change", read);
    return () => query.removeEventListener("change", read);
  }, []);
  return still;
}
