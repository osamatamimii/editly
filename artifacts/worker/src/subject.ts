/**
 * Running the tracker, and knowing when not to believe it.
 *
 * `track-subject.py` reports a face box per sampled frame. This turns that into
 * something the renderer can use, and — the more important half — decides when
 * the answer is not worth using.
 *
 * There are three ways this comes back empty, and all three end the same way:
 * the renderer falls back to the static interest measurement and says so. The
 * vision libraries may not be installed, because the worker image is built
 * without them or the install is broken. The clip may have no face in it at all
 * — a screen recording, a drone shot, a hands-only demo. Or the detector may
 * find a face in a scattering of frames with long gaps between them, which is
 * not a track: following it would move the frame on evidence we do not have.
 *
 * That last case is the one worth being strict about. A confidently wrong
 * reframe is worse than a neutral one, because the neutral one is at least the
 * framing the person shooting expected — and a frame that lurches toward a
 * false positive halfway through a sentence is the most visible way an
 * automatic edit can announce itself.
 */
import { spawn } from "node:child_process";
import { guard, LIMITS } from "./deadline";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MIN_SUBJECT_COVERAGE, type SubjectSample } from "./framing";
import type { Say } from "./say";

/** Frames a second read. Where a person is does not change faster than this. */
const SAMPLE_FPS = 4;

/**
 * Width the frames are reduced to before detection.
 *
 * Faces are found from their proportions, not their detail, and a 320-wide
 * frame carries every proportion a 1080-wide one does at a twentieth of the
 * pixels. The height follows the source so the aspect ratio — and therefore
 * every face in it — is not distorted.
 */
const PROXY_WIDTH = 320;

/** How long to look. A tracker that runs the whole file costs more than it earns. */
const MAX_SECONDS = 600;

export interface SubjectTrack {
  samples: SubjectSample[];
  /** Fraction of sampled frames a face was found in. */
  coverage: number;
}

export interface TrackOptions {
  /** Overridable in tests, and by an image that puts python elsewhere. */
  python?: string;
  scriptPath?: string;
  seconds?: number;
  /**
   * Where in the recording to start looking, in seconds.
   *
   * The tracker read the first ten minutes of the *source* whatever stretch of
   * it the edit was made of — so a clip taken from 12:00 of a podcast had no
   * samples inside it at all, and the coverage that decides whether to follow
   * anybody was measured over material the viewer will never see. A clip where
   * the speaker is perfectly clear could be refused because the rest of the
   * recording has nobody in it.
   */
  from?: number;
}

/**
 * Reads the clip and reports where the person is over time, or null when the
 * answer would not be worth acting on.
 *
 * Never throws. Every failure here is a worse reframe, not a failed render, and
 * a caller that had to wrap this in a try/catch would eventually forget to.
 */
export async function trackSubject(
  file: string,
  sourceWidth: number,
  sourceHeight: number,
  options: TrackOptions = {},
): Promise<SubjectTrack | null> {
  const proxyWidth = Math.max(2, Math.round(PROXY_WIDTH / 2) * 2);
  const proxyHeight = Math.max(2, Math.round((proxyWidth * sourceHeight) / sourceWidth / 2) * 2);
  const python = options.python ?? process.env["PYTHON_PATH"] ?? "python3";
  const script = options.scriptPath ?? defaultScriptPath();

  try {
    const from = Math.max(0, options.from ?? 0);
    const lines = await run(file, proxyWidth, proxyHeight, python, script, options.seconds ?? MAX_SECONDS, from);
    const samples: SubjectSample[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      let row: { i?: number; cx?: number; cy?: number; s?: number };
      try {
        row = JSON.parse(line) as { i?: number; cx?: number; cy?: number; s?: number };
      } catch {
        continue;
      }
      if (typeof row.i !== "number") continue;
      const fraction = (v: unknown): number | null =>
        typeof v === "number" && v >= 0 && v <= 1 ? v : null;
      samples.push({
        // On the source clock, like every other measurement handed to the
        // renderer: the seek is an optimisation, not a change of reference.
        t: from + row.i / SAMPLE_FPS,
        x: fraction(row.cx),
        /*
          `cy` and `s` have been in every line this tracker has ever written
          and were thrown away here, because the only reader was a reframe and
          a reframe only slides sideways. Keeping them costs two fields and is
          the whole of what `subjectSpace` below needs.
        */
        y: fraction(row.cy),
        size: fraction(row.s),
      });
    }

    if (samples.length === 0) return null;
    const coverage = samples.filter((s) => s.x !== null).length / samples.length;
    // Reported rather than silently dropped, so the caller can say "we looked
    // and there was nobody" differently from "we could not look".
    return { samples, coverage };
  } catch {
    return null;
  }
}

