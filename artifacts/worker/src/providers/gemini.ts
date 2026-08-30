/**
 * Watching the video, not just hearing it.
 *
 * The transcript says what was said. It cannot say where the speaker is
 * looking, when the shot changed, whether someone else walked into frame, or
 * whether the screen is showing a demo we must not cut through. Every framing
 * decision and every "these are the best thirty seconds" decision is visual,
 * and a text-only editor guesses at all of them.
 *
 * Two things keep this affordable.
 *
 * We upload a proxy, not the source. ffmpeg makes a 360p, 1 fps, silent H.264
 * copy first — 1 fps because that is the rate the model samples at anyway, and
 * silent because the transcript already covers the audio and we would be paying
 * for the same information twice. A two-hour podcast becomes a few tens of
 * megabytes instead of several gigabytes.
 *
 * We read in windows. A million-token context holds about three hours at low
 * resolution, but sending three hours to ask "which parts are interesting"
 * spends the whole context on a question that is local. Windows also mean a
 * long source starts producing usable answers before the last minute is read.
 *
 * What this deliberately does not do: per-frame bounding boxes. Keeping a face
 * framed at 30 fps is local vision work on our own machine, and building the
 * pipeline as though an API could do it would be a structural mistake, not just
 * an expensive one.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SceneRead, SceneReadOptions, SceneReader } from "./types";
import { withDeadline } from "./deadline";

const API_ROOT = "https://generativelanguage.googleapis.com";
const DEFAULT_MODEL = "gemini-flash-lite-latest";

/** How much of the source one request covers. */
const WINDOW_MS = 10 * 60 * 1000;

/** The proxy we upload. Matches how the model samples, and nothing more. */
const PROXY_FPS = 1;
const PROXY_HEIGHT = 360;

/**
 * How much of each frame the model actually looks at.
 *
 * Low is about 66 tokens a frame; the default is around 258. The difference is
 * roughly $0.0018 against $0.007 a minute — against a budget of ten cents a
 * produced minute and a current spend of two and a half, so the cost argument
 * that chose `LOW` was answering the wrong question.
 *
 * What the extra resolution buys is specific and checkable: text on screen, and
 * faces small enough in frame that expression is the only thing distinguishing
 * a reaction from a pause. Both feed `protect` — the stretches silence removal
 * must not cut through — and a demo whose on-screen text we could not read is
 * exactly the kind of thing that gets cut out of the middle.
 *
 * Overridable, because a deployment that is watching four-hour podcasts at
 * scale has a different arithmetic from one watching ninety-second clips.
 */
const DEFAULT_MEDIA_RESOLUTION = "MEDIA_RESOLUTION_MEDIUM";

export interface GeminiOptions {
  apiKey: string;
  model?: string;
  /** `MEDIA_RESOLUTION_LOW` | `MEDIA_RESOLUTION_MEDIUM` | `MEDIA_RESOLUTION_HIGH`. */
  mediaResolution?: string;
  fetchImpl?: typeof fetch;
  /** Context that makes the reading better: what was said, and when. */
  transcriptHint?: string;
}

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    scenes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          startSeconds: { type: "number" },
          endSeconds: { type: "number" },
          description: { type: "string" },
          interest: { type: "number" },
          protect: { type: "boolean" },
        },
        required: ["startSeconds", "endSeconds", "description", "interest", "protect"],
      },
    },
  },
  required: ["scenes"],
} as const;

const INSTRUCTION = [
  "You are reading a video so an editor can decide what to keep.",
  "Split it into scenes at real visual changes: a cut, a new shot, the speaker moving, something new appearing on screen.",
  "For each scene: describe what is happening in one short line, score how much it earns a place in a short cut from 0 to 1,",
  "and set protect to true when cutting through it would destroy something: a demonstration, a screen share, a reveal, a countdown,",
  "anything where the middle is meaningless without the whole.",
  "Score for what a viewer would stop scrolling for, not for what is well lit.",
  "Timestamps are seconds from the start of the video you were given.",
].join(" ");

export function createGeminiSceneReader(options: GeminiOptions): SceneReader {
  const model = options.model ?? DEFAULT_MODEL;
  const doFetch = withDeadline(options.fetchImpl ?? fetch);

  return {
    name: `gemini/${model}`,

    async read(mediaPath: string, opts: SceneReadOptions = {}): Promise<SceneRead[]> {
      const duration = await probeDuration(mediaPath);
      const from = opts.fromMs ?? 0;
      const to = Math.min(opts.toMs ?? duration * 1000, duration * 1000);
      const scenes: SceneRead[] = [];

      for (let windowStart = from; windowStart < to; windowStart += WINDOW_MS) {
        const windowEnd = Math.min(windowStart + WINDOW_MS, to);
        const proxy = await makeProxy(mediaPath, windowStart, windowEnd - windowStart);
        try {
          const uri = await uploadFile(doFetch, options.apiKey, proxy, opts.signal);
          const read = await askForScenes(doFetch, options, model, uri, opts.signal);
          // The model answers in the proxy's own timeline, which starts at zero.
          for (const scene of read) {
            scenes.push({
              ...scene,
              startMs: scene.startMs + windowStart,
              endMs: Math.min(scene.endMs + windowStart, windowEnd),
            });
          }
        } finally {
          await rm(path.dirname(proxy), { recursive: true, force: true });
        }
      }

      return scenes;
    },
  };
}

