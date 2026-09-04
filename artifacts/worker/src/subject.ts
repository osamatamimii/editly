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
      let row: { i?: number; cx?: number };
      try {
        row = JSON.parse(line) as { i?: number; cx?: number };
      } catch {
        continue;
      }
      if (typeof row.i !== "number") continue;
      samples.push({
        // On the source clock, like every other measurement handed to the
        // renderer: the seek is an optimisation, not a change of reference.
        t: from + row.i / SAMPLE_FPS,
        x: typeof row.cx === "number" && row.cx >= 0 && row.cx <= 1 ? row.cx : null,
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
