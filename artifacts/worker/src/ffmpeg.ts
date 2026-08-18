/**
 * The actual video work.
 *
 * Everything an edit plan asks for is compiled into a single filter graph and
 * encoded exactly once. The earlier version ran each operation as its own
 * ffmpeg invocation, which meant a clip that was trimmed, reframed, captioned
 * and watermarked went through four lossy encodes — every pass throwing away
 * detail the next pass could never recover. One pass is the difference between
 * "it worked" and "it looks good", and looking good is the whole product.
 *
 * The cost is that a failure names the graph rather than one operation, so the
 * graph is assembled from labelled, individually readable stages and logged.
 */
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { criticise } from "./critic";
import { renderMotionLayer, MOTION_SUBSAMPLES, type MotionTitle } from "./motion";
import type { EditOperation, EditPlan } from "@workspace/api-zod";
import { captionLayout, type CaptionLayout } from "./caption-layout";
import {
  chooseCropCenter,
  coverScale,
  cropExpression,
  cropOffsetX,
  measureInterest,
  subjectPath,
  MIN_SUBJECT_COVERAGE,
} from "./framing";
import { trackSubject, trackNote } from "./subject";
import { keepSegmentsFrom, remapTime, snapToWords, MOTION_OVERSCAN, type Segment, type SpokenWord } from "./timeline";

// These moved to `timeline.ts` so the critic could share them without importing
// the renderer that imports it. Re-exported because this is where callers —
// including the test suites — have always found them.
export { keepSegmentsFrom, remapTime, snapToWords, MOTION_OVERSCAN, type Segment, type SpokenWord };

export interface SourceInfo {
  width: number;
  height: number;
  fps: number;
  duration: number;
  hasAudio: boolean;
}

const FFMPEG = process.env["FFMPEG_PATH"] ?? "ffmpeg";
const FFPROBE = process.env["FFPROBE_PATH"] ?? "ffprobe";

export class FfmpegError extends Error {}

