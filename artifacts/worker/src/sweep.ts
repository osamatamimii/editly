/**
 * Letting cold files go, slowly, and being able to prove what would go first.
 *
 * Nothing in this product has ever aged out of storage. A file is deleted when
 * its project, its clip or its account is deleted, and never otherwise — so
 * every master, every browser-playable preview, every poster frame and every
 * file somebody uploaded once and forgot is still there. That is not only a
 * bill: it invalidates the arithmetic behind a large decision, because the
 * storage analysis that put "move to R2" at the top of the list assumed ageing
 * would exist. Without it the curve is not flat storage plus egress; it is
 * storage accumulating with no ceiling.
 *
 * ## What ages, and what does not
 *
 * The **master stays as long as the project does.** It is the thing the
 * customer paid for, and a product that deletes the file somebody bought is not
 * saving money, it is losing the customer. Nothing in this file can select one:
 * `chooseRemovals` never emits a master's key, and the suite asserts it.
 *
 * The **preview** — the VP9 copy written beside every master so a browser with
 * a broken H.264 decoder can still play it — ages out ninety days after the
 * project was last opened. Losing it costs nothing visible: `preview.ts` finds
 * it by convention rather than by a column, and a master with no preview beside
 * it is exactly the state every render before that feature was in, with the
 * player falling back to the master on its own.
 *
 * A **source that never produced a render** ages out after thirty days. It is
 * the one file here nobody has ever done anything with.
 *
 * **Poster frames are left alone by default**, and that is a deliberate
 * departure from the proposal this was built against, made by measuring: a
 * poster is a few tens of kilobytes and a preview is megabytes, so thumbnails
 * are on the order of one percent of the saving — and they are what the whole
 * dashboard is made of. Sweeping them turns every older project into a grey
 * rectangle to save almost nothing. `RETENTION_THUMBNAIL_DAYS` turns it on for
 * anybody who disagrees, and the arithmetic is here to be argued with.
 *
 * ## The three ways a sweep goes wrong, and what is done about each
 *
 * **It ages from a column nobody fills.** `last_opened_at` is `NULL` on every
 * row that existed before it did, and a sweep that reads `NULL` as "never
 * opened" deletes the entire estate on the first day its window elapses. So
 * nothing here ages from that column alone: the clock starts at
 * `max(last_opened_at, updated_at, the moment migration 0040 was applied)`.
 * Every row that already existed gets a full window beginning at the migration,
 * and a database whose ledger has no row for 0040 gets no sweep at all — the
 * caller refuses rather than guessing a date.
 *
 * **It deletes from the first day it ships.** There is no version of "we will
 * watch it carefully" that survives a wrong prefix. So the mode is `dry` unless
 * something says otherwise: it selects, counts and logs exactly what it would
 * remove, and removes nothing. Turning it to `on` is a deliberate act taken
 * after reading a week of those logs.
 *
 * **It leaves a file nobody knows about.** A row cleared before its file is
 * deleted is a permanent orphan: the key is gone from the database, so nothing
 * will ever ask for that object again and nothing will ever delete it. So the
 * order is fixed — the object first, the column after — and a failed delete
 * leaves the row exactly as it was, which means the next sweep tries again.
 *
 * And every removal goes through `lib/object-store`, never through a URL built
 * by hand. This is the first caller in the product that deletes, which makes it
 * the first real test of whether that seam is a seam.
 */
import { previewPathFor } from "./preview";
import { RETENTION as PUBLISHED } from "@workspace/api-zod/processors";

export type SweepMode = "off" | "dry" | "on";

export interface RetentionConfig {
  mode: SweepMode;
  /** Days after last open before the browser-playable copy goes. */
  previewDays: number;
  /** Days before a source that never produced a render goes. */
  unusedSourceDays: number;
  /** Days before a poster frame goes. Zero means never — see the note above. */
  thumbnailDays: number;
}

export const DEFAULT_RETENTION: RetentionConfig = {
  // Dry by default, everywhere, including in production. See above.
  mode: "dry",
  previewDays: 90,
  unusedSourceDays: 30,
  thumbnailDays: 0,
};

