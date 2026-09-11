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
import { spawn } from "node:child_process";
import { beatsOf } from "./beats";
import { guard, LIMITS } from "./deadline";
import { type MusicMaker } from "./providers/music";

/**
 * How long an audio file is, asked of the file.
 *
 * Its own probe rather than `probeDuration` from the renderer, and the
 * difference is not style: that one reads a *video* source, and a bed has no
 * picture in it. Handed an mp3 it answered zero, which this module read as "no
 * readable audio" and threw every generated bed away — a library that could
 * never fill itself, with nothing failing anywhere.
 *
 * `format=duration` is the container's own answer and is what ffprobe gives
 * for an audio-only file. Zero on any failure, which the caller treats as a
 * file that does not play.
 */
function audioSeconds(file: string): Promise<number> {
  return new Promise((resolve) => {
    const ff = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      file,
    ]);
    /*
      A deadline, like every other child this worker starts.

      ffprobe on a thirty-second mp3 answers in milliseconds, so this will
      never fire in practice — which is exactly why it has to be here. The one
      that wedges is the one nobody expected to, and a child with no deadline
      holds the render loop open with nothing to report it.
    */
    const deadline = guard(ff, { ...LIMITS.analysis, what: "reading the length of a music bed" });
    let out = "";
    ff.stdout.on("data", (chunk: Buffer) => {
      deadline.touch();
      out += chunk.toString();
    });
    ff.on("error", () => {
      deadline.clear();
      resolve(0);
    });
    ff.on("close", () => {
      deadline.clear();
      if (deadline.expired) return resolve(0);
      const seconds = Number.parseFloat(out.trim());
      resolve(Number.isFinite(seconds) && seconds > 0 ? seconds : 0);
    });
  });
}

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

  const made = await maker.make({ mood, file }).catch((error: unknown) => {
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

  /*
    And the length, measured for the same reason.

    We never asked for one: Lyria's duration is a property of the model, not a
    request parameter. So the only number that is true about this file comes
    out of the file. A bed recorded as thirty seconds because thirty is what
    the clip model usually makes is a row that will be wrong the first time it
    is not.
  */
  const seconds = await audioSeconds(file);
  if (!(seconds > 0)) {
    // Nothing decodable came back. It plays nowhere, so it is not written.
    log?.warn({ mood }, "a generated bed had no readable duration, so it was discarded");
    return null;
  }

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
    seconds,
    bpm,
    source: maker.name,
    timesUsed: 1,
  });

  log?.info({ mood, id, bpm, source: maker.name }, "made a music bed and added it to the library");
  return { file, bpm, freshlyMade: true };
}
