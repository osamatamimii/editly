/**
 * The worker's side of Supabase Storage.
 *
 * Unlike the browser, the worker is not any particular user, so it uses the
 * service role key and bypasses row-level security. Every path it touches is
 * taken from a job row whose ownership the API already established — the worker
 * never derives a path from anything a client sent it directly.
 */
import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";

const SUPABASE_URL = requireEnv("SUPABASE_URL").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

export const VIDEOS_BUCKET = "videos";

/**
 * A transfer that did not complete, said in words the person can act on.
 *
 * Separate from a plain Error because of what the worker does with each. An
 * unrecognised error is infrastructure, and the customer is told "Rendering
 * failed. We are looking into it." — which is the right answer for a filter
 * graph that blew up, and the wrong one here. "Your video did not arrive here
 * in full" is not plumbing; it is the one sentence that tells somebody the
 * useful thing, which is that trying again is worth their time.
 *
 * Every message on this class is written to be read by the person who uploaded
 * the video, not by whoever is on call.
 */
export class StorageTransferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageTransferError";
  }
}

/** The one sentence, whichever of the two ways it was noticed. */
function incomplete(received: number, expected: number): StorageTransferError {
  return new StorageTransferError(
    `Your video arrived incomplete: ${inMegabytes(received)} of ${inMegabytes(expected)}. ` +
      `Nothing was rendered from it, so trying again is worth it.`,
  );
}

