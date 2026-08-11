/**
 * The last look at a plan before ffmpeg runs it.
 *
 * Everything upstream of here decides what the edit *should* be without being
 * able to see what it will become. The API writes a plan having never opened
 * the file. `enrich` fills in the words and the emphasis, but it reads the
 * original — the file as recorded. And then the renderer cuts the silence out,
 * which changes the length of the video and moves every moment in it.
 *
 * That gap is where the bugs live, and they are all the same bug: a number
 * measured against one timeline being applied to another. Nobody notices,
 * because ffmpeg does exactly what it was told and the output plays fine. It is
 * just wrong — a punch on the wrong word, a caption for a sentence that has
 * been cut, a zoom that magnifies past the pixels we reserved for it.
 *
 * So this module owns the conversion, all of it, in one place. It is the reason
 * the renderer no longer shifts caption times itself: two places knowing about
 * source-versus-edited time is precisely how punches came to be forgotten.
 *
 * It repairs rather than refuses. A render that arrives slightly worse is worth
 * more to someone than a render that did not arrive, so every finding here
 * moves or trims or scales something down and writes a line saying so. The one
 * thing it will not do is leave a decision in place that it knows is wrong.
 */
import type { EditOperation } from "@workspace/api-zod";
import { remapTime, MOTION_OVERSCAN, type Segment } from "./timeline";

export interface CriticInput {
  operations: EditOperation[];
  /** The kept stretches after silence removal, or null if nothing was cut. */
  kept: Segment[] | null;
  /** Length of the video the viewer will actually receive, in seconds. */
  effectiveDuration: number;
}

export interface CriticResult {
  operations: EditOperation[];
  /** What was changed and why, in the language the render notes are written in. */
  notes: string[];
}

/**
 * A punch closer than this to a splice reads as a glitch in the cut rather than
 * emphasis on a word — the frame jumps and zooms in the same instant, and the
 * eye attributes both to the edit going wrong.
 */
const SPLICE_GUARD_SECONDS = 0.15;

/** Two punches nearer than this are one punch with a stutter in it. */
const MIN_PUNCH_GAP_SECONDS = 0.9;

/**
 * How far past native resolution a punch may take the frame.
 *
 * Reframing crops to `MOTION_OVERSCAN` of the target and the base zoom scales
 * it back, so a zoom of exactly the overscan is native pixels. Beyond that we
 * are upscaling, and past about a quarter it is visible as softness on a face —
 * which is the one thing a punch-in is supposed to be showing you.
 */
const MAX_UPSCALE = 1.25;

export function criticise(input: CriticInput): CriticResult {
  const notes: string[] = [];
  const { kept, effectiveDuration } = input;

  /** Source seconds to edited seconds. Identity when nothing was cut. */
  const toEdited = (seconds: number): number => (kept ? remapTime(seconds, kept) : seconds);

  /**
   * Did this moment survive the cut?
   *
   * `remapTime` collapses anything inside a removed stretch onto the cut point,
   * which is right for a caption — the words either side of it are still there.
   * For a punch it is wrong: the word that was going to be emphasised is gone,
   * and what remains is a zoom on whatever happened to follow.
   */
  const survived = (seconds: number): boolean => {
    if (!kept) return true;
    return kept.some((segment) => seconds >= segment.start && seconds <= segment.end);
  };

  const operations: EditOperation[] = [];

  // Read the motion operations up front: the zoom ceiling is a property of the
  // pair, not of either one alone.
  const kenBurns = input.operations.find((op) => op.type === "kenBurns");
  const punch = input.operations.find((op) => op.type === "zoomPunch");
  const zoom = capZoom(
    kenBurns?.type === "kenBurns" ? kenBurns.to : null,
    punch?.type === "zoomPunch" ? punch.amount : null,
  );
  if (zoom.note) notes.push(zoom.note);

  for (const operation of input.operations) {
    if (operation.type === "zoomPunch") {
      const holdSeconds = operation.holdMs / 1000;
      const original = operation.at.length;

      const lost = operation.at.filter((at) => !survived(at)).length;

      let at = operation.at
        .filter(survived)
        .map(toEdited)
        // A punch needs room to open and close. One that starts with less than
        // its own hold left plays as a zoom that never comes back.
        .filter((seconds) => seconds >= 0 && seconds + holdSeconds <= effectiveDuration)
        .sort((a, b) => a - b);

      // Cutting silence pulls moments together: two emphases a second apart in
      // the recording can end up touching once the pause between them is gone.
      const spaced: number[] = [];
      for (const seconds of at) {
        if (spaced.length === 0 || seconds - spaced[spaced.length - 1] >= MIN_PUNCH_GAP_SECONDS) {
          spaced.push(seconds);
        }
      }
      const crowded = at.length - spaced.length;
      at = spaced.map((seconds) => nudgeOffSplice(seconds, kept, effectiveDuration));

      if (lost > 0) {
        notes.push(`${lost} punch${lost === 1 ? "" : "es"} fell in silence that was cut, so ${lost === 1 ? "it was" : "they were"} dropped`);
      }
      const trimmed = original - lost - at.length - crowded;
      if (trimmed > 0) {
        notes.push(`${trimmed} punch${trimmed === 1 ? "" : "es"} landed past the end of the edit and ${trimmed === 1 ? "was" : "were"} dropped`);
      }
      if (crowded > 0) {
        notes.push(`${crowded} punch${crowded === 1 ? "" : "es"} bunched up once the pauses were cut, so the ${crowded === 1 ? "extra one was" : "extras were"} dropped`);
      }

      if (at.length === 0) {
        notes.push("no punch survived the cut, so the clip is left without them rather than with arbitrary ones");
        continue;
      }

      operations.push({ ...operation, at, amount: zoom.punchAmount ?? operation.amount });
      continue;
    }

    if (operation.type === "kenBurns" && zoom.kenBurnsTo != null) {
      operations.push({ ...operation, to: zoom.kenBurnsTo });
      continue;
    }

    if (operation.type === "burnCaptions") {
      const cues = operation.cues
        .map((cue) => ({
          ...cue,
          startMs: toEdited(cue.startMs / 1000) * 1000,
          endMs: toEdited(cue.endMs / 1000) * 1000,
          words: cue.words?.map((word) => ({
            ...word,
            startMs: toEdited(word.startMs / 1000) * 1000,
            endMs: toEdited(word.endMs / 1000) * 1000,
          })),
        }))
        // A cue whose words were entirely inside a removed stretch collapses to
        // zero length. Burning it would flash a caption for a sentence nobody
        // can hear, on the frame where the cut happened.
        .filter((cue) => cue.endMs - cue.startMs >= 1)
        .filter((cue) => cue.startMs / 1000 < effectiveDuration)
        .map((cue) => ({ ...cue, endMs: Math.min(cue.endMs, effectiveDuration * 1000) }));

      const dropped = operation.cues.length - cues.length;
      if (dropped > 0) {
        notes.push(`${dropped} caption${dropped === 1 ? "" : "s"} covered speech that was cut, so ${dropped === 1 ? "it was" : "they were"} removed`);
      }

      if (cues.length === 0) {
        notes.push("every caption belonged to speech that was cut, so none were burned");
        continue;
      }

      operations.push({ ...operation, cues });
      continue;
    }

    operations.push(operation);
  }

  return { operations, notes };
}

