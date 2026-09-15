/**
 * The other resource a render can run out of.
 *
 * Memory has a table, a piece cap and a comment in `fly.toml`. Disk had
 * nothing — and disk is the one this machine is actually short of. A Fly
 * `shared-cpu-1x` boots with a few gigabytes of root filesystem, and a render
 * writes, into `/tmp`, at minimum: the source it downloaded, whatever
 * intermediates the plan asks for (a reframed pass, a music bed, a title
 * layer's PNG sequence), and the finished file — before any of it is uploaded
 * and none of it removed until the job ends.
 *
 * ## What running out looks like
 *
 * Not an error anybody can read. ffmpeg's write fails partway, it exits
 * non-zero with `No space left on device` buried in a stderr tail we cap at
 * 16 KB, and the job is retried — onto the same machine, with the same full
 * disk, twice more, spending the customer's attempts on a condition that has
 * nothing to do with their video. Worse, the leftovers of the failed attempt
 * are what makes the next one fail sooner.
 *
 * ## So: ask first, and clean up after the machine that came before
 *
 * `roomFor` is asked once, before the download, with the source's own size and
 * a multiplier for what a render makes of it. Refusing before spending
 * anything is the whole point: the job goes back to the queue for a machine
 * with room, uncharged, rather than dying at 80%.
 *
 * `sweepStaleWork` runs at boot. A machine that was OOM-killed or SIGKILLed
 * mid-render never reached its `finally`, so its work directory is still
 * there — and on Fly a restarted machine keeps its filesystem. Two of those
 * and there is no room for a third render.
 */
import { readdir, rm, stat, statfs } from "node:fs/promises";
import type { NotePair } from "./say";
import { tmpdir } from "node:os";
import path from "node:path";

/** The prefix `processJob` gives its work directory. */
export const WORK_PREFIX = "editly-render-";

/**
 * How much disk a render needs, as a multiple of the source it starts from.
 *
 * Measured rather than guessed, on the heaviest plan this product offers — a
 * 1080p source, silence removal, a reframe to 9:16, a music bed and a kinetic
 * title layer: source 1.0, reframed intermediate 0.9, bed 0.05, title PNGs
 * 1.4, output 0.8. That is 4.15, and 6 is that with room for a source whose
 * bitrate is higher than the one measured.
 *
 * The clips path is the exception in the other direction: it writes several
 * outputs, but each is seconds long and they add to well under one source.
 */
export const WORK_TO_SOURCE = 6;

/**
 * And how much a job that only listens needs, which is a different number.
 *
 * On 15 September a three-gigabyte upload was refused for room every sixty
 * seconds for twenty-one minutes — and it was a `transcribe` row, sized with
 * the multiplier above. Six times three gigabytes is eighteen and a half with
 * the reserve; the machine had seven and a third free; so the arithmetic said
 * no forever, about a job that would have fitted twice over.
 *
 * Listening writes the source and one audio proxy. Deepgram's is a 16 kHz mono
 * FLAC — about eight kilobytes a second, thirty megabytes an hour, which is
 * three hundredths of a video of the same length. Nothing else touches the
 * disk: `probeSource` and `loudestSample` read the file they were given, and
 * the provider is handed a path.
 *
 * So 1.0 for the source, 0.05 for a proxy from a file far more compressed than
 * the one measured, and the rest is headroom. The reserve on top is the same
 * reserve.
 *
 * Kept as a named constant rather than a literal at the call site because the
 * bug was not the number, it was that there was only one number: a render's
 * multiplier applied to something that is not a render, with nothing anywhere
 * saying the two differ.
 */
export const LISTEN_TO_SOURCE = 1.3;

/**
 * Never fill the disk completely, even when the arithmetic says it fits.
 *
 * The root filesystem is not ours alone: the Node process, its heap dumps on
 * a crash, apt's caches, and the container runtime's own logs all write here.
 * A render that fits with nothing to spare takes the machine down with it
 * rather than failing by itself.
 */
export const DISK_RESERVE_BYTES = 512 * 1024 * 1024;

