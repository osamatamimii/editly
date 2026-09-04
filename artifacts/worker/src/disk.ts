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
}

/**
 * Whether this machine has room to render a source of this size.
 *
 * Never throws. A filesystem that will not answer `statfs` is not a reason to
 * refuse a render — it is a reason to carry on as before, which is what every
 * deploy of this worker did until this file existed.
 */
export async function roomFor(sourceBytes: number, dir: string = tmpdir()): Promise<DiskRoom> {
  const neededBytes = Math.round(sourceBytes * WORK_TO_SOURCE) + DISK_RESERVE_BYTES;
  try {
    const fs = await statfs(dir);
    const freeBytes = Number(fs.bavail) * Number(fs.bsize);
    return { enough: freeBytes >= neededBytes, freeBytes, neededBytes };
  } catch {
    return { enough: true, freeBytes: Number.POSITIVE_INFINITY, neededBytes };
  }
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
