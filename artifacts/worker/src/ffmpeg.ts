/**
 * The actual video work.
 *
 * Operations are applied one at a time, each writing an intermediate file,
 * rather than being composed into a single enormous filter_complex. That is
 * slower, and deliberately so: a failed render tells you exactly which
 * operation broke, and each step can be inspected on disk. Renders here are
 * minutes long and run on a machine nobody is waiting on, so clarity is worth
 * more than the saved pass.
 */
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { EditOperation, EditPlan } from "@workspace/api-zod";

export interface Segment {
  /** Seconds. */
  start: number;
  end: number;
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
      // ffmpeg's useful message is always the last few lines, never the first.
      else reject(new FfmpegError(`${bin} exited ${code}\n${stderr.trim().split("\n").slice(-8).join("\n")}`));
    });
  });
}

export async function probeDuration(file: string): Promise<number> {
  const { stdout } = await run(FFPROBE, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  const seconds = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new FfmpegError(`Could not read a duration from ${path.basename(file)}. Is it a valid video?`);
  }
  return seconds;
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
    [
      "-hide_banner",
      "-i", file,
      "-af", `silencedetect=noise=${thresholdDb}dB:d=${minSilenceSeconds}`,
      "-f", "null",
      "-",
    ],
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
  // A silence running to the end of the file never gets a silence_end line.
  if (pendingStart !== null) {
    silences.push({ start: pendingStart, end: await probeDuration(file) });
  }
  return silences;
}

/**
 * Inverts a list of silences into the parts worth keeping, growing each kept
 * part by `padding` on both sides so words are not clipped at the cut.
 */
export function keepSegmentsFrom(
  duration: number,
  silences: Segment[],
  padding: number,
): Segment[] {
  const kept: Segment[] = [];
  let cursor = 0;

  for (const silence of silences) {
    const start = Math.max(0, silence.start + padding);
    if (start > cursor) kept.push({ start: cursor, end: start });
    cursor = Math.max(cursor, Math.min(duration, silence.end - padding));
  }
  if (cursor < duration) kept.push({ start: cursor, end: duration });

  // Fragments this short are cutting artefacts, not content, and each one costs
  // a concat segment.
  const MIN_SEGMENT_SECONDS = 0.05;
  return kept.filter((s) => s.end - s.start > MIN_SEGMENT_SECONDS);
}

/**
 * Where a moment in the original lands after the cuts. Moments inside a removed
 * stretch collapse onto the cut point, which is where a caption for them
 * belongs.
 */
export function remapTime(seconds: number, kept: Segment[]): number {
  let elapsed = 0;
  for (const segment of kept) {
    if (seconds < segment.start) return elapsed;
    if (seconds <= segment.end) return elapsed + (seconds - segment.start);
    elapsed += segment.end - segment.start;
  }
  return elapsed;
}

const PLATFORM_ASPECT: Record<string, { w: number; h: number }> = {
  tiktok: { w: 1080, h: 1920 },
  reels: { w: 1080, h: 1920 },
  shorts: { w: 1080, h: 1920 },
};

function escapeForFilter(text: string): string {
  // drawtext parses its own value, so colons, quotes and backslashes all have
  // to survive two levels of unquoting.
  return text.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/%/g, "\\%");
}

function toAssTime(ms: number): string {
  const cs = Math.round(ms / 10);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

const CAPTION_STYLES: Record<string, string> = {
  // Name, Fontname, Fontsize, PrimaryColour(&HBBGGRR), OutlineColour, ...
  "bold-white": "Style: Cap,DejaVu Sans,64,&H00FFFFFF,&H00000000,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,2,2,60,60,120,1",
  "bold-yellow": "Style: Cap,DejaVu Sans,64,&H0000E5FF,&H00000000,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,2,2,60,60,120,1",
  "karaoke-box": "Style: Cap,DejaVu Sans,60,&H00FFFFFF,&H00000000,&H00000000,&HB0000000,-1,0,0,0,100,100,0,0,3,0,0,2,60,60,140,1",
};

/**
 * Writes an ASS subtitle file. ASS rather than SRT because burning captions in
 * a style anyone would call "viral" needs control over outline, shadow and
 * placement, and SRT carries none of that.
 */
async function writeSubtitleFile(
  file: string,
  cues: Array<{ startMs: number; endMs: number; text: string }>,
  style: string,
): Promise<void> {
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1080",
    "PlayResY: 1920",
    "WrapStyle: 0",
    "",
    "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    CAPTION_STYLES[style] ?? CAPTION_STYLES["bold-white"],
    "",
    "[Events]",
    "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
  ];
  const events = cues
    .filter((c) => c.endMs > c.startMs)
    .map((c) => {
      const text = c.text.replace(/\r?\n/g, "\\N").replace(/[{}]/g, "");
      return `Dialogue: 0,${toAssTime(c.startMs)},${toAssTime(c.endMs)},Cap,,0,0,0,,${text}`;
    });
  await writeFile(file, [...header, ...events].join("\n"), "utf8");
}

