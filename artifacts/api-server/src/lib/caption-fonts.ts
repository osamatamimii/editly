/**
 * Putting a person's chosen faces onto whatever plan they got.
 *
 * A plan reaches the queue three ways — a template, a sentence the planner
 * turned into operations, or a plan sent whole — and the font choice belongs to
 * the person rather than to any of those. So it is applied once, here, at the
 * point every plan passes through, instead of being remembered in three places
 * and forgotten in two.
 *
 * It touches only the caption operations, and only the fields it was given: a
 * plan that already names a face keeps it, because a plan sent whole is a
 * caller who has said what they want and this is a preference, not an override.
 */
import type { EditPlan, CaptionFontChoice } from "@workspace/api-zod";
import { isCaptionFace } from "@workspace/api-zod";

/** Only ids this deployment actually ships. Anything else is dropped here so
 *  the worker never has to decide what an unknown name means. */
function known(id: string | undefined): string | undefined {
  return id && isCaptionFace(id) ? id : undefined;
}

export function withCaptionFonts(plan: EditPlan, fonts: CaptionFontChoice | undefined): EditPlan {
  const latin = known(fonts?.latin);
  const arabic = known(fonts?.arabic);
  if (!latin && !arabic) return plan;

  return {
    ...plan,
    operations: plan.operations.map((operation) => {
      if (operation.type !== "autoCaptions" && operation.type !== "burnCaptions") return operation;
      return {
        ...operation,
        ...(latin && !operation.font ? { font: latin } : {}),
        ...(arabic && !operation.fontArabic ? { fontArabic: arabic } : {}),
      };
    }),
  };
}
