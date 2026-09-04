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
import { guard, LIMITS, type Limits } from "./deadline";
import { writeFile, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { criticise, settlePunches } from "./critic";
import { renderMotionLayer, MOTION_SUBSAMPLES, type MotionTitle } from "./motion";
import { beatsOf, everyNth } from "./beats";
import type { EditOperation, EditPlan, GradeLook, TransitionStyle } from "@workspace/api-zod";
import {
  captionLayout,
  nominalSizeFor,
  widthInCaps,
  linesFor,
  balancedLines,
  CAPTION_FACES,
  facePair,
  type CaptionFace,
  type FacePair,
  type CaptionLayout,
} from "./caption-layout";
import { emphasisScore, medianOf, EMPHASIS_MIN_SCORE } from "./captions";
import {
  chooseCropCenter,
  coverScale,
  cropExpression,
  cropOffsetX,
  pathWithinCut,
  measureInterest,
  subjectPath,
  MIN_SUBJECT_COVERAGE,
} from "./framing";
import { trackSubject, trackNote } from "./subject";
import { overscanFor, scaleFor, takesFrom } from "./shots";
import { keepSegmentsFrom, mergeSpans, outputDuration, remapTime, snapToWords, snapToSpeechBreaks, MOTION_OVERSCAN, type RemovableSpan, type Segment, type SpokenWord } from "./timeline";
import { tighten, type TightenResult } from "./tighten";
import { placeSoundEffects, joinTimes, MIN_EDIT_SECONDS as SFX_MIN_EDIT_SECONDS, type SfxPalette } from "./sfx";
import { chooseHighlight } from "./highlight";
import { chooseConversationClips, type Reading } from "./conversation";
import { sayIn, type Language } from "./say";
import { threadArgs } from "./cores";
export { chooseHighlight, chooseClips } from "./highlight";

// These moved to `timeline.ts` so the critic could share them without importing
// the renderer that imports it. Re-exported because this is where callers —
// including the test suites — have always found them.
export { keepSegmentsFrom, mergeSpans, outputDuration, remapTime, snapToWords, snapToSpeechBreaks, MOTION_OVERSCAN, type RemovableSpan, type Segment, type SpokenWord };

export interface SourceInfo {
  width: number;
  height: number;
  fps: number;
  /**
   * How long the *picture* runs.
   *
   * Was the container's duration, which is the longest stream in the file —
   * and a screen recorder, or anything remuxed, routinely writes audio that
   * outlasts its video. Every end-anchored decision is computed from this: the
   * fade-out never ran on such a file while the note said it had, a ken burns
   * push stopped at four fifths of the way with nothing said, and the meter
   * billed for seconds of picture that do not exist. The video stream's own
   * duration is the one the frames end at.
   */
  duration: number;
  hasAudio: boolean;
  /**
   * Degrees of rotation the container asks for, if any.
   *
   * A phone shooting portrait stores a landscape frame plus a display matrix,
   * and ffmpeg rotates on decode — so the filter graph receives a frame the
   * *reported* width and height describe transposed. Nothing read this, so a
   * portrait clip with any motion operation was scaled to an exact 1920x1080
   * and came out stretched to three times its proper width.
   */
  rotation: number;
}

/**
 * How far a chosen window may move to land on a pause.
 *
 * A share of the ask rather than a fixed number of seconds, because the same
 * two seconds mean different things: on a four-second hook it is half the
 * clip, and on a ninety-second highlight it is noise. Fifteen per cent, with a
 * floor so a very short ask can still move at all and a ceiling so a very long
 * one cannot wander.
 *
 * The budget is the honesty in this: somebody asked for thirty seconds, and a
 * clip that quietly became forty-one because the sentences ran long is not
 * what they asked for.
 */
function breathingRoom(targetSeconds: number): number {
  return Math.min(4, Math.max(0.75, targetSeconds * 0.15));
}

const FFMPEG = process.env["FFMPEG_PATH"] ?? "ffmpeg";
const FFPROBE = process.env["FFPROBE_PATH"] ?? "ffprobe";

export class FfmpegError extends Error {}

function run(
  bin: string,
  args: string[],
  options: { onStderr?: (chunk: string) => void; limits?: Omit<Limits, "what"> } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    // Nothing here may run forever; see deadline.ts for what a hang does to
    // the rest of the platform. The default is the render's, because the
    // unqualified call in this file is the render.
    const deadline = guard(child, { ...(options.limits ?? LIMITS.render), what: bin });
    let stdout = "";
    /*
      The last few kilobytes of stderr, not all of it.

      Only `tail.slice(-10)` is ever read, and only on failure — but the whole
      stream was retained. The render is spawned at ffmpeg's default log level,
      so every progress rewrite and every per-frame warning accumulated: at 30
      fps over a three-hour encode that is hundreds of thousands of lines, tens
      to hundreds of megabytes of UTF-16, on the one box in this system where an
      OOM kill is documented as "the job dies with no note and no output while
      the customer's minute is spent either way".

      Sixteen kilobytes is far more than the ten lines that get read and small
      enough to be free.
    */
    const STDERR_KEPT_BYTES = 16 * 1024;
    let stderr = "";
    child.stdout.on("data", (d) => {
      deadline.touch();
      // Not capped: the only things read from stdout here are ffprobe answers,
      // which are a handful of lines, and truncating one would corrupt it.
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      deadline.touch();
      const text = d.toString();
      stderr += text;
      if (stderr.length > STDERR_KEPT_BYTES) stderr = stderr.slice(-STDERR_KEPT_BYTES);
      options.onStderr?.(text);
    });
    child.on("error", (err) => {
      deadline.clear();
      reject(new FfmpegError(`${bin} could not be started: ${err.message}`));
    });
    child.on("close", (code) => {
      deadline.clear();
      // Before the exit code, because a killed child closes with a code like
      // any other and would otherwise be reported as an ordinary failure —
      // or, worse, as a success on the wrappers that tolerate a bad code.
      if (deadline.expired) {
        reject(deadline.error);
        return;
      }
      if (code === 0) resolve({ stdout, stderr });
      else {
        // ffmpeg's useful message is always the last few lines, never the
        // first — and the *first* line is what anything downstream takes when
        // it needs one sentence. It used to be `${bin} exited ${code}`, so
        // every render failure in the product read "ffmpeg exited 1": a binary
        // name and a number, with the actual complaint sitting on the lines
        // below where nobody looked. Put the complaint first and the exit code
        // where it belongs, which is after it.
        /*
          Split on carriage returns too, and skip the progress it writes with
          them.

          ffmpeg reports progress by rewriting one line — `frame= 120 fps=30
          q=28.0 size=...` terminated with `\r`, not `\n` — so on a render
          that got as far as encoding, the whole progress stream is a single
          "line" and it is the last one. The complaint that was meant to lead
          the message ended up underneath a block of counters, and the sentence
          the product showed was the counters.

          And a killed child closes with `code === null`, which read as
          "ffmpeg exited null" — a sentence that names neither what happened
          nor what to do about it.
        */
        const tail = stderr
          .split(/[\r\n]+/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0 && !/^(frame|size)=/.test(line));
        const ended = code === null ? `${bin} was stopped before it finished` : `${bin} exited ${code}`;
        const complaint = tail[tail.length - 1] ?? ended;
        reject(new FfmpegError(`${complaint}\n${ended}\n${tail.slice(-10).join("\n")}`));
      }
    });
  });
}

// ─── Probing ────────────────────────────────────────────────────────────────

export async function probeSource(file: string): Promise<SourceInfo> {
  const { stdout } = await run(FFPROBE, [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,avg_frame_rate,duration",
    "-show_entries", "stream_side_data=rotation",
    "-show_entries", "stream_tags=rotate",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1",
    file,
  ], { limits: LIMITS.probe });

  const read = (key: string): string | undefined =>
    stdout.split("\n").find((l) => l.startsWith(`${key}=`))?.split("=")[1]?.trim();

  const rotationText = read("rotation") ?? read("TAG:rotate") ?? read("rotate");
  const turned = Number.parseFloat(rotationText ?? "");
  // ffmpeg reports the matrix as a negative angle where the tag is positive;
  // only the quarter turns matter here, and only whether they transpose.
  const rotation = Number.isFinite(turned) ? ((Math.round(turned / 90) * 90) % 360 + 360) % 360 : 0;
  const transposed = rotation === 90 || rotation === 270;

  const codedWidth = Number.parseInt(read("width") ?? "", 10);
  const codedHeight = Number.parseInt(read("height") ?? "", 10);
  const width = transposed ? codedHeight : codedWidth;
  const height = transposed ? codedWidth : codedHeight;

  /*
    The picture's own length, falling back to the container's.

    `format=duration` is the longest stream in the file. A screen recorder, or
    anything remuxed, writes audio that outlasts its video — and every
    end-anchored decision in the render is computed from this number, so the
    fade-out was written past the last frame and never ran while its note said
    it had. Some containers do not carry a per-stream duration; for those the
    old answer is still the best one available.
  */
  const streamSeconds = Number.parseFloat(read("duration") ?? "");
  const containerSeconds = Number.parseFloat(
    stdout.split("\n").filter((l) => l.startsWith("duration=")).pop()?.split("=")[1]?.trim() ?? "",
  );
  const duration = Number.isFinite(streamSeconds) && streamSeconds > 0 ? streamSeconds : containerSeconds;

  if (!Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(duration) || duration <= 0) {
    throw new FfmpegError(`Could not read ${path.basename(file)} as a video. Is the file complete?`);
  }

  const [num, den] = (read("avg_frame_rate") ?? "30/1").split("/").map(Number);
  const fps = den > 0 && num > 0 ? num / den : 30;

  return { width, height, fps, duration, rotation, hasAudio: await hasAudioStream(file) };
}

export async function probeDuration(file: string): Promise<number> {
  return (await probeSource(file)).duration;
}

/**
 * How long a file is, from the container, whatever streams it has.
 *
 * `probeDuration` goes through `probeSource`, which wants a video stream and
 * throws "Could not read … as a video" on a music file. That is right for a
 * source clip and wrong for a bed — and it was found the honest way: the first
 * version of the beat-loop fix called `probeDuration(musicAsset.file)` with a
 * `.catch(() => 0)` on it, which turned the throw into a zero, which turned the
 * fix off. The catch hid the bug it was written to work around.
 *
 * ## And `0` was the same bug through the front door
 *
 * The guard below used to answer `0` for anything it could not read, which the
 * caller compared against and treated as "no loop to correct for" — the exact
 * state the catch produced. `ffprobe` answers `N/A` for a headerless MP3 or
 * ADTS stream and for some streamed containers, `Number("N/A")` is `NaN`, and
 * the correction switched itself off for those files while the note went on
 * saying the punches had been placed across the whole edit.
 *
 * `null` is "nobody could measure this", which is a different claim from "this
 * is zero seconds long" and is the one that is true. The caller has to decide
 * what to do about it, which is the point.
 */
