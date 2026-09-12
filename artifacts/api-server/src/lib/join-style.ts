import type { TransitionStyle } from "@workspace/api-zod";

/**
 * Which joins the product may reach for on its own, and which it will only do
 * when somebody names one.
 *
 * This is a taste rule and it is written down because taste that is not written
 * down is taste that drifts. The contract offers fifteen styles and every one of
 * them is a thing a person can legitimately ask for; that is not the same
 * question as which of them a machine should choose when nobody said. An
 * automatic wipe is the single most software-made thing a video editor does — it
 * is the look of a 2009 slideshow, and it is what people mean when they say an
 * edit looks like it was made by a computer. A glitch chosen by a machine is
 * worse: it is a decorative fault, and the viewer reads it as a real one.
 *
 * So the set below is small and each entry earns its place by being either
 * invisible or rhythmic, never decorative:
 *
 *   `dissolve`   — the invisible one. It says time passed and nothing else, and
 *                  it is what every documentary and every interview has used for
 *                  sixty years. When in doubt this is the answer.
 *   `whipPan`    — the rhythmic one. A cut under a burst of directional blur is
 *                  the current language of a music-led montage, and a dissolve
 *                  in that position reads as a slideshow.
 *   `flashBlack` — the punctuation. A blink to black is a full stop between two
 *                  sections, which is a thing long-form actually needs and a
 *                  thing no other style says.
 *
 * Everything else — every wipe, every slide, `flash`, `flashGrey`, `zoomBlur`,
 * `glitch` — is reachable by asking for it by name and is never chosen here.
 * That is not a judgement that they are bad. It is a judgement that choosing
 * one *for* somebody is claiming to know a thing about their taste that nothing
 * in the recording could have told us.
 */
export const CHOSEN_UNPROMPTED: readonly TransitionStyle[] = ["dissolve", "whipPan", "flashBlack"];

/** Whether this is one the product is allowed to pick without being asked. */
export function mayChoose(style: TransitionStyle): boolean {
  return CHOSEN_UNPROMPTED.includes(style);
}

/**
 * What the product knows about the video, as far as the join is concerned.
 *
 * Deliberately four facts and not a label. Nothing in a recording announces
 * that it is a podcast; what a recording has is a length, somebody speaking or
 * not, a number of subjects, and a bed about to go under it. Naming the kind
 * would be a guess dressed as a fact, and the rules below would then be written
 * against the guess instead of against the evidence.
 */
export interface Footage {
  /** Whether anybody speaks. */
  hasSpeech: boolean;
  /** The source's length in seconds, or null when it was never measured. */
  seconds: number | null;
  /** How many subjects the reading found the recording moving through. */
  chapters: number | null;
  /** Whether a music bed is going under this edit. */
  musicUnder: boolean;
  /** Whether the delivery is one of the vertical feeds. */
  vertical: boolean;
}

/**
 * Long enough that a dissolve is read as an elision rather than as a smudge.
 *
 * Ten minutes. Under it the material is short form whatever it is about, and
 * short form's joins are quick; past it the viewer has settled into the pace of
 * a conversation, and a join that takes its time is the one that reads as
 * deliberate. The number is a threshold about attention rather than about this
 * product, which is why it is a constant with an argument beside it.
 */
const SETTLED_SECONDS = 600;

/**
 * The join this video wants, and how long it should take.
 *
 * The director gave every video the same quarter-second dissolve. That is the
 * right answer for most of them and it is plainly the wrong one for two: a
 * montage cut to music, where a dissolve is what a slideshow does, and an hour
 * of conversation, where a quarter of a second is over before it has said
 * anything. Nothing failed in either case. They simply came out looking like
 * they had been through a machine that had one idea.
 *
 * Every branch here picks from `CHOSEN_UNPROMPTED`, which is the rule the set
 * exists to enforce: whatever this function learns about a recording, it can
 * never decide on somebody's behalf that their video should have a wipe in it.
 */
export function joinFor(footage: Footage): { style: TransitionStyle; durationMs: number } {
  /*
    Cut to music, or cut to nothing being said.

    A bed under the edit means the rhythm is the track's and the joins belong to
    it; no speech at all means the pictures are carrying the whole thing, which
    is the same edit by another route. A whip is motion, and motion is what a
    cut on a beat wants — but only on the feeds that form belongs to. The same
    material delivered wide is a film, and a whip pan in a film is a mistake.
  */
  if ((footage.musicUnder || !footage.hasSpeech) && footage.vertical) {
    // Short, because the blur is the effect and a long whip is a smear.
    return { style: "whipPan", durationMs: 180 };
  }

  /*
    An hour of somebody talking, moving through subjects.

    Both halves are required. Length alone is a lecture recorded in one sitting
    with nothing to punctuate, and chapters alone is a three-minute explainer
    that changes topic quickly — neither wants a half-second black. Together
    they are the shape of a conversation with parts, and the blink is the only
    thing in the vocabulary that says "that was a section, here is the next".
  */
  if (
    footage.hasSpeech &&
    footage.seconds !== null &&
    footage.seconds >= SETTLED_SECONDS &&
    (footage.chapters ?? 0) >= 3
  ) {
    return { style: "flashBlack", durationMs: 320 };
  }

  /*
    And everything else, which is most things: somebody talking, to a feed.

    A quarter of a second, which is what this has always been and is right — it
    is long enough to be read as a join and short enough that short form's pace
    survives it.
  */
  return { style: "dissolve", durationMs: 250 };
}
