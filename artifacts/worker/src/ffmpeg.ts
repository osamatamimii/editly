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
import { beatsOf, everyNth } from "./beats";
import type { EditOperation, EditPlan, GradeLook, TransitionStyle } from "@workspace/api-zod";
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
import { keepSegmentsFrom, outputDuration, remapTime, snapToWords, MOTION_OVERSCAN, type Segment, type SpokenWord } from "./timeline";
import { chooseHighlight } from "./highlight";
import { sayIn, type Language } from "./say";
export { chooseHighlight, chooseClips } from "./highlight";

// These moved to `timeline.ts` so the critic could share them without importing
// the renderer that imports it. Re-exported because this is where callers —
// including the test suites — have always found them.
export { keepSegmentsFrom, outputDuration, remapTime, snapToWords, MOTION_OVERSCAN, type Segment, type SpokenWord };

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
 * The two Unicode characters that say "decide this line's direction from what
 * is in it".
 *
 * ASS has no `dir` attribute, and libass lays a line out left to right unless
 * something in the text says otherwise. For a wholly Arabic line the letters
 * themselves say so and it comes out right — which is exactly why this went
 * unseen. What has no direction of its own is the punctuation: a full stop, a
 * question mark, the ellipsis this renderer appends when a caption is
 * truncated. Those take the *paragraph's* direction, so an Arabic sentence
 * ending in `…` was drawn with the ellipsis at its beginning.
 *
 * FSI takes the direction from the first strong character in the run and PDI
 * closes it — the same rule as `dir="auto"`, chosen for the same reason: it is
 * a better rule than any we would write, and it leaves an English line
 * byte-for-byte where it already was.
 */
const FSI = "\u2068";
const PDI = "\u2069";

/** One line, told to work out its own direction. */
function isolate(line: string): string {
  return line ? `${FSI}${line}${PDI}` : line;
}

/**
 * Whether a line reads right to left — first strong character wins.
 *
 * Deliberately the same rule as the isolate above and as `dir="auto"` in the
 * editor, because three different answers to "which way does this read" is
 * three chances for the frame, the reply and the caption to disagree.
 */
export function readsRightToLeft(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    // Arabic, Hebrew, Syriac, Thaana and the Arabic presentation forms.
    if ((c >= 0x0590 && c <= 0x08ff) || (c >= 0xfb1d && c <= 0xfdff) || (c >= 0xfe70 && c <= 0xfeff)) return true;
    // Latin, Greek and Cyrillic — enough to settle any line this renderer sees.
    if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0xc0 && c <= 0x52f)) return false;
  }
  return false;
}

/**
 * Per-cue animation. These are the effects that make short-form captions read
 * as deliberate rather than as an accessibility track: a small overshoot on
 * entry, and a word-level wipe that tracks the speaker.
 */
