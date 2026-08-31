/**
 * The look at the file after ffmpeg has made it.
 *
 * `critic.ts` inspects the plan — numbers measured on one timeline about to be
 * applied to another. This module inspects the *result*: the actual bytes the
 * viewer is about to receive. The two are different jobs. A plan can be
 * perfectly consistent and still come out wrong, because between the plan and
 * the file stands an encoder with opinions of its own.
 *
 * The concrete case that earns this module its place: `loudnorm` in one pass.
 * We ask it for -14 LUFS and it *usually* obliges, but on short clips and on
 * clips with a wide loudness range it lands whole LU away from the target —
 * and the render notes were still telling the user "levelled to -14 LUFS",
 * because the note was written when the filter was requested, not when the
 * result was measured. The fix is the textbook one: measure what actually came
 * out, and run a second, linear pass built from those measurements. The video
 * stream is copied untouched, so the correction costs seconds, not a re-render.
 *
 * Everything else here is a tripwire rather than a repair. A deterministic
 * pipeline that produced a black picture or lost the audio will do it again if
 * re-run, so there is nothing to retry — but there is something to *say*, and
 * saying it in the notes beats the user discovering it in the export. The rule
 * is the same one the plan critic lives by: a render that arrives slightly
 * worse is worth more than one that does not arrive, and the one unforgivable
 * thing is to know about a defect and stay quiet.
 *
 * Failures of the review itself never fail the render: every path in here
 * degrades to "deliver the file we have".
 */