export function retentionFrom(env: NodeJS.ProcessEnv = process.env): RetentionConfig {
  /*
    A window has to be a positive number of days, and zero is not one.

    The rule this function is supposed to have is written two lines below the
    version that did not have it: "a typo in an environment variable must not
    be able to mean 'delete everything today'." The guard was `raw >= 0`, and
    zero is exactly that instruction for these two windows — a project created
    five minutes ago has `coldDays` of 0, and `0 >= 0` selects it.

    Two ways a real deployment reached it, neither of them a typo anybody would
    notice:

      `Number("") === 0`. An environment variable that is present and empty —
      `RETENTION_UNUSED_SOURCE_DAYS=` in an env file, a CI template that emits
      every key whether or not it has a value, `fly secrets set X=""` — is
      finite and non-negative, so it did not fall back. Only an *absent*
      variable fell back.

      And the interface taught it. `thumbnailDays: 0` is documented in this
      same file as meaning **never**, so an operator enabling preview ageing
      while keeping customer sources writes `RETENTION_UNUSED_SOURCE_DAYS=0` by
      analogy and gets the opposite of what the other zero means.

    Zero stays valid for thumbnails, where it is a documented sentinel and
    `chooseRemovals` already guards on it. For the two windows that stand
    between a customer's irreplaceable upload and a delete, it falls back.
  */
  const days = (name: string, fallback: number, zeroMeans: "never" | "nothing"): number => {
    const raw = Number(env[name]);
    if (!Number.isFinite(raw)) return fallback;
    if (raw < 0) return fallback;
    if (raw === 0 && zeroMeans === "nothing") return fallback;
    return raw;
  };
  /*
    And a window may be made longer than what the customer was told, never
    shorter.

    `/privacy` renders `RETENTION.previewDays` and `RETENTION.unusedSourceDays`
    — 90 and 30 — and `privacy-test` binds that page to `DEFAULT_RETENTION` in
    this file. But the *deployed* windows are these environment variables, and
    nothing reconciled the two: `RETENTION_UNUSED_SOURCE_DAYS=7` deletes
    customer sources twenty-three days before the page they agreed to says it
    will, with a green build and no contradiction anywhere.

    The page is a promise about the customer's data, so it is a floor. Setting
    a longer window is a decision about our storage bill and is honoured;
    setting a shorter one is a promise nobody kept, and the promise wins.
  */
  const atLeastPublished = (chosen: number, published: number): number => Math.max(chosen, published);

  const mode = env["RETENTION_SWEEP"];
  return {
    mode: mode === "on" || mode === "off" ? mode : DEFAULT_RETENTION.mode,
    previewDays: atLeastPublished(
      days("RETENTION_PREVIEW_DAYS", DEFAULT_RETENTION.previewDays, "nothing"),
      PUBLISHED.previewDays,
    ),
    unusedSourceDays: atLeastPublished(
      days("RETENTION_UNUSED_SOURCE_DAYS", DEFAULT_RETENTION.unusedSourceDays, "nothing"),
      PUBLISHED.unusedSourceDays,
    ),
    // The one place zero is a real answer, and it is the only window here that
    // cannot destroy anything a person could not remake.
    thumbnailDays: days("RETENTION_THUMBNAIL_DAYS", DEFAULT_RETENTION.thumbnailDays, "never"),
  };
}

/** One project, as much of it as ageing needs to know. */
export interface SweepableProject {
  id: string;
  userId: string;
  /** The master. Read only so its preview's key can be derived; never removed. */
  editedVideoPath: string | null;
  /** What was uploaded. Removable only when nothing was ever made from it. */
  videoPath: string | null;
  thumbnailPath: string | null;
  lastOpenedAt: Date | null;
  updatedAt: Date | null;
  /** How many render jobs this project has ever had, in any state. */
  renders: number;
}

/** One clip, whose preview ages with the project it belongs to. */
export interface SweepableClip {
  id: string;
  projectId: string;
  outputPath: string | null;
  thumbnailPath: string | null;
}

export interface Removal {
  key: string;
  kind: "preview" | "thumbnail" | "source";
  /** The column to clear once the object is gone. Absent for previews, which are found by convention. */
  clear?: { table: "projects" | "clips"; id: string; column: "thumbnail_path" | "video_path" };
  /** Why this key was chosen, for the dry-run log. */
  why: string;
}