function run(
  bin: string,
  args: string[],
  options: { onStderr?: (chunk: string) => void } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      const text = d.toString();
      stderr += text;
      options.onStderr?.(text);
    });
    child.on("error", (err) => reject(new FfmpegError(`${bin} could not be started: ${err.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        // ffmpeg's useful message is always the last few lines, never the
        // first — and the *first* line is what anything downstream takes when
        // it needs one sentence. It used to be `${bin} exited ${code}`, so
        // every render failure in the product read "ffmpeg exited 1": a binary
        // name and a number, with the actual complaint sitting on the lines
        // below where nobody looked. Put the complaint first and the exit code
        // where it belongs, which is after it.
        const tail = stderr.trim().split("\n").filter(Boolean);
        const complaint = tail[tail.length - 1] ?? `${bin} exited ${code}`;
        reject(new FfmpegError(`${complaint}\n${bin} exited ${code}\n${tail.slice(-10).join("\n")}`));
      }
    });
  });
}

// ─── Probing ────────────────────────────────────────────────────────────────

export async function probeSource(file: string): Promise<SourceInfo> {
  const { stdout } = await run(FFPROBE, [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,avg_frame_rate",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1",
    file,
  ]);

  const read = (key: string): string | undefined =>
    stdout.split("\n").find((l) => l.startsWith(`${key}=`))?.split("=")[1]?.trim();

  const width = Number.parseInt(read("width") ?? "", 10);
  const height = Number.parseInt(read("height") ?? "", 10);
  const duration = Number.parseFloat(read("duration") ?? "");

  const [num, den] = (read("avg_frame_rate") ?? "30/1").split("/").map(Number);
  const fps = den > 0 && num > 0 ? num / den : 30;

  if (!Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(duration) || duration <= 0) {
    throw new FfmpegError(`Could not read ${path.basename(file)} as a video. Is the file complete?`);
  }

  return { width, height, fps, duration, hasAudio: await hasAudioStream(file) };
}

export async function probeDuration(file: string): Promise<number> {
  return (await probeSource(file)).duration;
}

export async function hasAudioStream(file: string): Promise<boolean> {
  const { stdout } = await run(FFPROBE, [
    "-v", "error",
    "-select_streams", "a",
    "-show_entries", "stream=index",
    "-of", "csv=p=0",
    file,
  ]);
  return stdout.trim().length > 0;
}

// ─── Silence ────────────────────────────────────────────────────────────────

/**
 * Finds stretches of near-silence using ffmpeg's silencedetect filter, which
 * reports them on stderr as it scans. Returns them in order.
 */
export async function detectSilences(
  file: string,
  thresholdDb: number,
  minSilenceSeconds: number,
): Promise<Segment[]> {
  let buffer = "";
  await run(
    FFMPEG,
    ["-hide_banner", "-i", file, "-af", `silencedetect=noise=${thresholdDb}dB:d=${minSilenceSeconds}`, "-f", "null", "-"],
    { onStderr: (chunk) => { buffer += chunk; } },
  );

  const silences: Segment[] = [];
  let pendingStart: number | null = null;
  for (const line of buffer.split("\n")) {
    const start = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (start) {
      pendingStart = Math.max(0, Number.parseFloat(start[1]));
      continue;
    }
    const end = line.match(/silence_end:\s*([\d.]+)/);
    if (end && pendingStart !== null) {
      silences.push({ start: pendingStart, end: Number.parseFloat(end[1]) });
      pendingStart = null;
    }
  }
  if (pendingStart !== null) {
    silences.push({ start: pendingStart, end: await probeDuration(file) });
  }
  return silences;
}

// ─── Motion ─────────────────────────────────────────────────────────────────

function clampExpr(inner: string): string {
  return `max(0,min(1,${inner}))`;
}

/**
 * Builds the zoom expression for zoompan.
 *
 * `on` is the output frame number, so `on/FPS` is the timestamp. Every ramp is
 * eased linearly over RAMP seconds; a hard cut to a zoomed frame reads as a
 * glitch rather than as emphasis.
 */
export function zoomExpression(
  options: {
    base: number;
    fps: number;
    totalFrames: number;
    kenBurns?: { to: number };
    punches?: Array<{ at: number; duration: number; amount: number }>;
  },
): string {
  const { base, fps, totalFrames } = options;
  const terms: string[] = [String(base)];

  if (options.kenBurns) {
    const delta = (options.kenBurns.to - 1) * base;
    terms.push(`${delta.toFixed(4)}*min(1,on/${Math.max(1, totalFrames)})`);
  }

  const RAMP = 0.25;
  for (const punch of options.punches ?? []) {
    const t = `(on/${fps.toFixed(4)})`;
    const inRamp = clampExpr(`(${t}-${punch.at.toFixed(3)})/${RAMP}`);
    const outRamp = clampExpr(`(${(punch.at + punch.duration).toFixed(3)}-${t})/${RAMP}`);
    const amount = (punch.amount * base).toFixed(4);
    terms.push(`${amount}*min(${inRamp},${outRamp})`);
  }

  return terms.join("+");
}

// ─── Captions ───────────────────────────────────────────────────────────────

export interface CaptionWord {
  startMs: number;
  endMs: number;
  text: string;
}

export interface CaptionCue {
  startMs: number;
  endMs: number;
  text: string;
  /** Present when the source of the cue knows per-word timing. */
  words?: CaptionWord[];
}

function toAssTime(ms: number): string {
  const cs = Math.max(0, Math.round(ms / 10));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

/**
 * Style rows. PrimaryColour is the fill, SecondaryColour is what karaoke wipes
 * *from* — ASS colours are &HAABBGGRR, which is backwards from every other
 * format and the single easiest thing to get wrong here.
 */
interface CaptionColours {
  /** The fill. */
  primary: string;
  /** What a karaoke wipe reveals from. */
  secondary: string;
  outline: string;
  back: string;
  /** 1 is outline + shadow, 3 is an opaque box behind the text. */
  borderStyle: number;
  outlineWidth: number;
  shadow: number;
}

const CAPTION_COLOURS: Record<string, CaptionColours> = {
  "bold-white": {
    primary: "&H00FFFFFF", secondary: "&H00A0A0A0", outline: "&H00000000", back: "&HA0000000",
    borderStyle: 1, outlineWidth: 5, shadow: 2,
  },
  "bold-yellow": {
    primary: "&H0000E5FF", secondary: "&H00FFFFFF", outline: "&H00000000", back: "&HA0000000",
    borderStyle: 1, outlineWidth: 5, shadow: 2,
  },
  "karaoke-box": {
    primary: "&H00FFFFFF", secondary: "&H0000E5FF", outline: "&H00000000", back: "&HC0000000",
    borderStyle: 3, outlineWidth: 0, shadow: 0,
  },
};

/**
 * The style row, built from the layout rather than frozen in a string.
 *
 * The old rows hardcoded size 72 and 180 px of bottom margin, which was correct
 * for exactly one frame size and wrong for every platform: 180 px sits inside
 * TikTok's bottom furniture, so the last line of every caption was drawn under
 * the username. Size and margins now come from caption-layout.ts.
 */
function captionStyleRow(style: string, layout: CaptionLayout): string {
  const c = CAPTION_COLOURS[style] ?? CAPTION_COLOURS["bold-white"];
  return [
    "Style: Cap", "DejaVu Sans", String(layout.fontSize),
    c.primary, c.secondary, c.outline, c.back,
    "-1", "0", "0", "0",      // bold, italic, underline, strikeout
    "100", "100", "0", "0",   // scale x/y, spacing, angle
    String(c.borderStyle), String(c.outlineWidth), String(c.shadow),
    String(layout.alignment), String(layout.marginL), String(layout.marginR), String(layout.marginV),
    "1",
  ].join(",");
}

/**
 * Per-cue animation. These are the effects that make short-form captions read
 * as deliberate rather than as an accessibility track: a small overshoot on
 * entry, and a word-level wipe that tracks the speaker.
 */
function animateCue(cue: CaptionCue, animation: string): string {
  const body = cue.text.replace(/\r?\n/g, "\\N").replace(/[{}]/g, "");

  if (animation === "karaoke" && cue.words && cue.words.length > 0) {
    // \kf wipes the fill across each word for exactly its own duration, so the
    // highlight follows the voice instead of a fixed rhythm.
    return cue.words
      .map((w) => {
        const cs = Math.max(1, Math.round((w.endMs - w.startMs) / 10));
        return `{\\kf${cs}}${w.text.replace(/[{}]/g, "")} `;
      })
      .join("")
      .trimEnd();
  }

  if (animation === "pop") {
    // Overshoot to 108% then settle. 120ms is short enough to feel snappy and
    // long enough not to strobe.
    return `{\\fad(60,60)\\fscx70\\fscy70\\t(0,120,\\fscx108\\fscy108)\\t(120,200,\\fscx100\\fscy100)}${body}`;
  }

  return `{\\fad(60,60)}${body}`;
}

/**
 * Breaks each cue onto lines that fit the space the platform actually leaves.
 *
 * libass will wrap on its own, but only at the style's margins and with no idea
 * that the last line is about to land under a username — and its wrap point is
 * chosen for the box, not for the sentence. Doing it here means the break lands
 * between words we chose, and a cue that cannot fit is truncated visibly rather
 * than pushed into the furniture.
 */
export function wrapToLayout(cues: CaptionCue[], layout: CaptionLayout): CaptionCue[] {
  return cues.map((cue) => {
    const words = cue.text.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = "";

    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (candidate.length > layout.maxCharsPerLine && line) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);

    // Beyond the allowed number of lines the caption would climb over the
    // speaker's face. Ending on an ellipsis is honest; silently spilling is not.
    const shown = lines.slice(0, layout.maxLines);
    if (lines.length > layout.maxLines) shown[shown.length - 1] += "…";

    return { ...cue, text: shown.join("\n") };
  });
}

export async function writeSubtitleFile(
  file: string,
  cues: CaptionCue[],
  style: string,
  animation: string,
  frame: { width: number; height: number },
  // Optional, and when it is absent we compute the layout that is safe on every
  // platform rather than falling back to a constant. A caller who has not
  // thought about placement should still not get captions under a username.
  layout: CaptionLayout = captionLayout(frame, null),
): Promise<void> {
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${frame.width}`,
    `PlayResY: ${frame.height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    captionStyleRow(style, layout),
    "",
    "[Events]",
    "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
  ];

  const events = cues
    .filter((c) => c.endMs > c.startMs)
    .map((c) => `Dialogue: 0,${toAssTime(c.startMs)},${toAssTime(c.endMs)},Cap,,0,0,0,,${animateCue(c, animation)}`);

  await writeFile(file, [...header, ...events].join("\n"), "utf8");
}

// ─── Encoding ───────────────────────────────────────────────────────────────

/**
 * One encode, so these settings are the only ones that matter.
 *
 * `medium`/CRF 18 rather than `veryfast`/CRF 20: this runs on a machine nobody
 * is waiting on, so spending seconds to keep detail is free. A short keyframe
 * interval matters because every one of these platforms re-encodes on upload,
 * and gives a cleaner result when it can cut on a keyframe.
 */
const VIDEO_ENCODE = [
  "-c:v", "libx264",
  "-preset", "medium",
  "-crf", "18",
  "-profile:v", "high",
  "-level", "4.2",
  "-pix_fmt", "yuv420p",
  "-g", "60",
  "-keyint_min", "30",
  "-sc_threshold", "0",
];

/**
 * The same settings, adjusted for a frame with four times the pixels.
 *
 * `medium`/CRF 18 is right at 1080 and wrong at 2160 for two reasons that pull
 * the same way. The encode is roughly four times the work, which turns a render
 * nobody is waiting on into one they are; and quantisation artefacts are far
 * harder to see at that pixel density, so CRF 20 there looks like CRF 18 here
 * while producing a file somebody can actually upload. Level 5.1 because 4.2
 * does not admit frames this large — a mismatch some players enforce and others
 * ignore, which is the worst kind of wrong.
 */
function videoEncodeFor(frameHeight: number): string[] {
  if (frameHeight <= 1920) return VIDEO_ENCODE;
  return VIDEO_ENCODE.map((arg, i, all) => {
    if (all[i - 1] === "-preset") return "fast";
    if (all[i - 1] === "-crf") return "20";
    if (all[i - 1] === "-level") return "5.1";
    return arg;
  });
}

const AUDIO_ENCODE = ["-c:a", "aac", "-b:a", "192k", "-ar", "48000"];

/**
 * Moves the moov atom to the front. Without it a browser must download the
 * whole file before it can show a single frame — which, for a video served
 * from object storage, looks exactly like a broken player.
 */
const FASTSTART = ["-movflags", "+faststart"];

function escapeForFilter(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/%/g, "\\%");
}

/**
 * The export frame, from its height.
 *
 * All three targets are 9:16, so the height is the only number: 1920 gives
 * 1080x1920, 2160 gives 1216x2160, 1280 gives 720x1280. Widths are rounded to
 * even because H.264 chroma subsampling requires it and an odd dimension fails
 * the encode with a message about nothing in particular.
 */
const DEFAULT_FRAME_HEIGHT = 1920;

export function frameFor(height: number): { w: number; h: number } {
  const h = Math.round(height / 2) * 2;
  return { w: Math.round((h * 9) / 16 / 2) * 2, h };
}

/**
 * How much taller than the source's own vertical crop we are willing to go.
 *
 * Reframing takes a 9:16 window out of the source and scales it to the target,
 * so a 1080p landscape clip only carries about 608 real pixels across that
 * window — every vertical export from it is already an upscale. That is
 * inherent and fine. Going further is not: exporting a 1080p camera at 2160
 * quadruples the file for exactly the same detail, costs the customer their
 * upload time and us the encode, and looks softer, not sharper.
 *
 * So the requested height is capped at what the crop can plausibly carry, with
 * this much headroom, and the cap is stated rather than applied silently.
 */
const HONEST_UPSCALE = 2;

/**
 * Where an overlay sits. `W`/`H` are the frame, `w`/`h` the thing being laid on
 * it, so the same expression is right at 1080×1920 and at 1080×1350 — which a
 * pixel offset would not be.
 */
const OVERLAY_POSITION: Record<string, string> = {
  "top-left": "40:40",
  "top-center": "(W-w)/2:40",
  "top-right": "W-w-40:40",
  center: "(W-w)/2:(H-h)/2",
  "bottom-left": "40:H-h-40",
  "bottom-center": "(W-w)/2:H-h-40",
  "bottom-right": "W-w-40:H-h-40",
};

const WATERMARK_POSITION: Record<string, string> = {
  "bottom-right": "x=w-tw-40:y=h-th-40",
  "bottom-center": "x=(w-tw)/2:y=h-th-40",
  "top-right": "x=w-tw-40:y=40",
};

export interface RenderContext {
  workDir: string;
  onProgress?: (fraction: number, stage: string) => void;
  /**
   * Where the words are, on the source clock.
   *
   * A measurement of this file rather than a decision about it, which is why it
   * arrives here and not in the plan: the plan is the contract and stays
   * replayable, while this is the same kind of input as the frame size. It is
   * what lets a cut avoid landing inside a word — silence detection works on
   * amplitude, and amplitude does not respect syllables.
   */
  words?: SpokenWord[];
  /**
   * Asset id → the file already downloaded next to the source.
   *
   * Resolved by the caller, not looked up here, for the same reason the plan
   * carries ids and not paths: by the time a filter graph is being written, the
   * question "is this file allowed" must already be answered. A renderer that
   * can open an arbitrary path is one plan away from reading someone else's
   * project.
   */
  assets?: Map<string, { file: string; kind: "video" | "image" | "audio" }>;
}

export interface RenderResult {
  output: string;
  notes: string[];
  /** What the source measured, before any cuts. */
  sourceSeconds: number;
  /**
   * How long the edit should come out, computed from the cut map rather than
   * read from the finished file.
   *
   * This is arithmetic, not a guess, and it is here so that a render whose
   * output cannot be probed still has an honest number to be billed on instead
   * of a null the meter would read as free.
   */
  estimatedSeconds: number;
}

type Op<T extends EditOperation["type"]> = Extract<EditOperation, { type: T }>;

/**
 * Compiles a plan into one filter graph and runs it.
 *
 * Order within the graph is fixed regardless of the order operations appear in
 * the plan, because it is the only order that is correct: cuts first (they
 * change every later timestamp), then framing, then motion, then anything drawn
 * on top.
 */
export async function renderPlan(input: string, plan: EditPlan, ctx: RenderContext): Promise<RenderResult> {
  const notes: string[] = [];
  const source = await probeSource(input);
  const output = path.join(ctx.workDir, "output.mp4");

  /**
   * The one operation of this type the graph will use.
   *
   * The graph has exactly one slot per kind — one crop, one zoom expression,
   * one subtitle filter — so a plan carrying two of the same operation cannot
   * express both. It used to take the first and drop the rest with no note and
   * no error, which meant a plan asking for two different punch sets rendered
   * as one and looked, from the outside, like the second one had simply not
   * worked. Now the loss is stated.
   */
  const find = <T extends EditOperation["type"]>(type: T): Op<T> | undefined => {
    const matches = plan.operations.filter((o) => o.type === type) as Op<T>[];
    if (matches.length > 1) {
      notes.push(
        `the plan asked for ${matches.length} ${type} operations and the render can only apply one, so the first was used`,
      );
    }
    return matches[0];
  };

  const silence = find("removeSilence");
  const reframe = find("formatForPlatform");
  // `let`, because the critic revises these once it knows what the edit became.
  let kenBurns = find("kenBurns");
  let zoomPunch = find("zoomPunch");
  let captions = find("burnCaptions");
  const watermark = find("watermark");
  const loudness = find("normalizeLoudness");
  const grade = find("grade");

  ctx.onProgress?.(0.02, "Looking at your footage");

  // ── Cuts ──────────────────────────────────────────────────────────────────
  let kept: Segment[] | null = null;
  if (silence) {
    if (!source.hasAudio) {
      notes.push("no audio track, nothing to trim");
    } else {
      ctx.onProgress?.(0.06, "Finding the silences");
      const silences = await detectSilences(input, silence.thresholdDb, silence.minSilenceMs / 1000);
      const protect = (silence.protect ?? []).map((r) => ({ start: r.startMs / 1000, end: r.endMs / 1000 }));
      let candidate = keepSegmentsFrom(source.duration, silences, silence.paddingMs / 1000, protect);

      // Amplitude does not respect words. A stop consonant or an unvoiced
      // syllable dips below the threshold, the detector reads a pause, and the
      // cut lands mid-word — which sounds like the speaker stumbled, so nobody
      // reports it as a bug. With a transcript this is arithmetic.
      if (ctx.words && ctx.words.length > 0) {
        const before = candidate;
        candidate = snapToWords(candidate, ctx.words);
        const moved = candidate.reduce(
          (count, segment, i) =>
            count + (before[i] && (before[i].start !== segment.start || before[i].end !== segment.end) ? 1 : 0),
          0,
        );
        if (moved > 0 || candidate.length !== before.length) {
          notes.push(
            `${Math.max(moved, before.length - candidate.length)} cut${Math.max(moved, before.length - candidate.length) === 1 ? "" : "s"} moved off the middle of a word`,
          );
        }
      }
      if (protect.length > 0) {
        const spared = silences.filter((s) => protect.some((r) => s.start < r.end && s.end > r.start)).length;
        if (spared > 0) {
          notes.push(
            `${spared} quiet ${spared === 1 ? "stretch was" : "stretches were"} left in because something was happening on screen there`,
          );
        }
      }

      if (candidate.length === 0) {
        throw new FfmpegError("The whole clip reads as silence at this threshold — nothing would be left.");
      }
      const keptDuration = candidate.reduce((sum, s) => sum + (s.end - s.start), 0);
      if (keptDuration >= source.duration - 0.01) {
        notes.push("no silence found to remove");
      } else {
        kept = candidate;
        notes.push(`removed ${(source.duration - keptDuration).toFixed(1)}s of silence across ${silences.length} gaps`);
      }
    }
  }

  const videoParts: string[] = [];
  const audioParts: string[] = [];
  let graphPrefix = "";
  let vLabel = "0:v";
  let aLabel = "0:a";

  if (kept) {
    const pieces: string[] = [];
    kept.forEach((segment, i) => {
      pieces.push(`[0:v]trim=start=${segment.start}:end=${segment.end},setpts=PTS-STARTPTS[cv${i}]`);
      pieces.push(`[0:a]atrim=start=${segment.start}:end=${segment.end},asetpts=PTS-STARTPTS[ca${i}]`);
    });
    pieces.push(`${kept.map((_, i) => `[cv${i}][ca${i}]`).join("")}concat=n=${kept.length}:v=1:a=1[cutv][cuta]`);
    graphPrefix = `${pieces.join(";")};`;
    vLabel = "cutv";
    aLabel = "cuta";
  }

  const effectiveDuration = kept
    ? kept.reduce((sum, s) => sum + (s.end - s.start), 0)
    : source.duration;

  // ── The critic ────────────────────────────────────────────────────────────
  //
  // Everything decided so far was decided against the *original*: the API never
  // saw the file, and enrich read the recording. The cuts above have just
  // changed how long the video is and moved every moment inside it. This is the
  // first and only point where both the plan and the edited timeline are known,
  // so it is where the two are reconciled — see critic.ts for what that catches.
  {
    const reviewed = criticise({
      operations: plan.operations,
      kept,
      effectiveDuration,
      words: ctx.words,
    });
    notes.push(...reviewed.notes);
    const reviewedFind = <T extends EditOperation["type"]>(type: T): Op<T> | undefined =>
      reviewed.operations.find((o) => o.type === type) as Op<T> | undefined;
    kenBurns = reviewedFind("kenBurns");
    zoomPunch = reviewedFind("zoomPunch");
    captions = reviewedFind("burnCaptions");
  }

  // ── Framing ───────────────────────────────────────────────────────────────
  const hasMotion = Boolean(kenBurns || zoomPunch);
  let frameWidth = source.width;
  let frameHeight = source.height;

  if (reframe) {
    const asked = frameFor(reframe.maxHeight ?? DEFAULT_FRAME_HEIGHT);
    // What the source can honestly fill: the 9:16 window out of it, at the
    // scale that window is already being taken at.
    const sourceWindowHeight = Math.min(source.height, (source.width * 16) / 9);
    const ceiling = Math.max(DEFAULT_FRAME_HEIGHT, sourceWindowHeight * HONEST_UPSCALE);
    const target = asked.h > ceiling ? frameFor(ceiling) : asked;
    if (target.h !== asked.h) {
      notes.push(
        `exported at ${target.h}p rather than ${asked.h}p — this footage has no more detail than that, and the larger file would only be a bigger copy of the same picture`,
      );
    }
    frameWidth = target.w;
    frameHeight = target.h;
    // Crop wider than the target when something will move, so the base zoom is
    // a downscale rather than an upscale. lanczos because the default bilinear
    // is visibly softer on the large downscales this does.
    const overscan = hasMotion ? MOTION_OVERSCAN : 1;
    const cropW = Math.round((target.w * overscan) / 2) * 2;
    const cropH = Math.round((target.h * overscan) / 2) * 2;

    // Where the window goes. A centre crop is only right when the subject is
    // centred; on an interview framed to one side it delivers a shoulder.
    const scale = coverScale(source, { width: cropW, height: cropH });
    const scaledWidth = Math.round(source.width * scale);
    let cropX = Math.round((scaledWidth - cropW) / 4) * 2;

    // Where the crop sits horizontally, as an ffmpeg expression. A number when
    // the window holds still, which is the usual and the preferred answer.
    let cropXExpr = String(cropX);

    if (scaledWidth > cropW + 2) {
      ctx.onProgress?.(0.08, "Finding your subject in the frame");
      const windowFraction = cropW / scaledWidth;

      // Faces first: "where is the person" is the question, and everything else
      // here is a proxy for it. The tracker answers with null rather than
      // throwing, so a missing python, a screen recording, or a clip nobody
      // appears in all land in the same place.
      const track = await trackSubject(input, source.width, source.height);
      const note = trackNote(track);
      if (note) notes.push(note);

      if (track && track.coverage >= MIN_SUBJECT_COVERAGE) {
        const path = subjectPath(track.samples, windowFraction);
        cropXExpr = cropExpression(path.keyframes, scaledWidth, cropW);
        const moves = (path.keyframes.length - 1) / 2;
        notes.push(
          path.moves
            ? `followed the speaker, moving the frame ${Math.round(moves)} time${Math.round(moves) === 1 ? "" : "s"} where they moved`
            : "framed on the speaker and held there",
        );
      } else {
        try {
          const choice = chooseCropCenter(await measureInterest(input), windowFraction);
          cropX = cropOffsetX(choice, scaledWidth, cropW);
          cropXExpr = String(cropX);
          notes.push(
            choice.moved
              ? `framed on the subject rather than the centre (${Math.round(choice.center * 100)}% across)`
              : "kept the centre — nothing in the frame argued for moving off it",
          );
        } catch {
          // Measurement is an improvement, not a dependency. A centre crop is
          // still a real edit; failing the render over it would not be.
          notes.push("could not read the framing, so the centre was kept");
        }
      }
    }

    videoParts.push(
      `scale=${cropW}:${cropH}:force_original_aspect_ratio=increase:flags=lanczos`,
      `crop=${cropW}:${cropH}:'${cropXExpr}':(ih-oh)/2`,
      "setsar=1",
    );
    notes.push(`reframed to ${target.w}x${target.h} for ${reframe.platform}`);
  } else if (hasMotion) {
    const cropW = Math.round((source.width * MOTION_OVERSCAN) / 2) * 2;
    const cropH = Math.round((source.height * MOTION_OVERSCAN) / 2) * 2;
    videoParts.push(`scale=${cropW}:${cropH}:flags=lanczos`, "setsar=1");
  }

  // ── Motion ────────────────────────────────────────────────────────────────
  if (hasMotion) {
    const fps = source.fps;
    const totalFrames = Math.max(1, Math.round(effectiveDuration * fps));
    const punches = (zoomPunch?.at ?? []).map((at) => ({
      at,
      duration: zoomPunch?.holdMs ? zoomPunch.holdMs / 1000 : 1.2,
      amount: zoomPunch?.amount ?? 0.12,
    }));

    const z = zoomExpression({
      base: MOTION_OVERSCAN,
      fps,
      totalFrames,
      kenBurns: kenBurns ? { to: kenBurns.to } : undefined,
      punches,
    });

    videoParts.push(
      `zoompan=z='${z}':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${frameWidth}x${frameHeight}:fps=${fps.toFixed(4)}`,
    );

    if (kenBurns) notes.push(`slow push to ${Math.round(kenBurns.to * 100)}%`);
    if (punches.length > 0) notes.push(`${punches.length} punch-in${punches.length === 1 ? "" : "s"}`);
  }

  // ── Grade ─────────────────────────────────────────────────────────────────
  //
  // After motion and before anything drawn on top: the picture is graded, the
  // captions and the mark are not. A watermark whose white drifted with the
  // saturation of the footage under it would read as a rendering fault.
  if (grade && Math.abs(grade.saturation - 1) > 0.001) {
    videoParts.push(`eq=saturation=${grade.saturation.toFixed(3)}`);
    notes.push(
      grade.saturation > 1
        ? `colour pushed ${Math.round((grade.saturation - 1) * 100)}% toward your reference`
        : `colour pulled back ${Math.round((1 - grade.saturation) * 100)}% toward your reference`,
    );
  }

  // ── Drawn on top ──────────────────────────────────────────────────────────
  if (captions) {
    // Already on the edited timeline: the critic moved them with the cuts, and
    // shifting again here would move every caption a second time. That split of
    // responsibility is deliberate — one place converts, everywhere else trusts.
    const cues: CaptionCue[] = captions.cues.map((c) => ({
      startMs: c.startMs,
      endMs: c.endMs,
      text: c.text,
      words: c.words?.map((w) => ({ ...w })),
    }));

    const subtitlePath = path.join(ctx.workDir, "captions.ass");
    const layout = captionLayout({ width: frameWidth, height: frameHeight }, reframe?.platform ?? null);
    await writeSubtitleFile(
      subtitlePath,
      wrapToLayout(cues, layout),
      captions.style,
      captions.animation,
      { width: frameWidth, height: frameHeight },
      layout,
    );
    videoParts.push(`subtitles=${subtitlePath.replace(/[\\:']/g, "\\$&")}`);
    notes.push(`burned ${cues.length} captions (${captions.animation})`);
  }

  if (watermark) {
    videoParts.push(
      [
        `drawtext=text='${escapeForFilter(watermark.text)}'`,
        "fontcolor=white@0.85",
        "fontsize=h/32",
        "box=1",
        "boxcolor=black@0.35",
        "boxborderw=12",
        WATERMARK_POSITION[watermark.position] ?? WATERMARK_POSITION["bottom-right"],
      ].join(":"),
    );
    notes.push(`watermarked "${watermark.text}"`);
  }

  // ── Audio ─────────────────────────────────────────────────────────────────
  if (loudness && source.hasAudio) {
    // -14 LUFS is what every one of these platforms normalises to. Arriving at
    // the right level means they leave the audio alone.
    audioParts.push(`loudnorm=I=${loudness.targetLufs}:TP=-1.5:LRA=11`);
    notes.push(`levelled to ${loudness.targetLufs} LUFS`);
  }

  // ── Designed motion ───────────────────────────────────────────────────────
  //
  // Titles are rendered in a browser to a transparent frame sequence and then
  // laid over the picture like any other overlay. They are built *before* the
  // overlay chain so they end up on top of b-roll and images, which is the
  // order anyone would expect: a title is the last thing between the viewer
  // and the frame.
  //
  // The whole thing degrades to a note. No browser in the image, a scene that
  // fails to paint, a title whose moment was cut — none of those are reasons
  // to fail a render that is otherwise finished.
  const titleOps = plan.operations.filter((o): o is Op<"motionTitle"> => o.type === "motionTitle");
  let motionLayer: { pattern: string; frames: number; fps: number } | null = null;
  if (titleOps.length > 0) {
    const titles: MotionTitle[] = [];
    for (const op of titleOps) {
      const start = kept ? remapTime(op.at, kept) : op.at;
      const end = kept ? remapTime(op.at + op.durationSeconds, kept) : op.at + op.durationSeconds;
      if (end - start < 0.2) {
        notes.push("dropped a title whose moment did not survive the cut");
        continue;
      }
      titles.push({
        text: op.text,
        at: start,
        durationSeconds: end - start,
        style: op.style,
        position: op.position,
      });
    }
    if (titles.length > 0) {
      const until = Math.max(...titles.map((t) => t.at + t.durationSeconds)) + 0.6;
      motionLayer = await renderMotionLayer(
        { width: frameWidth, height: frameHeight, fps: source.fps, titles, durationSeconds: until },
        path.join(ctx.workDir, "motion"),
      );
      if (motionLayer) notes.push(`rendered ${titles.length} title${titles.length === 1 ? "" : "s"}`);
      else notes.push("could not render the titles here, so they were left out");
    }
  }

  // ── Things laid over the picture ──────────────────────────────────────────
  //
  // Unlike every other operation here, these do not have one slot: a plan may
  // legitimately place a logo, a screenshot and a piece of b-roll, and they
  // compose. So each one becomes its own ffmpeg input and its own overlay link,
  // chained in plan order.
  //
  // Timings arrive on the source clock like all the others, so they are moved
  // through the same cut map — an overlay pinned to a sentence that got cut
  // must not reappear over whatever took its place.
  const overlayOps = plan.operations.filter(
    (o): o is Op<"overlayImage"> | Op<"insertBRoll"> => o.type === "overlayImage" || o.type === "insertBRoll",
  );
  const extraInputs: string[] = [];
  const overlayLinks: string[] = [];

  /** Frames the motion layer contributes, averaged back down to one. */
  const motionInputArgs = (): string[] =>
    motionLayer ? ["-framerate", String(motionLayer.fps), "-i", motionLayer.pattern] : [];

  if (overlayOps.length > 0) {
    for (const op of overlayOps) {
      const asset = ctx.assets?.get(op.assetId);
      if (!asset) {
        notes.push(`skipped an overlay: asset ${op.assetId} is not in this project`);
        continue;
      }
      if (op.type === "overlayImage" && asset.kind !== "image") {
        // The kind is re-derived from the bytes upstream, so this is a plan
        // asking to draw a video as a still, not a mislabelled upload.
        notes.push("skipped an image overlay: that asset is not an image");
        continue;
      }

      const startSrc = op.at;
      const endSrc = op.at + op.durationSeconds;
      const start = kept ? remapTime(startSrc, kept) : startSrc;
      const end = kept ? remapTime(endSrc, kept) : endSrc;
      if (end - start < 0.1) {
        // The whole stretch it was pinned to was cut away.
        notes.push("dropped an overlay whose moment did not survive the cut");
        continue;
      }

      const idx = extraInputs.length / 2 + 1; // input 0 is the source
      const inLabel = overlayLinks.length === 0 ? "OVBASE" : `ov${overlayLinks.length}`;
      const outLabel = `ov${overlayLinks.length + 1}`;

      if (op.type === "overlayImage") {
        // A still needs `-loop 1` to have a duration at all, and a `-t` so the
        // loop is finite: without it ffmpeg never reaches the end of the input
        // and the render does not stop.
        extraInputs.push("-loop", "1", "-t", (end + 0.5).toFixed(3), "-i", asset.file);
        const w = Math.max(2, Math.round(frameWidth * op.scale));
        const alpha = op.opacity < 1 ? `,format=rgba,colorchannelmixer=aa=${op.opacity.toFixed(3)}` : "";
        overlayLinks.push(`[${idx}:v]scale=${w}:-2${alpha}[img${idx}]`);
        overlayLinks.push(
          `[${inLabel}][img${idx}]overlay=${OVERLAY_POSITION[op.position]}:` +
            `enable='between(t,${start.toFixed(3)},${end.toFixed(3)})':eof_action=pass[${outLabel}]`,
        );
        notes.push(`laid an image over the frame at ${start.toFixed(1)}s`);
      } else {
        // B-roll: a second clip filling the frame for a while. The source audio
        // is kept underneath, which is what a cutaway is — the picture changes
        // and the person keeps talking.
        extraInputs.push("-i", asset.file);
        const fit =
          op.fit === "cover"
            ? `scale=${frameWidth}:${frameHeight}:force_original_aspect_ratio=increase:flags=lanczos,crop=${frameWidth}:${frameHeight}`
            : `scale=${frameWidth}:${frameHeight}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${frameWidth}:${frameHeight}:(ow-iw)/2:(oh-ih)/2:black`;
        overlayLinks.push(
          `[${idx}:v]${fit},setsar=1,trim=0:${(end - start).toFixed(3)},setpts=PTS-STARTPTS+${start.toFixed(3)}/TB[br${idx}]`,
        );
        overlayLinks.push(
          `[${inLabel}][br${idx}]overlay=0:0:` +
            `enable='between(t,${start.toFixed(3)},${end.toFixed(3)})':eof_action=pass[${outLabel}]`,
        );
        notes.push(`cut to b-roll at ${start.toFixed(1)}s for ${(end - start).toFixed(1)}s`);
      }
    }
  }

  if (motionLayer) {
    const idx = extraInputs.length / 2 + 1;
    extraInputs.push(...motionInputArgs());
    const inLabel = overlayLinks.length === 0 ? "OVBASE" : `ov${overlayLinks.length}`;
    const outLabel = `ov${overlayLinks.length + 1}`;
    // `tmix` is the shutter: four samples averaged into one frame, so fast
    // movement smears and slow movement stays sharp without anyone deciding
    // which is which. `select` then keeps one frame per group so the layer
    // comes back to the output rate instead of four times it.
    overlayLinks.push(
      `[${idx}:v]tmix=frames=${MOTION_SUBSAMPLES}:weights='${Array(MOTION_SUBSAMPLES).fill(1).join(" ")}',` +
        `select='not(mod(n\\,${MOTION_SUBSAMPLES}))',setpts=N/${source.fps.toFixed(4)}/TB,` +
        `scale=${frameWidth}:${frameHeight}[mot]`,
    );
    overlayLinks.push(`[${inLabel}][mot]overlay=0:0:eof_action=pass[${outLabel}]`);
  }

  // ── Assemble ──────────────────────────────────────────────────────────────
  const graphParts: string[] = [];
  // With overlays present the main chain stops at a named link and the overlay
  // links carry it the rest of the way; without them it ends at [vout] as
  // before. Naming this once here is what keeps the two cases from disagreeing
  // about which label holds the finished picture.
  const hasOverlays = overlayLinks.length > 0;
  const mainVideoOut = hasOverlays ? "OVBASE" : "vout";
  if (videoParts.length > 0) graphParts.push(`[${vLabel}]${videoParts.join(",")}[${mainVideoOut}]`);
  else if (hasOverlays) graphParts.push(`[${kept ? vLabel : "0:v"}]null[OVBASE]`);
  graphParts.push(...overlayLinks);
  if (source.hasAudio && audioParts.length > 0) graphParts.push(`[${aLabel}]${audioParts.join(",")}[aout]`);

  const graph = graphPrefix + graphParts.join(";");

  // A bracketed name is a filter label; a bare one is an input stream. Mixing
  // them up makes ffmpeg look for "0:a" inside the graph and fail on a plan
  // that touches only the picture.
  const overlayTail = overlayLinks.length > 0 ? `[ov${overlayLinks.length / 2}]` : null;
  const finalV = overlayTail ?? (videoParts.length > 0 ? "[vout]" : kept ? `[${vLabel}]` : "0:v");
  const finalA = audioParts.length > 0 ? "[aout]" : kept ? `[${aLabel}]` : "0:a";

  const args = ["-hide_banner", "-y", "-i", input, ...extraInputs];
  if (graph.length > 0) args.push("-filter_complex", graph);

  args.push("-map", finalV);
  if (source.hasAudio) args.push("-map", finalA);

  args.push(...videoEncodeFor(frameHeight));
  if (source.hasAudio) args.push(...AUDIO_ENCODE);
  args.push(...FASTSTART, output);

  ctx.onProgress?.(0.15, describeWork(plan));

  // Progress from ffmpeg's own reported timestamp, not from a guess.
  await run(FFMPEG, args, {
    onStderr: (chunk) => {
      const m = chunk.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (!m) return;
      const seconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      const fraction = Math.min(1, seconds / Math.max(0.1, effectiveDuration));
      ctx.onProgress?.(0.15 + fraction * 0.85, describeWork(plan));
    },
  });

  if (notes.length === 0) notes.push("re-encoded with no changes requested");
  ctx.onProgress?.(1, "finishing");
  return { output, notes, sourceSeconds: source.duration, estimatedSeconds: effectiveDuration };
}

function describeWork(plan: EditPlan): string {
  const types = new Set(plan.operations.map((o) => o.type));
  if (types.has("burnCaptions")) return "Cutting, reframing and burning captions";
  if (types.has("kenBurns") || types.has("zoomPunch")) return "Cutting, reframing and adding motion";
  if (types.has("removeSilence")) return "Cutting the silences and reframing";
  return "Rendering";
}

export function describe(op: EditOperation): string {
  switch (op.type) {
    case "removeSilence": return "Cutting the silences";
    case "formatForPlatform": return `Reframing for ${op.platform}`;
    case "burnCaptions": return "Burning in captions";
    // Replaced by burnCaptions before the renderer ever sees a plan — see
    // enrich.ts. Named here so the switch stays exhaustive and a future path
    // that skips enrichment fails to compile rather than silently doing nothing.
    case "autoCaptions": return "Burning in captions";
    case "watermark": return "Adding the watermark";
    case "grade": return "Matching the colour to your reference";
    case "kenBurns": return "Adding a slow push";
    case "zoomPunch": return "Adding punch-in zooms";
    case "normalizeLoudness": return "Levelling the audio";
    case "insertBRoll": return "Cutting in your b-roll";
    case "overlayImage": return "Laying your image over the frame";
    case "motionTitle": return "Animating your titles";
  }
}
