/**
 * The worker's side of the object store.
 *
 * Unlike the browser, the worker is not any particular user, so it carries the
 * deployment's own credential and bypasses row-level security. Every path it
 * touches is taken from a job row whose ownership the API already established —
 * the worker never derives a path from anything a client sent it directly.
 *
 * ## Where the address comes from, and where it stopped coming from
 *
 * This file used to spell `${SUPABASE_URL}/storage/v1/object/videos/${key}` in
 * three places and hold the service role key in a module constant. That is the
 * one thing in here that is a property of *which provider we are on* rather
 * than of what a transfer has to survive, and R2 has no answer to any of it:
 * no `apikey` header, no row policies, a PUT where Supabase wants a POST. So
 * the URL, the verb and the headers now come from `@workspace/object-store`,
 * and switching provider is a variable rather than an edit to this file.
 *
 * ## What deliberately did not move
 *
 * Everything below the address. The connect clock and the separate stall
 * clock, the byte count that catches a body which ends short of its own
 * Content-Length, the 413 that becomes a sentence naming the real ceiling,
 * the stream-from-disk upload that exists because the worker has one gigabyte.
 * Each of those was paid for by an outage, none of them is provider-specific,
 * and moving them into the seam to make it look tidier would risk all of them
 * for nothing. The rule for this file is: ask the seam *where*, then send the
 * request with our own machinery.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { objectStoreFrom, isSafeKey, VIDEOS_BUCKET } from "@workspace/object-store";

/*
  Built once, at import, and allowed to throw.

  The two lines it replaces were `requireEnv` calls that threw here too, and
  for the same reason: a worker that starts without knowing where storage is
  will claim a job, download nothing, and fail a customer's render. Refusing
  at boot turns that into a deploy that does not come up.
*/
const store = objectStoreFrom();

export { VIDEOS_BUCKET };

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
 * the deployment's credential, so the request that goes out reads whatever
 * folder the traversal lands in.
 *
 * That hole is closed at the API now. This check exists because rows written
 * while it was open are still in the database, and because a guard that only
 * exists at the edge is one refactor away from not existing.
 *
 * The rule itself moved into the object store package, beside the thing it
 * guards: every driver applies it as the first line of every method, so a key
 * that fails it cannot reach a URL even if a caller here forgot to ask. Which
 * is why the two transfers below no longer assert separately — `address()`
 * refuses first, before there is anything to send. This stays exported because
 * it is a question worth being able to ask without performing a transfer, and
 * it is the same answer either way.
 */
