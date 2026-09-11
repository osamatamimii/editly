/**
 * Putting a look picked in the editor's panel onto the plan it rode in with.
 *
 * The same seam as `withCaptionFonts`, for the same reason: a plan reaches
 * the queue through more than one door and the choice belongs to the person,
 * so it is applied once at the point every plan passes through.
 *
 * ## Why it only writes over a field still at its default
 *
 * The zod schemas default every caption field, so by the time a plan is here
 * there is no "unset" left to look at — a sentence that named no style and a
 * sentence that could not have named one both arrive as `bold-white`/`pop`/
 * `normal`. What there *is*: none of those defaults is reachable by name.
 * `CAPTION_STYLE_WORDS` has no entry for bold-white, no animation word maps
 * to pop, no pace word maps to normal — a person cannot ask for a default in
 * words, so a default value is always the parser having heard nothing on that
 * subject, and the picker is allowed to speak. A named value is a sentence
 * that spoke («هرموزي», «كلمة كلمة»), and the sentence wins over the panel:
 * the panel was set before the words were typed, and the words are newer.
 *
 * If a default ever becomes nameable, this trades correctness for it — the
 * check in `direct-test` that encodes this table is where that shows up.
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
        ...(look.style && operation.style === "bold-white" ? { style: look.style } : {}),
        ...(look.animation && operation.animation === "pop" ? { animation: look.animation } : {}),
        /* Pace is a grouping decision and only `autoCaptions` groups. */
        ...(look.pace && operation.type === "autoCaptions" && operation.pace === "normal"
          ? { pace: look.pace }
          : {}),
      };
    }),
  };
}