export interface DiskRoom {
  /** True when the render can be started here. */
  enough: boolean;
  /** What is free right now, in bytes. */
  freeBytes: number;
  /** What this job is expected to need, including the reserve. */
  neededBytes: number;
  /**
   * How big this filesystem is in total, empty or not.
   *
   * The difference between this and `freeBytes` is the difference between
   * "come back later" and "not here, ever", and until it existed the worker
   * could not tell them apart — so it said "come back later" to both, once a
   * minute, for as long as the row existed. `Infinity` when the filesystem
   * would not answer, which keeps "unknown means yes" true of this too.
   */
  totalBytes: number;
}

/**
 * Whether this machine has room to render a source of this size.
 *
 * Never throws. A filesystem that will not answer `statfs` is not a reason to
 * refuse a render — it is a reason to carry on as before, which is what every
 * deploy of this worker did until this file existed.
 */
export async function roomFor(
  sourceBytes: number,
  dir: string = tmpdir(),
  /*
    Which job this is. Defaulted to the render's multiplier because that is
    what every existing caller meant, and named at the one call site that
    means something else — see `LISTEN_TO_SOURCE` for what it cost to have a
    single number here.
  */
  multiplier: number = WORK_TO_SOURCE,
): Promise<DiskRoom> {
  const neededBytes = Math.round(sourceBytes * multiplier) + DISK_RESERVE_BYTES;
  try {
    const fs = await statfs(dir);
    const freeBytes = Number(fs.bavail) * Number(fs.bsize);
    const totalBytes = Number(fs.blocks) * Number(fs.bsize);
    return { enough: freeBytes >= neededBytes, freeBytes, neededBytes, totalBytes };
  } catch {
    return {
      enough: true,
      freeBytes: Number.POSITIVE_INFINITY,
      neededBytes,
      totalBytes: Number.POSITIVE_INFINITY,
    };
  }
}

/**
 * Is this job too big for this machine even with nothing else on it?
 *
 * A shortage that emptying the disk would fix is a wait: another render is
 * holding the space, it will finish, and handing the row back is exactly
 * right. A job that needs more than the whole filesystem is not short of
 * anything — it is asking for something that does not exist here, and no
 * amount of waiting produces it.
 *
 * Those two were one branch until 15 September, and the consequence was a row
 * that lived forever: claimed, refused, handed back, claimed again sixty
 * seconds later, for as long as anybody left it there. It sat at the head of
 * the queue the whole time — the claim orders by age — so nothing behind it
 * ran either. The only trace was a `warn` in a log, and the customer's panel
 * said nothing at all, because the code was right that nothing had happened
 * to their project. Nothing was ever going to.
 *
 * An unreadable filesystem answers `false` here, for the same reason it
 * answers `enough` above: not knowing is not a reason to refuse somebody.
 */
export function beyondThisMachine(room: DiskRoom): boolean {
  if (!Number.isFinite(room.totalBytes)) return false;
  return room.neededBytes > room.totalBytes;
}

/** Gigabytes, one decimal, for a sentence a person reads. */
const gb = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

/**
 * What the log says when there is not room.
 *
 * Written for whoever reads it at three in the morning: both numbers, and the
 * fact that the job was not consumed. The customer is told nothing, because
 * nothing happened to their project — it is still queued.
 */
export function noRoomMessage(room: DiskRoom): string {
  return (
    `not enough disk to render here: ${gb(room.freeBytes)} free, ` +
    `${gb(room.neededBytes)} needed. The job goes back to the queue untouched.`
  );
}

/**
 * What the *customer* reads when the file is bigger than the machine.
 *
 * The other sentence above is for whoever is on call. This one is for the
 * person whose project has been sitting there, and it exists because for
 * twenty-one minutes the honest answer was available and nobody was given it.
 *
 * It names the file's own size rather than gigabytes of scratch space, because
 * that is the number they can do something about, and it does not apologise
 * for a machine they never agreed to care about.
 *
 * Both halves, like every note this worker writes — see say.ts on why the
 * Arabic is a required argument rather than an optional field.
 */
export function tooLargeNote(sourceBytes: number): NotePair {
  return {
    en:
      `This video is ${gb(sourceBytes)}, which is more than we can work on in ` +
      `one piece. Send a shorter cut, or a smaller export of the same thing, ` +
      `and it will go straight through.`,
    ar:
      `هالفيديو ${gb(sourceBytes)}، وهاد أكبر من اللي بنقدر نشتغل عليه دفعة وحدة. ` +
      `ابعت قصّة أقصر، أو نسخة أخفّ من نفس الفيديو، وبيمشي على طول.`,
  };
}

