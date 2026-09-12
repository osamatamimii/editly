/**
 * Putting a look picked in the editor's panel onto the plan it rode in with.
 *
 * The same seam as `withCaptionFonts`, for the same reason: a plan reaches
 * the queue through more than one door and the choice belongs to the person,
 * so it is applied once at the point every plan passes through.
 *
 * ## Why it only writes a field the sentence left alone
 *
 * A caption field is absent when nobody said — that is the whole of
 * `DEFAULT_CAPTION_LOOK`, and it is what makes this module three lines of
 * logic instead of an argument.
 *
 * It used to be an argument. The schema defaulted every field, so by the time
 * a plan arrived there was no "unset" left to look at: a sentence that named
 * no style and a sentence that could not have named one both said
 * `bold-white`. This file compared against those default *values* and wrote
 * over anything still holding one, which worked only because no default was
 * reachable by name — no caption word maps to bold-white, none to pop, none
 * to normal — so a default value could be read as "the parser heard nothing".
 * The comment here said out loud that the day a default became nameable, the
 * trick would start overwriting real choices. That day arrived with
 * `creator`, which is both the new default and a look a person can ask for by
 * name.
 *
 * So the test is presence. A field the sentence set is a sentence that spoke
 * («هرموزي», «كلمة كلمة»), and the sentence wins over the panel — the panel
 * was set before the words were typed, and the words are newer.
 *
 * ## Where it runs
 *
 * Beside `withCaptionFonts`, right after the sentence is parsed — so it
 * styles what the person asked for. Operations added later by the direction
 * or by habits keep their own styling, exactly as they keep their own faces;
 * the two preferences ride the same seam and age the same way.
 *
 * ## Not a setting
 *
 * Nothing here is stored. `habits.ts` records the decision that a stated
 * preference is a worse signal than a demonstrated one; this look is one
 * message's worth of pointing at a chip instead of typing its name, and the
 * renders it produces are what the habits arithmetic learns from.
 */
import type { EditPlan, CaptionLookChoice } from "@workspace/api-zod";

export function withCaptionLook(
  plan: EditPlan,
  look: CaptionLookChoice | undefined,
): EditPlan {
  if (!look || (!look.style && !look.animation && !look.pace)) return plan;

  return {
    ...plan,
    operations: plan.operations.map((operation) => {
      if (operation.type !== "autoCaptions" && operation.type !== "burnCaptions") return operation;
      return {
        ...operation,
        ...(look.style && operation.style === undefined ? { style: look.style } : {}),
        ...(look.animation && operation.animation === undefined ? { animation: look.animation } : {}),
        /* Pace is a grouping decision and only `autoCaptions` groups. */
        ...(look.pace && operation.type === "autoCaptions" && operation.pace === undefined
          ? { pace: look.pace }
          : {}),
      };
    }),
  };
}