async function askForScenes(
  doFetch: typeof fetch,
  options: GeminiOptions,
  model: string,
  fileUri: string,
  signal: AbortSignal | undefined,
): Promise<SceneRead[]> {
  const parts: unknown[] = [{ fileData: { mimeType: "video/mp4", fileUri } }, { text: INSTRUCTION }];
  if (options.transcriptHint) {
    parts.push({ text: `What is said, for context:\n${options.transcriptHint.slice(0, 20000)}` });
  }

  const response = await doFetch(`${API_ROOT}/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": options.apiKey },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: {
        // Enough resolution to read the screen and see a face, which is what
        // the answer is actually made of. See DEFAULT_MEDIA_RESOLUTION.
        mediaResolution: options.mediaResolution ?? DEFAULT_MEDIA_RESOLUTION,
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
        temperature: 0.2,
      },
    }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`gemini ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  return parseScenes(await response.json());
}

/** Pulled out so the shape can be tested without a key or a network. */
export function parseScenes(payload: unknown): SceneRead[] {
  const root = payload as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = root.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text.trim()) return [];

  let parsed: { scenes?: Array<Record<string, unknown>> };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("gemini returned something that is not the JSON its own schema asked for");
  }

  return (parsed.scenes ?? [])
    .map((scene) => ({
      startMs: Math.round(Number(scene.startSeconds ?? 0) * 1000),
      endMs: Math.round(Number(scene.endSeconds ?? 0) * 1000),
      description: String(scene.description ?? "").slice(0, 300),
      interest: clamp01(Number(scene.interest ?? 0)),
      protect: scene.protect === true,
    }))
    .filter((scene) => scene.endMs > scene.startMs);
}

/**
 * Resumable upload, which is the only protocol the Files API offers for
 * anything of size. Three round trips: ask for a URL, send the bytes, wait for
 * the file to become usable.
 */
async function uploadFile(
  doFetch: typeof fetch,
  apiKey: string,
  filePath: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const bytes = (await stat(filePath)).size;

  const start = await doFetch(`${API_ROOT}/upload/v1beta/files`, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bytes),
      "X-Goog-Upload-Header-Content-Type": "video/mp4",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: "editly-proxy" } }),
    signal,
  });
  if (!start.ok) throw new Error(`gemini upload start ${start.status}`);

  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("gemini did not return an upload URL");

  const sent = await doFetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(bytes),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: await readFile(filePath),
    signal,
  });
  if (!sent.ok) throw new Error(`gemini upload ${sent.status}`);

  const body = (await sent.json()) as { file?: { uri?: string; name?: string; state?: string } };
  const uri = body.file?.uri;
  const name = body.file?.name;
  if (!uri || !name) throw new Error("gemini upload returned no file reference");

  await waitUntilActive(doFetch, apiKey, name, body.file?.state, signal);
  return uri;
}

/** A freshly uploaded video is PROCESSING for a moment; asking early fails. */
async function waitUntilActive(
  doFetch: typeof fetch,
  apiKey: string,
  name: string,
  initialState: string | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  let state = initialState;
  for (let attempt = 0; attempt < 60 && state !== "ACTIVE"; attempt += 1) {
    if (state === "FAILED") throw new Error("gemini could not process the uploaded proxy");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const response = await doFetch(`${API_ROOT}/v1beta/${name}`, {
      headers: { "x-goog-api-key": apiKey },
      signal,
    });
    if (!response.ok) throw new Error(`gemini file check ${response.status}`);
    state = ((await response.json()) as { state?: string }).state;
  }
  if (state !== "ACTIVE") throw new Error("gemini never finished processing the uploaded proxy");
}

/** The small, silent, one-frame-a-second copy we are actually willing to send. */
export async function makeProxy(mediaPath: string, fromMs: number, durationMs: number): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "editly-proxy-"));
  const out = path.join(dir, "proxy.mp4");

  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-hide_banner", "-nostdin", "-loglevel", "error",
      "-ss", (fromMs / 1000).toFixed(3),
      "-t", (durationMs / 1000).toFixed(3),
      "-i", mediaPath,
      "-an",
      "-vf", `fps=${PROXY_FPS},scale=-2:${PROXY_HEIGHT}:flags=bicubic`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "32", "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-y", out,
    ]);
    let err = "";
    child.stderr.on("data", (d) => {
      err += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`could not build a proxy for scene reading: ${err.slice(0, 300)}`));
    });
  });

  return out;
}

function probeDuration(file: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=nw=1:nk=1",
      file,
    ]);
    let out = "";
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.on("error", () => resolve(0));
    child.on("close", () => resolve(Number(out.trim()) || 0));
  });
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
