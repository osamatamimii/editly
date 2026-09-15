/**
 * A correction is a change to the edit you have, not a new edit from nothing.
 *
 * Asked what should happen around a render, Osama described three steps: Noah
 * says what he is about to do, the edit runs, and then «المستخدم بيصير يطلب منه
 * عدة تعديلات». The first two were built. The third was not, and what stood in
 * for it lost the person's work every time.
 *
 * Every message is planned on its own. The model is sent the sentence and
 * nothing else — no history, no previous plan — so:
 *
 *     «اقصص السكتات وضيف ترجمة وخلّيه عريض ليوتيوب»
 *         → removeSilence, autoCaptions, formatForPlatform(youtube)
 *
 *     «خلي الترجمة أكبر»
 *         → autoCaptions(big), formatForPlatform(**reels**)
 *
 * The second render is vertical. Nobody asked for that: the sentence said
 * nothing about shape, so `direct` filled it in from the project's default —
 * which is set when the project is created and never follows what anybody
 * says. A person who asked for a wide YouTube cut and then asked for bigger
 * captions got a vertical video, and the only warning was a line in Noah's
 * reply that they had no reason to re-read.
 *
 * ## The rule
 *
 * The edit this project already has is the starting point. The new sentence
 * wins wherever it has an opinion, and everything it is silent about is kept.
 *
 * "Silent about" is the careful part, and `SpokenSubjects` is what makes it
 * possible to get right: **"drop the captions" produces no caption operation
 * and is emphatically not silence about captions.** Carrying the old one
 * forward there would re-add the thing they just removed, which is the worst
 * failure available to this file — worse than losing the edit, because the
 * person said the words and watched them be ignored.
 */
import type { EditOperation, EditPlan } from "@workspace/api-zod";
import type { SpokenSubjects } from "./plan-from-text";

/**
 * Which operations belong to a subject the sentence can speak about.
 *
 * Only the six `SpokenSubjects` know. Everything else — a grade, a fade, a
 * highlight, a zoom — has no subject flag, and for those "the sentence did not
 * produce one" is the whole test: there is no way to say "no grade" that
 * produces a grade operation.
 */
const SUBJECT_OF: Partial<Record<EditOperation["type"], keyof SpokenSubjects>> = {
  formatForPlatform: "platform",
  autoCaptions: "captions",
  removeSilence: "silence",
  tighten: "silence",
  addMusic: "music",
  alternateFraming: "coverage",
  soundEffects: "sfx",
};

/**
 * The operations that decide the *shape* of what comes back.
 *
 * Carried forward like everything else, with one exception written into
 * `carryForward`: "keep the whole thing" is a sentence about shape that
 * produces no shape operation, and it has no flag in `SpokenSubjects`. Without
 * naming them here, «خليه كامل» after «أعطني أقوى 30 ثانية» would hand back
 * thirty seconds again.
 */
const SHAPE = new Set<EditOperation["type"]>(["extractHighlight", "extractClips", "extractRange", "stillsReel"]);

export interface CarriedForward {
  operations: EditOperation[];
  /** The types taken from the previous edit, for the sentence that says so. */
  kept: EditOperation["type"][];
}

/**
 * The edit this sentence produced, on top of the edit that was already there.
 *
 * @param previous  The plan of the last render on this project, or null.
 * @param spoken    What this sentence produced.
 * @param spoke     Which subjects this sentence decided, either way.
 * @param keepsWhole Whether the sentence asked for the whole recording, which
 *   is the one way to speak about shape without producing an operation.
 */
export function carryForward(
  previous: EditPlan | null | undefined,
  spoken: EditOperation[],
  spoke: SpokenSubjects,
  keepsWhole = false,
): CarriedForward {
  if (!previous || previous.operations.length === 0) return { operations: spoken, kept: [] };

  const produced = new Set(spoken.map((op) => op.type));
  const kept: EditOperation["type"][] = [];
  const carried: EditOperation[] = [];

  for (const op of previous.operations) {
    // The sentence has its own version of this. Theirs wins, always.
    if (produced.has(op.type)) continue;
    // They spoke about it and produced nothing, which is a removal.
    const subject = SUBJECT_OF[op.type];
    if (subject && spoke[subject]) continue;
    // "Keep the whole thing" is a decision about shape with no operation in it.
    if (keepsWhole && SHAPE.has(op.type)) continue;
    carried.push(op);
    kept.push(op.type);
  }

  return { operations: [...spoken, ...carried], kept };
}