/**
 * Keep the compound zoom inside the pixels reframing reserved.
 *
 * The two motion operations do not know about each other: a slow push to 150%
 * and a 60% punch are each defensible alone and together magnify the frame to
 * well over twice native, which is a soft, crawling mess exactly when the
 * viewer is being asked to look closely. The push is reduced first because it
 * is ambient — losing some of it is barely perceptible, where a punch that has
 * been flattened has stopped doing its job.
 */
function capZoom(
  kenBurnsTo: number | null,
  punchAmount: number | null,
): { kenBurnsTo: number | null; punchAmount: number | null; note?: string } {
  if (kenBurnsTo == null && punchAmount == null) return { kenBurnsTo: null, punchAmount: null };

  const base = MOTION_OVERSCAN;
  const ceiling = base * MAX_UPSCALE;

  const peak = (to: number | null, amount: number | null): number =>
    base + (to != null ? (to - 1) * base : 0) + (amount != null ? amount * base : 0);

  if (peak(kenBurnsTo, punchAmount) <= ceiling) {
    return { kenBurnsTo: null, punchAmount: null };
  }

  // Give the push back first, down to a floor where it is still a push.
  let to = kenBurnsTo;
  if (to != null) {
    const room = ceiling - base - (punchAmount != null ? punchAmount * base : 0);
    to = Math.max(1.02, Math.min(to, 1 + room / base));
  }

  let amount = punchAmount;
  if (amount != null && peak(to, amount) > ceiling) {
    const room = ceiling - base - (to != null ? (to - 1) * base : 0);
    amount = Math.max(0.02, room / base);
  }

  return {
    kenBurnsTo: to != null && to !== kenBurnsTo ? round(to) : null,
    punchAmount: amount != null && amount !== punchAmount ? round(amount) : null,
    note: "the push and the punches together would have magnified past the frame we kept, so both were eased back",
  };
}

/**
 * Move a punch clear of the nearest splice.
 *
 * Only forward: a punch is emphasis on something about to be said, and pulling
 * it earlier puts it on the word before.
 */
function nudgeOffSplice(seconds: number, kept: Segment[] | null, limit: number): number {
  if (!kept || kept.length < 2) return seconds;

  let elapsed = 0;
  for (const segment of kept) {
    elapsed += segment.end - segment.start;
    if (elapsed >= limit) break;
    if (Math.abs(seconds - elapsed) < SPLICE_GUARD_SECONDS) {
      return Math.min(elapsed + SPLICE_GUARD_SECONDS, limit);
    }
  }
  return seconds;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