export interface RenderContext {
  workDir: string;
  onProgress?: (fraction: number, stage: string) => void;
}

/** Encoder settings shared by every step that re-encodes. */
const VIDEO_ENCODE = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"];
const AUDIO_ENCODE = ["-c:a", "aac", "-b:a", "128k"];

async function applyRemoveSilence(
  input: string,
  output: string,
  op: Extract<EditOperation, { type: "removeSilence" }>,
  ctx: RenderContext,
): Promise<{ kept: Segment[] | null; note: string }> {
  if (!(await hasAudioStream(input))) {
    return { kept: null, note: "no audio track, nothing to trim" };
  }

  const duration = await probeDuration(input);
  const silences = await detectSilences(input, op.thresholdDb, op.minSilenceMs / 1000);
  const kept = keepSegmentsFrom(duration, silences, op.paddingMs / 1000);

  if (kept.length === 0) {
    throw new FfmpegError("The whole clip reads as silence at this threshold — nothing would be left.");
  }
  if (kept.length === 1 && kept[0].end - kept[0].start >= duration - 0.01) {
    return { kept: null, note: "no silence found to remove" };
  }

  // One trim pair per kept segment, concatenated. `setpts`/`asetpts` reset each
  // piece's timestamps to zero so concat lays them end to end.
  const filters: string[] = [];
  kept.forEach((segment, i) => {
    filters.push(`[0:v]trim=start=${segment.start}:end=${segment.end},setpts=PTS-STARTPTS[v${i}]`);
    filters.push(`[0:a]atrim=start=${segment.start}:end=${segment.end},asetpts=PTS-STARTPTS[a${i}]`);
  });
  const streams = kept.map((_, i) => `[v${i}][a${i}]`).join("");
  filters.push(`${streams}concat=n=${kept.length}:v=1:a=1[vout][aout]`);

  await run(FFMPEG, [
    "-hide_banner", "-y",
    "-i", input,
    "-filter_complex", filters.join(";"),
    "-map", "[vout]", "-map", "[aout]",
    ...VIDEO_ENCODE, ...AUDIO_ENCODE,
    output,
  ]);

  const removed = duration - kept.reduce((sum, s) => sum + (s.end - s.start), 0);
  return { kept, note: `removed ${removed.toFixed(1)}s of silence across ${silences.length} gaps` };
}

async function applyFormatForPlatform(
  input: string,
  output: string,
  op: Extract<EditOperation, { type: "formatForPlatform" }>,
): Promise<string> {
  const target = PLATFORM_ASPECT[op.platform] ?? PLATFORM_ASPECT["tiktok"];
  // Fill the frame and crop the overflow, rather than letterboxing: black bars
  // read as low-effort on every one of these platforms.
  const filter = [
    `scale=${target.w}:${target.h}:force_original_aspect_ratio=increase`,
    `crop=${target.w}:${target.h}`,
    "setsar=1",
  ].join(",");

  await run(FFMPEG, [
    "-hide_banner", "-y",
    "-i", input,
    "-vf", filter,
    ...VIDEO_ENCODE,
    "-c:a", "copy",
    output,
  ]);
  return `reframed to ${target.w}x${target.h} for ${op.platform}`;
}