import { spawn } from "node:child_process";
import { guard, LIMITS } from "./deadline";
import { rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { EditOperation } from "@workspace/api-zod";
import { sayIn, type Language } from "./say";

export interface ReviewContext {
  operations: EditOperation[];
  /** The language the notes come back in. Absent means English. */
  language?: Language;
  /** The file the render started from, for "was it like this when it arrived". */
  sourcePath: string;
  /** Whether the source carried an audio track, probed before the render. */
  sourceHadAudio: boolean;
  /**
   * Whether the render was built to produce sound — the renderer's own
   * `source.hasAudio || musicUsable`, carried over rather than guessed at.
   *
   * These are two different questions and this file used to ask only the first.
   * A silent clip with a bed laid under it comes out with sound the source
   * never had: the render maps an audio stream, the plan asks for a level, and
   * the review skipped the measurement because the *source* was silent. A
   * music-only edit could ship at any loudness at all and nothing would say so.
   * Absent means fall back to the source, which is what every caller that
   * predates the field means.
   */
  expectedAudio?: boolean;
  /** Seconds the cut map said the edit should run, or null when unknown. */
  expectedSeconds: number | null;
  workDir: string;
}

export interface ReviewResult {
  /** User-facing lines, in the language of the render notes. */
  notes: string[];
  /** Diagnostics for the log. Never shown to the user. */
  warnings: string[];
  /** True when the output file was rewritten in place. */
  repaired: boolean;
  /** Integrated loudness of the delivered file, when it was measured. */
  measuredLufs: number | null;
}

/**
 * How far the mix may land from the requested level before we intervene.
 *
 * One LU is about the smallest difference anyone reliably hears in an A/B, and
 * platform normalisers ignore errors of that size anyway. Correcting inside
 * the tolerance would re-encode every render's audio for a change nobody could
 * perceive.
 */
const LOUDNESS_TOLERANCE_LU = 1.0;

/** Quieter than this and the mix is silence, not a level to be corrected. */
const SILENT_MIX_LUFS = -55;

/**
 * Output duration may drift this far from the cut map's arithmetic before it is
 * worth a diagnostic — concat and frame boundaries legitimately move the end a
 * few hundred milliseconds.
 */
const DURATION_SLACK = (expected: number): number => Math.max(1.5, expected * 0.05);

/**
 * Mean 8-bit luma below this, across the sampled frames, is a black picture.
 *
 * Limited-range video puts black at Y=16, not 0 — a frame of pure black
 * measures exactly 16 — so the line sits just above that plus encode noise.
 */
const BLACK_LUMA = 18;

/** ...and a source needs to sit above this before we call the black our fault. */
const SOURCE_LUMA_FLOOR = 36;

/** Seconds of picture to sample when checking for black output. */
const LUMA_SAMPLE_SECONDS = 30;

export async function reviewOutput(file: string, ctx: ReviewContext): Promise<ReviewResult> {
  const t = sayIn(ctx.language);
  const notes: string[] = [];
  const warnings: string[] = [];
  let repaired = false;
  let measuredLufs: number | null = null;

  const probe = await probeStreams(file);
  /** What the render intended to produce, not what arrived with the footage. */
  const expectedAudio = ctx.expectedAudio ?? ctx.sourceHadAudio;

  // ── Length ────────────────────────────────────────────────────────────────
  // A mismatch here is a bug in the cut arithmetic or the concat, and it is
  // ours to chase, not the user's to act on — so it goes to the log, never the
  // notes. The billing meter already measures the file directly.
  if (ctx.expectedSeconds != null && ctx.expectedSeconds > 0 && probe.duration > 0) {
    const drift = Math.abs(probe.duration - ctx.expectedSeconds);
    if (drift > DURATION_SLACK(ctx.expectedSeconds)) {
      warnings.push(
        `output runs ${probe.duration.toFixed(1)}s where the cut map computed ${ctx.expectedSeconds.toFixed(1)}s`,
      );
    }
  }

  // ── The sound is still there ──────────────────────────────────────────────
  // The renderer maps an audio stream whenever the source has one, so a source
  // with sound and an output without it means the graph dropped a link on the
  // floor. Deterministic, so not retried — but said out loud.
  if (expectedAudio && !probe.hasAudio) {
    warnings.push(
      ctx.sourceHadAudio
        ? "source had an audio track and the output does not"
        : "music was laid under a silent source and the output has no audio stream",
    );
    notes.push(
      t(
        "the sound did not survive this edit. That is a fault on our side, not in your footage",
        "لم ينجُ الصوت من هذا التعديل. وهذا عطل عندنا، لا في لقطتك",
      ),
    );
  }

  // ── The level actually reached ────────────────────────────────────────────
  const loudness = ctx.operations.find((op) => op.type === "normalizeLoudness");
  if (loudness && loudness.type === "normalizeLoudness" && expectedAudio && probe.hasAudio) {
    const target = loudness.targetLufs;
    const measured = await measureLoudness(file, target);
    if (!measured) {
      warnings.push("could not measure the output loudness");
    } else {
      measuredLufs = measured.inputI;
      if (measured.inputI <= SILENT_MIX_LUFS) {
        // Levelling silence is not a miss to be corrected; it is a clip with
        // nothing in it, and gain would only raise the noise floor.
        warnings.push(`output mix measures ${measured.inputI.toFixed(1)} LUFS, effectively silent`);
      } else if (Math.abs(measured.inputI - target) > LOUDNESS_TOLERANCE_LU) {
        const corrected = await correctLoudness(file, target, measured, ctx.workDir);
        if (corrected != null) {
          repaired = true;
          measuredLufs = corrected;
          notes.push(
            t(
              `the levelling missed on the first pass. The mix came out at ${measured.inputI.toFixed(1)} LUFS instead of ${target}, so it was measured and corrected`,
              `أخطأت التسوية في التمريرة الأولى: خرج المزيج عند ${measured.inputI.toFixed(1)} LUFS بدل ${target}، فقيس وصُحّح`,
            ),
          );
        } else {
          warnings.push(
            `mix measured ${measured.inputI.toFixed(1)} LUFS against a ${target} target and the correction did not land`,
          );
          notes.push(
            t(
              `the mix came out at ${measured.inputI.toFixed(1)} LUFS instead of ${target} and a correction did not take, so it ships as it is`,
              `خرج المزيج عند ${measured.inputI.toFixed(1)} LUFS بدل ${target} ولم ينجح التصحيح، فيُسلَّم كما هو`,
            ),
          );
        }
      }
    }
  }

  // ── The picture is a picture ──────────────────────────────────────────────
  // Only when the output looks black do we pay for a second read to ask
  // whether the source was black too — someone rendering an audio-only clip
  // over a black frame deserves no apology for their own footage.
  if (probe.hasVideo) {
    const outLuma = await meanLuma(file);
    if (outLuma != null && outLuma < BLACK_LUMA) {
      const sourceLuma = await meanLuma(ctx.sourcePath);
      if (sourceLuma != null && sourceLuma > SOURCE_LUMA_FLOOR) {
        warnings.push(
          `output luma ${outLuma.toFixed(1)} against source luma ${sourceLuma.toFixed(1)}. The picture is black`,
        );
        notes.push(
          t(
            "the picture came out black. That is a bug on our side, not in your footage",
            "خرجت الصورة سوداء. وهذا عطل عندنا، لا في لقطتك",
          ),
        );
      }
    }
  }

  return { notes, warnings, repaired, measuredLufs };
}

// ── Measurements ────────────────────────────────────────────────────────────

interface LoudnessReading {
  inputI: number;
  inputTp: number;
  inputLra: number;
  inputThresh: number;
  targetOffset: number;
}

/**
 * What `loudnorm` itself would measure, in the shape its second pass wants.
 *
 * ebur128 could give the integrated number alone, but the correction pass
 * needs the filter's own idea of threshold and offset, and the only honest way
 * to get those is to ask the same filter that will use them.
 */
async function measureLoudness(file: string, target: number): Promise<LoudnessReading | null> {
  const said = await ffmpeg([
    "-i", file,
    "-af", `loudnorm=I=${target}:TP=-1.5:LRA=11:print_format=json`,
    "-vn", "-sn", "-f", "null", "-",
  ]);
  const json = lastJsonBlock(said);
  if (!json) return null;
  const numberField = (name: string): number | null => {
    const v = Number(json[name]);
    return Number.isFinite(v) ? v : null;
  };
  const inputI = numberField("input_i");
  const inputTp = numberField("input_tp");
  const inputLra = numberField("input_lra");
  const inputThresh = numberField("input_thresh");
  if (inputI == null || inputTp == null || inputLra == null || inputThresh == null) return null;
  return { inputI, inputTp, inputLra, inputThresh, targetOffset: numberField("target_offset") ?? 0 };
}

/**
 * The second, linear pass, built from the first pass's measurements.
 *
 * The video stream is copied, not re-encoded: the correction touches only the
 * audio, costs seconds, and cannot soften a frame. The corrected file replaces
 * the original only after its own level has been measured again and found
 * closer to the target than the one it replaces — a correction is not taken on
 * faith from the same filter that just missed.
 *
 * Returns the corrected file's measured loudness, or null when the correction
 * failed or did not improve matters (the original is kept untouched).
 */
async function correctLoudness(
  file: string,
  target: number,
  measured: LoudnessReading,
  workDir: string,
): Promise<number | null> {
  const fixed = path.join(workDir, "relevelled.mp4");
  try {
    await ffmpegOrThrow([
      "-y", "-i", file,
      "-map", "0:v?", "-map", "0:a",
      "-c:v", "copy",
      "-af",
      `loudnorm=I=${target}:TP=-1.5:LRA=11` +
        `:measured_I=${measured.inputI}:measured_TP=${measured.inputTp}` +
        `:measured_LRA=${measured.inputLra}:measured_thresh=${measured.inputThresh}` +
        `:offset=${measured.targetOffset}:linear=true`,
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
      "-movflags", "+faststart",
      fixed,
    ]);
    const again = await measureLoudness(fixed, target);
    if (!again) return null;
    const before = Math.abs(measured.inputI - target);
    const after = Math.abs(again.inputI - target);
    if (after >= before) return null;
    await rename(fixed, file);
    return again.inputI;
  } catch {
    await unlink(fixed).catch(() => {});
    return null;
  }
}

/**
 * Mean luma over the opening stretch, sampled at one frame a second.
 *
 * One fps at a thumbnail size is enough to tell a black render from a dark
 * one, and keeps the check to well under a second of work. Null when the read
 * fails — an unmeasurable picture is not evidence of a black one.
 */
async function meanLuma(file: string): Promise<number | null> {
  const said = await ffmpeg([
    "-t", String(LUMA_SAMPLE_SECONDS),
    "-i", file,
    "-vf", "fps=1,scale=160:-2,signalstats,metadata=print:file=-",
    "-an", "-sn", "-f", "null", "-",
  ]);
  const values: number[] = [];
  for (const m of said.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)) {
    const v = Number(m[1]);
    if (Number.isFinite(v)) values.push(v);
  }
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// ── Plumbing ────────────────────────────────────────────────────────────────

const FFMPEG = process.env["FFMPEG_PATH"] ?? "ffmpeg";
const FFPROBE = process.env["FFPROBE_PATH"] ?? "ffprobe";

/**
 * Runs ffmpeg for its report, not its output; never throws on exit code.
 *
 * "Never throws on exit code" is exactly why the deadline has to be checked
 * separately here. A killed child closes like a finished one, and this
 * function's whole contract is to hand back whatever was said — so without the
 * flag a hung measurement pass would return a few lines of ffmpeg banner and
 * the critic would review a render against nothing.
 */
function ffmpeg(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ["-hide_banner", "-nostdin", ...args]);
    const deadline = guard(child, { ...LIMITS.analysis, what: "measuring the finished render" });
    let said = "";
    const collect = (d: Buffer) => {
      deadline.touch();
      said += d.toString();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (err) => {
      deadline.clear();
      reject(err);
    });
    child.on("close", () => {
      deadline.clear();
      if (deadline.expired) reject(deadline.error);
      else resolve(said);
    });
  });
}

