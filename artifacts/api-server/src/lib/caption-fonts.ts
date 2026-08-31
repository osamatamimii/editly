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

/**
 * Only ids that name a face this render could actually draw with: one we ship,
 * or one this person uploaded and we measured. Anything else is dropped here
 * so the worker never has to decide what an unknown name means.
 *
 * `mine` is the ids of that person's ready faces, passed in by the caller. Not
 * looked up here, and not trusted from the request: a font id is a capability
 * — hand the renderer somebody else's and it would fetch and draw their file.
 */
function known(id: string | undefined, mine: readonly string[]): string | undefined {
  if (!id) return undefined;
  return isCaptionFace(id) || mine.includes(id) ? id : undefined;
}

export function withCaptionFonts(
  plan: EditPlan,
  fonts: CaptionFontChoice | undefined,
  mine: readonly string[] = [],
): EditPlan {
  const latin = known(fonts?.latin, mine);
  const arabic = known(fonts?.arabic, mine);
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

/**
 * The ids of this person's ready faces.
 *
 * Here rather than in each route, so the two doors a plan comes through cannot
 * end up asking different questions. `ready` only: a font still being measured
 * has no numbers yet, and a plan naming it would render at a guessed size.
 */
export async function myFaceIds(userId: string): Promise<string[]> {
  const { db, captionFacesTable } = await import("@workspace/db");
  const { and, eq } = await import("drizzle-orm");
  const rows = await db
    .select({ id: captionFacesTable.id })
    .from(captionFacesTable)
    .where(and(eq(captionFacesTable.userId, userId), eq(captionFacesTable.status, "ready")));
  return rows.map((row) => row.id);
}
