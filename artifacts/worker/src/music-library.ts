/**
 * The library of beds we made ourselves, and the rule that keeps it cheap.
 *
 * One question, asked on every render that wants music: *is there already a
 * bed for this mood?* Almost always there is, and the answer costs a row read.
 * When there is not, one is generated, measured, stored and remembered — so
 * the next person to ask for that mood, on any account, gets the same file for
 * nothing.
 *
 * That is the whole economic argument for generating music at all. Priced per
 * generation, a bed on every render is about four cents a video, which is a
 * third of the margin on the cheapest plan in this product. Priced per *mood*,
 * the entire library costs a few dollars once. The table is not a cache in
 * front of a catalogue; it is the catalogue, and it writes itself.
 *
 * Nothing here decides whether a video should have music. That is settled far
 * upstream, in the sentence somebody typed — music is off by default in this
 * product and this module is only ever reached because a plan asked.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db, musicTracksTable } from "@workspace/db";
import type { MusicMood } from "@workspace/api-zod";
import { downloadObject, uploadObject } from "./storage";
import { beatsOf } from "./beats";
import { BED_SECONDS, type MusicMaker } from "./providers/music";

/**
 * Where a bed lives in the bucket.
 *
 * A fixed prefix that belongs to nobody, which is the point: every other
 * object in this bucket is under a user id, and the storage rules are written
 * against that. These are the product's own files, served to everyone, and
 * putting them in any customer's folder would make one person's account the
 * landlord of everybody's music.
 */
export function bedObjectKey(mood: MusicMood, id: string): string {
  return `library/music/${mood}/${id}.mp3`;
}

/**
 * How many variants of one mood are worth having.
 *
 * Not one, because a creator who cuts four videos a week would hear the same
 * thirty seconds under all of them and would be right to notice. Not many,
 * because each one is bought. Four is the number at which the repeat is a
 * fortnight away rather than a day, and the whole library is twenty-four
 * files.
 */
export const VARIANTS_PER_MOOD = 4;

export interface Bed {
  /** Local path to the audio, ready to hand to the renderer. */
  file: string;
  /** Measured, and null when nothing in this file should be cut to. */
  bpm: number | null;
  /** True when this render is what paid to create it. */
  freshlyMade: boolean;
}

/**
 * A bed for this mood: an existing one where possible, a new one where not.
 *
 * Returns null only when there is nothing on the shelf *and* nothing that can
 * make one. That is a normal state — most deployments have no music key — and
 * the caller writes a note rather than failing the render.
 */
export async function bedFor(options: {
  mood: MusicMood;
  workDir: string;
  maker: MusicMaker | null;
  log?: { info: (obj: unknown, msg: string) => void; warn: (obj: unknown, msg: string) => void };
}): Promise<Bed | null> {
  const { mood, workDir, maker, log } = options;

  /*
    The least-used live variant, which is how a new one ever gets heard.

    Ordering by `times_used` rather than at random means the fourth variant
    starts being handed out the moment it exists, instead of waiting for a
    coin flip to stop favouring the three that already have a head start.
  */
  const live = await db
    .select()
    .from(musicTracksTable)
    .where(and(eq(musicTracksTable.mood, mood), isNull(musicTracksTable.retiredAt)))
    .orderBy(asc(musicTracksTable.timesUsed))
    .limit(1);

  const existing = live[0];
  const shelfIsFull = await countFor(mood) >= VARIANTS_PER_MOOD;

  /*
    Use what is there unless the shelf is not full yet and we can afford to
    deepen it.

    The order of these two conditions is the cost control. Once a mood has its
    four variants nothing is ever generated for it again, however many renders
    ask — so the bill for music stops growing while the product keeps growing.
  */
  if (existing && (shelfIsFull || !maker)) {
    const file = path.join(workDir, `bed-${existing.id}.mp3`);
    try {
      await downloadObject(existing.path, file);
    } catch (error) {
      // The row is real and the object is not reachable this minute. Fall
      // through to making one rather than failing: a bed is a bed.
      log?.warn({ err: String(error), mood, id: existing.id }, "a stored bed could not be fetched");
      return maker ? make({ mood, workDir, maker, log }) : null;
    }
    await db
      .update(musicTracksTable)
      .set({ timesUsed: existing.timesUsed + 1 })
      .where(eq(musicTracksTable.id, existing.id));
    return { file, bpm: existing.bpm, freshlyMade: false };
  }

  if (!maker) return null;
  const made = await make({ mood, workDir, maker, log });
  // Nothing came back, but something may be on the shelf already — an outage
  // at the generator must not take the library down with it.
  if (!made && existing) {
    const file = path.join(workDir, `bed-${existing.id}.mp3`);
    try {
      await downloadObject(existing.path, file);
      return { file, bpm: existing.bpm, freshlyMade: false };
    } catch {
      return null;
    }
  }
  return made;
}

async function countFor(mood: MusicMood): Promise<number> {
  const rows = await db
    .select({ id: musicTracksTable.id })
    .from(musicTracksTable)
    .where(and(eq(musicTracksTable.mood, mood), isNull(musicTracksTable.retiredAt)));
  return rows.length;
}

/** Generate one, measure it, store it, remember it. */
async function make(options: {
  mood: MusicMood;
  workDir: string;
  maker: MusicMaker;
  log?: { info: (obj: unknown, msg: string) => void; warn: (obj: unknown, msg: string) => void };
}): Promise<Bed | null> {
  const { mood, workDir, maker, log } = options;
  const id = randomUUID();
  const file = path.join(workDir, `bed-${id}.mp3`);

  const made = await maker.make({ mood, seconds: BED_SECONDS, file }).catch((error: unknown) => {
    log?.warn({ err: String(error), mood }, "the music generator threw");
    return null;
  });
  if (!made) return null;

  /*
    Measured from the file that was written, never from what was asked for.

    The prompt asks for a steady tempo; whether the model obliged is a fact
    about the bytes. `beatsOf` is the same detector the zoom punches use, with
    the same negative half — it answers null for a pad, a drone or anything
    whose grid it cannot see through. Null here is recorded as null and means
    the punches will not be synced to this bed.
  */
  const grid = await beatsOf(file).catch(() => null);
  const bpm = grid ? Math.round(grid.bpm * 10) / 10 : null;

  const key = bedObjectKey(mood, id);
  try {
    await uploadObject(key, file, "audio/mpeg");
  } catch (error) {
    // It plays for this render and is not remembered, so the next render pays
    // again. Worse than storing it; much better than refusing the music.
    log?.warn({ err: String(error), mood }, "a new bed could not be stored, so it will not be reused");
    return { file, bpm, freshlyMade: true };
  }

  await db.insert(musicTracksTable).values({
    id,
    mood,
    path: key,
    seconds: made.seconds,
    bpm,
    source: maker.name,
    timesUsed: 1,
  });

  log?.info({ mood, id, bpm, source: maker.name }, "made a music bed and added it to the library");
  return { file, bpm, freshlyMade: true };
}