export function isSafeObjectKey(key: string): boolean {
  return isSafeKey(key);
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
/**
 * Everything this process has pulled out of storage since it started.
 *
 * A module-level counter, which is the one shape that is honest here: a render
 * downloads a source, sometimes a reference, and any number of assets, through
 * three different call sites in two files. Threading a total back through all
 * of them would be an argument on every function for a number none of them
 * cares about — and the thing being measured is a property of the *process*,
 * not of any one download.
 *
 * The worker renders one job at a time, so reading the delta across a job is
 * exact. If that ever stops being true, this has to become per-job, and the
 * comment on `jobs.bytes_in` is where somebody will find out why.
 */
let pulledBytes = 0;

/** What has been pulled so far. `bytesPulled()` before and after is one job's. */
export function bytesPulled(): number {
  return pulledBytes;
}

export async function downloadObject(key: string, destination: string): Promise<void> {
  // Where, and with what — from the seam. It applies the key rule before it
  // builds anything, so an unsafe key throws here rather than reaching a URL.
  const at = store.address(key, "GET");

  // Two clocks, because "the server never answered" and "the server answered
  // and then stopped sending" are different failures and only the first one
  // can be judged before any bytes exist.
  const controller = new AbortController();
  const connect = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(at.url, {
      method: at.method,
      headers: at.headers,
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
      // Counted here rather than from Content-Length, because what egress
      // costs is what actually crossed the wire — a download that stalls
      // halfway is billed for the half that arrived.
      pulledBytes += chunk.length;
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

/**
 * What the bucket says its own per-object ceiling is, asked only when it matters.
 *
 * The first version of this was an environment variable holding 50 MB, which
 * is Supabase's free-plan limit today. Two things were wrong with that and
 * they are the same thing: it is a copy of somebody else's number, so it is
 * wrong from the moment the plan changes, and it is quoted in a sentence
 * written at the exact moment we have been proved not to know it. "Your 12MB
 * edit is over the 50MB limit" is a message that argues with itself.
 *
 * So the number is asked for, on the failure path only — one request, after a
 * 413 has already happened, which is a place where an extra round trip costs
 * nothing and a wrong number costs a support conversation. Null when Storage
 * will not say, and the sentence then says less rather than guessing.
 */
async function bucketObjectLimit(): Promise<number | null> {
  try {
    // Through the seam, which answers null on a provider that has no such
    // ceiling of its own — which R2 does not, and saying so is the truth. On
    // R2 the wall a file hits is ours, checked before the URL is signed, and a
    // sentence quoting a bucket setting there would describe a wall that does
    // not exist.
    return (await store.facts())?.fileSizeLimit ?? null;
  } catch {
    return null;
  }
}

export async function uploadObject(key: string, source: string, contentType = "video/mp4"): Promise<void> {
  /*
    Streamed from disk, not read into memory.

    This used to be `readFile` into a Buffer and then `new Uint8Array(buffer)`,
    which is the same bytes twice. The worker has one gigabyte, so a 500 MB
    output — eight minutes of what this renderer produces — was two gigabytes
    of buffers and an OOM kill. And an OOM is not a failed render: the process
    dies holding the lock, the stale sweep requeues the job, it renders again,
    it dies again, and three attempts later the customer is told "Rendering
    failed" having burned three renders of machine time. The limit that was
    actually reached is never named anywhere.
  */
  const { size } = await stat(source);

  /*
    The verb comes from the seam and is not this file's business: Supabase
    writes an object with POST and answers 400 to a PUT for one that does not
    exist yet, while S3 writes with PUT and has no POST at all. A hardcoded
    verb here is a worker that only runs on one provider.

    Content-Length goes through it too, explicitly, from the file on disk. It
    was added because without it undici sends chunked, and an object store is
    entitled to refuse that.
  */
  const at = store.address(key, "PUT", { contentType, upsert: true, contentLength: size });

  const controller = new AbortController();
  // One request with no progress to read, so the clock is all there is. Thirty
  // minutes is far more than any render's output needs and still bounded.
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(at.url, {
      method: at.method,
      headers: at.headers,
      body: Readable.toWeb(createReadStream(source)) as ReadableStream,
      // Required by undici whenever the body is a stream: it says we are not
      // reading the response while still writing the request.
      duplex: "half",
      signal: controller.signal,
    } as RequestInit & { duplex: "half" });
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

  // The bucket's own size limit, which is a real wall and not a hiccup.
  //
  // It arrives at the very last step of a render that has already cost its
  // minutes, and as a bare 413 it reached people as "Rendering failed. We are
  // looking into it." — a sentence that sends somebody to support to be told
  // their video is too big. An edit can be larger than the file it came from:
  // a phone compresses at a low bitrate and this renderer encodes at CRF 18,
  // so an upload that fit can produce an output that does not.
  if (res.status === 413) {
    // The limit from the bucket itself, and only if it agrees that this file
    // is over it. A ceiling that says the file should have fit is a ceiling we
    // have just been proved wrong about, and quoting it would produce a
    // sentence that argues with itself.
    const limit = await bucketObjectLimit();
    const worthStating = limit !== null && size > limit;
    throw new StorageTransferError(
      worthStating
        ? `Your edit was made, but it is ${inMegabytes(size)} and storage will not accept a file over ` +
          `${inMegabytes(limit)}. Nothing was billed. A shorter edit will fit.`
        : `Your edit was made, but storage refused it as too large at ${inMegabytes(size)}. ` +
          `Nothing was billed. A shorter edit will fit.`,
    );
  }

  if (!res.ok) {
    throw new Error(`upload failed for ${key}: ${res.status} ${await res.text().catch(() => "")}`);
  }
}