async function applyBurnCaptions(
  input: string,
  output: string,
  op: Extract<EditOperation, { type: "burnCaptions" }>,
  ctx: RenderContext,
  kept: Segment[] | null,
): Promise<string> {
  // Cues are timed against the original. If silence was cut, they have to move
  // with it, or every caption drifts further out of sync as the clip goes on.
  const cues = kept
    ? op.cues.map((c) => ({
        ...c,
        startMs: remapTime(c.startMs / 1000, kept) * 1000,
        endMs: remapTime(c.endMs / 1000, kept) * 1000,
      }))
    : op.cues;

  const subtitlePath = path.join(ctx.workDir, "captions.ass");
  await writeSubtitleFile(subtitlePath, cues, op.style);

  await run(FFMPEG, [
    "-hide_banner", "-y",
    "-i", input,
    "-vf", `subtitles=${subtitlePath.replace(/[\\:]/g, "\\$&")}`,
    ...VIDEO_ENCODE,
    "-c:a", "copy",
    output,
  ]);
  return `burned ${cues.length} captions`;
}

async function applyWatermark(
  input: string,
  output: string,
  op: Extract<EditOperation, { type: "watermark" }>,
): Promise<string> {
  const position: Record<string, string> = {
    "bottom-right": "x=w-tw-40:y=h-th-40",
    "bottom-center": "x=(w-tw)/2:y=h-th-40",
    "top-right": "x=w-tw-40:y=40",
  };
  const drawtext = [
    `drawtext=text='${escapeForFilter(op.text)}'`,
    "fontcolor=white@0.85",
    "fontsize=h/32",
    "box=1",
    "boxcolor=black@0.35",
    "boxborderw=12",
    position[op.position] ?? position["bottom-right"],
  ].join(":");

  await run(FFMPEG, [
    "-hide_banner", "-y",
    "-i", input,
    "-vf", drawtext,
    ...VIDEO_ENCODE,
    "-c:a", "copy",
    output,
  ]);
  return `watermarked "${op.text}"`;
}

export interface RenderResult {
  output: string;
  notes: string[];
}

/**
 * Runs a plan end to end. Operations execute in the order given, except that
 * removeSilence is hoisted to the front: every later operation is cheaper on a
 * shorter clip, and captions need to know what was cut in order to stay in sync.
 */
export async function renderPlan(input: string, plan: EditPlan, ctx: RenderContext): Promise<RenderResult> {
  const ordered = [...plan.operations].sort((a, b) => rank(a) - rank(b));
  const notes: string[] = [];
  let current = input;
  let kept: Segment[] | null = null;

  for (const [index, op] of ordered.entries()) {
    const output = path.join(ctx.workDir, `step-${index}-${op.type}.mp4`);
    ctx.onProgress?.(index / ordered.length, describe(op));

    if (op.type === "removeSilence") {
      const result = await applyRemoveSilence(current, output, op, ctx);
      kept = result.kept;
      notes.push(result.note);
      if (result.kept === null) continue; // nothing was written
    } else if (op.type === "formatForPlatform") {
      notes.push(await applyFormatForPlatform(current, output, op));
    } else if (op.type === "burnCaptions") {
      notes.push(await applyBurnCaptions(current, output, op, ctx, kept));
    } else if (op.type === "watermark") {
      notes.push(await applyWatermark(current, output, op));
    }
    current = output;
  }

  if (current === input) {
    // Every operation was a no-op. Still produce a real output file so the
    // project ends up with something to play rather than a dangling key.
    const passthrough = path.join(ctx.workDir, "passthrough.mp4");
    await run(FFMPEG, ["-hide_banner", "-y", "-i", input, "-c", "copy", passthrough]);
    current = passthrough;
  }

  ctx.onProgress?.(1, "finishing");
  return { output: current, notes };
}

function rank(op: EditOperation): number {
  switch (op.type) {
    case "removeSilence": return 0;
    case "formatForPlatform": return 1;
    case "burnCaptions": return 2;
    case "watermark": return 3;
  }
}

export function describe(op: EditOperation): string {
  switch (op.type) {
    case "removeSilence": return "Cutting the silences";
    case "formatForPlatform": return `Reframing for ${op.platform}`;
    case "burnCaptions": return "Burning in captions";
    case "watermark": return "Adding the watermark";
  }
}