/** Runs ffmpeg for its output file; a non-zero exit is a failure. */
function ffmpegOrThrow(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ["-hide_banner", "-nostdin", ...args]);
    const deadline = guard(child, { ...LIMITS.analysis, what: "cutting a sample of the render" });
    let said = "";
    child.stderr.on("data", (d: Buffer) => {
      deadline.touch();
      said += d.toString();
    });
    child.on("error", (err) => {
      deadline.clear();
      reject(err);
    });
    child.on("close", (code) => {
      deadline.clear();
      if (deadline.expired) reject(deadline.error);
      else if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${said.slice(-400)}`));
    });
  });
}

/**
 * The last {...} block in a stream of ffmpeg chatter, parsed.
 *
 * loudnorm prints its JSON at the very end of stderr, after the progress
 * lines. There are no other braces in ffmpeg's output on these invocations,
 * but taking the last block keeps a future filter's stray braces from
 * poisoning the read.
 */
function lastJsonBlock(text: string): Record<string, unknown> | null {
  const open = text.lastIndexOf("{");
  const close = text.lastIndexOf("}");
  if (open < 0 || close <= open) return null;
  try {
    return JSON.parse(text.slice(open, close + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function probeStreams(file: string): Promise<{ duration: number; hasAudio: boolean; hasVideo: boolean }> {
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn(FFPROBE, [
      "-v", "error",
      "-show_entries", "format=duration:stream=codec_type",
      "-of", "json",
      file,
    ]);
    const deadline = guard(child, { ...LIMITS.probe, what: "reading the render's own header" });
    let said = "";
    child.stdout.on("data", (d: Buffer) => {
      said += d.toString();
    });
    child.on("error", (err) => {
      deadline.clear();
      reject(err);
    });
    child.on("close", () => {
      deadline.clear();
      if (deadline.expired) reject(deadline.error);
      else resolve(said);
    });
  });
  try {
    const parsed = JSON.parse(out) as {
      format?: { duration?: string };
      streams?: Array<{ codec_type?: string }>;
    };
    return {
      duration: Number(parsed.format?.duration) || 0,
      hasAudio: (parsed.streams ?? []).some((s) => s.codec_type === "audio"),
      hasVideo: (parsed.streams ?? []).some((s) => s.codec_type === "video"),
    };
  } catch {
    return { duration: 0, hasAudio: false, hasVideo: false };
  }
}
