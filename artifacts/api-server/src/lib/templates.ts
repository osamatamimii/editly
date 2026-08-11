/**
 * Named looks.
 *
 * A template is nothing more exotic than a saved edit plan. That is the whole
 * reason to have made the plan declarative: "make it like a Hormozi clip" is
 * not a prompt to be interpreted, it is a set of operations somebody already
 * chose, and the result is identical every time.
 *
 * Each of these was tuned against real footage rather than guessed. The numbers
 * are the interesting part — they are what separates motion that reads as
 * deliberate from motion that reads as a bug.
 */
import type { EditOperation, Platform } from "@workspace/api-zod";

export interface Template {
  id: string;
  name: string;
  /** One line, shown on the button. Says what it does, not how it feels. */
  description: string;
  /** Best suited to this kind of footage. */
  bestFor: string;
  build: (context: TemplateContext) => EditOperation[];
}

export interface TemplateContext {
  platform: Platform;
  /**
   * Seconds, or null when nobody has measured the file yet.
   *
   * Null is not a missing value to be defaulted. It used to be filled in with
   * 30, which meant a template placed its punches as though every video were
   * half a minute long — on a ten-minute talk, four zooms in the first twenty
   * seconds and nothing after. An empty `at` is the better answer: it tells the
   * worker to choose the moments from the speech itself, which is what it would
   * rather do anyway.
   */
  durationSeconds: number | null;
  /** Free plans carry the mark. */
  watermark: boolean;
}

function withWatermark(operations: EditOperation[], context: TemplateContext): EditOperation[] {
  if (!context.watermark) return operations;
  return [...operations, { type: "watermark", text: "Edited with Editly", position: "bottom-right" }];
}

/**
 * Punches placed at even intervals through the clip, skipping the first and
 * last couple of seconds — a zoom on the opening frame fights the hook, and one
 * on the final frame lands after anyone has stopped watching.
 */
export function evenlySpacedPunches(durationSeconds: number | null, count: number): number[] {
  // "We do not know how long this is" and "this is 30 seconds" are different
  // claims, and only one of them is ever true. Handing back an empty list makes
  // the worker pick the emphasis from the transcript instead of from a guess.
  if (durationSeconds == null || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return [];
  const start = 2;
  const end = Math.max(start + 1, durationSeconds - 2);
  if (end <= start) return [];
  const step = (end - start) / (count + 1);
  return Array.from({ length: count }, (_, i) => Number((start + step * (i + 1)).toFixed(2)));
}

export const TEMPLATES: Template[] = [
  {
    id: "tight-talking-head",
    name: "Tight talking head",
    description: "Cuts every pause, pushes in slowly, levels the audio.",
    bestFor: "One person to camera",
    build: (context) =>
      withWatermark(
        [
          { type: "removeSilence", thresholdDb: -32, minSilenceMs: 400, paddingMs: 70 },
          { type: "formatForPlatform", platform: context.platform },
          // A locked-off camera plus a slow push is the entire look. 1.08 over
          // the clip is roughly a percent every few seconds — felt, not seen.
          { type: "kenBurns", to: 1.08 },
          { type: "normalizeLoudness", targetLufs: -14 },
        ],
        context,
      ),
  },
  {
    id: "high-energy",
    name: "High energy",
    description: "Aggressive silence cuts and punch-in zooms throughout.",
    bestFor: "Rants, reactions, anything fast",
    build: (context) =>
      withWatermark(
        [
          // 250ms is short enough to remove the breath between sentences, which
          // is what makes this style feel relentless.
          { type: "removeSilence", thresholdDb: -30, minSilenceMs: 250, paddingMs: 40 },
          { type: "formatForPlatform", platform: context.platform },
          {
            type: "zoomPunch",
            at: evenlySpacedPunches(context.durationSeconds, 4),
            amount: 0.14,
            holdMs: 900,
          },
          { type: "normalizeLoudness", targetLufs: -13 },
        ],
        context,
      ),
  },
  {
    id: "clean-cut",
    name: "Clean cut",
    description: "Silence removed and reframed. Nothing else touched.",
    bestFor: "Footage that already looks how you want",
    build: (context) =>
      withWatermark(
        [
          { type: "removeSilence", thresholdDb: -34, minSilenceMs: 700, paddingMs: 120 },
          { type: "formatForPlatform", platform: context.platform },
          { type: "normalizeLoudness", targetLufs: -14 },
        ],
        context,
      ),
  },
  {
    id: "podcast-clip",
    name: "Podcast clip",
    description: "Keeps the natural rhythm, adds a gentle push and even levels.",
    bestFor: "Two people talking, longer takes",
    build: (context) =>
      withWatermark(
        [
          // A long threshold on purpose: cutting every pause out of a
          // conversation makes it sound like an argument.
          { type: "removeSilence", thresholdDb: -36, minSilenceMs: 900, paddingMs: 150 },
          { type: "formatForPlatform", platform: context.platform },
          { type: "kenBurns", to: 1.05 },
          { type: "normalizeLoudness", targetLufs: -14 },
        ],
        context,
      ),
  },
];

export function findTemplate(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