/**
 * Where the person is, and where they are not.
 *
 * The reference study named person-aware placement as one of the three things
 * that separate a designed frame from a template: r04 puts its diagram cards
 * in the empty space either side of a head, joined by lines that go *around*
 * it, and never once crosses the face. r05 and r08 keep their captions clear
 * of a mouth. None of that is a motion problem — it is knowing where somebody
 * is, which this file has known all along and never said.
 *
 * ## Why a union and not a position
 *
 * A head moves. A card placed against where the face was at second three is a
 * card over the face at second five, and that failure is invisible in every
 * still anybody would check. So the face box returned here is the **union of
 * every sample in the window**, grown by a margin — the space the person
 * occupies at any point while the thing is on screen, not where they happened
 * to be when it arrived.
 *
 * ## And why it can answer "I don't know"
 *
 * Below `MIN_SUBJECT_COVERAGE` this returns null rather than a guess. A card
 * confidently placed beside a face that was never found is worse than a card
 * placed by the plan: the plan's box is at least somebody's decision, and this
 * one would be arithmetic over noise. The same rule the reframe already
 * follows, for the same reason.
 *
 * Everything is in **source-frame fractions**, which is the clock the samples
 * arrive on. A plan that reframes has moved the picture underneath these
 * numbers, and a caller that reframes must remap them — said here rather than
 * left to be discovered, because a box that is right until somebody asks for
 * 9:16 is the worst shape this could take.
 */
export interface SubjectSpace {
  /** Everything the person covers while the window lasts, with margin. */
  face: { x: number; y: number; w: number; h: number };
  /** Fraction of the window's samples a face was actually found in. */
  coverage: number;
  /** Clear rectangles, full height, either side of them. Null when too narrow. */
  left: { x: number; y: number; w: number; h: number } | null;
  right: { x: number; y: number; w: number; h: number } | null;
  /** Clear rectangles, full width, above and below them. */
  above: { x: number; y: number; w: number; h: number } | null;
  below: { x: number; y: number; w: number; h: number } | null;
}

/**
 * Nothing narrower than this is a place to put anything.
 *
 * An eighth of the frame holds an icon and a short word at the sizes this
 * product draws them. Below it, "there is room on the left" is true and
 * useless: whatever goes there is too small to read, and a caller that trusted
 * it would produce a frame with a stamp in the corner rather than a layout.
 */
const SMALLEST_USEFUL = 0.125;

/**
 * How far outside the face the clear space starts, as a fraction of the frame.
 *
 * Four per cent, which at 1080 wide is 43px — enough that a card does not look
 * welded to somebody's ear, and not so much that a head near the edge leaves
 * no usable side at all.
 */
const FACE_MARGIN = 0.04;

export function subjectSpace(
  samples: SubjectSample[],
  options: {
    /** Window on the source clock. */
    from: number;
    to: number;
    /** The source's shape, needed because the tracker reports one size only. */
    sourceWidth: number;
    sourceHeight: number;
  },
): SubjectSpace | null {
  const within = samples.filter((s) => s.t >= options.from && s.t <= options.to);
  if (within.length === 0) return null;

  const seen = within.filter(
    (s) => s.x !== null && s.y !== null && s.y !== undefined && s.size !== null && s.size !== undefined,
  );
  const coverage = seen.length / within.length;
  if (coverage < MIN_SUBJECT_COVERAGE) return null;

  /*
    The tracker measures one number for the face and it is a width.

    Its boxes come from a Haar cascade, which reports squares — so the height
    in pixels is the width in pixels, and turning that into a fraction of the
    *frame's* height needs the frame's shape. On a 9:16 source a face a fifth
    of the width is barely an eighth of the height, and treating the two as the
    same fraction puts the clear space in the wrong place by a large margin.
  */
  const aspect = options.sourceHeight > 0 ? options.sourceWidth / options.sourceHeight : 1;

  let x0 = 1;
  let x1 = 0;
  let y0 = 1;
  let y1 = 0;
  for (const s of seen) {
    const halfW = (s.size as number) / 2;
    const halfH = (halfW * aspect);
    x0 = Math.min(x0, (s.x as number) - halfW);
    x1 = Math.max(x1, (s.x as number) + halfW);
    y0 = Math.min(y0, (s.y as number) - halfH);
    y1 = Math.max(y1, (s.y as number) + halfH);
  }

  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  const face = {
    x: clamp01(x0 - FACE_MARGIN),
    y: clamp01(y0 - FACE_MARGIN),
    w: 0,
    h: 0,
  };
  face.w = clamp01(x1 + FACE_MARGIN) - face.x;
  face.h = clamp01(y1 + FACE_MARGIN) - face.y;

  const room = (x: number, y: number, w: number, h: number) =>
    w >= SMALLEST_USEFUL && h >= SMALLEST_USEFUL ? { x, y, w, h } : null;

  return {
    face,
    coverage,
    left: room(0, 0, face.x, 1),
    right: room(face.x + face.w, 0, 1 - (face.x + face.w), 1),
    above: room(0, 0, 1, face.y),
    below: room(0, face.y + face.h, 1, 1 - (face.y + face.h)),
  };
}