/** Bytes as somebody would say them, because "20971520" is not a sentence. */
function inMegabytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)}MB`
    : `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set for the worker to reach Storage.`);
  return value;
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    ...extra,
  };
}

/**
 * The same key rule the API applies before writing a path, applied again here
 * before one is used.
 *
 * The header above says the worker "never derives a path from anything a client
 * sent it directly" — which is true, and was still not enough. Every key on a
 * job row was typed by a browser at some point; the API is what stands between
 * the two, and it stood in the wrong place for a while, accepting
 * `%2e%2e/%2e%2e/` because it only looked for a literal `..`. The URL parser
 * resolves those before the request leaves this process, and this process holds
 * the service role key, so the request that goes out reads whatever folder the
 * traversal lands in.
 *
 * That hole is closed at the API now. This check exists because rows written
 * while it was open are still in the database, and because a guard that only
 * exists at the edge is one refactor away from not existing.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isSafeObjectKey(key: string): boolean {
  if (!key || key.startsWith("/") || key.endsWith("/")) return false;
  const segments = key.split("/");
  return segments.length >= 3 && segments.every((s) => SAFE_SEGMENT.test(s));
}

function assertSafeKey(key: string): void {
  if (!isSafeObjectKey(key)) {
    // The key is not echoed: if it is hostile it is going into a log that
    // somebody will later paste somewhere, and its shape is enough to debug.
    throw new Error(
      `refusing to touch a storage key that is not a plain <user>/<project>/<name> path (${key.split("/").length} segments)`,
    );
  }
}

/**
 * Ceilings on the two requests every render makes.
 *
 * `fetch` in Node has no timeout of any kind, and these two calls sit at the
 * top and the bottom of `processJob`. A socket that is accepted and then goes
 * quiet — an overloaded provider, a dropped route, a middlebox holding the
 * connection open — waits forever, and the await waiting on it is inside the
 * job. From there it is the whole outage described in deadline.ts: the lock
 * keeper goes on renewing the heartbeat, healthz reports the worker online,
 * the monitor reports the platform healthy, and no render ever finishes again.
 *
 * The worker's three transcription providers were given this treatment already
 * (providers/deadline.ts). Storage was not, and it is the one call every
 * single render makes twice.
 *
 * Stall-led for the download, for the same reason the render is: a two-hour
 * source is a legitimately long download and a total ceiling would have to be
 * set so high it would never fire. Bytes arriving is the honest signal.
 */
const CONNECT_TIMEOUT_MS = 60_000;
const DOWNLOAD_STALL_MS = 2 * 60_000;
const UPLOAD_TIMEOUT_MS = 30 * 60_000;

/** Streams an object to a local file rather than buffering it — these are videos. */
export async function downloadObject(key: string, destination: string): Promise<void> {
  assertSafeKey(key);

  // Two clocks, because "the server never answered" and "the server answered
  // and then stopped sending" are different failures and only the first one
  // can be judged before any bytes exist.
  const controller = new AbortController();
  const connect = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/storage/v1/object/${VIDEOS_BUCKET}/${key}`, {
      headers: headers(),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(connect);
    if (controller.signal.aborted) {
      throw new StorageTransferError(
        "Your video could not be fetched from storage, which did not answer in time. Nothing was rendered, so trying again is worth it.",
      );
    }
    throw error;
  }
  clearTimeout(connect);

  if (!res.ok || !res.body) {
    throw new Error(`download failed for ${key}: ${res.status} ${await res.text().catch(() => "")}`);
  }

  /*
    How many bytes there are supposed to be.

    Read before the transfer rather than trusted after it, because of the
    failure that is not a timeout at all: a connection closed cleanly in the
    middle of the body. `pipeline` sees an ordinary end-of-stream and resolves,
    the file on disk is a truncated video, ffmpeg reads it happily — MP4 and
    WebM both decode what is present — and the customer is charged for an edit
    of the first two thirds of their recording. There is no error anywhere in
    that sequence. A byte count is the only thing that can tell it from a
    finished download.
  */
  const declared = Number(res.headers.get("content-length"));
  const expected = Number.isFinite(declared) && declared > 0 ? declared : null;

  let received = 0;
  let lastByteAt = Date.now();
  let stalled = false;

  // A Transform rather than a `data` listener: attaching one is what puts a
  // stream into flowing mode, and doing that before `pipeline` has taken the
  // stream is how bytes go to nobody.
  const count = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      received += chunk.length;
      lastByteAt = Date.now();
      done(null, chunk);
    },
  });

  const watch = setInterval(() => {
    if (Date.now() - lastByteAt >= DOWNLOAD_STALL_MS) {
      stalled = true;
      controller.abort();
    }
  }, 15_000);
  watch.unref?.();

  try {
    await pipeline(
      Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
      count,
      createWriteStream(destination),
    );
  } catch (error) {
    if (stalled) {
      throw new StorageTransferError(
        `Your video stopped arriving after ${inMegabytes(received)} and did not resume. Nothing was rendered, so trying again is worth it.`,
      );
    }
    // A short body is caught here as often as below, and this is the branch
    // that runs when the transport notices first — undici raises "terminated"
    // when a connection closes before Content-Length is satisfied. That is a
    // true statement about a socket and a useless one about a video, and it
    // would be filed under "Rendering failed. We are looking into it."
    if (expected !== null && received < expected) throw incomplete(received, expected);
    throw error;
  } finally {
    clearInterval(watch);
  }

  // And here when it does not: a body that ends cleanly short of what the
  // header promised is not an error to any layer below this line.
  if (expected !== null && received !== expected) throw incomplete(received, expected);
}

export async function uploadObject(key: string, source: string, contentType = "video/mp4"): Promise<void> {
  assertSafeKey(key);
  const body = await readFile(source);
  // One request with no progress to read, so the clock is all there is. Thirty
  // minutes is far more than any render's output needs and still bounded.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/storage/v1/object/${VIDEOS_BUCKET}/${key}`, {
      method: "POST",
      headers: headers({ "Content-Type": contentType, "x-upsert": "true" }),
      body: new Uint8Array(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new StorageTransferError(
        "Your edit was made, but saving it timed out. It was not billed, and trying again is worth it.",
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`upload failed for ${key}: ${res.status} ${await res.text().catch(() => "")}`);
  }
}