export interface ChooseInput {
  projects: SweepableProject[];
  clips: SweepableClip[];
  now: Date;
  /** When migration 0040 was applied. Nothing ages from before it. */
  floor: Date;
  config: RetentionConfig;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When this project's clock started running.
 *
 * The latest of three things, and the third is the one that matters: a row that
 * existed before `last_opened_at` did carries `NULL` there and an `updated_at`
 * that may be a year old, and without the floor its first sweep would take
 * everything on day one.
 */
export function coldSince(project: SweepableProject, floor: Date): number {
  return Math.max(
    project.lastOpenedAt?.getTime() ?? 0,
    project.updatedAt?.getTime() ?? 0,
    floor.getTime(),
  );
}

/**
 * What this sweep would remove. Pure — no store, no database, no clock of its
 * own — so the suite can drive it with a year of dates and no infrastructure.
 */
export function chooseRemovals(input: ChooseInput): Removal[] {
  const { projects, clips, now, floor, config } = input;
  if (config.mode === "off") return [];

  const clipsByProject = new Map<string, SweepableClip[]>();
  for (const clip of clips) {
    const list = clipsByProject.get(clip.projectId) ?? [];
    list.push(clip);
    clipsByProject.set(clip.projectId, list);
  }

  const out: Removal[] = [];
  for (const project of projects) {
    const coldDays = (now.getTime() - coldSince(project, floor)) / DAY_MS;
    // A clock running backwards — a row touched in the future, a machine whose
    // time is wrong — is a reason to do nothing, not a reason to delete.
    if (!Number.isFinite(coldDays) || coldDays < 0) continue;

    const owned = (key: string | null): key is string =>
      typeof key === "string" && key.length > 0 && key.startsWith(`${project.userId}/${project.id}/`);

    if (coldDays >= config.previewDays) {
      // The master itself is untouchable; only the copy beside it goes. This is
      // the one place in the product that derives a key rather than reading one
      // from a column, so it is also the one place where a mistake would delete
      // something with a name nobody wrote down.
      if (owned(project.editedVideoPath)) {
        const preview = previewPathFor(project.editedVideoPath);
        if (preview !== project.editedVideoPath) {
          out.push({
            key: preview,
            kind: "preview",
            why: `${Math.floor(coldDays)} days since this project was opened`,
          });
        }
      }
      for (const clip of clipsByProject.get(project.id) ?? []) {
        if (!owned(clip.outputPath)) continue;
        const preview = previewPathFor(clip.outputPath);
        if (preview !== clip.outputPath) {
          out.push({
            key: preview,
            kind: "preview",
            why: `${Math.floor(coldDays)} days since the project this clip belongs to was opened`,
          });
        }
      }
    }

    if (config.thumbnailDays > 0 && coldDays >= config.thumbnailDays) {
      if (owned(project.thumbnailPath)) {
        out.push({
          key: project.thumbnailPath,
          kind: "thumbnail",
          clear: { table: "projects", id: project.id, column: "thumbnail_path" },
          why: `${Math.floor(coldDays)} days since this project was opened`,
        });
      }
      for (const clip of clipsByProject.get(project.id) ?? []) {
        if (!owned(clip.thumbnailPath)) continue;
        out.push({
          key: clip.thumbnailPath,
          kind: "thumbnail",
          clear: { table: "clips", id: clip.id, column: "thumbnail_path" },
          why: `${Math.floor(coldDays)} days since the project this clip belongs to was opened`,
        });
      }
    }

    /*
      A source nothing was ever made from.

      `renders` counts jobs in *any* state, not finished ones, which is the
      difference between a rule and an accident: a job that is queued behind
      forty others, or one that failed and will be retried, still names this
      file as its input. Counting only finished renders would let the sweep
      delete the input of a render that is about to run.
    */
    if (project.renders === 0 && coldDays >= config.unusedSourceDays && owned(project.videoPath)) {
      out.push({
        key: project.videoPath,
        kind: "source",
        clear: { table: "projects", id: project.id, column: "video_path" },
        why: `uploaded, never rendered, and untouched for ${Math.floor(coldDays)} days`,
      });
    }
  }

  // The same object can be named twice — a clip whose output path equals the
  // project's, a preview derived from both — and asking the store to delete a
  // key twice is a wasted request and a confusing count.
  const seen = new Set<string>();
  return out.filter((removal) => {
    if (seen.has(removal.key)) return false;
    seen.add(removal.key);
    return true;
  });
}

export interface ApplyDeps {
  /** `lib/object-store`'s `remove`. Never a URL built here. */
  remove(keys: string[]): Promise<void>;
  /** Clears the column that named the object, and only after it is gone. */
  clearColumn(table: "projects" | "clips", id: string, column: string): Promise<void>;
  log?: (fields: Record<string, unknown>, message: string) => void;
}

export interface SweepResult {
  mode: SweepMode;
  /** How many objects were chosen. In `dry` this is the whole answer. */
  chosen: number;
  removed: number;
  failed: number;
  byKind: Record<Removal["kind"], number>;
}

/**
 * Carry out — or, in `dry`, decline to carry out — what `chooseRemovals` chose.
 *
 * Never throws. A sweep is housekeeping: it must not be able to take a worker
 * down, and one object that will not delete must not stop the next twenty.
 */
export async function applyRemovals(
  removals: Removal[],
  config: RetentionConfig,
  deps: ApplyDeps,
): Promise<SweepResult> {
  const byKind: Record<Removal["kind"], number> = { preview: 0, thumbnail: 0, source: 0 };
  for (const removal of removals) byKind[removal.kind] += 1;

  const result: SweepResult = {
    mode: config.mode,
    chosen: removals.length,
    removed: 0,
    failed: 0,
    byKind,
  };

  if (config.mode !== "on") {
    // The dry run's whole product is this line. It names keys, because a count
    // alone cannot be reviewed — "1,412 objects" is not something anybody can
    // agree to, and twenty keys are.
    deps.log?.(
      { ...result, sample: removals.slice(0, 20).map((r) => `${r.kind} ${r.key}: ${r.why}`) },
      "retention sweep, dry: nothing was deleted",
    );
    return result;
  }

  for (const removal of removals) {
    try {
      // The object first. Always. A column cleared before its object is deleted
      // leaves a file nothing will ever name again.
      await deps.remove([removal.key]);
      if (removal.clear) {
        await deps.clearColumn(removal.clear.table, removal.clear.id, removal.clear.column);
      }
      result.removed += 1;
    } catch (error) {
      result.failed += 1;
      // Left exactly as it was, so the next sweep tries again. This is why the
      // order above is not a preference.
      deps.log?.({ err: error, key: removal.key, kind: removal.kind }, "could not remove an aged object");
    }
  }

  deps.log?.({ ...result }, "retention sweep");
  return result;
}