/**
 * The sentence a render note carries when a track was found but not trusted.
 *
 * Both halves, like every other note in this worker. It used to return English
 * only, and was pushed unconditionally into the notes of every render — so an
 * Arabic job came back with its own summary in Arabic and this line in English
 * in the middle of it. `say.ts` makes both halves *required* precisely so a
 * note cannot be written in one language; a function that returns a bare string
 * walks around that.
 */
export function trackNote(track: SubjectTrack | null, t: Say): string | null {
  if (track === null) return null;
  if (track.coverage >= MIN_SUBJECT_COVERAGE) return null;
  if (track.coverage === 0) {
    return t(
      "no face to follow in this clip, so the frame was placed by where the picture is busiest",
      "لا وجه لتتبّعه في هذا المقطع، فوُضع الكادر حيث الصورة أكثر ازدحامًا",
    );
  }
  const percent = Math.round(track.coverage * 100);
  return t(
    `a face was only visible in ${percent}% of this clip, which is not enough to follow, so the frame was placed by where the picture is busiest`,
    `ظهر الوجه في ${percent}٪ فقط من هذا المقطع، وهذا لا يكفي للتتبّع، فوُضع الكادر حيث الصورة أكثر ازدحامًا`,
  );
}

function run(
  file: string,
  width: number,
  height: number,
  python: string,
  script: string,
  seconds: number,
  from: number,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    // ffmpeg decodes and downscales; python only ever sees raw pixels. Two
    // processes rather than one because decoding video in Python would mean
    // another copy of the file and another codec dependency in the image.
    const ffmpeg = spawn("ffmpeg", [
      "-hide_banner", "-nostdin", "-loglevel", "error",
      // Seek before the input, so a clip from an hour into a recording costs
      // the same as one from the top of it.
      ...(from > 0 ? ["-ss", from.toFixed(3)] : []),
      "-t", String(seconds),
      "-i", file,
      "-an",
      "-vf", `fps=${SAMPLE_FPS},scale=${width}:${height}:flags=area,format=bgr24`,
      "-f", "rawvideo", "-",
    ]);

    const tracker = spawn(python, [script, String(width), String(height)]);

    // Both ends, because either can be the one that hangs and the survivor
    // would then wait on a pipe that never closes. The tracker prints a line
    // per sampled frame, so its silence is the tell; ffmpeg is judged on the
    // frames it hands over, which is the tracker's input.
    const trackerDeadline = guard(tracker, { ...LIMITS.analysis, what: "following the speaker" });
    const decodeDeadline = guard(ffmpeg, { ...LIMITS.analysis, what: "decoding frames to follow the speaker" });

    let out = "";
    let err = "";
    tracker.stdout.on("data", (d: Buffer) => {
      trackerDeadline.touch();
      out += d.toString();
    });
    tracker.stderr.on("data", (d: Buffer) => {
      trackerDeadline.touch();
      err += d.toString();
    });

    // Piped first, then listened to. Attaching a `data` handler is what puts a
    // stream into flowing mode, and doing that before the pipe exists is how
    // frames get read by nobody.
    ffmpeg.stdout.pipe(tracker.stdin);
    ffmpeg.stdout.on("data", () => decodeDeadline.touch());
    // ffmpeg finishing first is normal; the pipe closing is what ends the
    // tracker. An error on either side is the same outcome to the caller.
    const fail = (error: unknown) => {
      trackerDeadline.clear();
      decodeDeadline.clear();
      reject(error);
    };
    ffmpeg.on("error", fail);
    tracker.on("error", fail);
    ffmpeg.stdout.on("error", () => {});
    tracker.stdin.on("error", () => {});

    tracker.on("close", (code) => {
      ffmpeg.kill("SIGKILL");
      trackerDeadline.clear();
      decodeDeadline.clear();
      // A partial track is worse than no track: the frame would follow the
      // speaker for the first few seconds and then hold wherever they were
      // standing when we stopped looking, which reads as a deliberate choice.
      const timedOut = trackerDeadline.error ?? decodeDeadline.error;
      if (timedOut) reject(timedOut);
      else if (code === 0) resolve(out.split("\n"));
      else reject(new Error(`subject tracking exited ${code}: ${err.trim().slice(0, 200)}`));
    });
  });
}

/**
 * Where the tracker script is.
 *
 * Two layouts have to work and they put it in different places. Built, the
 * worker is one bundled `.mjs` and the build copies the script beside it. From
 * source — `pnpm dev`, and anything that bundles this module for a test — the
 * module is in `src/` and the script is in `scripts/` next door.
 *
 * The first version of this only handled the built layout, and the failure was
 * silent in the worst way: tracking simply never happened, every clip quietly
 * fell back to the old static framing, and nothing anywhere said so. Trying
 * both, and saying which was used when neither works, is the difference between
 * a feature that is off and a feature nobody can tell is off.
 */
function defaultScriptPath(): string {
  const override = process.env["SUBJECT_SCRIPT"];
  if (override) return override;

  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "track-subject.py"),
    path.join(here, "..", "scripts", "track-subject.py"),
    path.join(here, "scripts", "track-subject.py"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}