/**
 * And the same for a machine that kept being busy rather than being small.
 *
 * Separate sentence because it is a separate fact: the file would fit, the
 * machine never had room to spare while it was asked. "Try again" is honest
 * here and would be a lie in the one above.
 */
export function noRoomForNowNote(): NotePair {
  return {
    en:
      "There was not room for this while it was waiting, and nothing was " +
      "charged for it. Start it again and it should go through.",
    ar:
      "ما كان في مساحة طول ما هالطلب مستني، وما انحسب عليك شي. " +
      "شغّله مرة تانية ولازم يمشي.",
  };
}

/** A directory old enough that no live render could still be using it. */
const STALE_AFTER_MS = 60 * 60_000;

/**
 * Work directories left by a machine that did not get to clean up.
 *
 * Only at boot, and only those older than an hour, because this process is
 * not the only one that may be running: a rolling deploy overlaps two copies,
 * and deleting the other one's work mid-render is a far worse bug than the
 * one being fixed.
 *
 * Returns the number of bytes reclaimed, for the line in the log.
 */
export async function sweepStaleWork(dir: string = tmpdir(), now: number = Date.now()): Promise<number> {
  let freed = 0;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.startsWith(WORK_PREFIX)) continue;
    const full = path.join(dir, name);
    try {
      const info = await stat(full);
      if (!info.isDirectory()) continue;
      if (now - info.mtimeMs < STALE_AFTER_MS) continue;
      freed += await sizeOf(full);
      await rm(full, { recursive: true, force: true });
    } catch {
      // A directory that vanished between the listing and the stat is one
      // somebody else cleaned up, which is the outcome we wanted anyway.
    }
  }
  return freed;
}

async function sizeOf(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await sizeOf(full);
    else {
      try {
        total += (await stat(full)).size;
      } catch {
        /* gone */
      }
    }
  }
  return total;
}

/**
 * Let a stage's files go the moment the stage is over, rather than at the end
 * of the job.
 *
 * The work directory is removed in `processJob`'s `finally`, so every
 * intermediate a render writes is held until the whole job is done — including
 * through the upload, the preview encode and the probe, none of which read any
 * of them. `WORK_TO_SOURCE`'s own measurement says what that costs: source 1.0,
 * reframed intermediate 0.9, title PNGs 1.4, output 0.8. Once the renderer has
 * returned, 2.3 of those 4.1 are dead weight, and they are held across the
 * slowest remaining minutes of the job.
 *
 * That is not an abstract tidiness. On 15 September a three-gigabyte upload
 * could not be listened to because the arithmetic said the disk was too small,
 * and the disk on this machine is seven gigabytes for everything. Peak usage is
 * what decides whether the next job is refused, and peak usage is set by what
 * is held at once.
 *
 * `keep` is the whole interface, and it is a list of what is still *needed*
 * rather than a list of what to delete: a stage that starts writing a new
 * intermediate should not also have to remember to add it to a removal list
 * somewhere else. Paths may be absolute or relative to `dir`.
 *
 * Never throws, and never touches anything outside `dir`. A cleanup that can
 * fail a render would be worse than the disk it is saving — this is an
 * optimisation, and the `finally` that removes the whole directory is still
 * what guarantees nothing is left behind.
 */
export async function freeAllBut(
  dir: string,
  keep: ReadonlyArray<string>,
): Promise<{ freedBytes: number; removed: string[] }> {
  const spared = new Set(keep.map((p) => path.basename(p)));
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { freedBytes: 0, removed: [] };
  }
  let freedBytes = 0;
  const removed: string[] = [];
  for (const entry of entries) {
    if (spared.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    try {
      freedBytes += entry.isDirectory() ? await sizeOf(full) : (await stat(full)).size;
      await rm(full, { recursive: true, force: true });
      removed.push(entry.name);
    } catch {
      // Gone already, or held open by something. Either way the job is not the
      // place to find out, and `finally` will try again.
    }
  }
  return { freedBytes, removed };
}