function animateCue(cue: CaptionCue, animation: string): string {
  // `wrapToLayout` has already chosen where this cue breaks, for a box that
  // clears the platform's furniture. Those are the lines every animation draws.
  const lines = cue.text
    .replace(/[{}]/g, "")
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
  const body = lines.map(isolate).join("\\N");

  if (animation === "karaoke" && cue.words && cue.words.length > 0) {
    // \kf wipes the fill across each word for exactly its own duration, so the
    // highlight follows the voice instead of a fixed rhythm.
    //
    // And the words are emitted in reverse for a right-to-left line, which
    // looks like vandalism and is the only correct thing to do. A `\kf` tag
    // starts a new layout run — measurably: a colour tag in the same place
    // changes nothing, a karaoke tag splits the line — so libass reorders
    // *within* each word and then sets the words down left to right. Every
    // word was shaped perfectly and the sentence was backwards: a caption that
    // is legible, timed to the voice, and says the sentence in reverse. Laying
    // the runs down in reverse order puts them back where the bidi algorithm
    // would have put them, and an embedded English word still reads left to
    // right because its own run does.
    //
    // ## And it is laid onto the lines the layout chose
    //
    // This branch used to ignore `cue.text` completely and emit every word of
    // the cue as one unbroken run. The wrapping was computed, the truncation
    // was computed, and karaoke threw both away — so a cue that "pop" drew as
    // three lines ending in an ellipsis, karaoke drew as seven lines climbing
    // over the speaker's face and out of the safe band. Nothing failed: the
    // captions were legible, timed and correctly coloured, in the wrong half
    // of the frame. The whole point of `caption-layout.ts` is that a caption
    // never lands under a username, and one of the three animations was not
    // subject to it.
    const rtl = readsRightToLeft(cue.text);
    const remaining = [...cue.words];
    const drawn = lines.map((line) => {
      const tokens = line.split(/\s+/).filter(Boolean);
      const runs = tokens.map((token) => {
        const word = remaining.shift();
        // The tokens come from this cue's own text, so they line up with its
        // words. When they do not — a provider whose text and word list
        // disagree — the line is drawn with what is left rather than dropped,
        // and the timing degrades before the words do.
        if (!word) return { text: token, cs: 0 };
        // `wrapToLayout` marks a truncated cue by appending the ellipsis to the
        // last token it kept. That mark belongs to the caption, not to the
        // word, so it is carried over rather than lost with the tail.
        const text = token.endsWith("…") && !word.text.endsWith("…") ? `${word.text}…` : word.text;
        return { text, cs: Math.max(1, Math.round((word.endMs - word.startMs) / 10)) };
      });
      // Per line, not per cue: lines stack top to bottom in every language, and
      // only the order *within* a line follows the direction of its script.
      const ordered = rtl ? [...runs].reverse() : runs;
      return ordered
        // Each word is isolated too: the run boundary the tag creates is also
        // a boundary the line's own isolate cannot reach across, so a word
        // carrying its sentence's full stop needs its own.
        .map((run) => `{\\kf${run.cs}}${isolate(run.text.replace(/[{}]/g, ""))} `)
        .join("")
        .trimEnd();
    });
    return drawn.join("\\N");
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

/**
 * How many pieces may be given their own decode of the source.
 *
 * An edit that plays out of order cannot share one decoder — see the cut chain
 * for why — so each piece opens the file for itself. That is not free, and it
 * is not linear. Measured on this machine against a 1080p source, peak
 * resident memory for the whole ffmpeg process:
 *
 *     2 pieces   602 MB      5 pieces   912 MB
 *     3 pieces   676 MB      6 pieces  1088 MB
 *     4 pieces   776 MB      8 pieces  1532 MB
 *
 * The worker has 1 GB (fly.toml). Six pieces is already over the box, and an
 * OOM kill is worse than the deadlock this replaced: the job dies with no note
 * and no output, and the customer's minute is spent either way.
 *
 * Four is where the line goes. A cold open on its own produces three pieces —
 * the hook, what came before it, what came after — so the ordinary case fits
 * with room to spare. It takes a cold open *and* a silence cut to make more,
 * and on that plan the join is dropped rather than the render.
 */
const MAX_SEPARATE_DECODES = 4;

/**
 * Do these pieces play in the order they appear in the file?
 *
 * True for every edit that only *removes* material, which is all of them
 * except a cold open. See the transition block for why the difference matters
 * to ffmpeg and not to anything else.
 */
function inSourceOrder(kept: Segment[]): boolean {
  return kept.every((segment, i) => i === 0 || segment.start >= kept[i - 1]!.start);
}

/**
 * What each named look actually does to the picture.
 *
 * `curves` rather than `colorbalance`, and that is not a style preference. The
 * first version of this used `colorbalance=rm=0.08:bm=-0.08`, which reads
 * exactly like what it should do and, measured, does **nothing** — a flat grey
 * frame came out with its U and V planes unmoved at 128, and still unmoved at
 * an absurd 0.20. The check that measures pixels caught it; a check that read
 * the filter string would have passed a feature that did not exist.
 *
 * Every one of these is a small move. The difference between a grade and a
 * filter is restraint, and the fastest way to make footage look cheap is to
 * over-grade it.
 *
 *   warm       red curve up, blue curve down, evenly — measured U 128→124,
 *              V 128→131 on neutral grey. Sunlight, not sepia.
 *   cool       the same curves swapped.
 *   cinematic  the teal-and-orange split, which is the one look here that has
 *              to treat the ends of the range differently: blue lifted in the
 *              shadows and pulled out of the highlights, red the other way.
 *              Measured on a black-to-white ramp, shadows U 128→135 while
 *              highlights go U 128→117 and V 128→132. That gap between the two
 *              ends *is* the look — it is what separates skin from background
 *              without touching either on its own.
 *   mono       saturation to zero, with a little contrast so it is not grey mush.
 *   punch      no hue shift at all, just more contrast and more colour, which
 *              is what people mean by "make it pop".
 *
 * All of these run in the same pass as the rest of the video chain, so a look
 * costs no extra encode.
 */
const GRADE_LOOKS: Record<
  Exclude<GradeLook, "none">,
  { filter: string; inWords: string; inWordsAr: string }
> = {
  warm: {
    filter: "curves=r='0/0 0.5/0.55 1/1':b='0/0 0.5/0.45 1/1'",
    inWords: "warmed the picture",
    inWordsAr: "أدفأت الصورة",
  },
  cool: {
    filter: "curves=r='0/0 0.5/0.45 1/1':b='0/0 0.5/0.55 1/1'",
    inWords: "cooled the picture",
    inWordsAr: "برّدت الصورة",
  },
  cinematic: {
    filter: "curves=b='0/0.12 0.5/0.48 1/0.88':r='0/0 0.55/0.60 1/1',eq=contrast=1.06",
    inWords: "graded it cinematic — blue in the shadows, warmth in the highlights",
    inWordsAr: "درّجتها سينمائية — زرقة في الظلال ودفء في الإضاءات",
  },
  mono: {
    filter: "eq=saturation=0:contrast=1.08",
    inWords: "took the colour out",
    inWordsAr: "نزعت اللون",
  },
  punch: {
    filter: "eq=contrast=1.12:saturation=1.18",
    inWords: "pushed the contrast and colour",
    inWordsAr: "رفعت التباين واللون",
  },
};

const AUDIO_ENCODE = ["-c:a", "aac", "-b:a", "192k", "-ar", "48000"];

/**
 * The ramp at every cut edge of the audio. 15ms sits in the gap between the
 * two perceptual thresholds that matter: far too short to register as a fade,
 * far too long to leave a click — a waveform cut mid-cycle steps
 * discontinuously, and a step is a click across the whole spectrum.
 */
const DECLICK_SECONDS = 0.015;
/**
 * Our style names to ffmpeg's.
 *
 * A map rather than passing the value straight through, because the contract's
 * names are ours to keep stable and ffmpeg's are ffmpeg's to change. `flash` is
 * `fadewhite` — named for what it looks like rather than for how it is done,
 * which is the only one of the ten where those differ.
 */
const XFADE_STYLE: Record<TransitionStyle, string> = {
  dissolve: "fade",
  wipeLeft: "wipeleft",
  wipeRight: "wiperight",
  wipeUp: "wipeup",
  wipeDown: "wipedown",
  slideLeft: "slideleft",
  slideRight: "slideright",
  slideUp: "slideup",
  slideDown: "slidedown",
  flash: "fadewhite",
};

/** The same ten, as the render notes say them. */
/** The same ten in Arabic, for the note the render writes. */
const STYLE_IN_WORDS_AR: Record<TransitionStyle, string> = {
  dissolve: "ذوّبت بين القصّات",
  wipeLeft: "مسحت إلى اليسار بين القصّات",
  wipeRight: "مسحت إلى اليمين بين القصّات",
  wipeUp: "مسحت إلى الأعلى بين القصّات",
  wipeDown: "مسحت إلى الأسفل بين القصّات",
  slideLeft: "انزلقت إلى اليسار بين القصّات",
  slideRight: "انزلقت إلى اليمين بين القصّات",
  slideUp: "انزلقت إلى الأعلى بين القصّات",
  slideDown: "انزلقت إلى الأسفل بين القصّات",
  flash: "ومضت بيضاء بين القصّات",
};

const STYLE_IN_WORDS: Record<TransitionStyle, string> = {
  dissolve: "dissolved between the cuts",
  wipeLeft: "wiped left between the cuts",
  wipeRight: "wiped right between the cuts",
  wipeUp: "wiped up between the cuts",
  wipeDown: "wiped down between the cuts",
  slideLeft: "slid left between the cuts",
  slideRight: "slid right between the cuts",
  slideUp: "slid up between the cuts",
  slideDown: "slid down between the cuts",
  flash: "flashed white between the cuts",
};



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
 * The height is the number that is asked for and the shape decides the width:
 * 1920 vertical gives 1080x1920, 1080 square gives 1080x1080, 1080 widescreen
 * gives 1920x1080. Widths are rounded to even because H.264 chroma
 * subsampling requires it and an odd dimension fails the encode with a message
 * about nothing in particular.
 */
export type FrameShape = "vertical" | "square" | "widescreen";

/** Width divided by height, for each shape we export. */
const SHAPE_RATIO: Record<FrameShape, number> = {
  vertical: 9 / 16,
  square: 1,
  widescreen: 16 / 9,
};

/**
 * Which shape a platform wants.
 *
 * Vertical for the three short-form feeds, widescreen for YouTube, and square
 * for the shape that is not a platform at all — the one several feeds share.
 */
export function shapeFor(platform: string | null | undefined): FrameShape {
  if (platform === "youtube") return "widescreen";
  if (platform === "square") return "square";
  return "vertical";
}

/**
 * The height to export at when nobody names one.
 *
 * 1920 tall for vertical is 1080 across; asking for 1920 on a widescreen frame
 * would be 3413 across, which is nobody's idea of a default. So the default is
 * per shape, and it is the same 1080 on the short edge in every case.
 */
export function defaultHeightFor(shape: FrameShape): number {
  return shape === "vertical" ? 1920 : 1080;
}

const DEFAULT_FRAME_HEIGHT = 1920;

export function frameFor(height: number, shape: FrameShape = "vertical"): { w: number; h: number } {
  const h = Math.round(height / 2) * 2;
  return { w: Math.round((h * SHAPE_RATIO[shape]) / 2) * 2, h };
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
  /**
   * The language this render's notes are written in, taken from the sentence
   * that started it. Absent means English, which is what a render started by
   * a button in an English interface should say.
   */
  language?: Language;
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
  // Every note below is written twice, once in each language, and resolved
  // here. Both halves are required arguments, so a new note cannot be added
  // in English alone — which is exactly how the render came to answer in a
  // different language from the reply that promised it.
  const t = sayIn(ctx.language);
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
        t(
          `the plan asked for ${matches.length} ${type} operations and the render can only apply one, so the first was used`,
          `طلبت الخطّة ${matches.length} عمليات ${type} والمُصيِّر لا يطبّق إلا واحدة، فاستُعملت الأولى`,
        ),
      );
    }
    return matches[0];
  };

  const silence = find("removeSilence");
  const highlight = find("extractHighlight");
  const range = find("extractRange");
  const reframe = find("formatForPlatform");
  // `let`, because the critic revises these once it knows what the edit became.
  let kenBurns = find("kenBurns");
  let zoomPunch = find("zoomPunch");
  let captions = find("burnCaptions");
  const watermark = find("watermark");
  const loudness = find("normalizeLoudness");
  const grade = find("grade");
  const fade = find("fade");
  const transition = find("transition");
  const coldOpen = find("coldOpen");
  const music = find("addMusic");
  /**
   * Resolved here rather than at the mix, because two decisions upstream of
   * the mix depend on whether there will be music: whether the loudness pass
   * has anything to level, and whether the command maps an audio stream at
   * all. A clip with no audio track and a bed under it still has to come out
   * with sound.
   */
  const musicAsset = music ? (ctx.assets?.get(music.assetId) ?? null) : null;
  const musicUsable = musicAsset !== null && musicAsset.kind === "audio";
  const hasAudioOut = source.hasAudio || musicUsable;

  ctx.onProgress?.(0.02, "Looking at your footage");

  // ── Cuts ──────────────────────────────────────────────────────────────────
  let kept: Segment[] | null = null;
  if (silence) {
    if (!source.hasAudio) {
      notes.push(t("no audio track, nothing to trim", "لا مسار صوت، فلا شيء يُقصّ"));
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
            t(
              `${Math.max(moved, before.length - candidate.length)} cut${Math.max(moved, before.length - candidate.length) === 1 ? "" : "s"} moved off the middle of a word`,
              `أُزيحت ${Math.max(moved, before.length - candidate.length)} قصّة عن منتصف كلمة`,
            ),
          );
        }
      }
      if (protect.length > 0) {
        const spared = silences.filter((s) => protect.some((r) => s.start < r.end && s.end > r.start)).length;
        if (spared > 0) {
          notes.push(
            t(
              `${spared} quiet ${spared === 1 ? "stretch was" : "stretches were"} left in because something was happening on screen there`,
              `أُبقيت ${spared} فترة هادئة لأن شيئًا كان يحدث على الشاشة فيها`,
            ),
          );
        }
      }

      if (candidate.length === 0) {
        throw new FfmpegError("The whole clip reads as silence at this threshold — nothing would be left.");
      }
      const keptDuration = candidate.reduce((sum, s) => sum + (s.end - s.start), 0);
      if (keptDuration >= source.duration - 0.01) {
        notes.push(t("no silence found to remove", "لم أجد صمتًا أزيله"));
      } else {
        kept = candidate;
        notes.push(
          t(
            `removed ${(source.duration - keptDuration).toFixed(1)}s of silence across ${silences.length} gaps`,
            `أزلت ${(source.duration - keptDuration).toFixed(1)} ثانية من الصمت موزّعة على ${silences.length} فجوة`,
          ),
        );
      }
    }
  }

  // ── The named range ───────────────────────────────────────────────────────
  //
  // The stretch the person pointed at, applied the same way the highlight is:
  // as an intersection with whatever silence removal kept, so "minute two to
  // three, with the dead air cut" keeps the audible parts of exactly that
  // stretch. No snapping to words here — these numbers were chosen by someone
  // who watched the footage, and second-guessing them is how software gets a
  // reputation for knowing better.
  if (range) {
    const start = Math.max(0, Math.min(range.startSeconds, range.endSeconds));
    const end = Math.min(source.duration, Math.max(range.startSeconds, range.endSeconds));
    if (start >= source.duration - 0.05) {
      notes.push(
        t(
          `the stretch you asked for starts at ${range.startSeconds.toFixed(0)}s, but the clip is only ${source.duration.toFixed(1)}s long — so nothing was cut away`,
          `المدى الذي طلبته يبدأ عند الثانية ${range.startSeconds.toFixed(0)}، والمقطع طوله ${source.duration.toFixed(1)} ثانية فقط — فلم يُقصّ شيء`,
        ),
      );
    } else if (end - start < 0.2) {
      notes.push(
        t(
          "the stretch you asked for is shorter than a fifth of a second, so it was left uncut",
          "المدى الذي طلبته أقصر من خُمس ثانية، فتُرك بلا قصّ",
        ),
      );
    } else {
      const window = { start, end };
      const inside = (kept ?? [{ start: 0, end: source.duration }])
        .map((s) => ({ start: Math.max(s.start, window.start), end: Math.min(s.end, window.end) }))
        .filter((s) => s.end - s.start > 0.05);
      kept = inside.length > 0 ? inside : [window];
      const clamped = range.endSeconds > source.duration + 0.05;
      notes.push(
        clamped
          ? t(
              `kept ${start.toFixed(1)}s to the end — the clip runs out at ${source.duration.toFixed(1)}s, before the ${range.endSeconds.toFixed(0)}s you named`,
              `أبقيت من الثانية ${start.toFixed(1)} إلى النهاية — المقطع ينتهي عند ${source.duration.toFixed(1)} ثانية، قبل الثانية ${range.endSeconds.toFixed(0)} التي سمّيتها`,
            )
          : t(
              `kept ${start.toFixed(1)}s to ${end.toFixed(1)}s, the stretch you asked for`,
              `أبقيت من الثانية ${start.toFixed(1)} إلى ${end.toFixed(1)}، المدى الذي طلبته`,
            ),
      );
    }
  }

  // ── The highlight ─────────────────────────────────────────────────────────
  //
  // Chosen after silence detection and applied as an intersection with it, so
  // "the best 30 seconds, with the dead air cut" means exactly that: the
  // window is picked from the words, and whatever silence removal decided is
  // honoured *inside* it. One `kept` list feeds the concat, the effective
  // duration and the critic, so captions and punches land on the edited clock
  // without anything new learning to count time.
  //
  // A plan carrying both a highlight and a named range is asking two people
  // to hold the scissors. The named range wins: it is the more specific
  // instruction, and a highlight window chosen outside it could escape the
  // very stretch the person pointed at.
  if (highlight && range) {
    notes.push(
      t(
        "the plan asked for both a highlight and a named stretch — the stretch you named won",
        "طلبت الخطّة هايلايت ومدًى مسمّى معًا — والمدى الذي سمّيته هو الذي فاز",
      ),
    );
  }
  if (highlight && !range) {
    const choice = chooseHighlight(source.duration, highlight.targetSeconds, ctx.words);
    if (choice.how === "whole") {
      notes.push(
        t(
          `the clip is ${source.duration.toFixed(1)}s — no longer than the ${Math.round(highlight.targetSeconds)}s you asked to keep, so nothing was cut away`,
          `المقطع طوله ${source.duration.toFixed(1)} ثانية — ليس أطول من ${Math.round(highlight.targetSeconds)} ثانية طلبت إبقاءها، فلم يُقصّ شيء`,
        ),
      );
    } else {
      let window = choice.window;
      if (ctx.words && ctx.words.length > 0) {
        // The scorer starts windows on word starts, but the right edge can
        // still land mid-word; widening both edges to word boundaries costs a
        // breath of extra footage and saves a clipped syllable.
        const snapped = snapToWords([window], ctx.words);
        if (snapped.length === 1) window = { start: snapped[0].start, end: Math.min(source.duration, snapped[0].end) };
      }
      const inside = (kept ?? [{ start: 0, end: source.duration }])
        .map((s) => ({ start: Math.max(s.start, window.start), end: Math.min(s.end, window.end) }))
        .filter((s) => s.end - s.start > 0.05);
      // A window that somehow swallowed every kept stretch would render
      // nothing; the window alone is the least-wrong recovery.
      kept = inside.length > 0 ? inside : [window];
      notes.push(
        choice.how === "speech"
          ? t(
              `kept the strongest ${Math.round(window.end - window.start)}s — ${window.start.toFixed(1)}s to ${window.end.toFixed(1)}s, where the speech runs densest`,
              `أبقيت أقوى ${Math.round(window.end - window.start)} ثانية — من ${window.start.toFixed(1)} إلى ${window.end.toFixed(1)}، حيث الكلام أكثف`,
            )
          : t(
              `we could not hear the words in this clip, so the highlight is its middle ${Math.round(window.end - window.start)}s`,
              `لم نستطع سماع الكلام في هذا المقطع، فالهايلايت هو ${Math.round(window.end - window.start)} ثانية من وسطه`,
            ),
      );
    }
  }

  // ── The cold open ─────────────────────────────────────────────────────────
  //
  // Last of the cut decisions, and the only one that reorders rather than
  // removes: the strongest moment is lifted out of wherever it sits and made
  // the first thing anyone hears, then the rest plays from the top without it.
  //
  // It moves the moment instead of copying it, which is the whole reason this
  // is expressible at all. Every source moment still appears exactly once, so
  // `remapTime` stays a one-to-one map and captions, punches, overlays and
  // titles keep landing where they belong — they simply land in a different
  // order. A copy would have put one sentence on screen twice and made "where
  // does this caption go" a question with two answers.
  if (coldOpen) {
    const base = kept ?? [{ start: 0, end: source.duration }];
    const spanned = base.reduce((sum, s) => sum + (s.end - s.start), 0);
    if (spanned <= coldOpen.seconds * 2) {
      notes.push(
        t(
          "this clip is too short to open on part of itself, so it plays in order",
          "هذا المقطع أقصر من أن يُفتح على جزء من نفسه، فيُعرض بترتيبه",
        ),
      );
    } else {
      const choice = chooseHighlight(source.duration, coldOpen.seconds, ctx.words);
      let window = choice.window;
      if (ctx.words && ctx.words.length > 0) {
        const snapped = snapToWords([window], ctx.words);
        if (snapped.length === 1) window = { start: snapped[0].start, end: Math.min(source.duration, snapped[0].end) };
      }

      // The hook is whatever of that window survived the earlier cuts; the
      // body is everything else, in source order, with the hook's stretch
      // taken out of it. Splitting rather than filtering, because the window
      // usually falls in the *middle* of a kept stretch and that stretch has
      // to become two.
      const hook: Segment[] = [];
      const body: Segment[] = [];
      for (const segment of base) {
        const start = Math.max(segment.start, window.start);
        const end = Math.min(segment.end, window.end);
        if (end - start > 0.05) {
          hook.push({ start, end });
          if (start - segment.start > 0.05) body.push({ start: segment.start, end: start });
          if (segment.end - end > 0.05) body.push({ start: end, end: segment.end });
        } else {
          body.push(segment);
        }
      }

      if (hook.length === 0) {
        notes.push(
          t(
            "could not find a moment strong enough to open on, so it plays in order",
            "لم أجد لحظة قويّة بما يكفي لأفتح عليها، فيُعرض بترتيبه",
          ),
        );
      } else {
        kept = [...hook, ...body];
        const hookSeconds = hook.reduce((sum, s) => sum + (s.end - s.start), 0);
        notes.push(
          choice.how === "speech"
            ? t(
                `opened on the strongest ${hookSeconds.toFixed(1)}s — from ${window.start.toFixed(1)}s — then the rest plays from the top without it`,
                `فتحت على أقوى ${hookSeconds.toFixed(1)} ثانية — من الثانية ${window.start.toFixed(1)} — ثم يُعرض الباقي من البداية بدونها`,
              )
            : t(
                `we could not hear the words, so it opens on ${hookSeconds.toFixed(1)}s from the middle and the rest plays from the top`,
                `لم نستطع سماع الكلام، ففُتح على ${hookSeconds.toFixed(1)} ثانية من الوسط ويُعرض الباقي من البداية`,
              ),
        );
      }
    }
  }

  const videoParts: string[] = [];
  const audioParts: string[] = [];
  let graphPrefix = "";
  let vLabel = "0:v";
  let aLabel = "0:a";

  const extraInputs: string[] = [];

  /**
   * ffmpeg's stream index for the next `-i`, counted rather than derived.
   *
   * It used to be `extraInputs.length / 2 + 1`, which reads as "two args per
   * input" and is true of `-i file` and of nothing else here: a still is
   * `-loop 1 -t D -i file` (six) and the motion layer is `-framerate N -i P`
   * (four). So the first extra input was always right and the second was right
   * only if the first happened to be b-roll — a plan that laid an image over
   * the frame and *then* cut to b-roll asked ffmpeg for stream 4 of a command
   * with three inputs, and the render died on a filtergraph error rather than
   * on anything the person had done. One counter, incremented where the input
   * is actually pushed, cannot drift from the args the way arithmetic over
   * their length can.
   */
  let nextInput = 1; // input 0 is the source
  const addInput = (...args: string[]): number => {
    extraInputs.push(...args);
    return nextInput++;
  };

  // ── The join ──────────────────────────────────────────────────────────────
  //
  // How long each cut overlaps the next. Zero is a hard cut, which is what
  // every edit before this one was. It is decided here, before a single filter
  // is written, because it is not only a look: it is the rate the output clock
  // runs at through every join, and captions, punches, overlays and titles are
  // all placed against that clock further down. One number, computed once,
  // handed to everything.
  let overlap = 0;
  /** The ffmpeg name for the style asked for. */
  let joinStyle = "fade";
  if (transition) {
    const joins = kept ? kept.length - 1 : 0;
    if (joins < 1) {
      // Asking for a transition on an edit with nothing to join is not an
      // error — it is usually a plan built for a longer recording than this one
      // turned out to be. Say what happened rather than silently doing nothing.
      notes.push(
        t(
          "there are no cuts in this edit to put a transition between, so nothing was joined",
          "لا توجد قصّات في هذا التعديل أضع بينها انتقالًا، فلم يُوصَل شيء",
        ),
      );
    } else {
      const asked = transition.durationMs / 1000;
      // The overlap has to fit inside the shortest thing it joins — twice, in
      // fact, since an interior piece is transitioned into on its way in and
      // out of on its way out. Two fifths keeps both inside it with room left
      // that is actually the shot itself; anything more and the shortest piece
      // is never on screen alone, which is not a transition, it is a smear.
      const shortest = Math.min(...kept!.map((segment) => segment.end - segment.start));
      const room = shortest * 0.4;
      if (room < 0.05) {
        notes.push(
          t(
            "the pieces this edit is cut into are too short to put a transition between, so the cuts stay hard",
            "القطع التي قُسّم إليها هذا التعديل أقصر من أن أضع بينها انتقالًا، فتبقى القصّات حادّة",
          ),
        );
      } else if (!inSourceOrder(kept!) && kept!.length > MAX_SEPARATE_DECODES) {
        // Overlapping the joins of an out-of-order edit costs one decoder per
        // piece, and past four of them on a 1080p source that is more memory
        // than the worker has. Trading a missing dissolve for an OOM kill is
        // not a trade: the kill takes the whole render with it and says
        // nothing. See MAX_SEPARATE_DECODES for the measurements.
        notes.push(
          t(
            `this edit opens on a hook and is cut into ${kept!.length} pieces — too many to overlap the joins of an edit that plays out of order, so the cuts stay hard and the hook stands`,
            `هذا التعديل يفتح على خطّاف ومقسوم إلى ${kept!.length} قطعة — أكثر من أن أراكب وصلات تعديل يُعرض بغير ترتيبه، فتبقى القصّات حادّة ويبقى الخطّاف`,
          ),
        );
      } else {
        overlap = Math.min(asked, room);
        joinStyle = XFADE_STYLE[transition.style];
        const named = STYLE_IN_WORDS[transition.style];
        notes.push(
          overlap < asked - 0.001
            ? t(
                `${named} over ${overlap.toFixed(2)}s — shorter than asked, so the shortest piece is still on screen by itself`,
                `${STYLE_IN_WORDS_AR[transition.style]} خلال ${overlap.toFixed(2)} ثانية — أقصر ممّا طُلب، كي تبقى أقصر قطعة على الشاشة وحدها`,
              )
            : t(`${named} over ${overlap.toFixed(2)}s`, `${STYLE_IN_WORDS_AR[transition.style]} خلال ${overlap.toFixed(2)} ثانية`),
        );
      }
    }
  }

  if (kept) {
    const pieces: string[] = [];
    const withAudio = source.hasAudio;
    const last = kept.length - 1;

    /**
     * Does each piece get its own decode of the source, instead of being a
     * `trim` branch off one shared one?
     *
     * Normally not, and normally it would be waste: one decode feeding several
     * trims is exactly what a filter graph is for. But ffmpeg feeds those
     * branches in the order the decoder produces frames, and a cold open is
     * the one thing here that *reorders* the cut list rather than shortening
     * it — the hook comes from the middle of the file and plays first. Chained
     * `acrossfade` over branches that want the file out of order does not come
     * out wrong, it **deadlocks**: measured, three out-of-order pieces never
     * finish at all, and two produce a file with almost no audio in it. That
     * is a job that burns to the worker's timeout with the customer's minute
     * already spent.
     *
     * Seeking each piece on its own input removes the shared decoder, and with
     * it the ordering constraint. It costs one extra seek per piece, which on
     * an input-level `-ss` is close to free, and it is only paid on the plans
     * that need it: an edit that only removes material still reads the file
     * once, forwards, exactly as before.
     */
    const perPieceInput = overlap > 0 && !inSourceOrder(kept);

    kept.forEach((segment, i) => {
      // `fps` is only forced when the joins overlap: xfade reads two streams in
      // lockstep and a variable frame rate walks them out of it, where concat
      // simply plays one after the other and never has to care.
      const cadence = overlap > 0 ? `,fps=${source.fps.toFixed(4)}` : "";

      // `-ss` before `-i` is an input seek: ffmpeg lands on the keyframe before
      // the mark and decodes forward to it, so the piece is frame-accurate and
      // the reading is cheap. `-t` bounds it, which is what `trim` did before.
      const idx = perPieceInput
        ? addInput("-ss", segment.start.toFixed(4), "-t", (segment.end - segment.start).toFixed(4), "-i", input)
        : 0;
      const vSource = perPieceInput
        ? `[${idx}:v]setpts=PTS-STARTPTS${cadence}[cv${i}]`
        : `[0:v]trim=start=${segment.start}:end=${segment.end},setpts=PTS-STARTPTS${cadence}[cv${i}]`;
      pieces.push(vSource);
      if (!withAudio) return;
      // Every audio edge gets a blink-long ramp (15ms — under any perceptual
      // threshold for a fade, well over the one for a click). A cut lands
      // wherever the detector put it, which is rarely a zero crossing, and a
      // waveform that jumps mid-cycle is a broadband click stitched into the
      // join. This is the audio analogue of lanczos on the downscale: not a
      // decision anyone is told about, just the cut done properly — so no
      // note, and no way to turn it off.
      //
      // An edge that a dissolve is about to cross fade over does not get one:
      // the crossfade already ramps it, over a hundred times longer, and two
      // ramps stacked on one edge is an audible dip in the middle of the
      // transition. The outer two edges are still hard cuts out of the source
      // and still get theirs.
      const len = segment.end - segment.start;
      const ramp = Math.min(DECLICK_SECONDS, len / 4);
      const rampIn = overlap > 0 && i > 0 ? 0 : ramp;
      const rampOut = overlap > 0 && i < last ? 0 : ramp;
      const fades = [
        rampIn > 0 ? `afade=t=in:st=0:d=${rampIn.toFixed(4)}` : null,
        rampOut > 0 ? `afade=t=out:st=${Math.max(0, len - rampOut).toFixed(4)}:d=${rampOut.toFixed(4)}` : null,
      ].filter((part): part is string => part !== null);
      pieces.push(
        (perPieceInput
          ? `[${idx}:a]asetpts=PTS-STARTPTS`
          : `[0:a]atrim=start=${segment.start}:end=${segment.end},asetpts=PTS-STARTPTS`) +
          (fades.length > 0 ? `,${fades.join(",")}` : "") +
          `[ca${i}]`,
      );
    });

    if (overlap > 0 && kept.length > 1) {
      // Chained pairwise, because that is the only shape xfade has. Each join
      // starts `overlap` before the end of everything already stitched — and
      // everything already stitched is shorter than the sum of its parts by one
      // overlap per join made so far, which is the whole reason the output
      // clock needs correcting downstream.
      let elapsed = kept[0].end - kept[0].start;
      let vPrevious = "cv0";
      let aPrevious = "ca0";
      for (let i = 1; i < kept.length; i += 1) {
        const offset = elapsed - i * overlap;
        const vOut = i === last ? "cutv" : `xv${i}`;
        pieces.push(
          `[${vPrevious}][cv${i}]xfade=transition=${joinStyle}:duration=${overlap.toFixed(4)}:` +
            `offset=${Math.max(0, offset).toFixed(4)}[${vOut}]`,
        );
        vPrevious = vOut;
        if (withAudio) {
          const aOut = i === last ? "cuta" : `xa${i}`;
          pieces.push(`[${aPrevious}][ca${i}]acrossfade=d=${overlap.toFixed(4)}:c1=tri:c2=tri[${aOut}]`);
          aPrevious = aOut;
        }
        elapsed += kept[i].end - kept[i].start;
      }
    } else {
      pieces.push(
        `${kept.map((_, i) => (withAudio ? `[cv${i}][ca${i}]` : `[cv${i}]`)).join("")}` +
          `concat=n=${kept.length}:v=1:a=${withAudio ? 1 : 0}[cutv]${withAudio ? "[cuta]" : ""}`,
      );
    }
    graphPrefix = `${pieces.join(";")};`;
    vLabel = "cutv";
    if (withAudio) aLabel = "cuta";
  }

  const effectiveDuration = kept ? outputDuration(kept, overlap) : source.duration;

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
      overlap,
      words: ctx.words,
    });
    notes.push(...reviewed.notes);
    const reviewedFind = <T extends EditOperation["type"]>(type: T): Op<T> | undefined =>
      reviewed.operations.find((o) => o.type === type) as Op<T> | undefined;
    kenBurns = reviewedFind("kenBurns");
    zoomPunch = reviewedFind("zoomPunch");
    captions = reviewedFind("burnCaptions");
  }

  // ── Punches on the beat ───────────────────────────────────────────────────
  //
  // Deliberately here, immediately after the critic, because this is the first
  // line in the file where `zoomPunch.at` is on the **output** clock. Emphasis
  // moments are read from the recording and remapped through the cuts; beats
  // come from a bed that is laid under the finished edit, and there is no
  // remapping to do. Placing this earlier would put two different clocks in one
  // array, which is the shape of the bug this renderer keeps finding.
  //
  // And a beat plan with no bed does not quietly become an emphasis plan. Those
  // are different edits, and doing the other one without saying so is the
  // failure this pipeline's notes exist to prevent.
  if (zoomPunch && zoomPunch.on === "beat" && zoomPunch.at.length === 0) {
    if (!musicUsable) {
      notes.push(
        t(
          "there is no music under this edit, so there was no beat to put the punches on",
          "لا موسيقى تحت هذا التعديل، فلم يكن هناك إيقاع أضع عليه التقريبات",
        ),
      );
    } else {
      ctx.onProgress?.(0.42, "Listening for the beat");
      const grid = await beatsOf(musicAsset.file);
      if (!grid) {
        notes.push(
          t(
            "could not find a steady beat in that track, so the punches were left out rather than placed on a guess",
            "لم أجد إيقاعًا ثابتًا في ذلك المقطع، فتُركت التقريبات بدل وضعها على تخمين",
          ),
        );
      } else {
        // The bed may start partway into the track, so a beat at 12.4s in the
        // file is at 12.4 − fromSeconds in the edit. Beats before the bed
        // starts are not beats anybody hears.
        const onEdit = grid.beats
          .map((at) => at - music!.fromSeconds)
          .filter((at) => at >= 0);
        const at = everyNth({ ...grid, beats: onEdit }, 4, { from: 0, to: effectiveDuration }).slice(0, 40);
        if (at.length === 0) {
          notes.push(
            t(
              "the beat in that track starts after this edit ends, so the punches were left out",
              "إيقاع ذلك المقطع يبدأ بعد نهاية هذا التعديل، فتُركت التقريبات",
            ),
          );
        } else {
          zoomPunch = { ...zoomPunch, at };
          const bpm = Math.round(grid.bpm);
          notes.push(
            t(
              `put ${at.length} punch${at.length === 1 ? "" : "es"} on the beat, one a bar at ${bpm} bpm`,
              `وضعت ${at.length} تقريبة على الإيقاع، واحدة كل مازورة عند ${bpm} نبضة في الدقيقة`,
            ),
          );
        }
      }
    }
  }

  // ── Framing ───────────────────────────────────────────────────────────────
  const hasMotion = Boolean(kenBurns || zoomPunch);
  let frameWidth = source.width;
  let frameHeight = source.height;

  if (reframe) {
    const shape = shapeFor(reframe.platform);
    const defaultHeight = defaultHeightFor(shape);
    const asked = frameFor(reframe.maxHeight ?? defaultHeight, shape);
    // What the source can honestly fill: the window of this shape taken out of
    // it, at the scale that window is already being taken at. Generalised from
    // the 9:16-only version — for a widescreen target out of a vertical phone
    // clip the same arithmetic runs the other way round, and it has to.
    const sourceWindowHeight = Math.min(source.height, source.width / SHAPE_RATIO[shape]);
    const ceiling = Math.max(defaultHeight, sourceWindowHeight * HONEST_UPSCALE);
    const target = asked.h > ceiling ? frameFor(ceiling, shape) : asked;
    if (target.h !== asked.h) {
      notes.push(
        t(
          `exported at ${target.h}p rather than ${asked.h}p — this footage has no more detail than that, and the larger file would only be a bigger copy of the same picture`,
          `صُدّر بـ${target.h}p بدل ${asked.h}p — هذه اللقطة لا تحمل تفاصيل أكثر من ذلك، والملفّ الأكبر سيكون نسخة أكبر من الصورة نفسها فقط`,
        ),
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
            ? t(
                `followed the speaker, moving the frame ${Math.round(moves)} time${Math.round(moves) === 1 ? "" : "s"} where they moved`,
                `تابعت المتكلّم، وحرّكت الكادر ${Math.round(moves)} مرّة حيث تحرّك`,
              )
            : t("framed on the speaker and held there", "أطّرت على المتكلّم وثبّت الكادر"),
        );
      } else {
        try {
          const choice = chooseCropCenter(await measureInterest(input), windowFraction);
          cropX = cropOffsetX(choice, scaledWidth, cropW);
          cropXExpr = String(cropX);
          notes.push(
            choice.moved
              ? t(
                  `framed on the subject rather than the centre (${Math.round(choice.center * 100)}% across)`,
                  `أطّرت على الموضوع بدل المنتصف (عند ${Math.round(choice.center * 100)}٪ من العرض)`,
                )
              : t(
                  "kept the centre — nothing in the frame argued for moving off it",
                  "أبقيت المنتصف — لا شيء في الكادر دعا إلى مغادرته",
                ),
          );
        } catch {
          // Measurement is an improvement, not a dependency. A centre crop is
          // still a real edit; failing the render over it would not be.
          notes.push(t("could not read the framing, so the centre was kept", "تعذّرت قراءة التأطير، فأُبقي المنتصف"));
        }
      }
    }

    videoParts.push(
      `scale=${cropW}:${cropH}:force_original_aspect_ratio=increase:flags=lanczos`,
      `crop=${cropW}:${cropH}:'${cropXExpr}':(ih-oh)/2`,
      "setsar=1",
    );
    notes.push(
      t(`reframed to ${target.w}x${target.h} for ${reframe.platform}`, `أُعيد التأطير إلى ${target.w}x${target.h} لـ${reframe.platform}`),
    );
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

    if (kenBurns) {
      notes.push(t(`slow push to ${Math.round(kenBurns.to * 100)}%`, `حركة بطيئة إلى ${Math.round(kenBurns.to * 100)}٪`));
    }
    if (punches.length > 0) {
      notes.push(
        t(`${punches.length} punch-in${punches.length === 1 ? "" : "s"}`, `${punches.length} تقريبة`),
      );
    }
  }

  // ── Grade ─────────────────────────────────────────────────────────────────
  //
  // After motion and before anything drawn on top: the picture is graded, the
  // captions and the mark are not. A watermark whose white drifted with the
  // saturation of the footage under it would read as a rendering fault.
  if (grade) {
    // The look first, then the reference multiplier, so the two compose rather
    // than argue: the look decides the mood and the match decides how much
    // colour there is. Ordered, not merged — merging them would mean deciding
    // for the person which of the two they meant more.
    const look = grade.look ?? "none";
    if (look !== "none") {
      videoParts.push(GRADE_LOOKS[look].filter);
      notes.push(t(GRADE_LOOKS[look].inWords, GRADE_LOOKS[look].inWordsAr));
    }
    if (Math.abs(grade.saturation - 1) > 0.001) {
      // Mono has already taken the colour to zero. Multiplying zero is still
      // zero, so the filter would do nothing — but the note would claim a
      // push toward a reference that cannot happen, which is the kind of small
      // lie this file exists to avoid.
      if (look === "mono") {
        notes.push(
          t(
            "the reference match was left off, because there is no colour left in a black-and-white picture to match with",
            "تُركت مطابقة المرجع، لأن الصورة بالأبيض والأسود لم يبقَ فيها لون يُطابَق",
          ),
        );
      } else {
        videoParts.push(`eq=saturation=${grade.saturation.toFixed(3)}`);
        notes.push(
          grade.saturation > 1
            ? t(
                `colour pushed ${Math.round((grade.saturation - 1) * 100)}% toward your reference`,
                `دُفع اللون ${Math.round((grade.saturation - 1) * 100)}٪ نحو مرجعك`,
              )
            : t(
                `colour pulled back ${Math.round((1 - grade.saturation) * 100)}% toward your reference`,
                `سُحب اللون ${Math.round((1 - grade.saturation) * 100)}٪ نحو مرجعك`,
              ),
        );
      }
    }
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
    /**
     * A wipe needs word times, and the note used to claim it either way.
     *
     * `animateCue` draws a plain fade when a cue has no word timings — the only
     * honest thing it can do, since the wipe is per word — and the note went on
     * saying "(karaoke)". Somebody who asked for the wipe, did not get it, and
     * was told they did has no way to find out why. The provider is what
     * decides this: word times come back from transcription, and a fallback
     * that returns only sentences cannot carry them.
     */
    const wipeable = cues.some((cue) => cue.words && cue.words.length > 0);
    if (captions.animation === "karaoke" && !wipeable) {
      notes.push(
        t(
          `burned ${cues.length} captions, but the words came back without their own timings, so they fade in rather than wiping across`,
          `حرقت ${cues.length} كابشن، لكن الكلمات عادت بلا توقيت خاصّ بها، فتظهر بتلاشٍ بدل المسح كلمةً كلمة`,
        ),
      );
    } else {
      notes.push(t(`burned ${cues.length} captions (${captions.animation})`, `حرقت ${cues.length} كابشن (${captions.animation})`));
    }
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
    notes.push(t(`watermarked "${watermark.text}"`, `وُضعت العلامة المائية "${watermark.text}"`));
  }

  // ── Audio ─────────────────────────────────────────────────────────────────
  if (loudness && hasAudioOut) {
    // -14 LUFS is what every one of these platforms normalises to. Arriving at
    // the right level means they leave the audio alone.
    audioParts.push(`loudnorm=I=${loudness.targetLufs}:TP=-1.5:LRA=11`);
    notes.push(t(`levelled to ${loudness.targetLufs} LUFS`, `سُوّي المستوى إلى ${loudness.targetLufs} LUFS`));
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
      const start = kept ? remapTime(op.at, kept, overlap) : op.at;
      const end = kept ? remapTime(op.at + op.durationSeconds, kept, overlap) : op.at + op.durationSeconds;
      if (end - start < 0.2) {
        notes.push(
          t("dropped a title whose moment did not survive the cut", "أسقطت عنوانًا لم تنجُ لحظته من القصّ"),
        );
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
      if (motionLayer) {
        notes.push(t(`rendered ${titles.length} title${titles.length === 1 ? "" : "s"}`, `صُيّر ${titles.length} عنوان`));
      } else {
        notes.push(
          t("could not render the titles here, so they were left out", "تعذّر تصيير العناوين هنا، فتُركت خارج التعديل"),
        );
      }
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
  const overlayLinks: string[] = [];

  /** Frames the motion layer contributes, averaged back down to one. */
  const motionInputArgs = (): string[] =>
    motionLayer ? ["-framerate", String(motionLayer.fps), "-i", motionLayer.pattern] : [];

  if (overlayOps.length > 0) {
    for (const op of overlayOps) {
      const asset = ctx.assets?.get(op.assetId);
      if (!asset) {
        notes.push(
          t(
            `skipped an overlay: asset ${op.assetId} is not in this project`,
            `تخطّيت تراكبًا: الملفّ ${op.assetId} ليس في هذا المشروع`,
          ),
        );
        continue;
      }
      if (op.type === "overlayImage" && asset.kind !== "image") {
        // The kind is re-derived from the bytes upstream, so this is a plan
        // asking to draw a video as a still, not a mislabelled upload.
        notes.push(
          t("skipped an image overlay: that asset is not an image", "تخطّيت تراكب صورة: ذلك الملفّ ليس صورة"),
        );
        continue;
      }

      const startSrc = op.at;
      const endSrc = op.at + op.durationSeconds;
      const start = kept ? remapTime(startSrc, kept, overlap) : startSrc;
      const end = kept ? remapTime(endSrc, kept, overlap) : endSrc;
      if (end - start < 0.1) {
        // The whole stretch it was pinned to was cut away.
        notes.push(
          t("dropped an overlay whose moment did not survive the cut", "أسقطت تراكبًا لم تنجُ لحظته من القصّ"),
        );
        continue;
      }

      // Each overlay is *two* links — one to prepare the layer, one to composite
      // it — so the number of links is twice the number of stages, and naming
      // the labels after the link count made the second overlay read from a
      // link that was never written: `[ov2]` after a first stage that produced
      // `[ov1]`. Every plan with two or more overlays built a graph ffmpeg
      // could not initialise. Count stages, not links.
      const stage = overlayLinks.length / 2;
      const inLabel = stage === 0 ? "OVBASE" : `ov${stage}`;
      const outLabel = `ov${stage + 1}`;

      let idx: number;
      if (op.type === "overlayImage") {
        // A still needs `-loop 1` to have a duration at all, and a `-t` so the
        // loop is finite: without it ffmpeg never reaches the end of the input
        // and the render does not stop.
        idx = addInput("-loop", "1", "-t", (end + 0.5).toFixed(3), "-i", asset.file);
        const w = Math.max(2, Math.round(frameWidth * op.scale));
        const alpha = op.opacity < 1 ? `,format=rgba,colorchannelmixer=aa=${op.opacity.toFixed(3)}` : "";
        overlayLinks.push(`[${idx}:v]scale=${w}:-2${alpha}[img${idx}]`);
        overlayLinks.push(
          `[${inLabel}][img${idx}]overlay=${OVERLAY_POSITION[op.position]}:` +
            `enable='between(t,${start.toFixed(3)},${end.toFixed(3)})':eof_action=pass[${outLabel}]`,
        );
        notes.push(
          t(`laid an image over the frame at ${start.toFixed(1)}s`, `وضعت صورة فوق الكادر عند الثانية ${start.toFixed(1)}`),
        );
      } else {
        // B-roll: a second clip filling the frame for a while. The source audio
        // is kept underneath, which is what a cutaway is — the picture changes
        // and the person keeps talking.
        idx = addInput("-i", asset.file);
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
        notes.push(
          t(
            `cut to b-roll at ${start.toFixed(1)}s for ${(end - start).toFixed(1)}s`,
            `قطعت إلى لقطة مساندة عند الثانية ${start.toFixed(1)} لمدّة ${(end - start).toFixed(1)} ثانية`,
          ),
        );
      }
    }
  }

  if (motionLayer) {
    const idx = addInput(...motionInputArgs());
    const stage = overlayLinks.length / 2;
    const inLabel = stage === 0 ? "OVBASE" : `ov${stage}`;
    const outLabel = `ov${stage + 1}`;
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

  // ── The bed ───────────────────────────────────────────────────────────────
  //
  // Music is the one thing in this file laid on the *output* clock. Everything
  // else arrives on the source clock and is carried through the cut map,
  // because everything else is pinned to a moment in the recording. A bed is
  // pinned to the finished edit: it starts when the edit starts and ends when
  // it ends, whatever survived the cuts in between.
  //
  // Three shapes come out of here, and which one you get is decided by what is
  // actually in the file, not by what the plan hoped:
  //
  //   speech + music + duck  →  the bed is compressed by the speech itself
  //   speech + music         →  a straight mix at the asked-for level
  //   music alone            →  the bed *is* the audio, and the render maps it
  //
  // The third is why `hasAudioOut` exists. A silent phone clip with a track
  // under it used to come out silent, because every audio decision in here
  // asked whether the *source* had audio.
  const musicParts: string[] = [];
  let musicMixed = false;
  if (music) {
    if (!musicAsset) {
      notes.push(
        t(
          `skipped the music: asset ${music.assetId} is not in this project`,
          `تخطّيت الموسيقى: الملفّ ${music.assetId} ليس في هذا المشروع`,
        ),
      );
    } else if (!musicUsable) {
      // The kind is re-derived from the bytes on upload, so this is a plan
      // asking to play a video file as a song, not a mislabelled file.
      notes.push(
        t("skipped the music: that asset is not an audio file", "تخطّيت الموسيقى: ذلك الملفّ ليس ملفًّا صوتيًّا"),
      );
    } else {
      const inputArgs: string[] = [];
      // `-stream_loop` before `-i` repeats the decoded input; the trim below
      // is what makes the repetition finite. Without the trim a looped bed is
      // an input that never ends and a render that never returns.
      if (music.loop) inputArgs.push("-stream_loop", "-1");
      // Seeking the input rather than trimming the filter means each repeat
      // also starts past the intro, which is the point of asking for it.
      if (music.fromSeconds > 0) inputArgs.push("-ss", music.fromSeconds.toFixed(3));
      inputArgs.push("-i", musicAsset.file);
      const idx = addInput(...inputArgs);

      // The fades are the bed's own, not the edit's: `fade` ramps the finished
      // picture and mix together, and a bed that snapped in under a fade-in
      // would announce itself as an edit. Clamped to a third of the output so
      // the two never meet in the middle of a short clip.
      const askedFade = music.fadeSeconds;
      const fadeSeconds = Math.min(askedFade, effectiveDuration / 3);
      const fadeChain =
        fadeSeconds > 0.01
          ? `,afade=t=in:st=0:d=${fadeSeconds.toFixed(3)}` +
            `,afade=t=out:st=${Math.max(0, effectiveDuration - fadeSeconds).toFixed(3)}:d=${fadeSeconds.toFixed(3)}`
          : "";

      musicParts.push(
        `[${idx}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
          `atrim=0:${effectiveDuration.toFixed(3)},asetpts=PTS-STARTPTS,` +
          `volume=${music.gainDb.toFixed(1)}dB${fadeChain}[mus]`,
      );

      const wantsDuck = music.duck && source.hasAudio;
      if (source.hasAudio) {
        if (wantsDuck) {
          // The speech keys its own ducking. `asplit` because the same stream
          // has to be both the thing you hear and the thing the compressor
          // listens to — ffmpeg will not read one link twice.
          musicParts.push(`[${aLabel}]asplit=2[spmain][spkey]`);
          musicParts.push(
            `[mus][spkey]sidechaincompress=threshold=0.02:ratio=6:attack=15:release=350[musduck]`,
          );
          // `normalize=0` is not a detail. amix averages its inputs by default,
          // so mixing a bed in at -18dB would also drop the voice 6dB — the
          // edit would come out quieter than it went in and the level note
          // above it would be a lie.
          musicParts.push(`[spmain][musduck]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[amix]`);
        } else {
          musicParts.push(`[${aLabel}][mus]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[amix]`);
        }
        aLabel = "amix";
      } else {
        // Nothing to duck under and nothing to mix with: the bed is the track.
        aLabel = "mus";
      }
      musicMixed = true;

      notes.push(
        !source.hasAudio
          ? t(
              `laid music under the whole edit at ${music.gainDb.toFixed(0)}dB — this clip had no sound of its own, so the music is all of it`,
              `وضعت الموسيقى تحت التعديل كلّه عند ${music.gainDb.toFixed(0)}dB — هذا المقطع لا صوت له أصلًا، فالموسيقى هي صوته كلّه`,
            )
          : wantsDuck
            ? t(
                `laid music under the whole edit at ${music.gainDb.toFixed(0)}dB, ducking under the speech`,
                `وضعت الموسيقى تحت التعديل كلّه عند ${music.gainDb.toFixed(0)}dB، تنخفض تحت الكلام`,
              )
            : t(
                `laid music under the whole edit at ${music.gainDb.toFixed(0)}dB`,
                `وضعت الموسيقى تحت التعديل كلّه عند ${music.gainDb.toFixed(0)}dB`,
              ),
      );
      if (fadeSeconds < askedFade - 0.001 && askedFade > 0) {
        notes.push(
          t(
            `the music fades run ${fadeSeconds.toFixed(1)}s rather than the ${askedFade.toFixed(1)}s asked — shorter, so they stay a third of this short edit at most`,
            `تلاشي الموسيقى ${fadeSeconds.toFixed(1)} ثانية بدل ${askedFade.toFixed(1)} المطلوبة — أقصر، كي يبقى ثلث هذا التعديل القصير على الأكثر`,
          ),
        );
      }
    }
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
  graphParts.push(...musicParts);
  if (hasAudioOut && audioParts.length > 0) graphParts.push(`[${aLabel}]${audioParts.join(",")}[aout]`);

  // A bracketed name is a filter label; a bare one is an input stream. Mixing
  // them up makes ffmpeg look for "0:a" inside the graph and fail on a plan
  // that touches only the picture.
  const overlayTail = overlayLinks.length > 0 ? `[ov${overlayLinks.length / 2}]` : null;
  let finalV = overlayTail ?? (videoParts.length > 0 ? "[vout]" : kept ? `[${vLabel}]` : "0:v");
  let finalA = audioParts.length > 0 ? "[aout]" : kept || musicMixed ? `[${aLabel}]` : "0:a";

  // ── The fade ──────────────────────────────────────────────────────────────
  //
  // Last, on the finished picture, so the captions, the watermark and every
  // overlay sink into black together — a fade that spared the watermark would
  // read as a rendering fault, not a style. It touches no clock: the video is
  // exactly as long with it as without it, which is why it composes with the
  // cut map for free where a crossfade at the joins would not. The duration
  // shrinks on a very short clip so the two fades never eat more of it than a
  // fade should.
  if (fade) {
    const asked = fade.durationMs / 1000;
    const d = Math.min(asked, effectiveDuration / 3);
    const outStart = Math.max(0, effectiveDuration - d).toFixed(3);
    const vIn = finalV.startsWith("[") ? finalV : `[${finalV}]`;
    graphParts.push(`${vIn}fade=t=in:st=0:d=${d.toFixed(3)},fade=t=out:st=${outStart}:d=${d.toFixed(3)}[fadev]`);
    finalV = "[fadev]";
    if (hasAudioOut) {
      const aIn = finalA.startsWith("[") ? finalA : `[${finalA}]`;
      graphParts.push(
        `${aIn}afade=t=in:st=0:d=${d.toFixed(3)},afade=t=out:st=${outStart}:d=${d.toFixed(3)}[fadea]`,
      );
      finalA = "[fadea]";
    }
    notes.push(
      d < asked - 0.001
        ? t(
            `faded in and out over ${d.toFixed(1)}s — shorter than asked, so the fades stay a third of this short clip at most`,
            `تلاشٍ في الطرفين خلال ${d.toFixed(1)} ثانية — أقصر ممّا طُلب، كي يبقى ثلث هذا المقطع القصير على الأكثر`,
          )
        : t(
            `faded in from black and out to black over ${d.toFixed(1)}s`,
            `فُتح من السواد وأُغلق إليه خلال ${d.toFixed(1)} ثانية`,
          ),
    );
  }

  const graph = graphPrefix + graphParts.join(";");

  const args = ["-hide_banner", "-y", "-i", input, ...extraInputs];
  if (graph.length > 0) args.push("-filter_complex", graph);

  args.push("-map", finalV);
  if (hasAudioOut) args.push("-map", finalA);

  args.push(...videoEncodeFor(frameHeight));
  if (hasAudioOut) args.push(...AUDIO_ENCODE);
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

  if (notes.length === 0) notes.push(t("re-encoded with no changes requested", "أُعيد الترميز بلا أي تغيير مطلوب"));
  ctx.onProgress?.(1, "finishing");
  return { output, notes, sourceSeconds: source.duration, estimatedSeconds: effectiveDuration };
}

/**
 * A still from the middle of a finished clip.
 *
 * The panel used to mount one <video> per clip just to show what a piece was;
 * six pieces meant six players fetching metadata at once. A poster is one
 * small image each, and the player then loads nothing until somebody presses
 * play.
 *
 * Best-effort by construction: it returns null rather than throwing, because
 * a still is a convenience and a render is paid work.
 */
export async function grabPosterFrame(video: string, seconds: number, destination: string): Promise<string | null> {
  try {
    await run(FFMPEG, [
      "-hide_banner", "-y",
      // Seeking before the input is the fast path, and precision does not
      // matter for a poster: any frame from the middle is the middle.
      "-ss", Math.max(0, seconds).toFixed(2),
      "-i", video,
      "-frames:v", "1",
      // Tall enough to stay sharp on a retina panel row, small enough that
      // six of them cost less than one second of video.
      "-vf", "scale=-2:360",
      "-q:v", "4",
      destination,
    ]);
    return destination;
  } catch {
    return null;
  }
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
    case "extractHighlight": return "Finding the strongest stretch";
    case "extractRange": return "Cutting to the stretch you named";
    // Expanded by the worker into one extractRange render per clip before the
    // renderer ever sees a plan — see index.ts. Named here so the switch stays
    // exhaustive and a future path that skips the expansion fails to compile.
    case "extractClips": return "Cutting it into clips";
    case "coldOpen": return "Opening on the strongest moment";
    case "fade": return "Fading in and out";
    case "transition": return "Joining the cuts";
    case "formatForPlatform": return `Reframing for ${op.platform}`;
    case "burnCaptions": return "Burning in captions";
    // Replaced by burnCaptions before the renderer ever sees a plan — see
    // enrich.ts. Named here so the switch stays exhaustive and a future path
    // that skips enrichment fails to compile rather than silently doing nothing.
    case "autoCaptions": return "Burning in captions";
    case "watermark": return "Adding the watermark";
    case "grade": return op.look && op.look !== "none" ? "Grading the picture" : "Matching the colour to your reference";
    case "kenBurns": return "Adding a slow push";
    case "zoomPunch": return "Adding punch-in zooms";
    case "normalizeLoudness": return "Levelling the audio";
    case "addMusic": return "Laying the music under it";
    case "insertBRoll": return "Cutting in your b-roll";
    case "overlayImage": return "Laying your image over the frame";
    case "motionTitle": return "Animating your titles";
  }
}