export async function containerSeconds(file: string): Promise<number | null> {
  const { stdout } = await run(FFPROBE, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "csv=p=0",
    file,
  ], { limits: LIMITS.probe });
  const seconds = Number(stdout.trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

export async function hasAudioStream(file: string): Promise<boolean> {
  const { stdout } = await run(FFPROBE, [
    "-v", "error",
    "-select_streams", "a",
    "-show_entries", "stream=index",
    "-of", "csv=p=0",
    file,
  ], { limits: LIMITS.probe });
  return stdout.trim().length > 0;
}

// ─── Silence ────────────────────────────────────────────────────────────────

/**
 * Finds stretches of near-silence using ffmpeg's silencedetect filter, which
 * reports them on stderr as it scans. Returns them in order.
 */
/**
 * The loudest the recording gets, in dBFS, or null if nothing could be read.
 *
 * `silencedetect` takes an absolute level, and an absolute level is only
 * meaningful against a recording made at an ordinary one. A phone held at
 * arm's length, a lavalier with its gain down, a Zoom call recorded at the
 * default: these arrive peaking at -30 dBFS and below, and every one of them
 * read as silence from end to end. The render then threw "The whole clip reads
 * as silence at this threshold: nothing would be left" and the job failed for
 * good — on a file every other editor handles by looking at the level first.
 *
 * Audio only, so it costs a fraction of a second even on a long file.
 */
export async function peakDb(file: string): Promise<number | null> {
  let buffer = "";
  await run(FFMPEG, ["-hide_banner", "-vn", "-i", file, "-af", "volumedetect", "-f", "null", "-"], {
    onStderr: (chunk) => {
      buffer += chunk;
    },
  });
  const found = buffer.match(/max_volume:\s*(-?[\d.]+) dB/);
  const value = found ? Number.parseFloat(found[1]!) : NaN;
  return Number.isFinite(value) ? value : null;
}

/**
 * How far under the loudest moment the silence threshold has to sit.
 *
 * Only a floor, and only ever moves the threshold down. A recording made at an
 * ordinary level peaks well above the plan's -32 dBFS and nothing changes; a
 * recording that peaks at -34 has no sample anywhere above the threshold, so
 * every second of it reads as silence and the render fails outright. Twelve
 * decibels is a healthy gap between where a person's voice peaks and where the
 * pauses between their words sit.
 */
const QUIET_HEADROOM_DB = 12;

/**
 * How far the threshold may be moved. Past thirty decibels there is no signal
 * left to find, only the noise floor, and cutting against a noise floor
 * removes the room rather than the pauses.
 */
const MAX_THRESHOLD_SHIFT_DB = 30;

export async function detectSilences(
  file: string,
  thresholdDb: number,
  minSilenceSeconds: number,
): Promise<Segment[]> {
  let buffer = "";
  await run(
    FFMPEG,
    // `-vn` because this reads the sound and nothing else. Without it ffmpeg
    // decodes the picture too and throws every frame away: measured on a
    // forty-second 1080p clip, 2.29s with the video stream and 0.16s without —
    // fourteen times the work for nothing. On a ninety-minute podcast that is
    // five minutes of decoding per scan, and the clips path scans the whole
    // source once per clip.
    ["-hide_banner", "-vn", "-i", file, "-af", `silencedetect=noise=${thresholdDb}dB:d=${minSilenceSeconds}`, "-f", "null", "-"],
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
    /**
     * Shot sizes held across stretches of the finished video, from `shots.ts`.
     *
     * `scale` is relative to the frame that was asked for: 1 is that frame, and
     * anything below it pulls back into the overscan. These are the only terms
     * here that can be negative, and the only ones with no ramp — see below.
     */
    takes?: Array<{ from: number; to: number; scale: number }>;
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

  /*
    A step, deliberately, where everything above it is a ramp.

    A punch eases over a quarter of a second because the movement is the
    emphasis. A shot size is the opposite: the illusion is that a second camera
    was already running at this size, so the size has to be there in the first
    frame of the shot with nothing travelling into it. Anything else is one
    camera zooming across a cut, which is the amateur move this replaces.

    `between` is inclusive at both ends, and that is safe here rather than
    lucky: `alternateShots` merges neighbouring stretches of the same size, so
    no two terms can ever be open at the same instant. The single frame that
    lands exactly on a boundary belongs to the size that is ending, which is the
    frame the cut is on anyway.
  */
  for (const take of options.takes ?? []) {
    if (Math.abs(take.scale - 1) < 0.0005) continue;
    // Parenthesised because a wide take's term is negative and the parts of
    // this expression are joined with "+": `1.15+-0.15*...` is not something
    // the expression parser reads, and the failure would be at render time.
    const delta = ((take.scale - 1) * base).toFixed(4);
    terms.push(`(${delta})*between(on/${fps.toFixed(4)},${take.from.toFixed(3)},${take.to.toFixed(3)})`);
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
  /*
    The box style, with the wipe running the way a wipe runs.

    It was primary white and secondary yellow, which is backwards: with `\kf`
    the words already spoken take the *primary* colour and the ones still to
    come take the secondary, so the yellow was on the part of the line nobody
    had said yet. Most of the line was loud, the eye was pulled to the words
    ahead of the voice, and the colour drained away as the sentence was read.
    Nothing was broken — it is a legible caption with the two colours the other
    way round — and it is the difference between the line filling with colour
    as somebody speaks and the line emptying of it.
  */
  "karaoke-box": {
    primary: "&H0000E5FF", secondary: "&H00FFFFFF", outline: "&H00000000", back: "&HC0000000",
    /*
      `Outline` is the box's padding when BorderStyle is 3, not a stroke.

      It was 0, so the style called "karaoke-box" drew a box of zero size and
      had never drawn a box at all. On anything dark that is invisible and
      fine; on a beige wall or a bright sky it is white text on a light ground,
      which is the one thing an opaque backing exists to prevent. Six pixels is
      about a fifth of the cap height at the sizes this renders at.

      `Shadow` stays 0: BorderStyle 3 already fills behind the line, and a drop
      shadow under an opaque box is a second rectangle offset from the first.
    */
    borderStyle: 3, outlineWidth: 6, shadow: 0,
  },
};

/**
 * The two style names a cue can be drawn in.
 *
 * One file, two faces, chosen per line by what the line is written in. A
 * caption in Arabic under the Latin style renders — libass falls back per
 * glyph and shapes it correctly — it just renders a fifth too large, because
 * the fallback face draws its own cap height against a nominal size picked for
 * a different one. Nothing reports that. It is only visible beside a Latin
 * caption, and only to somebody looking for it.
 */
const LATIN_STYLE = "Cap";
const RTL_STYLE = "CapRtl";

/**
 * The style row, built from the layout rather than frozen in a string.
 *
 * The old rows hardcoded size 72 and 180 px of bottom margin, which was correct
 * for exactly one frame size and wrong for every platform: 180 px sits inside
 * TikTok's bottom furniture, so the last line of every caption was drawn under
 * the username. Size and margins now come from caption-layout.ts.
 */
/**
 * The old character-count wrap, kept for a caller that hands in a partial
 * layout — a shape a couple of tests use and nothing in the product does.
 */
function countedLines(text: string, maxCharsPerLine: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && candidate.length > maxCharsPerLine) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function captionStyleRow(
  name: string,
  face: CaptionFace,
  style: string,
  layout: CaptionLayout,
): string {
  const c = CAPTION_COLOURS[style] ?? CAPTION_COLOURS["bold-white"];
  return [
    `Style: ${name}`, face.family, String(nominalSizeFor(face, layout)),
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
/**
 * What a kinetic caption needs to know about the frame it is drawn in.
 *
 * Only the width question, and it is not a nicety. See `POP_SCALE`.
 */
export interface KineticContext {
  /** Typical word length across the whole track, in ms. The pace to judge against. */
  typicalWordMs: number;
  /** True when this line can grow by `POP_SCALE` and still be inside the frame. */
  fits: (line: string, rtl: boolean, scale: number) => boolean;
}

/**
 * How much larger the stressed word is drawn at the peak of its pop.
 *
 * The scale is a taste decision; whether it is applied is not.
 *
 * `WrapStyle: 2` means libass does no wrapping of its own — a line wider than
 * its box runs out of it rather than breaking — and `wrapToLayout` sizes every
 * line to fill that box **at 100%**. Growing one word therefore grows the whole
 * line, by roughly that word's share of it: measured on a three-word line in a
 * 488-pixel band, 394 pixels drawn became 400. Five per cent, not fifteen, and
 * small enough that most captions would never notice.
 *
 * It is still checked, because "most" is the wrong word for a guarantee. The
 * band is not decoration — it is what keeps a caption clear of the platform's
 * own furniture, the username and the buttons — and a line that `wrapToLayout`
 * has filled to the last pixel is exactly the line a pop would push past it.
 * A full line gets the colour without the scale: emphasis in two halves, and
 * the half that can cost something is the half that gets measured.
 */
export const POP_SCALE = 1.15;

/** Up, then back. Long enough to read as weight, short enough not to strobe. */
const POP_RISE_MS = 140;
const POP_FALL_MS = 160;

/**
 * The colour a stressed word takes, per style.
 *
 * Each one is a colour the style does not already use for its body text —
 * emphasis that matches the rest of the line is not emphasis. ASS colours are
 * `&HAABBGGRR`, which is backwards from every other format and the single
 * easiest thing here to get wrong.
 */
const EMPHASIS_COLOUR: Record<string, string> = {
  // Yellow on white.
  "bold-white": "&H00E5FF&",
  // White on yellow: the same pair, the other way round.
  "bold-yellow": "&HFFFFFF&",
  "karaoke-box": "&H00E5FF&",
};

/**
 * A style colour as an override tag takes it.
 *
 * The table stores `&HAABBGGRR` because that is what a Style row wants; `\c`
 * and `\1c` want `&HBBGGRR&`, with no alpha and a trailing ampersand. Two
 * spellings of the same colour, and getting it wrong is silent: libass ignores
 * a tag it cannot parse, so the word simply never changes colour.
 */
function bareColour(colour: string): string {
  return `&H${colour.replace(/^&H/i, "").replace(/&$/, "").slice(-6)}&`;
}

function animateCue(
  cue: CaptionCue,
  animation: string,
  style: string,
  kinetic: KineticContext | null,
): string {
  // `wrapToLayout` has already chosen where this cue breaks, for a box that
  // clears the platform's furniture. Those are the lines every animation draws.
  const lines = cue.text
    .replace(/[{}]/g, "")
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
  const body = lines.map(isolate).join("\\N");

  // The style's own colours and border, needed by two of the three animations:
  // karaoke reads the pair it transitions between, and kinetic reads whether
  // there is a box it must not hide along with the letters.
  const colours = CAPTION_COLOURS[style] ?? CAPTION_COLOURS["bold-white"]!;

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
        // and the timing degrades before the words do. One centisecond rather
        // than none: `\kf0` is a degenerate tag, and the whole file already
        // holds every wipe above zero for that reason.
        if (!word) return { text: token, startMs: null, endMs: null };
        // `wrapToLayout` marks a truncated cue by appending the ellipsis to the
        // last token it kept. That mark belongs to the caption, not to the
        // word, so it is carried over rather than lost with the tail.
        const text = token.endsWith("…") && !word.text.endsWith("…") ? `${word.text}…` : word.text;
        return { text, startMs: word.startMs, endMs: word.endMs };
      });

      /*
        Right to left, the highlight is a colour and not a wipe. Measured, and
        it had to be.

        `\kf` sweeps in **visual** order, left to right, whatever the script.
        The runs above are laid down in reverse for a right-to-left line — see
        the note at the top of this branch, which is correct and was verified
        again here with libass — so the leftmost run is the *last* word. Put
        those two facts together and the wipe on every Arabic caption this
        product has ever rendered started on the last word of the line and
        travelled to the first: legible, timed to something, and running
        backwards through the sentence.

        There is no spelling of `\kf` that fixes it, because the sweep is a
        property of the geometry. So right-to-left gets the same highlight by
        another mechanism: each word starts in the secondary colour and
        transitions to the primary over its own interval, timed with `\t`,
        which is anchored to the line and does not care where the word sits.
        Same two colours, same moment, correct order.
      */
      if (rtl) {
        const ordered = [...runs].reverse();
        return ordered
          .map((run) => {
            const body = isolate(run.text.replace(/[{}]/g, ""));
            if (run.startMs === null || run.endMs === null) return `${body} `;
            const from = Math.max(0, Math.round(run.startMs - cue.startMs));
            const to = Math.max(from + 1, Math.round(run.endMs - cue.startMs));
            return `{\\c${bareColour(colours.secondary)}\\t(${from},${to},\\c${bareColour(colours.primary)})}${body} `;
          })
          .join("")
          .trimEnd();
      }

      /*
        And left to right, the gaps between words are part of the wipe.

        `\kf` durations are cumulative from the start of the line, so emitting
        only each word's own length silently shifts everything after it earlier
        by the silence in front of it. A cue is only broken at a pause of half
        a second (`breakOnPauseMs`), so it legitimately contains gaps of up to
        499 ms each — and by the last word of a three-second cue the highlight
        could be the better part of a second ahead of the voice. Which is the
        one thing a karaoke caption is for.

        The gap is carried on the space that separates the words: `{\k<gap>}`
        on a space consumes that time without colouring anything, which is how
        a karaoke script has always written a rest. Checked against libass
        rather than reasoned about: without it the sweep on a
        `So … anyway … listen` cue finished 850 ms early.
      */
      let cursorMs = cue.startMs;
      const pieces = runs.map((run) => {
        const body = isolate(run.text.replace(/[{}]/g, ""));
        if (run.startMs === null || run.endMs === null) return `{\\kf1}${body}`;
        const gapCs = Math.round((run.startMs - cursorMs) / 10);
        const wipeCs = Math.max(1, Math.round((run.endMs - run.startMs) / 10));
        cursorMs = run.endMs;
        const rest = gapCs > 0 ? `{\\k${gapCs}}` : "";
        return `${rest}{\\kf${wipeCs}}${body}`;
      });
      // The separator carries the next word's rest, so it is written between
      // the pieces rather than appended to each of them.
      return pieces.reduce((line_, piece, at) => (at === 0 ? piece : `${line_} ${piece}`), "");
    });
    return drawn.join("\\N");
  }

  if (animation === "kinetic" && kinetic && cue.words && cue.words.length > 0) {
    /*
      Words that arrive with the voice, and one that is leaned on.

      Two mechanisms, and they are separated on purpose because only one of
      them can change the geometry of a line:

      **Reveal** is `\alpha`, and alpha does not touch a glyph's advance width.
      A word that has not been said yet still occupies its space, so nothing
      moves as the line fills in — which is the whole difference between a
      caption arriving and a caption reflowing.

      **Emphasis** is a colour and, where there is room, a scale that overshoots
      and settles back to 100%. It returns to 100% so the line's final geometry
      is the geometry `wrapToLayout` measured; the widening lasts 300ms and is
      the movement the eye reads as weight.

      ## And the runs are laid down in reverse for a right-to-left line

      Measured, not assumed, and it is the same finding the karaoke branch
      records: an override block carrying `\alpha` and `\t` starts a new layout
      run, exactly as `\kf` does. libass reorders *within* each run and then
      sets the runs down left to right — so the first word of an Arabic
      sentence lit up at the **left** end of the line. Every word shaped
      perfectly, the sentence backwards. Reversing puts them back where the
      bidi algorithm would have put them.
    */
    const rtl = readsRightToLeft(cue.text);
    const words = cue.words;

    // At most one per cue. Two stressed words in one breath is not emphasis,
    // it is a style — and it reads as the caption flickering.
    let stressed = -1;
    let best = EMPHASIS_MIN_SCORE;
    for (let i = 0; i < words.length; i += 1) {
      const score = emphasisScore(words[i], words[i - 1], kinetic.typicalWordMs);
      if (score >= best) {
        best = score;
        stressed = i;
      }
    }

    const accent = EMPHASIS_COLOUR[style] ?? EMPHASIS_COLOUR["bold-white"];
    const remaining = [...words];
    let index = 0;

    const drawn = lines.map((line) => {
      // Whether *this* line can afford the pop, not the cue. A cue's lines are
      // wrapped independently and only one of them is usually near the edge.
      const roomToPop = kinetic.fits(line, rtl, POP_SCALE);
      const tokens = line.split(/\s+/).filter(Boolean);
      const runs = tokens.map((token) => {
        const word = remaining.shift();
        const at = index;
        index += 1;
        // The tokens come from this cue's own text so they line up with its
        // words. Where a provider's text and word list disagree, the line is
        // drawn from what is left and the timing degrades before the words do.
        if (!word) return { text: token, tags: "" };
        // `wrapToLayout` marks a truncated cue by appending the ellipsis to the
        // last token it kept. That mark belongs to the caption, not the word.
        const text = token.endsWith("…") && !word.text.endsWith("…") ? `${word.text}…` : word.text;

        // Relative to the line's own start, which is what `\t` measures from.
        // Clamped at zero: a word whose timing starts a hair before its cue
        // would otherwise be given a negative transform and never appear.
        const inMs = Math.max(0, Math.round(word.startMs - cue.startMs));
        /*
          Which alphas are hidden depends on whether the style draws a box.

          `\alpha` sets all four at once — fill, secondary, border and shadow —
          and with `BorderStyle: 3` the border *is* the box behind the line. So
          on the box styles a word that had not been spoken yet took its box
          with it, and the box grew word by word: at half a second it was a
          small black rectangle around one word floating in the middle of the
          frame, and by two seconds it had inflated into two full-width bars.
          The caption appeared to change size and position while it was being
          read, which reads as broken rather than as animated.

          `\1a` and `\4a` hide the letters and their shadow and leave `\3a`
          alone, so the box is full width from the first frame and the words
          arrive inside it. On an outline style the box does not exist and
          hiding everything is still right — leaving `\3a` visible there would
          draw a ghost outline of words nobody has said yet.
        */
        const hide = colours.borderStyle === 3 ? "\\1a&HFF&\\4a&HFF&" : "\\alpha&HFF&";
        const show = colours.borderStyle === 3 ? "\\1a&H00&\\4a&H00&" : "\\alpha&H00&";
        let tags = `${hide}\\t(${inMs},${inMs + 1},${show}`;
        if (at === stressed) tags += `\\c${accent}`;
        tags += ")";
        if (at === stressed && roomToPop) {
          tags +=
            `\\t(${inMs + 1},${inMs + 1 + POP_RISE_MS},\\fscx${Math.round(POP_SCALE * 100)}\\fscy${Math.round(POP_SCALE * 100)})` +
            `\\t(${inMs + 1 + POP_RISE_MS},${inMs + 1 + POP_RISE_MS + POP_FALL_MS},\\fscx100\\fscy100)`;
        }
        return { text, tags };
      });
      const ordered = rtl ? [...runs].reverse() : runs;
      return ordered
        // Each word is isolated too: the run boundary the tag creates is also a
        // boundary the line's own isolate cannot reach across, so a word
        // carrying its sentence's full stop needs its own.
        .map((run) => `{${run.tags}}${isolate(run.text.replace(/[{}]/g, ""))} `)
        .join("")
        .trimEnd();
    });

    // No fade *in*: the words reveal themselves, and a fade on top of that is
    // the caption arriving twice.
    return `{\\fad(0,60)}${drawn.join("\\N")}`;
  }

  /*
    `kinetic` lands here when the words came back without their own timings.

    A word cannot arrive when it is spoken if nobody said when it was spoken,
    and the honest fallback is the whole caption arriving at once — which is
    exactly `pop`. Sharing the branch rather than falling through to the plain
    fade is what makes the note true: the renderer tells somebody their captions
    "pop in rather than arriving a word at a time", and a plain fade would have
    made that sentence a small lie.
  */
  if (animation === "pop" || animation === "kinetic") {
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
export function wrapToLayout(
  cues: CaptionCue[],
  layout: CaptionLayout,
  faces: FacePair = facePair(),
): CaptionCue[] {
  /*
    The width a line may draw to, in the same cap-height units the measurement
    returns. Comparing in caps rather than in pixels keeps this independent of
    which face the line ends up in — both are sized to the same cap height.

    Guarded, because the failure without the guard is silent in the worst way.
    A caller handing in a partial layout — `{ maxCharsPerLine, maxLines }`, as
    one test did — makes this NaN, every `>` against NaN is false, and the
    wrapper never breaks a line at all. No error, no warning: one very long
    caption drawn as a single run across the frame. So an unusable width falls
    back to the character count this function used before.
  */
  const measured = layout.usableWidth / layout.capHeight;
  const allowed = Number.isFinite(measured) && measured > 0 ? measured : null;

  return cues.map((cue) => {
    /*
      Measured, not counted, and by the same function the cue grouper uses.

      This counted characters against one average, and a character count is a
      fine estimate for ordinary prose and a bad one for anything else: `W` is
      three and a half times the width of `i`, so A LINE OF SHOUTING planned at
      eighteen characters drew past both margins. Nothing reported it, because
      libass silently rewrapped the overflow — and that rescue was itself
      putting an extra line on every caption in the product. Both halves are
      fixed together or neither is.

      A caller with no usable layout falls back to the character count, because
      the alternative is a NaN budget that never breaks a line at all.
    */
    /*
      And in the face this cue will actually be drawn in.

      The line is measured in cap-height units, which is face-independent for
      *height* and not for width: Anton runs at 0.6 of Montserrat's width per
      unit of height. So the same sentence fits a third more on one face than
      the other, and the wrapper has to know which — chosen by the same test
      that chooses the style row, so the two cannot disagree about a cue.
    */
    const face = readsRightToLeft(cue.text) ? faces.arabic : faces.latin;
    /*
      And broken evenly rather than greedily.

      Greedy filling answers "how many lines" correctly and draws them in the
      wrong shape: a full line over a short one, which on a centred block reads
      as ragged. `balancedLines` finds the narrowest allowance that still fits
      in the same number of lines, so the words, their order and the line count
      are all unchanged and only the break moves.
    */
    const lines =
      allowed === null
        ? countedLines(cue.text, layout.maxCharsPerLine)
        : balancedLines(cue.text, allowed, face.widthScale);

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
  /*
    Which faces, chosen in the plan.

    A pair rather than one, because a caption track can carry both scripts and
    each has to be sized by its own measurement. Defaulted here so every caller
    that has no opinion — and there are several, including this suite — keeps
    the pair the product shipped with.
  */
  faces: FacePair = facePair(),
): Promise<void> {
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${frame.width}`,
    `PlayResY: ${frame.height}`,
    /*
      2 — no wrapping of our own. `\N` is the only break.

      It was 0, "smart wrap", and smart wrap does not merely break lines that
      are too long: it *rebalances* the whole event to make the lines even.
      Every break `wrapToLayout` chose was then re-decided by libass, and the
      isolate characters around each line — the two invisible codepoints that
      make an Arabic sentence's full stop land at its end — threw the balance
      off enough to add a line. A three-line caption drew as four; with
      karaoke, where every word is its own layout run, it drew as five.

      Nothing failed. The captions were legible, correctly timed, correctly
      coloured, and a third taller than the block `caption-layout.ts` had
      checked against the platform's safe area — so `collidesWithFurniture`
      passed on three lines while five were drawn, climbing over the speaker's
      face. It is the exact bug that module was written to prevent, arriving
      through the one door it did not watch.

      Turning it off is only safe because the wrapping above measures rather
      than counts. Under WrapStyle 2 a line that is genuinely too wide runs off
      the frame instead of wrapping, so the estimate has to be right — which is
      what the advance table in `caption-layout.ts` is for, and what the
      quality suite measures in drawn pixels.
    */
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    captionStyleRow(LATIN_STYLE, faces.latin, style, layout),
    captionStyleRow(RTL_STYLE, faces.arabic, style, layout),
    "",
    "[Events]",
    "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
  ];

  /*
    Everything the kinetic animation needs, built once where the layout and the
    faces are in hand.

    `typicalWordMs` is the median across the whole track rather than within a
    cue, because "leaned on" only means anything against the pace of the speech
    around it, and five words is not a pace. It is the same measurement
    `emphasisPoints` takes for the punch-ins, through the same function, so the
    picture and the caption cannot end up emphasising different words.
  */
  const kinetic: KineticContext | null =
    animation === "kinetic"
      ? (() => {
          const durations = cues
            .flatMap((c) => c.words ?? [])
            .map((w) => w.endMs - w.startMs)
            .filter((ms) => ms > 0);
          const measured = layout.usableWidth / layout.capHeight;
          const allowed = Number.isFinite(measured) && measured > 0 ? measured : null;
          return {
            typicalWordMs: medianOf(durations),
            // No usable width means no measurement to be safe against, and the
            // safe answer is the colour without the scale.
            fits: (line, rtl, scale) =>
              allowed !== null &&
              widthInCaps(line, (rtl ? faces.arabic : faces.latin).widthScale) * scale <= allowed,
          };
        })()
      : null;

  const events = cues
    .filter((c) => c.endMs > c.startMs)
    .map(
      (c) =>
        `Dialogue: 0,${toAssTime(c.startMs)},${toAssTime(c.endMs)},${
          readsRightToLeft(c.text) ? RTL_STYLE : LATIN_STYLE
        },,0,0,0,,${animateCue(c, animation, style, kinetic)}`,
    );

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
export function videoEncodeFor(frameHeight: number, fps: number): string[] {
  // Keyframe cadence in *frames*, computed from the actual frame rate rather
  // than fixed. A hardcoded `-g 60` is two seconds only at 30fps; at 24 it is
  // 2.5s and at 25 it is 2.4s — past the ≤2s every one of these platforms wants
  // so it can cut on a keyframe when it re-encodes on upload. `round(fps*2)` is
  // two seconds at any rate, and `keyint_min` follows at one second.
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30;
  const gop = String(Math.max(1, Math.round(safeFps * 2)));
  const keyintMin = String(Math.max(1, Math.round(safeFps)));
  const uhd = frameHeight > 1920;
  return VIDEO_ENCODE.map((arg, i, all) => {
    if (all[i - 1] === "-g") return gop;
    if (all[i - 1] === "-keyint_min") return keyintMin;
    if (uhd && all[i - 1] === "-preset") return "fast";
    if (uhd && all[i - 1] === "-crf") return "20";
    if (uhd && all[i - 1] === "-level") return "5.1";
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
/**
 * The most punches one operation may carry, from the contract.
 *
 * `ZoomPunchOperation.at` is `.max(40)`, and the beat placer can produce far
 * more than that: one a bar at 120 bpm is one every two seconds. Named here
 * rather than written as a literal beside a `.slice`, because the number is a
 * fact about the schema and the *behaviour* when it is reached is a decision.
 */
/**
 * How long before the first title the layer starts.
 *
 * Enough for the animation's own run-up — a title that slides in begins
 * moving before it is legible — and short enough that the frames drawn to get
 * there are counted in tens rather than in thousands.
 */
const MOTION_LEAD_SECONDS = 0.5;

/**
 * The level every sound effect file is normalised to, in dBFS.
 *
 * `make-sfx.mjs` peak-normalises the catalogue to -3 so that one `gainDb` in
 * the plan means the same thing whichever file the rotation picks. It is also
 * what makes the layer's level a claim about the *file* rather than about the
 * edit, which is why the renderer has to put it back against the programme.
 */
const SFX_FILE_PEAK_DB = -3;

/**
 * How far to move the effects layer so `gainDb` means what the contract says.
 *
 * `SoundEffectsOperation.gainDb` is "how far under the programme the layer
 * sits", and the renderer applied it as a plain attenuation of a file that is
 * always normalised to the same peak — so the layer's level was a fact about
 * the catalogue rather than about the edit. A recording peaking at -17.7 dBFS
 * put the whoosh a decibel *above* the speech it was meant to sit twelve
 * under, while a recording at full scale put it fifteen under: the same take
 * at two distances from the microphone, two completely different mixes, and
 * the same sentence in the notes.
 *
 * Never a boost, and never more than thirty decibels of pull-down: past that
 * there is nothing under the noise floor left to be quieter than.
 */
/**
 * The threshold for a recording that peaks at full scale — the number this was
 * before it was scaled, and the one it still answers for such a file.
 */
const DUCK_THRESHOLD_AT_FULL_SCALE = 0.02;

/**
 * `sidechaincompress` refuses anything under 1/1024, so a very quiet recording
 * keys here rather than lower. Below this the compressor would be listening to
 * the room anyway.
 */
const DUCK_THRESHOLD_FLOOR = 0.001;

/**
 * Where the bed's ducking starts listening, as a linear amplitude.
 *
 * `sidechaincompress` takes an absolute threshold, and 0.02 — about -34 dBFS —
 * is a number written against a recording made at an ordinary level. It is not
 * a claim about the speech at all: a take peaking near full scale crosses it on
 * every syllable, and a take peaking at -29 dBFS RMS never crosses it, so the
 * bed simply never moved while the note said it did. Held to the same distance
 * under this recording's own peak, and floored so a very quiet file keys on the
 * voice rather than on the room behind it.
 */
export function duckThreshold(programmePeakDb: number | null): number {
  if (programmePeakDb === null) return DUCK_THRESHOLD_AT_FULL_SCALE;
  const scaled = DUCK_THRESHOLD_AT_FULL_SCALE * 10 ** (programmePeakDb / 20);
  return Math.max(DUCK_THRESHOLD_FLOOR, Math.min(0.05, scaled));
}

export function sfxLayerOffsetDb(programmePeakDb: number | null): number {
  if (programmePeakDb === null) return 0;
  return Math.max(-30, Math.min(0, programmePeakDb - SFX_FILE_PEAK_DB));
}

const MAX_PUNCHES = 40;

/**
 * The shortest join the contract admits, in seconds.
 *
 * `TransitionOperation.durationMs` is `.min(80)`, so eighty milliseconds is
 * the shortest dissolve anybody can ask for. Named here because the renderer
 * has to decide what to do when the pieces cannot hold even that, and the
 * answer has to be the same number the contract uses.
 */
const MIN_TRANSITION_SECONDS = 0.08;

/**
 * How many pieces an overlapped edit may be cut into on this machine.
 *
 * `xfade` reads two streams in lockstep and the chain holds every piece open
 * at once, so the cost is the frame size times the number of pieces. Measured
 * on a 1080p source with a 0.25s dissolve, peak resident memory for the whole
 * ffmpeg process: 505 MB for four pieces, 1633 MB for eight — about 130 MB per
 * piece, which is 62 bytes for every pixel in a frame.
 *
 * The worker has 1 GB (fly.toml) and shares it with Node, so the budget here
 * is 600 MB of xfade. That puts 1080p at four pieces, which is what the number
 * was when it was a constant — and lets a small frame have as many joins as it
 * can pay for, because a 320x240 piece costs a twenty-seventh of a 1080p one
 * and refusing it a dissolve was arithmetic that had never been done.
 *
 * The ceiling is a limit on the graph rather than on the memory: a chain of
 * fifty xfades is its own problem.
 */
const XFADE_BUDGET_BYTES = 600_000_000;
const XFADE_BYTES_PER_PIXEL_PER_PIECE = 62;
const MAX_OVERLAPPED_PIECES = 12;

export function maxOverlappedPieces(width: number, height: number): number {
  const perPiece = Math.max(1, width * height) * XFADE_BYTES_PER_PIXEL_PER_PIECE;
  return Math.max(2, Math.min(MAX_OVERLAPPED_PIECES, Math.floor(XFADE_BUDGET_BYTES / perPiece)));
}

/**
 * The grid a cut lands on, and the audio frame that matches it exactly.
 *
 * ## Why a grid at all
 *
 * `outputDuration` models the edit as the exact sum of the kept spans. The
 * render was not that. A video piece is a whole number of frames and an audio
 * piece is a whole number of samples, so `concat` advanced the output by the
 * *longer* of the two — on average half a frame more than the model, at every
 * join. Measured on a 92s source cut in thirty places: the model said 66.726s
 * and the file was 66.900s. Every caption, punch, overlay and title is placed
 * through `remapTime`, which shares the model, so all of them drifted ahead of
 * the picture — a caption led its own words by four frames after thirty cuts,
 * and by 1.36s after a hundred and seventy-six. The fade-out and the music trim
 * are computed from the same number and both ended early.
 *
 * Rounding every cut onto the frame grid removes the disagreement at the
 * source: a piece is then a whole number of frames *and* a whole number of
 * samples of the same length, the model is exact, and nothing downstream has
 * to know. A boundary moves by at most half a frame, which is under any
 * threshold that matters for a cut placed by amplitude.
 *
 * ## Why the audio has a cell size
 *
 * The cut is built by *selecting* frames out of one decode rather than by
 * trimming a branch per piece — see the cut chain for the memory measurement
 * that forced it — and selection keeps whole frames. So the audio has to be
 * re-framed onto cells that divide a video frame evenly, or the two streams
 * round differently and walk apart. Twenty cells per frame is small enough
 * that a declick ramp still has resolution to be a ramp, and 48000 divided by
 * twenty times any rate in the list below is a whole number of samples.
 *
 * A source whose rate is not on the list — 29.97 and its family, and every
 * variable-frame-rate screen recording — is retimed onto the nearest rate that
 * is. That is a tenth of a percent of frame timing on an NTSC file, invisible
 * and re-encoded by every platform anyway, and it is the only thing that makes
 * an exact grid possible for them.
 */
const CUT_GRID_RATES = [12, 15, 20, 24, 25, 30, 40, 48, 50, 60];
const CUT_AUDIO_RATE = 48_000;
const CUT_CELLS_PER_FRAME = 20;

interface CutGrid {
  /** Frames per second the cut is rounded onto. */
  fps: number;
  /** Whether the video has to be resampled onto that rate first. */
  retime: boolean;
  /** Samples in one audio cell; twenty cells make one frame. */
  samplesPerCell: number;
}

export function cutGridFor(fps: number): CutGrid {
  const nearest = CUT_GRID_RATES.reduce(
    (best, rate) => (Math.abs(rate - fps) < Math.abs(best - fps) ? rate : best),
    CUT_GRID_RATES[0]!,
  );
  const samplesPerCell = CUT_AUDIO_RATE / (nearest * CUT_CELLS_PER_FRAME);
  // A source already on the list keeps its own rate; everything else is moved
  // onto the nearest one. The tolerance is a thousandth of a frame, which
  // separates "30" from "30000/1001" without arguing about float arithmetic.
  return { fps: nearest, retime: Math.abs(nearest - fps) > 1e-3, samplesPerCell };
}

/**
 * Every boundary onto the grid, and nothing left that is shorter than a frame.
 *
 * Rounding is monotone, so two pieces that did not overlap cannot start to.
 * A piece under a frame long after rounding is not a piece — it is a boundary
 * that moved onto itself — and passing one to `select` would ask for zero
 * frames and a length the model would still count.
 */
export function snapCutsToGrid(kept: Segment[], fps: number): Segment[] {
  const cell = 1 / fps;
  return kept
    .map((segment) => ({
      start: Math.round(segment.start * fps) * cell,
      end: Math.round(segment.end * fps) * cell,
    }))
    .filter((segment) => segment.end - segment.start >= cell - 1e-9);
}

/**
 * The kept list split into runs that each play forwards.
 *
 * `select` reads the file once, in order, so it can express any edit that only
 * removes material — which is all of them except a cold open, where the hook
 * comes from the middle and plays first. Splitting at the one place the order
 * goes backwards gives each direction its own decode and lets both be
 * streamed: two decoders for a cold open instead of one decoder buffering
 * every frame between the top of the file and the hook.
 */
function orderedRuns(kept: Segment[]): Segment[][] {
  const runs: Segment[][] = [];
  for (const segment of kept) {
    const run = runs[runs.length - 1];
    if (run && segment.start >= run[run.length - 1]!.end - 1e-9) run.push(segment);
    else runs.push([segment]);
  }
  return runs;
}

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
    inWords: "graded it cinematic: blue in the shadows, warmth in the highlights",
    inWordsAr: "درّجتها سينمائية: زرقة في الظلال ودفء في الإضاءات",
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
 * Where the shipped sound effects live.
 *
 * Same shape as `subject.ts` resolving the tracker script, and for the same
 * reason: esbuild bundles TypeScript, not FLAC, so `build.mjs` copies the
 * folder beside the bundle and this looks there first. The source tree is the
 * fallback, which is what lets the suite run from a checkout with no build.
 *
 * A missing folder is not a failed render. It is a note — see the mix below —
 * because a sound layer is a flourish and the video is paid work.
 */
function sfxDirCandidates(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fromEnv = process.env["EDITLY_SFX_DIR"];
  return [
    ...(fromEnv ? [fromEnv] : []),
    path.join(here, "sfx"),
    path.join(here, "..", "assets", "sfx"),
    path.join(here, "assets", "sfx"),
    /*
      Last, and only reached from a checkout.

      A suite bundles this module into a temp directory, so "beside the bundle"
      resolves to somewhere with no sounds in it — and a renderer that silently
      finds none in every test is a renderer whose sound layer is only ever
      measured by the one suite that remembered to set the override. It cannot
      match in the container: `dist/sfx` is found two candidates earlier, and
      there is no repository under `/app`.
    */
    path.join(process.cwd(), "artifacts", "worker", "assets", "sfx"),
  ];
}

/** The file for one catalogue name, or null when the folder did not ship. */
async function sfxFile(name: string): Promise<string | null> {
  for (const dir of sfxDirCandidates()) {
    const candidate = path.join(dir, `${name}.flac`);
    try {
      await access(candidate, fsConstants.R_OK);
      return candidate;
    } catch {
      // next candidate
    }
  }
  return null;
}

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
 * How far from the edge anything laid over the picture sits.
 *
 * A share of the frame's width rather than a count of pixels. The halves in
 * these expressions — `(W-w)/2` — really are shape-independent, and the margin
 * beside them was the literal 40, which is 3.7% of the width at 1080 and 1.85%
 * at 2160: the same overlay tucked twice as far into the corner on a 4K export
 * as on an ordinary one, in a table whose comment says a pixel offset is
 * exactly what it avoids. Thirty-seven thousandths is the 40 the table has
 * always used, at the width it was chosen for.
 */
const OVERLAY_MARGIN = "(W*0.037)";
const WATERMARK_MARGIN = "(w*0.037)";

/**
 * Where an overlay sits. `W`/`H` are the frame, `w`/`h` the thing being laid on
 * it, so the same expression is right at 1080×1920 and at 1080×1350 — which a
 * pixel offset would not be.
 */
const OVERLAY_POSITION: Record<string, string> = {
  "top-left": `${OVERLAY_MARGIN}:${OVERLAY_MARGIN}`,
  "top-center": `(W-w)/2:${OVERLAY_MARGIN}`,
  "top-right": `W-w-${OVERLAY_MARGIN}:${OVERLAY_MARGIN}`,
  center: "(W-w)/2:(H-h)/2",
  "bottom-left": `${OVERLAY_MARGIN}:H-h-${OVERLAY_MARGIN}`,
  "bottom-center": `(W-w)/2:H-h-${OVERLAY_MARGIN}`,
  "bottom-right": `W-w-${OVERLAY_MARGIN}:H-h-${OVERLAY_MARGIN}`,
};

// `drawtext` names the frame `w`/`h` and the text `tw`/`th`, where `overlay`
// names them `W`/`H` and `w`/`h`. Same margin, different alphabet.
const WATERMARK_POSITION: Record<string, string> = {
  "bottom-right": `x=w-tw-${WATERMARK_MARGIN}:y=h-th-${WATERMARK_MARGIN}`,
  "bottom-center": `x=(w-tw)/2:y=h-th-${WATERMARK_MARGIN}`,
  "top-right": `x=w-tw-${WATERMARK_MARGIN}:y=${WATERMARK_MARGIN}`,
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
   * The command the render is about to run, before it runs.
   *
   * The shape of the filter graph is a decision with consequences that do not
   * show up in the output file: the cut used to be built as a branch per kept
   * piece, which produces exactly the right video and holds every frame of the
   * source span in memory while it does it. A test that renders a 320x240
   * fixture cannot tell the two shapes apart — the bad one costs 35 MB there
   * and 3.4 GB on a real upload — so the shape itself has to be inspectable.
   */
  onCommand?: (args: string[]) => void;
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
   * What the material is, when something has read it.
   *
   * Only the highlight reads it, and only to answer the question density
   * cannot: on a conversation, the strongest thirty seconds is where somebody
   * asked something and somebody else answered, not where the talking was
   * busiest. Absent on every render whose project has no reading, which is
   * where `chooseHighlight` remains the answer.
   */
  reading?: Reading | null;
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
  /**
   * Assets the project really has and this render could not fetch.
   *
   * Absence from `assets` used to mean both "you do not have this" and "we
   * could not get it", and the notes said the first for both — so a transient
   * storage error told somebody their music was not in the project, and they
   * went and looked, and it was.
   */
  unreachableAssetIds?: ReadonlySet<string>;
  /**
   * Faces this person uploaded, already downloaded, already measured.
   *
   * Same shape and same reason as `assets` above: the caller resolves, this
   * file draws. A renderer that could look up a font by id would be a renderer
   * that can be handed somebody else's font id — and the numbers a face is
   * drawn by are measured once, at upload, by rendering, so there is nothing
   * here that could re-derive them anyway.
   *
   * `dir` is where the files are. It goes to libass as `fontsdir`, because a
   * font that lives for the length of one render must not be installed into
   * the machine: two renders running side by side would then see each other's
   * fonts, and a family name is all it takes for one to draw the other's.
   */
  faces?: { available: CaptionFace[]; dir: string };
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
  /**
   * Whether this render was built to come out with sound.
   *
   * The renderer already decides this — `source.hasAudio || musicUsable` — and
   * maps an audio stream on the strength of it. The reviewer used to decide it
   * again from `sourceHadAudio` alone, which is a different question: a silent
   * clip with a bed under it comes out with sound the source never had, so the
   * reviewer skipped the level it was asked to check and never noticed the mix
   * missing its target. One decision, made once, carried forward.
   */
  hasAudioOut: boolean;
  /**
   * Whether this render actually put `loudnorm` in the graph.
   *
   * Not the same as "the plan asked for it". A `normalizeLoudness` op is applied
   * only when the render already has sound at the point the audio graph is
   * built — a silent source that gains a soundtrack later, from sound effects
   * mixed in, is never levelled. The reviewer used to re-derive this from the
   * plan and, seeing the op, measure an effects-only mix at -32 LUFS and "fix"
   * it to -14 — boosting four whooshes ~18 dB into a clipped master the render
   * had deliberately left alone. So the one place that knows says so, and the
   * reviewer levels only what was levelled.
   */
  levelled: boolean;
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
  const tightening = find("tighten");
  const highlight = find("extractHighlight");
  const range = find("extractRange");
  const reframe = find("formatForPlatform");
  // `let`, because the critic revises these once it knows what the edit became.
  let kenBurns = find("kenBurns");
  let zoomPunch = find("zoomPunch");
  const alternateFraming = find("alternateFraming");
  let captions = find("burnCaptions");
  const watermark = find("watermark");
  const loudness = find("normalizeLoudness");
  const grade = find("grade");
  const fade = find("fade");
  const transition = find("transition");
  /**
   * The loudest the recording gets, measured once and shared.
   *
   * Two decisions need it — where to listen for silence, and how far under the
   * programme the effects layer sits — and it costs an audio-only pass, so it
   * is measured on demand and remembered. `null` is "nobody could read this",
   * which both callers treat as "change nothing".
   */
  let measuredPeak: number | null | undefined;
  const sourcePeakDb = async (): Promise<number | null> => {
    if (measuredPeak === undefined) measuredPeak = source.hasAudio ? await peakDb(input) : null;
    return measuredPeak;
  };

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
  const soundEffects = find("soundEffects");
  /**
   * `let`, because a sound layer can be the only sound in the file.
   *
   * It starts as the question it has always answered — is there speech, is
   * there a bed — and the sound layer below turns it on if it actually laid
   * anything down. Deliberately *after* the loudness pass reads it: an edit
   * whose entire soundtrack is four whooshes must not be levelled to -14 LUFS,
   * which would make the accents as loud as a person talking. And deliberately
   * not turned on by the *presence* of the operation, because a plan can ask
   * for a layer on an edit with no cuts and no punches, where the honest answer
   * is a note and no audio stream at all.
   */
  let hasAudioOut = source.hasAudio || musicUsable;
  /** Set true only where `loudnorm` is actually added to the graph. See RenderResult. */
  let levelled = false;

  ctx.onProgress?.(0.02, "Looking at your footage");

  // ── Cuts ──────────────────────────────────────────────────────────────────
  //
  // Two kinds of removal, one machinery.
  //
  // Silence is found in the samples; hesitations and false starts are found in
  // the words. They arrive as the same thing — spans of source to drop — and go
  // through `keepSegmentsFrom` together, because everything downstream of the
  // cut (snapping off a word, remapping every caption and punch onto the edited
  // clock, the critic's guards) is correct exactly once and must stay that way.
  // A second cutter would be a second place for source-versus-edited time to be
  // got wrong, which is the worst bug this renderer has ever had.
  let kept: Segment[] | null = null;

  /** What tightening took, kept for the note and for the case where it is alone. */
  let tightened: TightenResult | null = null;
  if (tightening) {
    if (!ctx.words || ctx.words.length === 0) {
      notes.push(
        t(
          "nothing to tighten: this needs the words, and there is no transcript",
          "لا شيء أشدّه: هذا يحتاج الكلمات، ولا يوجد تفريغ",
        ),
      );
    } else {
      tightened = tighten(ctx.words, {
        fillers: tightening.fillers,
        repeats: tightening.repeats,
        duration: source.duration,
      });
      if (tightened.refused === "too much") {
        /*
          Said out loud rather than trimmed to the limit.

          If a quarter of a recording reads as hesitation, the reading is wrong
          — and a video that came back a quarter shorter with no explanation is
          a bug report, not an edit.
        */
        notes.push(
          t(
            "left the hesitations in: too much of this reads as filler for that to be right",
            "أبقيت الترددات: نسبة كبيرة جدًا من هذا تُقرأ كتردّد، وهذا لا يكون صحيحًا",
          ),
        );
      }
    }
  }

  const wordCuts: RemovableSpan[] = tightened?.cuts ?? [];

  if (silence || wordCuts.length > 0) {
    if (silence && !source.hasAudio) {
      notes.push(t("no audio track, nothing to trim", "لا مسار صوت، فلا شيء يُقصّ"));
    } else {
      let silences: RemovableSpan[] = [];
      if (silence && source.hasAudio) {
        ctx.onProgress?.(0.06, "Finding the silences");
        /*
          The threshold, moved to where this recording actually sits.

          See `peakDb`: an absolute level is a claim about a recording made at
          an ordinary one, and a quiet upload — a phone at arm's length, a
          lavalier with its gain down — read as silence from end to end and
          failed the job outright. Shifted rather than replaced, so the number
          in the plan still means what it meant: this far under the loud parts.
        */
        const peak = await sourcePeakDb();
        const shift =
          peak === null
            ? 0
            : Math.max(-MAX_THRESHOLD_SHIFT_DB, Math.min(0, peak - QUIET_HEADROOM_DB - silence.thresholdDb));
        const threshold = silence.thresholdDb + shift;
        if (shift < -1) {
          notes.push(
            t(
              `this recording is quiet: it peaks at ${peak!.toFixed(0)}dB, so I listened for silence ${Math.round(-shift)}dB further down to match it`,
              `هذا التسجيل هادئ: ذروته ${peak!.toFixed(0)} ديسيبل، فاستمعت للصمت عند مستوى أخفض بـ ${Math.round(-shift)} ديسيبل ليناسبه`,
            ),
          );
        }
        silences = await detectSilences(input, threshold, silence.minSilenceMs / 1000);
      }
      const protect = (silence?.protect ?? []).map((r) => ({ start: r.startMs / 1000, end: r.endMs / 1000 }));

      /*
        Merged before inverting, because `keepSegmentsFrom` walks its input in
        order and assumes the spans do not overlap. A hesitation sitting inside
        a detected silence is one removal, not two, and two overlapping spans
        would have the second one's start land behind the cursor and quietly
        produce a kept stretch of negative length.
      */
      const spans = mergeSpans([...silences, ...wordCuts]);
      let candidate = keepSegmentsFrom(source.duration, spans, (silence?.paddingMs ?? 0) / 1000, protect);

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
        throw new FfmpegError("The whole clip reads as silence at this threshold: nothing would be left.");
      }
      const keptDuration = candidate.reduce((sum, s) => sum + (s.end - s.start), 0);
      if (keptDuration >= source.duration - 0.01) {
        notes.push(t("no silence found to remove", "لم أجد صمتًا أزيله"));
      } else {
        kept = candidate;
        if (silence && silences.length > 0) {
          /*
            The silence, not everything that was removed.

            This said `source.duration - keptDuration`, which is the total the
            edit lost — and `candidate` is built from `mergeSpans([...silences,
            ...wordCuts])`, so the hesitations `tighten` found are inside that
            number. The comment ten lines down says the two are counted
            separately; the arithmetic did not separate them, and the next note
            then reported the same seconds again.

            A sixty-second clip with 3.0s of silence in two gaps and 2.0s of
            hesitations elsewhere read: "removed 5.0s of silence across 2 gaps"
            followed by "and cut 5 hesitations, 2.0s that was not silent" — the
            first sentence wrong by exactly the amount the second one names,
            and contradicted by it on the same screen.

            Summed from the detected spans, which is what "of silence" means.
          */
          const silentSeconds = silences.reduce((sum, span) => sum + Math.max(0, span.end - span.start), 0);
          notes.push(
            t(
              `removed ${silentSeconds.toFixed(1)}s of silence across ${silences.length} gaps`,
              `أزلت ${silentSeconds.toFixed(1)} ثانية من الصمت موزّعة على ${silences.length} فجوة`,
            ),
          );
        }
        /*
          Counted separately from the silence line.

          "Removed 40s of silence" and "removed 40s, twelve of them hesitations"
          are different sentences, and the second is the one that tells somebody
          the product did the thing they could not have done with a noise gate.
        */
        if (tightened && tightened.cuts.length > 0) {
          const parts: string[] = [];
          const partsAr: string[] = [];
          if (tightened.fillersFound > 0) {
            parts.push(`${tightened.fillersFound} hesitation${tightened.fillersFound === 1 ? "" : "s"}`);
            partsAr.push(`${tightened.fillersFound} تردّد`);
          }
          if (tightened.repeatsFound > 0) {
            parts.push(`${tightened.repeatsFound} false start${tightened.repeatsFound === 1 ? "" : "s"}`);
            partsAr.push(`${tightened.repeatsFound} بداية مكرّرة`);
          }
          notes.push(
            t(
              `and cut ${parts.join(" and ")}, ${tightened.droppedSeconds.toFixed(1)}s that was not silent`,
              `وقصصت ${partsAr.join(" و")}، أي ${tightened.droppedSeconds.toFixed(1)} ثانية لم تكن صامتة`,
            ),
          );
        }
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
          `the stretch you asked for starts at ${range.startSeconds.toFixed(0)}s, but the clip is only ${source.duration.toFixed(1)}s long, so nothing was cut away`,
          `المدى الذي طلبته يبدأ عند الثانية ${range.startSeconds.toFixed(0)}، والمقطع طوله ${source.duration.toFixed(1)} ثانية فقط، فلم يُقصّ شيء`,
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
              `kept ${start.toFixed(1)}s to the end. The clip runs out at ${source.duration.toFixed(1)}s, before the ${range.endSeconds.toFixed(0)}s you named`,
              `أبقيت من الثانية ${start.toFixed(1)} إلى النهاية: المقطع ينتهي عند ${source.duration.toFixed(1)} ثانية، قبل الثانية ${range.endSeconds.toFixed(0)} التي سمّيتها`,
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
        "the plan asked for both a highlight and a named stretch. The stretch you named won",
        "طلبت الخطّة هايلايت ومدًى مسمّى معًا، والمدى الذي سمّيته هو الذي فاز",
      ),
    );
  }
  if (highlight && !range) {
    /*
      Content first, density second - the same order the clips path uses.

      This is the branch the "Podcast clip" template goes down, which is why it
      matters here as much as it does over there: that template points
      `extractHighlight` at a ninety-minute conversation, and until now the
      forty-five seconds it kept were the forty-five where the talking was
      densest. One clip, chosen the way the set of clips is chosen.
    */
    const read =
      ctx.reading && ctx.words && ctx.words.length > 0
        ? chooseConversationClips({
            reading: ctx.reading,
            words: ctx.words,
            duration: source.duration,
            count: 1,
            targetSeconds: highlight.targetSeconds,
          })[0]
        : undefined;
    const choice: { window: { start: number; end: number }; how: "speech" | "centered" | "whole" | "conversation" } =
      read
        ? { window: { start: read.start, end: read.end }, how: "conversation" }
        : chooseHighlight(source.duration, highlight.targetSeconds, ctx.words);
    if (choice.how === "whole") {
      notes.push(
        t(
          `the clip is ${source.duration.toFixed(1)}s, no longer than the ${Math.round(highlight.targetSeconds)}s you asked to keep, so nothing was cut away`,
          `المقطع طوله ${source.duration.toFixed(1)} ثانية، ليس أطول من ${Math.round(highlight.targetSeconds)} ثانية طلبت إبقاءها، فلم يُقصّ شيء`,
        ),
      );
    } else {
      let window = choice.window;
      // Not for a window chosen from the reading: its edges are the moment a
      // turn began and the pause an answer settled into, and a drift budget can
      // only move them off the sentence they were chosen for.
      if (choice.how !== "conversation" && ctx.words && ctx.words.length > 0) {
        // Two moves, and the second is the one somebody notices.
        //
        // Widening to word boundaries saves a clipped syllable: the scorer
        // starts windows on word starts, but the right edge lands wherever
        // `start + the length asked for` fell.
        const snapped = snapToWords([window], ctx.words);
        if (snapped.length === 1) window = { start: snapped[0].start, end: Math.min(source.duration, snapped[0].end) };
        // Then onto the pauses. A word start in the middle of a sentence is
        // still the middle of a sentence, and a highlight that opens on
        // "...and that's why I think" is the most obvious way an automatic
        // edit announces itself.
        window = snapToSpeechBreaks(window, ctx.words, {
          driftSeconds: breathingRoom(highlight.targetSeconds),
          duration: source.duration,
        });
      }
      const inside = (kept ?? [{ start: 0, end: source.duration }])
        .map((s) => ({ start: Math.max(s.start, window.start), end: Math.min(s.end, window.end) }))
        .filter((s) => s.end - s.start > 0.05);
      // A window that somehow swallowed every kept stretch would render
      // nothing; the window alone is the least-wrong recovery.
      kept = inside.length > 0 ? inside : [window];
      /*
        Two numbers, because they are two different facts and only one of them
        is what the person receives.

        The window is a stretch of the *recording*; the silence pass then takes
        the dead air out of it. This note reported the window and called it
        what was kept, so somebody who asked for twenty seconds and received
        seventeen was told twenty-two. Both templates that use a highlight pair
        it with `removeSilence`, and so does the one-tap plan, so the shortfall
        was the normal case rather than the exception.
      */
      const windowSeconds = window.end - window.start;
      const delivered = kept.reduce((sum, s) => sum + (s.end - s.start), 0);
      const shortfall = windowSeconds - delivered > 0.2;
      notes.push(
        choice.how === "conversation"
          ? t(
              `kept ${Math.round(windowSeconds)}s chosen from what was said, ${window.start.toFixed(1)}s to ${window.end.toFixed(1)}s` +
                (shortfall ? `, ${delivered.toFixed(1)}s once the quiet inside it is cut` : "") +
                `: ${read?.why.en ?? ""}`,
              `أبقيت ${Math.round(windowSeconds)} ثانية مختارة ممّا قيل، من ${window.start.toFixed(1)} إلى ${window.end.toFixed(1)}` +
                (shortfall ? `، وتصير ${delivered.toFixed(1)} ثانية بعد قصّ الهدوء داخلها` : "") +
                `: ${read?.why.ar ?? ""}`,
            )
          : choice.how === "speech"
            ? t(
                `kept the strongest ${Math.round(windowSeconds)}s, ${window.start.toFixed(1)}s to ${window.end.toFixed(1)}s, where the speech runs densest` +
                  (shortfall ? `, which comes to ${delivered.toFixed(1)}s once the quiet inside it is cut` : ""),
                `أبقيت أقوى ${Math.round(windowSeconds)} ثانية، من ${window.start.toFixed(1)} إلى ${window.end.toFixed(1)}، حيث الكلام أكثف` +
                  (shortfall ? `، وتصير ${delivered.toFixed(1)} ثانية بعد قصّ الهدوء داخلها` : ""),
              )
            : t(
                `we could not hear the words in this clip, so the highlight is its middle ${Math.round(windowSeconds)}s` +
                  (shortfall ? `, which comes to ${delivered.toFixed(1)}s once the quiet inside it is cut` : ""),
                `لم نستطع سماع الكلام في هذا المقطع، فالهايلايت هو ${Math.round(windowSeconds)} ثانية من وسطه` +
                  (shortfall ? `، وتصير ${delivered.toFixed(1)} ثانية بعد قصّ الهدوء داخلها` : ""),
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
      // Inside what the edit still holds, not inside the whole recording. See
      // `chooseHighlight`'s `within` for what searching the whole recording did
      // to a named range and to every clip in a set.
      const held = { start: base[0]!.start, end: base[base.length - 1]!.end };
      const choice = chooseHighlight(source.duration, coldOpen.seconds, ctx.words, held);
      let window = choice.window;
      if (ctx.words && ctx.words.length > 0) {
        const snapped = snapToWords([window], ctx.words);
        if (snapped.length === 1) window = { start: snapped[0].start, end: Math.min(source.duration, snapped[0].end) };
        // A hook is the one place this matters most: it is the first thing
        // anybody hears, and half a sentence is not a hook.
        window = snapToSpeechBreaks(window, ctx.words, {
          driftSeconds: breathingRoom(coldOpen.seconds),
          duration: held.end,
          notBefore: held.start,
        });
      }

      /*
        A hook that starts a fraction of a second in starts at the beginning.

        Snapping to a word or to a pause routinely puts the window's start a
        tenth or two after the material begins, and splitting there leaves a
        crumb: the edit played 0.2s–3.0s, then jumped back for two tenths of a
        second, then carried on. That is not a cold open, it is a glitch — and
        it turned one piece into three, which is enough for a requested
        dissolve to cross fade a shot into itself twice.

        Under a second of lead is nothing to lift the hook over, so the hook
        simply starts where the material does.
      */
      const COLD_OPEN_MIN_LEAD = 1;
      if (window.start - base[0]!.start < COLD_OPEN_MIN_LEAD) {
        window = { start: base[0]!.start, end: window.end };
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
      } else if (body.length > 0 && body[0]!.start < hook[0]!.start - 0.05) {
        kept = [...hook, ...body];
        const hookSeconds = hook.reduce((sum, s) => sum + (s.end - s.start), 0);
        notes.push(
          choice.how === "speech"
            ? t(
                `opened on the strongest ${hookSeconds.toFixed(1)}s, from ${window.start.toFixed(1)}s, then the rest plays from the top without it`,
                `فتحت على أقوى ${hookSeconds.toFixed(1)} ثانية، من الثانية ${window.start.toFixed(1)}، ثم يُعرض الباقي من البداية بدونها`,
              )
            : t(
                `we could not hear the words, so it opens on ${hookSeconds.toFixed(1)}s from the middle and the rest plays from the top`,
                `لم نستطع سماع الكلام، ففُتح على ${hookSeconds.toFixed(1)} ثانية من الوسط ويُعرض الباقي من البداية`,
              ),
        );
      } else {
        /*
          The strongest moment is already the opening one.

          `chooseHighlight` breaks ties toward the earliest window, and a clip
          that genuinely opens strongly picks its own first seconds — so hook
          and body concatenate back into the original, in the original order,
          and nothing has been moved. The note said "opened on the strongest
          3.0s, from 0.0s, then the rest plays from the top without it", which
          describes a reordering that did not happen.

          Left as it was rather than forced: the plan asked for the strongest
          moment first and it already is. Splitting it anyway would also turn
          one piece into two, which is enough for a requested dissolve to cross
          fade a shot into itself and shorten the video by the overlap.
        */
        notes.push(
          t(
            "the strongest moment is already where this starts, so nothing was moved",
            "أقوى لحظة هي بداية المقطع أصلًا، فلم أنقل شيئًا",
          ),
        );
      }
    }
  }

  const videoParts: string[] = [];
  const audioParts: string[] = [];
  /**
   * Whether the plan asked for the room to be filtered out from under the
   * voice. Acted on where the speech is still on its own — see the music block.
   */
  let filterTheRoomOut = false;
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

  /*
    The cut, rounded onto one grid before anything is decided against it.

    `overlap`, `effectiveDuration`, the critic's remapping, the caption clock,
    the fade and the music trim are all computed from `kept` below. Rounding
    here — once, before any of them — is what makes the model and the file the
    same length. See `cutGridFor` for the measurement that made it necessary.
  */
  const grid = cutGridFor(source.fps);
  if (kept) kept = snapCutsToGrid(kept, grid.fps);

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
      /*
        The floor is the shortest transition the contract admits.

        It was 0.05, which is under `TransitionOperation.durationMs`'s own
        minimum of 80 — so a single short piece anywhere in the edit produced a
        sixty-millisecond dissolve nobody could have asked for and nobody would
        read as a dissolve. Below the contract's minimum there is no transition
        worth making, and saying the cuts stayed hard is the truthful answer.
      */
      if (room < MIN_TRANSITION_SECONDS) {
        notes.push(
          t(
            "the pieces this edit is cut into are too short to put a transition between, so the cuts stay hard",
            "القطع التي قُسّم إليها هذا التعديل أقصر من أن أضع بينها انتقالًا، فتبقى القصّات حادّة",
          ),
        );
      } else if (kept!.length > maxOverlappedPieces(source.width, source.height)) {
        // Overlapping the joins of an out-of-order edit costs one decoder per
        // piece, and past four of them on a 1080p source that is more memory
        // than the worker has. Trading a missing dissolve for an OOM kill is
        // not a trade: the kill takes the whole render with it and says
        // nothing. See `maxOverlappedPieces` for the measurements.
        notes.push(
          t(
            `this edit is cut into ${kept!.length} pieces, too many to overlap the joins of on this machine, so the cuts stay hard`,
            `هذا التعديل مقسوم إلى ${kept!.length} قطعة، أكثر من أن أراكب وصلاتها على هذه الماكينة، فتبقى القصّات حادّة`,
          ),
        );
      } else {
        overlap = Math.min(asked, room);
        joinStyle = XFADE_STYLE[transition.style];
        const named = STYLE_IN_WORDS[transition.style];
        notes.push(
          overlap < asked - 0.001
            ? t(
                `${named} over ${overlap.toFixed(2)}s, shorter than asked, so the shortest piece is still on screen by itself`,
                `${STYLE_IN_WORDS_AR[transition.style]} خلال ${overlap.toFixed(2)} ثانية، أقصر ممّا طُلب، كي تبقى أقصر قطعة على الشاشة وحدها`,
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
    /** Whether the finished soundtrack passed through the seam declick. */
    let declicked = false;

    if (overlap > 0) {
      /**
       * Every piece decoded on its own, because the joins overlap.
       *
       * `xfade` reads two streams in lockstep, so the pieces have to exist as
       * separate streams however they are made — and made as `trim` branches
       * off one shared decode they are ruinous: ffmpeg feeds those branches in
       * the order the decoder produces frames, so the frames of every later
       * piece pile up in memory while the first join is still being made.
       * Measured on a 1080p source with a 0.25s dissolve, peak resident memory
       * for the whole process:
       *
       *      pieces   trim branches   own input
       *           4         1170 MB      505 MB
       *           8         2802 MB     1633 MB
       *          12         4211 MB     3196 MB
       *
       * The worker has 1 GB (fly.toml). So an input each, always — and the cap
       * below applies to every overlapped edit rather than only to the ones
       * that play out of order, which is what it always should have been: the
       * in-order path was the cheaper-looking one and was in fact the one over
       * the box.
       *
       * A cold open additionally *cannot* share a decode: chained `acrossfade`
       * over branches that want the file out of order does not come out wrong,
       * it deadlocks — three out-of-order pieces measured never finishing at
       * all. Seeking each piece on its own input removes both problems at once.
       */
      kept.forEach((segment, i) => {
        // Forced onto the grid: xfade walks two streams frame by frame and a
        // variable frame rate walks them out of step.
        const cadence = `,fps=${grid.fps.toFixed(4)}`;
        // `-ss` before `-i` is an input seek: ffmpeg lands on the keyframe
        // before the mark and decodes forward to it, so the piece is
        // frame-accurate and the reading is cheap. `-t` bounds it.
        const idx = addInput(
          "-ss", segment.start.toFixed(4),
          "-t", (segment.end - segment.start).toFixed(4),
          "-i", input,
        );
        pieces.push(`[${idx}:v]setpts=PTS-STARTPTS${cadence}[cv${i}]`);
        if (!withAudio) return;
        // Every audio edge gets a blink-long ramp (15ms — under any perceptual
        // threshold for a fade, well over the one for a click). A cut lands
        // wherever the detector put it, which is rarely a zero crossing, and a
        // waveform that jumps mid-cycle is a broadband click stitched into the
        // join.
        //
        // An edge that a dissolve is about to cross fade over does not get
        // one: the crossfade already ramps it, over a hundred times longer,
        // and two ramps stacked on one edge is an audible dip in the middle of
        // the transition. The outer two edges are still hard cuts out of the
        // source and still get theirs.
        const len = segment.end - segment.start;
        const ramp = Math.min(DECLICK_SECONDS, len / 4);
        const rampIn = i > 0 ? 0 : ramp;
        const rampOut = i < last ? 0 : ramp;
        const fades = [
          rampIn > 0 ? `afade=t=in:st=0:d=${rampIn.toFixed(4)}` : null,
          rampOut > 0 ? `afade=t=out:st=${Math.max(0, len - rampOut).toFixed(4)}:d=${rampOut.toFixed(4)}` : null,
        ].filter((part): part is string => part !== null);
        pieces.push(
          `[${idx}:a]asetpts=PTS-STARTPTS` +
            (fades.length > 0 ? `,${fades.join(",")}` : "") +
            `[ca${i}]`,
        );
      });

      // Chained pairwise, because that is the only shape xfade has. Each join
      // starts `overlap` before the end of everything already stitched — and
      // everything already stitched is shorter than the sum of its parts by one
      // overlap per join made so far, which is the whole reason the output
      // clock needs correcting downstream.
      let elapsed = kept[0]!.end - kept[0]!.start;
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
          // `qsin` and not `tri`: two triangular ramps crossing sum to 0.71 of
          // either one at the midpoint, which is a 2.9 dB hole measured in the
          // middle of every dissolve. Equal-power curves sum to 1.
          pieces.push(`[${aPrevious}][ca${i}]acrossfade=d=${overlap.toFixed(4)}:c1=qsin:c2=qsin[${aOut}]`);
          aPrevious = aOut;
        }
        elapsed += kept[i]!.end - kept[i]!.start;
      }
      if (kept.length === 1) {
        // One piece and an overlap is not a state the join block produces, but
        // the labels have to exist for the rest of the graph either way.
        pieces.push(`[cv0]null[cutv]`);
        if (withAudio) pieces.push(`[ca0]anull[cuta]`);
      }
    } else {
      /**
       * The cut as a selection, not as a piece per branch.
       *
       * A hard cut used to be built the way a filter graph invites you to build
       * it: one `trim` branch per kept piece off a single decode, concatenated.
       * That shape buffers. `concat` drains its inputs in order, the decoder
       * produces frames in time order, and every frame belonging to a later
       * piece waits in memory until its turn — so the cost is not the length of
       * the edit, it is the **span of source the edit reaches across**, at one
       * uncompressed frame per frame. Measured, 1080p30:
       *
       *      span    peak resident
       *       5s          463 MB
       *      10s          946 MB
       *      20s         1826 MB
       *      35s         3229 MB
       *
       * — about 92 MB per second of source. `renderPlan` cutting the silence
       * out of a forty-second 1080p clip peaked at 3403 MB on a machine with
       * 1024. That is the default plan on the default upload, and the failure
       * is an OOM kill: no note, no output, the minute spent either way. It
       * survived because every fixture in the suite is 320x240 or 640x360,
       * where the same shape costs 35 MB.
       *
       * `select` keeps the frames whose timestamps fall inside a kept span and
       * drops the rest, streaming, out of one decode, with nothing queued
       * behind anything. Same cut, same frames, same lengths — measured
       * identical to the old graph on a thirty-piece edit, to the frame and to
       * the millisecond — for 98 MB instead of 3252 MB.
       *
       * The audio is re-framed onto cells that divide a frame exactly (see
       * `cutGridFor`) so that `aselect` rounds where `select` rounds. Without
       * that the two streams pick their own boundaries and walk apart: the same
       * edit built with a naive `aselect` came out with the audio 0.9s short of
       * the picture and the clicks nine seconds adrift by the end.
       *
       * An edit that plays out of order — a cold open — is split into runs that
       * each play forwards, and each run gets its own decode. Two decoders for
       * a cold open, streaming, instead of one decoder holding every frame
       * between the top of the file and the hook.
       */
      const runs = orderedRuns(kept);
      const halfFrame = 0.5 / grid.fps;
      const halfCell = (0.5 * grid.samplesPerCell) / CUT_AUDIO_RATE;
      const within = (spans: Segment[], shift: number): string =>
        spans.map((s) => `between(t,${(s.start - shift).toFixed(6)},${(s.end - shift).toFixed(6)})`).join("+");

      runs.forEach((run, r) => {
        // The first run reads the source as it was opened. A later one is a
        // second opening of the same file, seeked to where it begins —
        // `-copyts` so the timestamps stay on the source clock and one
        // expression can be written in the times the plan already speaks.
        const idx = r === 0 ? 0 : addInput("-ss", run[0]!.start.toFixed(4), "-copyts", "-i", input);
        // A source whose rate is not on the grid is moved onto it first. This
        // is also the only thing that makes a variable-frame-rate recording —
        // every OBS and QuickTime screen capture — come out in step with its
        // own sound.
        const cadence = grid.retime ? `fps=${grid.fps.toFixed(4)},` : "";
        pieces.push(
          `[${idx}:v]${cadence}select='${within(run, halfFrame)}',setpts=N/FRAME_RATE/TB[rv${r}]`,
        );
        if (!withAudio) return;
        pieces.push(
          // `aformat` and not `aresample`: both put the stream on the rate the
          // cells are measured in, and only one of them leaves the level
          // alone. `aresample` converts eagerly, so a mono recording is
          // converted a second time when a stereo effects bus joins it later
          // — and that second conversion halves the power per channel, so the
          // programme came out 3 dB quieter for no reason but the presence of
          // sound effects. `aformat` states the requirement and lets the one
          // conversion the graph needs do all of it at once.
          `[${idx}:a]aformat=sample_rates=${CUT_AUDIO_RATE},asetnsamples=n=${grid.samplesPerCell}:p=0,` +
            `aselect='${within(run, halfCell)}',asetpts=N/SR/TB[ra${r}]`,
        );
      });

      if (runs.length === 1) {
        pieces.push(`[rv0]null[cutv]`);
        if (withAudio) pieces.push(`[ra0]anull[cuta]`);
      } else {
        pieces.push(
          `${runs.map((_, r) => (withAudio ? `[rv${r}][ra${r}]` : `[rv${r}]`)).join("")}` +
            `concat=n=${runs.length}:v=1:a=${withAudio ? 1 : 0}[cutv]${withAudio ? "[cuta]" : ""}`,
        );
      }

      if (withAudio) {
        /*
          The declick, moved from the pieces to the seam.

          Every join used to get a 15ms ramp out and a 15ms ramp in, written on
          the two pieces either side of it. There are no pieces here, so the
          same shape is written once on the finished stream: a notch at each
          join on the output clock, which is exact because the cut is on the
          grid. The outer two edges are still hard cuts out of the source and
          still get their own fade.

          Not a decision anyone is told about — just the cut done properly, so
          no note and no way to turn it off.
        */
        const lengths = kept.map((segment) => segment.end - segment.start);
        const notches: string[] = [];
        let elapsed = 0;
        for (let i = 0; i < kept.length - 1; i += 1) {
          elapsed += lengths[i]!;
          const ramp = Math.min(DECLICK_SECONDS, Math.min(lengths[i]!, lengths[i + 1]!) / 4);
          if (ramp <= 0) continue;
          notches.push(`max(0,1-abs(t-${elapsed.toFixed(5)})/${ramp.toFixed(5)})`);
        }
        const total = lengths.reduce((sum, len) => sum + len, 0);
        const edge = Math.min(DECLICK_SECONDS, total / 4);
        const chain = [
          notches.length > 0 ? `volume=eval=frame:volume='1-(${notches.join("+")})'` : null,
          edge > 0 ? `afade=t=in:st=0:d=${edge.toFixed(4)}` : null,
          edge > 0 ? `afade=t=out:st=${Math.max(0, total - edge).toFixed(4)}:d=${edge.toFixed(4)}` : null,
        ].filter((part): part is string => part !== null);
        if (chain.length > 0) {
          pieces.push(`[cuta]${chain.join(",")}[cutd]`);
          declicked = true;
        }
      }
    }

    graphPrefix = `${pieces.join(";")};`;
    vLabel = "cutv";
    if (withAudio) aLabel = declicked ? "cutd" : "cuta";
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
      // `CriticInput.language` has existed since the critic did, and nothing
      // passed it. Every critic note — punches dropped into a cut, punches that
      // would land on "um", captions removed with the speech they covered, the
      // zoom cap — came back English and was concatenated into an Arabic
      // render's notes. `say.ts` requires both halves of every sentence so a
      // note *cannot* be written English-only; an optional parameter at the
      // call site undid that.
      language: ctx.language,
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
  /*
    A plan that names moments *and* asks for the beat gets the moments, and is
    told so.

    The planner deliberately keeps both — its own comment says "the renderer's
    notes say what was done either way" — and the renderer said nothing: the
    gate below needs an empty list, so "punch on 'this' and on 'that', on the
    beat" quietly became an ordinary emphasis edit with no mention of the beat
    anywhere in the notes.
  */
  if (zoomPunch && zoomPunch.on === "beat" && zoomPunch.at.length > 0) {
    notes.push(
      t(
        `this plan named ${zoomPunch.at.length} moment${zoomPunch.at.length === 1 ? "" : "s"} and also asked for the beat. The moments won: they are the more specific instruction`,
        `سمّت هذه الخطّة ${zoomPunch.at.length} لحظة وطلبت الإيقاع أيضًا، فاللحظات هي التي فازت لأنّها التعليمة الأدقّ`,
      ),
    );
  }

  if (zoomPunch && zoomPunch.on === "beat" && zoomPunch.at.length === 0) {
    if (!musicUsable) {
      notes.push(
        t(
          "there is no music under this edit, so there was no beat to put the punches on",
          "لا موسيقى تحت هذا التعديل، فلم يكن هناك إيقاع أضع عليه التقريبات",
        ),
      );
    } else {
      ctx.onProgress?.(0.10, "Listening for the beat");
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
        const firstPass = grid.beats
          .map((at) => at - music!.fromSeconds)
          .filter((at) => at >= 0);

        /**
         * The grid continues for as long as the bed does.
         *
         * `beatsOf` reads the track, so its beats span the track's own length —
         * and the bed is laid with `-stream_loop -1` whenever `loop` is set,
         * which is the schema's default. A ninety-second edit over a
         * twenty-five-second loop therefore got punches in the first twenty-five
         * seconds and none in the remaining sixty-five, while the note said
         * "put 12 punches on the beat, one a bar at 120 bpm". True of a quarter
         * of the video, false of the rest, and audibly so: the pulse keeps going
         * and the picture stops answering it.
         *
         * The repeat starts past the intro too — `-ss` sits before `-i`, so
         * every pass begins at `fromSeconds` — which makes the period on the
         * edit clock the track's length minus that seek, not the track's length.
         *
         * The phase is allowed to shift at each seam. `everyNth` steps by index,
         * so a pass whose beat count is not a multiple of four moves the bar
         * line — which is exactly what the audio does there, because a loop that
         * does not end on a bar has that seam in it. Following the seam is more
         * honest than hiding it.
         */
        const trackSeconds = music!.loop ? await containerSeconds(musicAsset.file) : null;
        // Null means the container would not say how long the track is, not
        // that it is zero seconds long. The correction cannot run without a
        // period — but the note must not then claim it did. See below.
        const loopLengthUnknown = Boolean(music!.loop) && trackSeconds === null;
        const loopPeriod = trackSeconds === null ? 0 : Math.max(0, trackSeconds - music!.fromSeconds);
        const onEdit: number[] = [];
        if (loopPeriod > 1 && effectiveDuration > loopPeriod && firstPass.length > 0) {
          for (let pass = 0; pass * loopPeriod <= effectiveDuration; pass += 1) {
            for (const at of firstPass) {
              const shifted = at + pass * loopPeriod;
              if (shifted > effectiveDuration) break;
              onEdit.push(shifted);
            }
          }
        } else {
          onEdit.push(...firstPass);
        }
        /*
          Forty is the schema's ceiling, and taking the first forty is the same
          bug the loop fix above was written against.

          `ZoomPunchOperation.at` is `.max(40)`, so a long edit over a fast bed
          produces more bars than may be carried. `.slice(0, 40)` kept the
          first forty — one punch a bar at 120 bpm is a punch every two
          seconds, so a three-minute edit got its punches in the first eighty
          seconds and none in the remaining hundred, with the note underneath
          saying they were put on the beat. True of the first 44% of the video
          and false of the rest, and audible: the pulse keeps going and the
          picture stops answering it.

          Spread across the whole edit instead, taking every Nth bar so the
          forty that survive are distributed rather than crowded at the front.
          The phase is still the music's; only the density changes, and the
          note below says so when it happens.
        */
        const everyBar = everyNth({ ...grid, beats: onEdit }, 4, { from: 0, to: effectiveDuration });
        const thinnedBy = everyBar.length > MAX_PUNCHES ? Math.ceil(everyBar.length / MAX_PUNCHES) : 1;
        const chosen = thinnedBy > 1
          ? everyBar.filter((_, index) => index % thinnedBy === 0).slice(0, MAX_PUNCHES)
          : everyBar;
        /*
          And through the same guards every other punch goes through.

          The critic runs before this, because the times do not exist until the
          music has been read — so it passed an empty beat operation straight
          through, correctly, and nothing applied its rules afterwards. A beat
          punch could open half a second before the end and leave the video
          ending mid-zoom (measured: hand-placed at the same moment, the critic
          drops it and says so; placed on the beat, it renders), and it could
          land inside a dissolve, which the critic clears every other punch out
          of by construction.
        */
        const at = settlePunches(chosen, {
          kept,
          effectiveDuration,
          overlap,
          holdSeconds: (zoomPunch.holdMs ?? 1200) / 1000,
        }).at;
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
            thinnedBy > 1
              ? t(
                  `put ${at.length} punch${at.length === 1 ? "" : "es"} on the beat at ${bpm} bpm, one every ${thinnedBy} bars, because a punch a bar is more than this edit can carry`,
                  `وضعت ${at.length} تقريبة على الإيقاع عند ${bpm} نبضة في الدقيقة، واحدة كل ${thinnedBy} مازورات، لأنّ واحدة كل مازورة أكثر ممّا يحتمله هذا التعديل`,
                )
              : t(
                  `put ${at.length} punch${at.length === 1 ? "" : "es"} on the beat, one a bar at ${bpm} bpm`,
                  `وضعت ${at.length} تقريبة على الإيقاع، واحدة كل مازورة عند ${bpm} نبضة في الدقيقة`,
                ),
          );
          /*
            And where they stop, when the track loops and we could not read
            how long it is.

            The note above is a claim about the whole edit. With a bed that
            repeats and a length the container would not give up, the punches
            only ever cover the first pass of the music — the picture answers
            the pulse at the start and stops answering it after that, which is
            audible, and which the sentence above would otherwise deny.
          */
          const lastPunch = at[at.length - 1] ?? 0;
          if (loopLengthUnknown && effectiveDuration - lastPunch > 2) {
            notes.push(
              t(
                "that music repeats and its length could not be read, so the punches stop where its first pass does rather than carrying on to the end",
                "تلك الموسيقى تتكرّر ولم يُمكن قراءة طولها، لذلك تتوقّف التقريبات عند نهاية الدورة الأولى بدل أن تستمرّ حتى النهاية",
              ),
            );
          }
        }
      }
    }
  }

  // ── Framing ───────────────────────────────────────────────────────────────
  //
  // Shot sizes first, because whether there are any decides how wide the crop
  // has to be, and the crop is the first thing built below.
  //
  // The decision is made from the cut, on the edited clock, and it is allowed
  // to come back empty: too few pieces, or none long enough to hold a size.
  // That is said out loud. An operation that quietly did nothing is the failure
  // mode this repository keeps finding, and "alternate the framing" on a clip
  // with one cut in it is exactly the shape of it.
  const framingAmount = alternateFraming?.amount ?? 0;
  const takes = alternateFraming ? takesFrom(kept, overlap, effectiveDuration) : [];
  if (alternateFraming && takes.length === 0) {
    notes.push(
      t(
        "left the framing alone: this edit has too few cuts to carry two shot sizes, and changing size once reads as a mistake rather than as coverage",
        "تركت التأطير كما هو، في هذا التعديل قصّات أقلّ من أن تحمل حجمين، وتغيير الحجم مرّة واحدة يُقرأ خطأً لا تغطية",
      ),
    );
  }

  const hasMotion = Boolean(kenBurns || zoomPunch || takes.length > 0);
  /*
    How much wider than the delivered frame the picture is cropped.

    Everything with motion in it is already cropped to `MOTION_OVERSCAN` so the
    base zoom is a downscale rather than an upscale. The wide shot size lives in
    exactly that margin, which is why the default costs nothing at all: at
    `amount` 0.15 this is the same number it has always been. A larger pull-back
    grows the crop instead of upscaling anything, and the price is paid once, in
    scaling the source further, rather than on every wide frame.
  */
  /*
    And only where there is a wider source to take it out of.

    The overscan exists so the base zoom is a *downscale*: the reframe crops a
    window 15% larger than the target out of the source, and the zoom then
    brings it back to exactly the target, so an unmoved frame is real pixels
    and a punch has somewhere to expand into. That argument needs the reframe.

    Without one there is no wider source, so the same number scaled the frame
    *up* by 1.15 and cropped straight back — measured on a 1920x1080 render,
    "a slow push" put 1671 of the 1920 columns on screen. Thirteen per cent of
    the picture thrown away and every frame softened, before the push starts,
    with nothing said about either. `zoomPunch` and `kenBurns` did it too, and
    `direct.ts` adds `alternateFraming` to any cut edit over a minute whether a
    platform was named or not.

    So: no reframe, no overscan — the push zooms into the frame the person
    uploaded, which is what a push is.

    `alternateFraming` is the exception, and a deliberate one. Its wide take is
    a zoom of *less* than one, which only exists if there is margin outside the
    frame to pull back into; without a reframe the overscan is the only way to
    manufacture any, and the trade — a softer picture for a second shot size —
    is the whole point of the operation. Nothing else in the file gets to make
    that trade by accident.
  */
  const needsMargin = Boolean(reframe) || takes.length > 0;
  const overscan =
    hasMotion && needsMargin ? overscanFor(MOTION_OVERSCAN, takes.length > 0 ? framingAmount : 0) : 1;
  const takeScales = takes.map((take) => ({
    from: take.from,
    to: take.to,
    scale: scaleFor(take.size, framingAmount),
  }));

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
          `exported at ${target.h}p rather than ${asked.h}p. This footage has no more detail than that, and the larger file would only be a bigger copy of the same picture`,
          `صُدّر بـ${target.h}p بدل ${asked.h}p، هذه اللقطة لا تحمل تفاصيل أكثر من ذلك، والملفّ الأكبر سيكون نسخة أكبر من الصورة نفسها فقط`,
        ),
      );
    }
    frameWidth = target.w;
    frameHeight = target.h;
    // Crop wider than the target when something will move, so the base zoom is
    // a downscale rather than an upscale. lanczos because the default bilinear
    // is visibly softer on the large downscales this does.
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
      ctx.onProgress?.(0.12, "Finding your subject in the frame");
      const windowFraction = cropW / scaledWidth;

      // Faces first: "where is the person" is the question, and everything else
      // here is a proxy for it. The tracker answers with null rather than
      // throwing, so a missing python, a screen recording, or a clip nobody
      // appears in all land in the same place.
      // From where the edit begins, not from the top of the recording. See
      // `TrackOptions.from`: a clip taken out of the middle of a podcast had
      // no samples inside it at all.
      const track = await trackSubject(input, source.width, source.height, {
        from: kept ? Math.min(...kept.map((segment) => segment.start)) : 0,
      });
      const note = trackNote(track, t);
      if (note) notes.push(note);

      if (track && track.coverage >= MIN_SUBJECT_COVERAGE) {
        const path = subjectPath(track.samples, windowFraction);
        /**
         * Onto the edited clock, like everything else drawn on the frame.
         *
         * The tracker samples the *original* file, so its keyframes are seconds
         * into the recording. This filter runs on `[cutv]` — after the trims,
         * after `setpts=PTS-STARTPTS`, after the concat — where `t` is seconds
         * into the *edit*. Every other thing placed in time here goes through
         * `remapTime`: captions, punches, overlays, motion titles. The reframe
         * was the one that did not.
         *
         * What that looked like: a ten-minute interview, silences cut to 7:30,
         * the speaker moving at 6:00. The crop ramped at t=360 on the output,
         * which is 7:12 in the source — the frame followed them about seventy
         * seconds late, smoothly, while the note said "followed the speaker".
         * On a clips render it is worse and not proportional: `extractClips`
         * hands the renderer a 30-second window out of a ten-minute source, so
         * every keyframe but the first sits past the end of the output and the
         * window holds wherever the speaker stood in the first second and a
         * quarter of the whole video, for every clip in the set.
         *
         * Nothing fails. The crop is valid, the picture moves, and it moves
         * smoothly — only somebody comparing the move against the speaker would
         * ever see it.
         *
         * Moments inside a removed stretch collapse onto their seam, which is
         * right, and which can put two keyframes at the same instant; a
         * zero-span ramp there would be a division guarded to 0.001 and a jump.
         * Keeping the first of each cluster leaves the move on the seam, where
         * the cut already is.
         */
        /*
          And only the part of the path this edit is made of.

          `remapTime` pins a moment outside the kept material onto a seam: a
          keyframe before the first kept stretch lands at 0, one after the last
          lands at the end. Nothing dropped them, so a clip taken out of the
          middle of a recording kept both — the opening hold became the
          speaker's position at 0:00 of the *recording*, and one surviving
          keyframe from after the window carried their position at the end of
          it, with `cropExpression` ramping linearly between the two across the
          whole clip.

          Measured on a four-second clip cut from 8s of a twenty-second file:
          the window opened 660px away from the speaker, lost them entirely for
          the first 0.7s, and panned for three of the four seconds — while the
          note said "followed the speaker, moving the frame 2 times where they
          moved". The right answer was a still window.

          So the path is cut to the window first: everything before it collapses
          into one hold at the position the speaker was last seen in, and
          everything after it is dropped. `extractHighlight`, `extractRange`,
          `extractClips` and `coldOpen` all take this path, and `direct.ts` puts
          a highlight and a reframe in the same plan by default.
        */
        const keyframes = kept ? pathWithinCut(path.keyframes, kept, overlap) : path.keyframes;
        cropXExpr = cropExpression(keyframes, scaledWidth, cropW);
        const moves = (keyframes.length - 1) / 2;
        notes.push(
          // Whether it moves *in the edit*, not whether it moved in the source.
          // Two moves either side of a cut stretch collapse to one seam, and a
          // note claiming two would be counting something the viewer cannot see.
          keyframes.length > 1
            ? t(
                `followed the speaker, moving the frame ${Math.round(moves)} time${Math.round(moves) === 1 ? "" : "s"} where they moved`,
                `تابعت المتكلّم، وحرّكت الكادر ${Math.round(moves)} مرّة حيث تحرّك`,
              )
            : t("framed on the speaker and held there", "أطّرت على المتكلّم وثبّت الكادر"),
        );
      } else {
        try {
          // From where the edit begins, for the same reason the tracker does.
          const editBegins = kept ? Math.min(...kept.map((segment) => segment.start)) : 0;
          const choice = chooseCropCenter(await measureInterest(input, undefined, editBegins), windowFraction);
          cropX = cropOffsetX(choice, scaledWidth, cropW);
          cropXExpr = String(cropX);
          notes.push(
            choice.moved
              ? t(
                  `framed on the subject rather than the centre (${Math.round(choice.center * 100)}% across)`,
                  `أطّرت على الموضوع بدل المنتصف (عند ${Math.round(choice.center * 100)}٪ من العرض)`,
                )
              : t(
                  "kept the centre. Nothing in the frame argued for moving off it",
                  "أبقيت المنتصف. لا شيء في الكادر دعا إلى مغادرته",
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
    /*
      And when nothing was framed, say that too.

      All of the framing machinery here is horizontal: the vertical offset is
      the constant `(ih-oh)/2`, and the search above only runs when the scaled
      source is wider than the window. Going the other way — a phone clip
      exported for YouTube — is therefore a centre crop of the height with no
      subject search at all, and it was the one reframe that emitted no framing
      note. Every other path says where it framed; this one said nothing, so a
      customer could not tell that no framing decision had been made. Forty-four
      per cent of the height is kept from the geometric middle, and a clip shot
      head-in-the-upper-third loses the head.
    */
    if (scaledWidth <= cropW + 2) {
      notes.push(
        t(
          "this clip is taller than the shape asked for, so the middle of the picture was kept, and the framing here only looks left and right",
          "هذا المقطع أطول من الشكل المطلوب، فأُبقي وسط الصورة، والتأطير هنا ينظر يمينًا ويسارًا فقط",
        ),
      );
    }
  } else if (hasMotion) {
    // Even dimensions for the encoder, and nothing else: `overscan` is 1 here
    // (see above), so this neither grows nor shrinks the picture.
    const cropW = Math.round((source.width * overscan) / 2) * 2;
    const cropH = Math.round((source.height * overscan) / 2) * 2;
    if (cropW !== source.width || cropH !== source.height) {
      videoParts.push(`scale=${cropW}:${cropH}:flags=lanczos`);
    }
    videoParts.push("setsar=1");
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
      // The overscan actually taken, not the constant. They are the same number
      // unless a wide shot size asked for more, and passing the constant there
      // would put the base zoom below the crop — every frame of the video
      // wider than the person asked for, and nothing to say so.
      base: overscan,
      fps,
      totalFrames,
      kenBurns: kenBurns ? { to: kenBurns.to } : undefined,
      punches,
      takes: takeScales,
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
    if (takes.length > 0) {
      // What the viewer can see, which is the number of *changes*, not the
      // number of stretches. Neighbouring shots at one size are one take, and a
      // note counting them separately would be counting something nobody
      // watching the video could point at.
      const changes = takes.length - 1;
      const tight = takes.filter((take) => take.size === "tight").length;
      /*
        The claim about the pixels is only true where the margin is real.

        With a reframe the wide size is the margin the crop already had and
        both sizes are native. Without one there is no margin — the frame is
        the whole picture — so the margin is manufactured by scaling up, and
        the close size is a fifteen per cent upscale. Both sentences were the
        first one, which told somebody their footage was untouched while every
        close shot in it had been enlarged.
      */
      notes.push(
        reframe
          ? t(
              `cut between a wide and a tight version of the frame, changing size ${changes} time${changes === 1 ? "" : "s"} across ${takes.length} shots. ${tight} of them are the close one, and both sizes are native: the wide one is the margin the crop already had`,
              `قطعت بين نسخة واسعة وأخرى ضيّقة من الكادر، وغيّرت الحجم ${changes} ${changes === 1 ? "مرّة" : "مرّات"} عبر ${takes.length} لقطات، منها ${tight} قريبة. والحجمان بدقّة أصلية، فالواسع هو الهامش الذي كان القصّ يأخذه أصلًا`,
            )
          : t(
              `cut between a wide and a tight version of the frame, changing size ${changes} time${changes === 1 ? "" : "s"} across ${takes.length} shots. ${tight} of them are the close one, which is a slight enlargement: this clip is not being reframed, so there is no margin outside the picture to pull back into`,
              `قطعت بين نسخة واسعة وأخرى ضيّقة من الكادر، وغيّرت الحجم ${changes} ${changes === 1 ? "مرّة" : "مرّات"} عبر ${takes.length} لقطات، منها ${tight} قريبة، وهي تكبير طفيف، فهذا المقطع لا يُعاد تأطيره، ولا هامش خارج الصورة أتراجع إليه`,
            ),
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
    // Resolved once and passed to both, because the wrapper measures against a
    // face's width and the style row names it: two calls that disagreed about
    // which face this render uses would wrap for one and draw the other.
    const faces = facePair({ latin: captions.font, arabic: captions.fontArabic }, ctx.faces?.available);
    const wrapped = wrapToLayout(cues, layout, faces);
    /**
     * Words that did not survive the wrap, said out loud.
     *
     * `wrapToLayout` cuts a cue to `maxLines` and appends an ellipsis, which is
     * the right thing to draw — a caption that spills climbs over the speaker's
     * face. It is not the right thing to do *quietly*. Two thirds of every
     * caption on every widescreen export was being discarded this way, and the
     * note underneath said "burned 42 captions".
     *
     * The grouping upstream now uses the real frame, so this should be rare;
     * a real output can still differ from the default height, and when it does
     * the person is told which words are missing rather than left to notice.
     */
    const trimmed = wrapped.filter((cue, i) => cue.text.endsWith("…") && !cues[i].text.endsWith("…")).length;
    if (trimmed > 0) {
      notes.push(
        t(
          `${trimmed} caption${trimmed === 1 ? " was" : "s were"} too long for this frame, so ${trimmed === 1 ? "it ends" : "they end"} on an ellipsis rather than covering the picture`,
          `${trimmed} كابشن أطول من أن يتّسع لها هذا الإطار، فتنتهي بعلامة حذف بدل أن تغطّي الصورة`,
        ),
      );
    }
    await writeSubtitleFile(
      subtitlePath,
      wrapped,
      captions.style,
      captions.animation,
      { width: frameWidth, height: frameHeight },
      layout,
      faces,
    );
    /*
      `fontsdir` only when there is one. libass reads the machine's fontconfig
      either way; this adds a directory to it for the length of this render,
      which is how an uploaded face is used without being installed.
    */
    const fontsdir = ctx.faces?.dir
      ? `:fontsdir=${ctx.faces.dir.replace(/[\\:']/g, "\\$&")}`
      : "";
    videoParts.push(`subtitles=${subtitlePath.replace(/[\\:']/g, "\\$&")}${fontsdir}`);
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
    } else if (captions.animation === "kinetic" && !wipeable) {
      /*
        The same admission as the wipe's, for the same reason.

        Kinetic is built out of per-word times: a word cannot arrive when it is
        spoken if nobody said when it was spoken. The animation degrades to the
        whole caption popping in, which is a real animation and not the one
        that was asked for — and somebody who asked, did not get it, and was
        told they did has no way to find out why.
      */
      notes.push(
        t(
          `burned ${cues.length} captions, but the words came back without their own timings, so the whole caption pops in rather than arriving a word at a time`,
          `حرقت ${cues.length} كابشن، لكن الكلمات عادت بلا توقيت خاصّ بها، فتظهر الجملة كاملة بدل أن تصل كلمةً كلمة`,
        ),
      );
    } else {
      notes.push(t(`burned ${cues.length} captions (${captions.animation})`, `حرقت ${cues.length} كابشن (${captions.animation})`));
    }
  }

  if (watermark) {
    /*
      The watermark text goes in a file, and that is a security boundary, not a
      convenience.

      It used to be interpolated straight into the filtergraph —
      `drawtext=text='<escaped>'` — behind a helper that escaped `\ : ' %` and
      nothing else. That is not enough. Inside an ffmpeg filtergraph a `\'`
      does not escape a quote, it *ends* the quoted run, and once the quote is
      closed an un-escaped `,` starts a brand-new filter. So a watermark of
      `',drawtext=textfile=/proc/self/environ,drawtext=text='` — 54 characters,
      inside the 60 the schema allows — parsed as three chained filters, the
      middle one drawing this worker's own environment (its keys, its database
      URL) onto the frame the person then downloads. `render-policy.ts` only
      replaces a client watermark on the free plan, so any paid account reached
      this. Measured against a real ffmpeg: the injected `textfile=` opened the
      named file.

      The text is not graph syntax, so it must not travel in the graph string.
      It is written to a file the server names, and `textfile=` reads it as the
      literal bytes it is. `expansion=none` stops drawtext interpreting its own
      `%{…}` sequences in that content. The only thing left in the graph is the
      filename, which is ours, escaped the way every other path in this file is.
      A payload like the one above now draws as its own absurd text and opens
      nothing — see tools/watermark-test.mjs, which measures both.
    */
    const watermarkPath = path.join(ctx.workDir, "watermark.txt");
    await writeFile(watermarkPath, watermark.text, "utf8");
    videoParts.push(
      [
        `drawtext=textfile='${watermarkPath.replace(/[\\:']/g, "\\$&")}'`,
        "expansion=none",
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
    /*
      The room, before the level.

      A phone or a laptop records the room as well as the person in it: a
      fridge, a fan, traffic through a window, the desk the microphone is
      standing on. Almost all of that sits below 80Hz, and no speech does — the
      lowest voices start around 85 — so it carries none of the words and a
      real share of the energy.

      Which is why it goes *before* `loudnorm` rather than after. Levelling
      measures everything in the file, so rumble is loudness as far as it is
      concerned: it pushes the whole mix down to make room for sound nobody can
      hear as anything. Measured on a take with room tone under it, the filter
      drops the rumble 7.6dB and leaves the voice band *very slightly louder*
      at the same target.

      Only when the plan says the clip is speech, and that is not caution for
      its own sake: the same filter is exactly wrong for music, where the
      bottom octave of a kick drum is the part it would take.
    */
    /*
      And on the *speech*, not on the finished mix.

      `audioParts` is applied to the programme after the bed and the effects
      have been mixed into it, so `voice: true` on a plan that also lays music
      took the bottom octave out of the music — which the paragraph above says
      in as many words is exactly wrong. Measured with a kick under it: 3.3 dB
      off the bed below 120 Hz, a 5.5 dB tilt across the track, and the note
      said "the room tone under the voice was filtered out". `plan-from-text`
      guards against emitting the pair; `direct.ts` does not, so any project
      holding an audio file gets it.

      Flagged here rather than filtered here: the music block below puts it on
      the speech leg before the mix.
    */
    if (loudness.voice) filterTheRoomOut = true;
    // -14 LUFS is what every one of these platforms normalises to. Arriving at
    // the right level means they leave the audio alone.
    audioParts.push(`loudnorm=I=${loudness.targetLufs}:TP=-1.5:LRA=11`);
    // The render levelled. The reviewer measures and corrects only what this
    // says it did, so an effects-only mix the render left alone is not "fixed".
    levelled = true;
    notes.push(
      loudness.voice
        ? t(
            `levelled to ${loudness.targetLufs} LUFS, with the room tone under the voice filtered out`,
            `سُوّي المستوى إلى ${loudness.targetLufs} LUFS، مع ترشيح ضجيج الغرفة تحت الصوت`,
          )
        : t(`levelled to ${loudness.targetLufs} LUFS`, `سُوّي المستوى إلى ${loudness.targetLufs} LUFS`),
    );
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
  /** Where the layer's own clock sits on the edit's. */
  let motionFrom = 0;
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
      /*
        Only the stretch the titles are actually on screen for.

        The layer was always rendered from zero, so its cost was the *end* time
        of the last title rather than its length — and every frame before the
        first one is fully transparent. A title placed at 8:30 of a podcast
        asked Chromium for 51,110 screenshots: measured at 102ms each and 12 KB
        per empty frame, that is eighty-five minutes and six hundred megabytes
        to draw two and a half seconds of text, on a box with 1 GB, with no
        deadline on it and no progress reported while it ran. The job looked
        hung because it was.

        So the layer starts a little before the first title and ends a little
        after the last, and the overlay puts it back where it belongs.
      */
      const from = Math.max(0, Math.min(...titles.map((title) => title.at)) - MOTION_LEAD_SECONDS);
      const until = Math.max(...titles.map((t) => t.at + t.durationSeconds)) + 0.6;
      motionFrom = from;
      motionLayer = await renderMotionLayer(
        {
          width: frameWidth,
          height: frameHeight,
          fps: source.fps,
          titles: titles.map((title) => ({ ...title, at: title.at - from })),
          durationSeconds: until - from,
        },
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
        // Which of the two silences this is. See `unreachableAssetIds`.
        notes.push(
          ctx.unreachableAssetIds?.has(op.assetId)
            ? t(
                "skipped an overlay: that file is in your project and we could not fetch it this time",
                "تخطّيت تراكبًا: الملفّ موجود في مشروعك ولم نتمكّن من جلبه هذه المرّة",
              )
            : t(
                "skipped an overlay: that file is not in this project",
                "تخطّيت تراكبًا: ذلك الملفّ ليس في هذا المشروع",
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
        /*
          `keepSourceAudio: false` is in the contract and is not implemented.

          Nothing in this file has ever read the field: the b-roll's own audio
          stream is never referenced, so the answer is always "yes, keep the
          speech" whatever the plan says. Both producers hard-code `true`, so
          nobody has met it — but a contract field that silently means one
          thing is a promise, and the honest cost of not keeping it is one
          sentence.
        */
        if (op.keepSourceAudio === false) {
          notes.push(
            t(
              "kept the speech under the b-roll: playing the b-roll's own sound instead is not something this can do yet",
              "أبقيت الكلام تحت اللقطة المساندة: تشغيل صوت اللقطة نفسها بدلًا منه ليس ممّا أستطيعه بعد",
            ),
          );
        }
        /*
          A photograph is a legal cutaway, and it used to render as nothing.

          `addInput("-i", file)` on a still gives an input of exactly one frame.
          `trim` then has one frame to take, `setpts` moves it to the start of
          the window, and `overlay` with `eof_action=pass` lets the base
          through from there on — so the picture never changed. Measured, not
          reasoned: a red still cut into a green clip left the frame green at
          every sample inside the window, including its middle. Nothing failed,
          nothing was logged, and the note said "cut to b-roll".

          `-loop 1 -t` gives the still a duration, and `fps` gives it the
          output's frame rate, which is the same pair `overlayImage` above has
          always used. The extra half second matches that branch too: the input
          must outlast the window, or the last frames of the cutaway are the
          base again.

          The kind is re-derived from the bytes at upload, so this is asking
          what the file *is*, not what the plan called it.
        */
        const still = asset.kind === "image";
        /*
          And a moving cutaway is only as long as the clip really is, with the
          note saying which.

          `trim` cannot invent frames and `eof_action=pass` lets the main
          picture back through, so a one-second clip asked to cover three
          seconds simply stopped after one — and the note said "cut to b-roll
          for 3.0s". The cutaway was a third of what was asked for and a third
          of what was reported, with nothing anywhere saying so.

          A still is exempt, and has to be: `-loop 1 -t` gives it exactly the
          duration asked for, so there is no length to fall short of and
          probing a single-frame input for one would only invent a shortfall.
        */
        const wanted = end - start;
        const held = still ? null : await probeDuration(asset.file).catch(() => null);
        const covered = held !== null && held > 0.05 ? Math.min(wanted, held) : wanted;
        const shortAsset = covered < wanted - 0.05;
        idx = still
          ? addInput("-loop", "1", "-t", (covered + 0.5).toFixed(3), "-i", asset.file)
          : addInput("-i", asset.file);
        const fit =
          op.fit === "cover"
            ? `scale=${frameWidth}:${frameHeight}:force_original_aspect_ratio=increase:flags=lanczos,crop=${frameWidth}:${frameHeight}`
            : `scale=${frameWidth}:${frameHeight}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${frameWidth}:${frameHeight}:(ow-iw)/2:(oh-ih)/2:black`;
        const rate = still ? `,fps=${source.fps.toFixed(4)}` : "";
        overlayLinks.push(
          `[${idx}:v]${fit},setsar=1${rate},trim=0:${covered.toFixed(3)},setpts=PTS-STARTPTS+${start.toFixed(3)}/TB[br${idx}]`,
        );
        overlayLinks.push(
          `[${inLabel}][br${idx}]overlay=0:0:` +
            `enable='between(t,${start.toFixed(3)},${(start + covered).toFixed(3)})':eof_action=pass[${outLabel}]`,
        );
        notes.push(
          shortAsset
            ? t(
                `cut to b-roll at ${start.toFixed(1)}s for ${covered.toFixed(1)}s. That clip is only ${covered.toFixed(1)}s long, and ${wanted.toFixed(1)}s was asked for`,
                `قطعت إلى لقطة مساندة عند الثانية ${start.toFixed(1)} لمدّة ${covered.toFixed(1)} ثانية. طول ذلك المقطع ${covered.toFixed(1)} ثانية فقط، والمطلوب كان ${wanted.toFixed(1)}`,
              )
            : t(
                `cut to b-roll at ${start.toFixed(1)}s for ${covered.toFixed(1)}s`,
                `قطعت إلى لقطة مساندة عند الثانية ${start.toFixed(1)} لمدّة ${covered.toFixed(1)} ثانية`,
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
        `select='not(mod(n\\,${MOTION_SUBSAMPLES}))',` +
        // Back to the output rate, and then forward to where the titles are.
        // The layer covers its own stretch and nothing else; `eof_action=pass`
        // lets the picture through on both sides of it.
        `setpts=N/${source.fps.toFixed(4)}/TB+${motionFrom.toFixed(4)}/TB,` +
        `scale=${frameWidth}:${frameHeight}[mot]`,
    );
    overlayLinks.push(`[${inLabel}][mot]overlay=0:0:eof_action=pass[${outLabel}]`);
  }

  // ── The sound layer, decided ──────────────────────────────────────────────
  //
  // Decided here and mixed after the bed, and the split is not tidiness: the
  // bed needs to know where the riser is. A riser that runs into a moment and
  // then stops is only half the effect — the other half is that everything else
  // gets out of the way while it climbs, which is the deliberate silence a
  // person hears as "something is about to happen". So the music dips under it,
  // and the music chain is built below.
  //
  // Nothing here opens a file. `sfx.ts` is a pure function over the finished
  // timeline, so every threshold in it is checked without ffmpeg; what is left
  // for this file is turning a list of moments into inputs.
  const sfxPlan =
    soundEffects
      ? placeSoundEffects({
          duration: effectiveDuration,
          // Joins on the *output* clock, overlap included — a whoosh placed by
          // the un-overlapped map drifts further out of sync with every join it
          // survives, which is the same arithmetic every caption is placed by.
          joins: kept ? joinTimes(kept, overlap) : [],
          // `zoomPunch.at` is already on the output clock here: the critic
          // remapped the emphasis moments and the beat grid was never on any
          // other clock. This is the first line in the file where both are true.
          punches: zoomPunch?.at ?? [],
          palette: soundEffects.palette as SfxPalette,
          onCuts: soundEffects.onCuts,
          onPunches: soundEffects.onPunches,
          onOpen: soundEffects.onOpen,
        })
      : null;
  /*
    The riser the render will actually lay, not the one the plan chose.

    The bed dips under it, and the dip is built here — before the effects are
    turned into inputs, which is where a missing file is noticed. So an image
    without the sound assets pulled the music down 7.3 dB (measured) for a
    riser that was not in the file, and said so, immediately above the note
    saying it could not find the sound effect files in this build. Music
    stepping out of the way of nothing is the most audible way a soundtrack can
    be wrong.
  */
  const plannedRiser = sfxPlan?.cues.find((c) => c.reason === "open") ?? null;
  const riserCue = plannedRiser && (await sfxFile(plannedRiser.sound)) ? plannedRiser : null;

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
  /*
    The de-rumble goes on the speech, before anything is mixed into it. See the
    loudness block for why it must not reach the bed.
  */
  const speechParts: string[] = [];
  if (filterTheRoomOut && source.hasAudio) {
    speechParts.push(`[${aLabel}]highpass=f=80[spdry]`);
    aLabel = "spdry";
  }

  const musicParts: string[] = [];
  let musicMixed = false;
  if (music) {
    if (!musicAsset) {
      // Same distinction as the overlay above, and it matters more here: the
      // music is the thing somebody notices missing.
      notes.push(
        ctx.unreachableAssetIds?.has(music.assetId)
          ? t(
              "skipped the music: that track is in your project and we could not fetch it this time",
              "تخطّيت الموسيقى: ذلك المقطع موجود في مشروعك ولم نتمكّن من جلبه هذه المرّة",
            )
          : t(
              "skipped the music: that track is not in this project",
              "تخطّيت الموسيقى: ذلك المقطع ليس في هذا المشروع",
            ),
      );
    } else if (!musicUsable) {
      // The kind is re-derived from the bytes on upload, so this is a plan
      // asking to play a video file as a song, not a mislabelled file.
      notes.push(
        t("skipped the music: that asset is not an audio file", "تخطّيت الموسيقى: ذلك الملفّ ليس ملفًّا صوتيًّا"),
      );
    } else {
      /*
        The intro, actually removed, when the bed both starts late and repeats.

        `-ss` before `-i` seeks the *first* pass; `-stream_loop` then replays
        the decoded stream from its beginning, so every repeat after the first
        played the intro the person asked to skip. Measured with a track whose
        every second is a different tone, laid with `fromSeconds: 4` under a
        thirty-second clip: seconds 4,5,6,7 then 0,1,2,3 then 4,5,6,7 again.
        The repeat period on the edit clock is therefore the track's whole
        length, not the length past the seek — so `loopPeriod` was wrong too,
        and beat punches drifted by `fromSeconds` per pass, measured at 60 to
        240ms out on a 120 bpm bed.

        Cutting the intro off once, into a copy, makes the loop the loop the
        person asked for. A stream copy, so it costs a remux rather than an
        encode.
      */
      let bedFile = musicAsset.file;
      let seekApplied = false;
      /*
        A looped AAC bed drops out for twenty milliseconds at every seam.

        `-stream_loop` repeats the *decoded* stream, and an AAC decode carries
        the encoder's priming and padding with it: measured on an 8-second
        m4a laid under a 30-second edit, the level falls to digital silence
        from 8.012s to 8.020s, once per pass. mp3 (which carries a gapless
        tag), wav and ogg are all seamless; `audio/mp4`, `audio/x-m4a` and
        `audio/aac` are all accepted uploads, so this is a hole in the bed of
        every second video whose music came off a phone.

        Decoding once to PCM removes the padding along with the codec. The
        cost is disk for the length of the track and a few seconds of decode.
      */
      const bedIsAac = /\.(m4a|aac|mp4)$/i.test(musicAsset.file);
      if (music.loop && bedIsAac) {
        const flat = path.join(ctx.workDir, "bed-flat.wav");
        // The container's own length is the track's length; the decode is
        // longer than that by exactly the padding, so `-t` is what removes it.
        // Measured: an 8.000s m4a decodes to 8.0109s, and the last 11ms are
        // the near-silence that became the hole.
        const nominal = await containerSeconds(musicAsset.file);
        try {
          await run(FFMPEG, [
            "-hide_banner", "-y",
            ...(music.fromSeconds > 0 ? ["-ss", music.fromSeconds.toFixed(3)] : []),
            "-i", musicAsset.file,
            ...(nominal !== null && nominal > music.fromSeconds
              ? ["-t", (nominal - music.fromSeconds).toFixed(3)]
              : []),
            "-vn", "-c:a", "pcm_s16le", "-ar", "48000",
            flat,
          ], { limits: LIMITS.analysis });
          bedFile = flat;
          seekApplied = music.fromSeconds > 0;
        } catch {
          // A track that will not decode to PCM here will not decode in the
          // graph either, and the graph's failure is the one with a message.
        }
      }
      if (music.loop && music.fromSeconds > 0 && !seekApplied) {
        const trimmed = path.join(ctx.workDir, `bed-from${Math.round(music.fromSeconds)}${path.extname(musicAsset.file) || ".m4a"}`);
        try {
          await run(FFMPEG, [
            "-hide_banner", "-y",
            "-ss", music.fromSeconds.toFixed(3),
            "-i", musicAsset.file,
            "-vn", "-c:a", "copy",
            trimmed,
          ], { limits: LIMITS.probe });
          bedFile = trimmed;
          seekApplied = true;
        } catch {
          // A container a stream copy cannot rewrite is not a reason to drop
          // the music: fall back to seeking the first pass, which is what this
          // did before, and the repeats bring the intro back.
        }
      }

      const inputArgs: string[] = [];
      // `-stream_loop` before `-i` repeats the decoded input; the trim below
      // is what makes the repetition finite. Without the trim a looped bed is
      // an input that never ends and a render that never returns.
      if (music.loop) inputArgs.push("-stream_loop", "-1");
      // Seeking the input rather than trimming the filter means the first pass
      // starts past the intro. Where the bed repeats, the copy above has
      // already removed it and there is nothing left to seek.
      if (music.fromSeconds > 0 && !seekApplied) inputArgs.push("-ss", music.fromSeconds.toFixed(3));
      inputArgs.push("-i", bedFile);
      const idx = addInput(...inputArgs);

      // The fades are the bed's own, not the edit's: `fade` ramps the finished
      // picture and mix together, and a bed that snapped in under a fade-in
      // would announce itself as an edit. Clamped to a third of the output so
      // the two never meet in the middle of a short clip.
      /*
        How much of the edit the bed actually covers.

        With `loop: false` and a track shorter than the edit, everything
        end-anchored was written past the end of the bed's own stream: the
        fade-out never ran, so the music played at full level and stopped dead;
        `atrim` left the output's audio stream shorter than its picture — 8
        seconds of sound under 30 seconds of video, with `hasAudioOut` true —
        and the note still said the music was laid "under the whole edit".
      */
      const bedSeconds = music.loop ? null : await containerSeconds(bedFile);
      const covered =
        bedSeconds === null
          ? effectiveDuration
          : Math.max(0, Math.min(effectiveDuration, bedSeconds - (seekApplied ? 0 : music.fromSeconds)));
      const bedRunsShort = covered < effectiveDuration - 0.2;

      const askedFade = music.fadeSeconds;
      const fadeSeconds = Math.min(askedFade, effectiveDuration / 3);
      const fadeChain =
        fadeSeconds > 0.01
          ? `,afade=t=in:st=0:d=${fadeSeconds.toFixed(3)}` +
            `,afade=t=out:st=${Math.max(0, covered - fadeSeconds).toFixed(3)}:d=${fadeSeconds.toFixed(3)}`
          : "";

      /*
        The hole the riser climbs into.

        A riser works by removing things, not by adding one. The lift announces
        a moment; what makes the moment land is that the bed steps out of the
        way while it climbs and steps back after. Without this the riser is one
        more sound competing with the music it is supposed to be clearing.

        A trapezoid rather than a switch, and written as a `min` of two ramps
        for the same reason `zoomExpression` is: `enable=` toggles the filter
        between frames, and a bed jumping 8 dB in one frame is a click. Down
        over 300ms from where the riser starts, held to the seam, back over
        500ms after it — the release is longer because coming back is the part
        nobody should be able to point at.

        `eval=frame` is not optional: without it ffmpeg evaluates the expression
        once, at zero, and the bed plays the whole edit at whatever the dip
        happened to be on the first frame. Nothing fails; the mix is simply
        wrong for the entire video.
      */
      const dipChain = riserCue
        ? `,volume=volume='1-0.6*max(0,min(1,min((t-${riserCue.at.toFixed(3)})/0.3,` +
          `(${(riserCue.at + riserCue.seconds + 0.5).toFixed(3)}-t)/0.5)))':eval=frame`
        : "";

      musicParts.push(
        `[${idx}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
          `atrim=0:${effectiveDuration.toFixed(3)},asetpts=PTS-STARTPTS,` +
          // Padded to the length of the edit, so a bed that runs out does not
          // take the output's audio stream with it.
          `apad=whole_dur=${effectiveDuration.toFixed(3)},atrim=0:${effectiveDuration.toFixed(3)},` +
          `volume=${music.gainDb.toFixed(1)}dB${fadeChain}${dipChain}[mus]`,
      );

      const wantsDuck = music.duck && source.hasAudio;
      if (source.hasAudio) {
        if (wantsDuck) {
          // The speech keys its own ducking. `asplit` because the same stream
          // has to be both the thing you hear and the thing the compressor
          // listens to — ffmpeg will not read one link twice.
          musicParts.push(`[${aLabel}]asplit=2[spmain][spkey]`);
          /*
            The threshold, put where this recording's speech actually is.

            0.02 is -34 dBFS, and it was written against a recording made at an
            ordinary level: a take peaking near full scale crosses it on every
            syllable. A take peaking at -29 dBFS RMS never crosses it at all —
            measured, 0.0 dB of ducking across the whole file, while the note
            said "ducking under the speech". The reduction was a function of how
            close the person held the microphone, not of how loud they were
            against the bed, and the same content recorded 12 dB hotter ducked
            by 10 to 14 dB. `loudnorm` runs after this mix, so nothing
            downstream could recover it either.

            Scaled by the same peak the effects layer is placed against, and
            floored so a very quiet file keys on speech rather than on its own
            noise.
          */
          const key = duckThreshold(await sourcePeakDb());
          musicParts.push(
            `[mus][spkey]sidechaincompress=threshold=${key.toFixed(5)}:ratio=6:attack=15:release=350[musduck]`,
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

      if (riserCue) {
        notes.push(
          t(
            "pulled the music down under the riser so the moment it leads into is not competing with it",
            "خفضت الموسيقى تحت اللفتة الصاعدة كي لا تزاحم اللحظة التي تقود إليها",
          ),
        );
      }

      /*
        How far it reaches, in both languages. A bed that runs out is a fact
        about the file the person uploaded, and the sentence that said "under
        the whole edit" was the same sentence whether it did or not.
      */
      const reach = bedRunsShort ? `under the first ${covered.toFixed(1)}s of the edit` : "under the whole edit";
      const reachAr = bedRunsShort ? `تحت أوّل ${covered.toFixed(1)} ثانية من التعديل` : "تحت التعديل كلّه";
      notes.push(
        !source.hasAudio
          ? t(
              `laid music ${reach} at ${music.gainDb.toFixed(0)}dB. This clip had no sound of its own, so the music is all of it`,
              `وضعت الموسيقى ${reachAr} عند ${music.gainDb.toFixed(0)}dB. هذا المقطع لا صوت له أصلًا، فالموسيقى هي صوته كلّه`,
            )
          : wantsDuck
            ? t(
                `laid music ${reach} at ${music.gainDb.toFixed(0)}dB, ducking under the speech`,
                `وضعت الموسيقى ${reachAr} عند ${music.gainDb.toFixed(0)}dB، تنخفض تحت الكلام`,
              )
            : t(
                `laid music ${reach} at ${music.gainDb.toFixed(0)}dB`,
                `وضعت الموسيقى ${reachAr} عند ${music.gainDb.toFixed(0)}dB`,
              ),
      );
      if (fadeSeconds < askedFade - 0.001 && askedFade > 0) {
        notes.push(
          t(
            `the music fades run ${fadeSeconds.toFixed(1)}s rather than the ${askedFade.toFixed(1)}s asked, so they stay a third of this short edit at most`,
            `تلاشي الموسيقى ${fadeSeconds.toFixed(1)} ثانية بدل ${askedFade.toFixed(1)} المطلوبة، كي يبقى ثلث هذا التعديل القصير على الأكثر`,
          ),
        );
      }
    }
  }

  // ── The sound layer, mixed ────────────────────────────────────────────────
  //
  // One ffmpeg input per sound, delayed to its moment, all of them summed into
  // one bus and the bus mixed under the programme. `normalize=0` on both mixes
  // for the reason spelled out over the bed: amix averages by default, so a
  // layer laid in at -12 dB would also pull the voice down and the loudness
  // note above would be a lie about a file that is quieter than it says.
  //
  // Before `loudnorm`, not after, and that is a choice. The platforms level to
  // -14 LUFS integrated; what they measure is the finished programme including
  // its accents, so the accents have to be inside the measurement or the file
  // arrives at the wrong level and gets turned down on the way in.
  //
  // Every failure here is a note. A missing folder, a name with no file, an
  // edit with nothing to accent: none of them fail a render somebody paid for.
  const sfxParts: string[] = [];
  let sfxMixed = false;
  if (soundEffects && sfxPlan) {
    if (sfxPlan.cues.length === 0) {
      /*
        Why there was nowhere to put one, rather than one reason for every
        case. An edit under `MIN_EDIT_SECONDS` has no room for a layer at all
        — including a two-second clip with a cut in the middle of it, which was
        being told it had no cuts. That is the normal shape on the clips path,
        where a short trailing clip is its own render.
      */
      notes.push(
        effectiveDuration < SFX_MIN_EDIT_SECONDS
          ? t(
              `left the sound effects out: at ${effectiveDuration.toFixed(1)}s this edit is too short for one to land in`,
              `تركت المؤثّرات الصوتية: بطول ${effectiveDuration.toFixed(1)} ثانية هذا التعديل أقصر من أن يقع فيه مؤثّر`,
            )
          : t(
              "left the sound effects out: this edit has no cuts and no punch-ins for one to land on",
              "تركت المؤثّرات الصوتية: هذا التعديل لا قصّات فيه ولا تقريبات تقع عليها",
            ),
      );
    } else {
      const labels: string[] = [];
      /** The cues that became inputs, which is what the note has to count. */
      const laid: typeof sfxPlan.cues = [];
      let missing = 0;

      /*
        `gainDb` is a level *relative to the programme*, so the programme has
        to be measured.

        The contract says so in as many words — "how far under the programme
        the layer sits; -12 dB is an accent you feel on a cut and would not be
        able to point at afterwards" — and the renderer treated it as an
        absolute attenuation. Every file ships peak-normalised to -3 dBFS, so
        the layer's peak was -3 + trimDb + gainDb whatever the recording was.
        Measured on a source peaking at -17.7 dBFS, which is an ordinary
        unnormalised phone or call recording: the whoosh came out at -16.5, a
        decibel *above* the speech it was meant to sit twelve under. The mix is
        deliberately upstream of `loudnorm`, so levelling could not recover the
        ratio either — the same take recorded further from the mic got a
        completely different mix and the same sentence.

        Shifting the layer by however far the recording falls short of the
        normalisation the files were built to restores the relationship the
        number describes. Never a boost: a recording already at full scale
        changes nothing.
      */
      const layerOffsetDb = sfxLayerOffsetDb(await sourcePeakDb());
      for (const cue of sfxPlan.cues) {
        const file = await sfxFile(cue.sound);
        if (!file) {
          missing += 1;
          continue;
        }
        laid.push(cue);
        const idx = addInput("-i", file);
        const label = `sfx${labels.length}`;
        // Trimmed to the room left before the end. A file that would run past
        // the last frame is not silently truncated by the mux — it is cut mid
        // waveform, which is a click on the last thing anybody hears.
        const room = Math.max(0.05, effectiveDuration - cue.at);
        const length = Math.min(cue.seconds, room);
        /*
          A trimmed cue is ramped out, because `atrim` is a step.

          The comment above is right about why the trim exists and wrong that
          it removes the click: cutting the file short *is* the mid-waveform
          cut. Measured at the trim point, `whoosh-soft` is at -7.6 dBFS,
          `whoosh-air` at -7.8 and `impact-deep` at -9.4 — a near-full-amplitude
          step to digital silence on the final frame, which short-form
          platforms play again immediately, so it is a click on every loop. Six
          milliseconds is under any threshold for a fade and well over the one
          for a step.
        */
        const clipped = length < cue.seconds - 1e-3;
        const ramp = Math.min(0.006, length / 4);
        const delayMs = Math.round(cue.at * 1000);
        sfxParts.push(
          `[${idx}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
            `atrim=0:${length.toFixed(3)},asetpts=PTS-STARTPTS,` +
            (clipped ? `afade=t=out:st=${(length - ramp).toFixed(4)}:d=${ramp.toFixed(4)},` : "") +
            `volume=${(soundEffects.gainDb + cue.trimDb + layerOffsetDb).toFixed(1)}dB` +
            `${delayMs > 0 ? `,adelay=${delayMs}:all=1` : ""}[${label}]`,
        );
        labels.push(label);
      }

      if (labels.length === 0) {
        notes.push(
          t(
            "could not find the sound effect files in this build, so the edit was left without them",
            "لم أجد ملفّات المؤثّرات الصوتية في هذه النسخة، فتُرك التعديل بلا مؤثّرات",
          ),
        );
      } else {
        let bus = labels[0]!;
        if (labels.length > 1) {
          // `duration=longest`, because each of these is a different length and
          // ending the bus with the first sound would drop every later one.
          sfxParts.push(
            `${labels.map((l) => `[${l}]`).join("")}` +
              `amix=inputs=${labels.length}:duration=longest:dropout_transition=0:normalize=0[sfxbus]`,
          );
          bus = "sfxbus";
        }

        // A clip with no sound of its own and no bed still has to come out with
        // the layer on it, and `amix` needs something to be the programme. An
        // explicit silence of exactly the right length is that something —
        // `duration=first` then means "as long as the video", which is what
        // every other branch of this mix already means.
        if (!source.hasAudio && !musicMixed) {
          const idx = addInput("-f", "lavfi", "-t", effectiveDuration.toFixed(3), "-i", "anullsrc=r=48000:cl=stereo");
          sfxParts.push(`[${idx}:a]asetpts=PTS-STARTPTS[sfxbase]`);
          aLabel = "sfxbase";
        }

        sfxParts.push(
          `[${aLabel}][${bus}]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[amixsfx]`,
        );
        aLabel = "amixsfx";
        sfxMixed = true;
        hasAudioOut = true;

        // The levelling pass reads `hasAudioOut` above, before this layer turns
        // it on, and that is deliberate: a soundtrack that is four whooshes and
        // nothing else must not be pushed to -14 LUFS, which would make the
        // accents as loud as a person talking. But the plan asked for
        // `normalizeLoudness`, and a request that quietly does not happen is the
        // failure this file is written against — so it is said, not dropped.
        if (loudness && !source.hasAudio && !musicMixed) {
          notes.push(
            t(
              "did not level the audio: the only sound here is the effects, kept at their own accent level rather than raised to a speaking one",
              "لم أُسوِّ المستوى: الصوت الوحيد هنا هو المؤثّرات، تُركت على مستوى لكنتها لا رُفعت إلى مستوى الكلام",
            ),
          );
        }

        // Counted off what was laid, not off what was planned. The headline
        // used `labels.length` and the breakdown used the plan, so a build
        // missing one file said "laid 2 sound effects: 3 on the cuts".
        const cuts = laid.filter((c) => c.reason === "cut").length;
        const hits = laid.filter((c) => c.reason === "punch").length;
        const riserLaid = laid.some((c) => c.reason === "open");
        const parts: string[] = [];
        const partsAr: string[] = [];
        if (cuts > 0) {
          parts.push(`${cuts} on the cuts`);
          partsAr.push(`${cuts} على القصّات`);
        }
        if (hits > 0) {
          parts.push(`${hits} under the punch-ins`);
          partsAr.push(`${hits} تحت التقريبات`);
        }
        if (riserLaid) {
          parts.push("and a riser into the first seam");
          partsAr.push("ولفتة صاعدة إلى أوّل وصلة");
        }
        notes.push(
          t(
            `laid ${labels.length} sound effect${labels.length === 1 ? "" : "s"} at ${soundEffects.gainDb.toFixed(0)}dB: ${parts.join(", ")}`,
            `وضعت ${labels.length} مؤثّرًا صوتيًّا عند ${soundEffects.gainDb.toFixed(0)}dB: ${partsAr.join("، ")}`,
          ),
        );
        if (missing > 0) {
          notes.push(
            t(
              `${missing} of them had no file in this build and were left out`,
              `${missing} منها بلا ملفّ في هذه النسخة فتُركت`,
            ),
          );
        }
        // Said rather than silently done. Somebody who cut forty times and hears
        // eleven whooshes should know that was a decision, not a fault.
        if (sfxPlan.thinned > 0) {
          notes.push(
            t(
              `${sfxPlan.thinned} more moment${sfxPlan.thinned === 1 ? "" : "s"} could have taken one and did not: a sound on every cut stops being an accent`,
              `${sfxPlan.thinned} لحظة أخرى كانت تحتمل مؤثّرًا ولم تأخذه: صوتٌ على كل قصّة يكفّ عن كونه لكنة`,
            ),
          );
        }
        if (sfxPlan.riserSkipped === "no-room" || sfxPlan.riserSkipped === "no-join") {
          notes.push(
            t(
              "there was no room for a riser before the first join, so it was left out rather than started halfway",
              "لا متّسع للفتة صاعدة قبل أوّل وصلة، فتُركت بدل أن تبدأ من منتصفها",
            ),
          );
        }
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
  graphParts.push(...speechParts);
  graphParts.push(...musicParts);
  graphParts.push(...sfxParts);
  if (hasAudioOut && audioParts.length > 0) graphParts.push(`[${aLabel}]${audioParts.join(",")}[aout]`);

  // A bracketed name is a filter label; a bare one is an input stream. Mixing
  // them up makes ffmpeg look for "0:a" inside the graph and fail on a plan
  // that touches only the picture.
  const overlayTail = overlayLinks.length > 0 ? `[ov${overlayLinks.length / 2}]` : null;
  let finalV = overlayTail ?? (videoParts.length > 0 ? "[vout]" : kept ? `[${vLabel}]` : "0:v");
  let finalA = audioParts.length > 0 ? "[aout]" : kept || musicMixed || sfxMixed ? `[${aLabel}]` : "0:a";

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
            `faded in and out over ${d.toFixed(1)}s, shorter than asked, so the fades stay a third of this short clip at most`,
            `تلاشٍ في الطرفين خلال ${d.toFixed(1)} ثانية، أقصر ممّا طُلب، كي يبقى ثلث هذا المقطع القصير على الأكثر`,
          )
        : t(
            `faded in from black and out to black over ${d.toFixed(1)}s`,
            `فُتح من السواد وأُغلق إليه خلال ${d.toFixed(1)} ثانية`,
          ),
    );
  }

  const graph = graphPrefix + graphParts.join(";");

  /*
    Thread counts stated rather than left to ffmpeg's own guess.

    See `cores.ts`: what ffmpeg counts is the host's CPUs, not this machine's,
    so on Fly it starts dozens of frame threads on a box with one core — and
    each in-flight thread holds a decoded frame, which makes the count a
    multiplier on the peak memory the table above this function is about.

    Before the inputs, because `-threads` is a global option and ffmpeg reads
    an option as belonging to the next file when it comes after one.
  */
  const args = ["-hide_banner", "-y", ...threadArgs(), "-i", input, ...extraInputs];
  if (graph.length > 0) args.push("-filter_complex", graph);

  args.push("-map", finalV);
  if (hasAudioOut) args.push("-map", finalA);

  args.push(...videoEncodeFor(frameHeight, source.fps));
  if (hasAudioOut) args.push(...AUDIO_ENCODE);
  args.push(...FASTSTART, output);

  ctx.onProgress?.(0.15, describeWork(plan));
  ctx.onCommand?.(args);

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
  return { output, notes, sourceSeconds: source.duration, estimatedSeconds: effectiveDuration, hasAudioOut, levelled };
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
  if (types.has("kenBurns") || types.has("zoomPunch") || types.has("alternateFraming"))
    return "Cutting, reframing and adding motion";
  if (types.has("removeSilence")) return "Cutting the silences and reframing";
  return "Rendering";
}

export function describe(op: EditOperation): string {
  switch (op.type) {
    case "removeSilence": return "Cutting the silences";
    case "tighten": return "Cutting the hesitations";
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
    case "soundEffects": return "Laying the sound effects in";
    case "alternateFraming": return "Cutting between two shot sizes";
    // Handled in index.ts before the renderer is called at all: by the time
    // a graph is being written the reel *is* the source. Named here so the
    // switch stays exhaustive and a path that skips the assembly fails to
    // compile rather than silently rendering the first photograph.
    case "stillsReel": return "Building a video from your photos";
  }
}
