/**
 * The files the planner is allowed to name.
 *
 * The model does not receive a project's files; it receives a *vocabulary*.
 * `buildSchema` in planner.ts turns this list into three enums — videos become
 * the b-roll enum, images the overlay enum, audio the music enum — and the
 * JSON schema is strict, so an id that is not here is an id the model cannot
 * produce. An empty enum is not a missing file. It is a missing **operation**:
 * the model has no way to ask for music at all.
 *
 * That is what makes the cap on this list a correctness question rather than a
 * performance one, and why the obvious implementation was wrong.
 *
 * ## The bug this exists to prevent
 *
 * It used to read the newest forty rows of the project, mixed. Somebody
 * uploads one music track in January and forty clips between then and March,
 * types "put my music under it", and the planner returns a plan with no music
 * in it — because the track was the forty-first row and the model was never
 * shown a track to name. Nothing errors. The reply is confident, the render
 * runs, and the only symptom is a video with no music that the person has to
 * notice for themselves.
 *
 * A flat cap over a mixed table always fails this way: the commonest kind
 * crowds out the rarest, and the rarest is usually the logo or the track — the
 * one file the person uploaded on purpose and is most likely to ask for by
 * name.
 *
 * So the budget is spent per kind, and every kind keeps a floor. The split is
 * uneven deliberately: clips and stills arrive in batches, tracks almost never
 * do, and eight is more music than any one edit has a use for.
 *
 * Ids, kinds and labels only. The planner is never told where a file is.
 */
import { and, desc, eq } from "drizzle-orm";
import { db, assetsTable } from "@workspace/db";
import type { PlannerAsset } from "./planner";

/** How many of each kind may enter the model's vocabulary. Forty in total. */
export const ASSET_BUDGET = {
  video: 16,
  image: 16,
  audio: 8,
} as const;

export type AssetKind = keyof typeof ASSET_BUDGET;

export const ASSET_KINDS: readonly AssetKind[] = Object.keys(ASSET_BUDGET) as AssetKind[];

/** The vocabulary for one project: newest first within each kind. */
export async function plannerAssets(projectId: string): Promise<PlannerAsset[]> {
  const perKind = await Promise.all(
    ASSET_KINDS.map((kind) =>
      db
        .select({ id: assetsTable.id, kind: assetsTable.kind, label: assetsTable.label })
        .from(assetsTable)
        .where(and(eq(assetsTable.projectId, projectId), eq(assetsTable.kind, kind)))
        .orderBy(desc(assetsTable.createdAt))
        .limit(ASSET_BUDGET[kind]),
    ),
  );
  return perKind.flat() as PlannerAsset[];
}
