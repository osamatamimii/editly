/**
 * Uploads and plays video through the private "videos" Storage bucket.
 *
 * The bytes go straight from the browser to Storage — they never pass through
 * the serverless API, which could not stream a 50 MB body anyway. Row-level
 * security confines every request to the signed-in user's own folder, so the
 * only thing the API is told afterwards is the resulting object key.
 */
import { useEffect, useState } from "react";
import { supabase } from "./supabase";

export const VIDEOS_BUCKET = "videos";

/**
 * The largest file we will accept.
 *
 * This is not our number. Supabase enforces a per-project upload ceiling, and
 * on the free plan that ceiling is 50 MB — roughly two minutes of phone video.
 * Raising it is a plan change on their side, not an edit here, which is why the
 * value is configuration rather than a constant: the day the ceiling moves,
 * nothing in this codebase needs to be touched.
 *
 * The uploader below is already built for what comes after: files above
 * RESUMABLE_THRESHOLD go up in chunks and survive a dropped connection, so a
 * two-hour podcast is a long upload rather than an impossible one.
 */
export const MAX_UPLOAD_BYTES = Number(import.meta.env.VITE_MAX_UPLOAD_BYTES) || 50 * 1024 * 1024;

/**
 * Above this, upload resumably. Supabase's resumable endpoint requires exactly
 * this chunk size for every part but the last, so it doubles as the threshold:
 * below one chunk there is nothing to resume and a single request is cheaper.
 */
const CHUNK_BYTES = 6 * 1024 * 1024;
const RESUMABLE_THRESHOLD = CHUNK_BYTES;

export const ACCEPTED_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"];

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function extensionFor(file: File): string {
  const fromName = file.name.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase();
  if (fromName) return fromName;
  if (file.type === "video/quicktime") return "mov";
  if (file.type === "video/webm") return "webm";
  return "mp4";
}

export class UploadError extends Error {}

export interface VideoFacts {
  /** Seconds. */
  duration: number;
  width: number;
  height: number;
}

/**
 * Reads what the browser already knows about a file before it is uploaded.
 *
 * The duration matters more than it looks: templates spread their punch-in
 * zooms across the clip's length, and without one they fall back to a guess —
 * so on a three-minute video every punch landed inside the first thirty
 * seconds.
 */
export function readVideoFacts(file: File): Promise<VideoFacts> {
  return new Promise((resolve, reject) => {
    const element = document.createElement("video");
    const url = URL.createObjectURL(file);
    const cleanUp = () => URL.revokeObjectURL(url);

    // A file the browser cannot decode must not hang the upload; it still
    // uploads fine, it just arrives without a length or a poster frame.
    const timer = setTimeout(() => {
      cleanUp();
      reject(new Error("timed out reading the video"));
    }, 15_000);

    element.preload = "metadata";
    element.muted = true;
    element.onloadedmetadata = () => {
      clearTimeout(timer);
      const facts = {
        duration: Number.isFinite(element.duration) ? element.duration : 0,
        width: element.videoWidth,
        height: element.videoHeight,
      };
      cleanUp();
      // Resolve with whatever was learned rather than insisting on all of it.
      // A file whose duration the browser reports as Infinity — recordings and
      // some streamed WebMs do this — still reports its dimensions perfectly
      // well, and those dimensions are what shape the player before a frame has
      // decoded. Rejecting here threw them away with the duration, which cost
      // exactly the case the stored dimensions exist for: a file this browser
      // cannot decode at all.
      facts.duration > 0 || (facts.width > 0 && facts.height > 0)
        ? resolve(facts)
        : reject(new Error("no usable metadata"));
    };
    element.onerror = () => {
      clearTimeout(timer);
      cleanUp();
      reject(new Error("could not decode the video"));
    };
    element.src = url;
  });
}

/**
 * Draws whatever the element is currently showing, scaled down.
 *
 * The long edge is capped: a poster for a 220px card does not need to be 4K,
 * and every one of these is stored and fetched on every dashboard load.
 */
function drawFrame(element: HTMLVideoElement): HTMLCanvasElement {
  const MAX_EDGE = 640;
  const scale = Math.min(1, MAX_EDGE / Math.max(element.videoWidth, element.videoHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(element.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(element.videoHeight * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas context");
  ctx.drawImage(element, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Is this frame effectively nothing?
 *
 * A poster that is one flat colour — almost always black — is worse than no
 * poster: the dashboard fills with rectangles that look like a broken app
 * rather than like a library of work. Both tests matter. Dark alone would
 * reject a legitimately moody shot, and flat alone would accept a white
 * screen; a frame that is both is a frame that never arrived.
 */
function looksBlank(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let sum = 0;
  let sumSquares = 0;
  let count = 0;
  // Every 40th pixel is plenty to characterise a frame and keeps this off the
  // critical path for a 640px image.
  for (let i = 0; i < data.length; i += 4 * 40) {
    const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    sum += luma;
    sumSquares += luma * luma;
    count++;
  }
  if (count === 0) return false;
  const mean = sum / count;
  const variance = sumSquares / count - mean * mean;
  return mean < 12 && variance < 24;
}

/** Resolves once the element has actually presented a frame, not merely seeked. */
function framePresented(element: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    // `seeked` fires when the seek completes, which on a large file can be
    // before the new frame has been decoded and handed to the compositor — so
    // drawImage returns the frame that was there before, usually the black one
    // at the very start. requestVideoFrameCallback fires when a frame is
    // genuinely on screen. Where it does not exist, a couple of animation
    // frames is the best approximation available.
    const withCallback = element as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    };
    if (typeof withCallback.requestVideoFrameCallback === "function") {
      withCallback.requestVideoFrameCallback(done);
    } else {
      requestAnimationFrame(() => requestAnimationFrame(done));
    }

    // Neither of those ever fires in a background tab: both are driven by the
    // rendering lifecycle, which is suspended while the tab is hidden. Measured
    // on the deployed build — a tab in the background saw no callback at all,
    // so the capture hung until its timeout and the poster was never written.
    // Switching tabs while a project loads should not cost you the poster, so
    // this falls through to a plain wait. Drawing slightly too early is the
    // risk that buys, and the blank check downstream is exactly the guard for
    // it — it will notice the black frame and try elsewhere in the clip.
    setTimeout(done, 500);
  });
}

/**
 * Grabs a single frame as a JPEG.
 *
 * Taken a little way in rather than at zero: the first frame of a phone
 * recording is very often a black or half-exposed one, which makes for a
 * dashboard of black rectangles — which is what a missing thumbnail looked
 * like in the first place. And if the frame it lands on turns out blank
 * anyway, it tries elsewhere in the clip rather than storing the black.
 */
export function captureThumbnail(file: File, atFraction = 0.25): Promise<Blob> {
  const url = URL.createObjectURL(file);
  return captureFrameFrom(url, atFraction).finally(() => URL.revokeObjectURL(url));
}

/** Where in the clip to look, in order, before giving up. */
const POSTER_FRACTIONS = [0.25, 0.5, 0.1, 0.75];

/**
 * The same capture, from a URL rather than a File — so a project whose poster
 * is missing can be given one from the clip it already has in Storage.
 */
export function captureFrameFrom(src: string, atFraction = 0.25): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const element = document.createElement("video");
    element.preload = "auto";
    element.muted = true;
    element.playsInline = true;
    element.crossOrigin = "anonymous";

    const timer = setTimeout(() => reject(new Error("timed out capturing a frame")), 30_000);
    const finish = (result: Blob | Error) => {
      clearTimeout(timer);
      element.onseeked = null;
      element.onerror = null;
      result instanceof Blob ? resolve(result) : reject(result);
    };

    const fractions = [atFraction, ...POSTER_FRACTIONS.filter((f) => f !== atFraction)];
    let attempt = 0;

    const seekTo = (fraction: number) => {
      const duration = Number.isFinite(element.duration) ? element.duration : 0;
      const target = duration > 0 ? duration * fraction : 0.1;
      element.currentTime = Math.min(Math.max(target, 0.1), Math.max(0.1, duration - 0.1));
    };

    element.onloadedmetadata = () => seekTo(fractions[0]);

    element.onseeked = async () => {
      try {
        await framePresented(element);
        const canvas = drawFrame(element);
        attempt++;
        // Keep looking while there are places left to look. The last attempt is
        // taken whatever it shows: a clip that really is black throughout
        // should still get its own poster rather than none.
        if (looksBlank(canvas) && attempt < fractions.length) {
          seekTo(fractions[attempt]);
          return;
        }
        canvas.toBlob(
          (blob) => finish(blob ?? new Error("could not encode the frame")),
          "image/jpeg",
          0.82,
        );
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };

    element.onerror = () => finish(new Error("could not decode the video"));
    element.src = src;
  });
}

/** Uploads the poster frame beside the video and returns its object key. */
export async function uploadThumbnail(options: {
  blob: Blob;
  userId: string;
  projectId: string;
  accessToken: string;
}): Promise<string> {
  const { blob, userId, projectId, accessToken } = options;
  const path = `${userId}/${projectId}/thumb.jpg`;
  const res = await fetch(
    `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/${VIDEOS_BUCKET}/${path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
        "Content-Type": "image/jpeg",
        "x-upsert": "true",
      },
      body: blob,
    },
  );
  if (!res.ok) throw new UploadError(`Could not store the poster frame (${res.status}).`);
  return path;
}

/**
 * Sends a reference video — the one whose look this edit should match.
 *
 * Deliberately the plain, non-resumable path with a tight size cap. A reference
 * is a sample of a style, not a deliverable: the worker only ever reads the
 * first two minutes of it, so asking someone to upload a whole episode as a
 * reference would cost them minutes of transfer for bytes we throw away. The
 * cap is the honest expression of that.
 */
export const MAX_REFERENCE_BYTES = 25 * 1024 * 1024;

export async function uploadReferenceVideo(options: {
  file: File;
  userId: string;
  projectId: string;
  accessToken: string;
}): Promise<string> {
  const { file, userId, projectId, accessToken } = options;
  if (file.size > MAX_REFERENCE_BYTES) {
    throw new UploadError(
      `That reference is ${formatBytes(file.size)}. We only read the first couple of minutes of one, so keep it under ${formatBytes(MAX_REFERENCE_BYTES)} — a short clip in the style you want is plenty.`,
    );
  }

  // Same per-user, per-project prefix as everything else: the storage policy
  // and the server's ownership check both key off it, and a reference is no
  // more shareable than the footage it is being matched to.
  const path = `${userId}/${projectId}/reference.${extensionFor(file)}`;
  const res = await fetch(
    `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/${VIDEOS_BUCKET}/${path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
        "Content-Type": file.type || "video/mp4",
        "x-upsert": "true",
      },
      body: file,
    },
  );
  if (!res.ok) throw new UploadError(`Could not store the reference video (${res.status}).`);
  return path;
}

export interface UploadHandle {
  /** Resolves to the durable Storage object key once the bytes are committed. */
  done: Promise<string>;
  /** Aborts the transfer; `done` then rejects with an UploadError. */
  cancel: () => void;
}

/**
 * Sends `file` to "<userId>/<projectId>/source.<ext>" and reports real transfer
 * progress. XMLHttpRequest is used rather than fetch because it is still the
 * only browser API that exposes upload progress events.
 *
 * Anything worth resuming is resumed. A single POST is the right shape for a
 * small file and the wrong shape for a large one: one dropped connection at
 * 90% and the person starts again from zero, which on a phone is how an upload
 * fails three times in a row and the person leaves. Above one chunk we use
 * Supabase's resumable endpoint, remember where we were across a page reload,
 * and pick the transfer back up.
 */
export function uploadProjectVideo(options: {
  file: File;
  userId: string;
  projectId: string;
  accessToken: string;
  onProgress?: (percent: number, loaded: number, total: number) => void;
}): UploadHandle {
  const { file, userId, projectId, accessToken, onProgress } = options;
  const path = `${userId}/${projectId}/source.${extensionFor(file)}`;

  if (file.size > RESUMABLE_THRESHOLD) {
    return uploadResumably({ file, path, accessToken, onProgress });
  }

  const endpoint = `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/${VIDEOS_BUCKET}/${path}`;

  const xhr = new XMLHttpRequest();

  const done = new Promise<string>((resolve, reject) => {
    xhr.open("POST", endpoint, true);
    xhr.setRequestHeader("Authorization", `Bearer ${accessToken}`);
    xhr.setRequestHeader("apikey", import.meta.env.VITE_SUPABASE_ANON_KEY);
    xhr.setRequestHeader("x-upsert", "true");
    if (file.type) xhr.setRequestHeader("Content-Type", file.type);

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      const percent = Math.min(99, Math.round((event.loaded / event.total) * 100));
      onProgress?.(percent, event.loaded, event.total);
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(100, file.size, file.size);
        resolve(path);
        return;
      }
      let message = `Upload failed (${xhr.status})`;
      try {
        const body = JSON.parse(xhr.responseText);
        if (body?.message) message = body.message;
        else if (body?.error) message = body.error;
      } catch {
        /* Storage returned a non-JSON error page */
      }
      if (xhr.status === 413) message = `This file is larger than the ${formatBytes(MAX_UPLOAD_BYTES)} limit.`;
      reject(new UploadError(message));
    };

    xhr.onerror = () => reject(new UploadError("Network error during upload."));
    xhr.onabort = () => reject(new UploadError("Upload cancelled."));

    xhr.send(file);
  });

  return { done, cancel: () => xhr.abort() };
}

/**
 * The resumable path, spoken in tus — the protocol Supabase's Storage exposes
 * for large objects.
 *
 * Three verbs and one idea: POST creates an upload and hands back a URL, PATCH
 * appends a chunk at a stated offset, HEAD asks where we got to. The offset is
 * the server's answer, never ours, which is what makes resuming safe after a
 * crash we did not see.
 *
 * The upload URL is kept in localStorage against this exact file, so closing
 * the tab mid-transfer costs the current chunk rather than the whole video. It
 * is keyed by path, size and last-modified time: a different file at the same
 * path is a different upload, and silently appending one file's bytes onto
 * another's would produce a video that plays for a while and then does not.
 */
function uploadResumably(options: {
  file: File;
  path: string;
  accessToken: string;
  onProgress?: (percent: number, loaded: number, total: number) => void;
}): UploadHandle {
  const { file, path, accessToken, onProgress } = options;
  const base = import.meta.env.VITE_SUPABASE_URL;
  const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;
  const memory = `editly:upload:${path}:${file.size}:${file.lastModified}`;

  let current: XMLHttpRequest | null = null;
  let cancelled = false;

  const auth = {
    authorization: `Bearer ${accessToken}`,
    apikey: anon,
    "tus-resumable": "1.0.0",
  };

  const report = (uploaded: number) => {
    const percent = Math.min(99, Math.round((uploaded / file.size) * 100));
    onProgress?.(percent, uploaded, file.size);
  };

  async function createUpload(): Promise<string> {
    const meta = [
      ["bucketName", VIDEOS_BUCKET],
      ["objectName", path],
      ["contentType", file.type || "video/mp4"],
      ["cacheControl", "3600"],
    ]
      .map(([k, v]) => `${k} ${btoa(unescape(encodeURIComponent(v)))}`)
      .join(",");

    const response = await fetch(`${base}/storage/v1/upload/resumable`, {
      method: "POST",
      headers: {
        ...auth,
        "upload-length": String(file.size),
        "upload-metadata": meta,
        "x-upsert": "true",
      },
    });
    if (!response.ok) throw new UploadError(await uploadErrorText(response));

    const location = response.headers.get("location");
    if (!location) throw new UploadError("Storage did not return somewhere to upload to.");
    return location;
  }

  /** The server's offset, which is the only one that counts. */
  async function offsetOf(url: string): Promise<number | null> {
    const response = await fetch(url, { method: "HEAD", headers: auth });
    if (!response.ok) return null;
    const offset = Number(response.headers.get("upload-offset"));
    return Number.isFinite(offset) ? offset : null;
  }

  function sendChunk(url: string, offset: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const chunk = file.slice(offset, Math.min(offset + CHUNK_BYTES, file.size));
      const xhr = new XMLHttpRequest();
      current = xhr;

      xhr.open("PATCH", url, true);
      for (const [key, value] of Object.entries(auth)) xhr.setRequestHeader(key, value);
      xhr.setRequestHeader("upload-offset", String(offset));
      xhr.setRequestHeader("content-type", "application/offset+octet-stream");

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) report(offset + event.loaded);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          const next = Number(xhr.getResponseHeader("upload-offset"));
          resolve(Number.isFinite(next) ? next : offset + chunk.size);
        } else {
          reject(new UploadError(`Upload failed (${xhr.status})`));
        }
      };
      xhr.onerror = () => reject(new UploadError("Network error during upload."));
      xhr.onabort = () => reject(new UploadError("Upload cancelled."));
      xhr.send(chunk);
    });
  }

  const done = (async () => {
    let url = localStorage.getItem(memory);
    let offset = 0;

    if (url) {
      const resumed = await offsetOf(url);
      // The server forgot this upload — expired, or never existed. Start over
      // rather than trusting a URL we cannot verify.
      if (resumed === null) {
        localStorage.removeItem(memory);
        url = null;
      } else {
        offset = resumed;
      }
    }

    if (!url) {
      url = await createUpload();
      localStorage.setItem(memory, url);
    }

    report(offset);

    while (offset < file.size) {
      if (cancelled) throw new UploadError("Upload cancelled.");
      offset = await sendChunk(url, offset);
    }

    localStorage.removeItem(memory);
    onProgress?.(100, file.size, file.size);
    return path;
  })();

  return {
    done,
    cancel: () => {
      cancelled = true;
      current?.abort();
    },
  };
}

async function uploadErrorText(response: Response): Promise<string> {
  if (response.status === 413) {
    return `This file is larger than the ${formatBytes(MAX_UPLOAD_BYTES)} limit your storage plan allows.`;
  }
  try {
    const body = await response.json();
    return body?.message ?? body?.error ?? `Upload failed (${response.status})`;
  } catch {
    return `Upload failed (${response.status})`;
  }
}

/**
 * Mints a short-lived playback URL. The bucket is private, so a raw object key
 * is useless without one of these.
 */
export async function signedVideoUrl(path: string, expiresInSeconds = 3600): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(VIDEOS_BUCKET)
    .createSignedUrl(path, expiresInSeconds);
  if (error) return null;
  return data?.signedUrl ?? null;
}

/**
 * Removes every object a project put in Storage.
 *
 * Row-level security already limits this to the caller's own folder, so it runs
 * with the user's token rather than an admin key. Best-effort: a project that
 * fails to shed its bytes is still deleted, it just leaves them behind.
 */
export async function deleteProjectVideos(userId: string, projectId: string): Promise<void> {
  const prefix = `${userId}/${projectId}`;
  const { data, error } = await supabase.storage.from(VIDEOS_BUCKET).list(prefix);
  if (error || !data?.length) return;
  const keys = data.filter((entry) => entry.id !== null).map((entry) => `${prefix}/${entry.name}`);
  if (keys.length === 0) return;
  await supabase.storage.from(VIDEOS_BUCKET).remove(keys);
}

/**
 * Turns a stored object key into something a <video> element can play.
 *
 * Projects created before Storage existed hold an absolute URL instead of a
 * key — those are passed through untouched, except for the dead "blob:" URLs
 * from the old fake upload, which only ever worked in the tab that made them.
 */
export function usePlayableVideo(pathOrUrl: string | null | undefined): {
  url: string | null;
  isResolving: boolean;
} {
  const [url, setUrl] = useState<string | null>(null);
  const [isResolving, setIsResolving] = useState(false);

  useEffect(() => {
    if (!pathOrUrl || pathOrUrl.startsWith("blob:")) {
      setUrl(null);
      setIsResolving(false);
      return;
    }
    if (/^https?:\/\//.test(pathOrUrl)) {
      setUrl(pathOrUrl);
      setIsResolving(false);
      return;
    }

    let cancelled = false;
    setIsResolving(true);
    signedVideoUrl(pathOrUrl)
      .then((signed) => {
        if (!cancelled) setUrl(signed);
      })
      .finally(() => {
        if (!cancelled) setIsResolving(false);
      });

    return () => {
      cancelled = true;
    };
  }, [pathOrUrl]);

  return { url, isResolving };
}

/**
 * Anything a project can put on screen: b-roll, a screenshot, a logo, music.
 *
 * Uploaded the same way and to the same per-user, per-project prefix as
 * everything else, so the storage policy and the server's ownership check both
 * keep working unchanged — and then *registered*, because the server's library
 * is the database table, not a listing of the bucket. A file nobody registered
 * is a file no plan can name.
 */
export const MAX_ASSET_BYTES = 512 * 1024 * 1024;

export type AssetKind = "video" | "image" | "audio";

/**
 * What this file is, from its MIME type — and `null` when it is something we
 * would not know what to do with, so an unsupported drop is refused here with
 * a sentence rather than at render time with a filter-graph error.
 */
export function assetKindOf(file: File): AssetKind | null {
  const type = (file.type || "").toLowerCase();
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/")) return "audio";
  return null;
}

export async function uploadProjectAsset(options: {
  file: File;
  userId: string;
  projectId: string;
  accessToken: string;
}): Promise<{ path: string; kind: AssetKind }> {
  const { file, userId, projectId, accessToken } = options;
  const kind = assetKindOf(file);
  if (!kind) {
    throw new UploadError(
      `We can use video, images and audio. "${file.name}" is neither, so there is nothing we could do with it in an edit.`,
    );
  }
  if (file.size > MAX_ASSET_BYTES) {
    throw new UploadError(
      `"${file.name}" is ${formatBytes(file.size)}. Keep each extra file under ${formatBytes(MAX_ASSET_BYTES)}.`,
    );
  }

  // A name derived from the bytes, not from the browser's. Two people uploading
  // "logo.png" into one project must not collide, and a filename is the one
  // part of an upload an attacker fully controls — the path segments are
  // validated server-side, and generating the leaf here means there is nothing
  // to validate.
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const path = `${userId}/${projectId}/asset-${stamp}.${extensionFor(file)}`;

  const res = await fetch(
    `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/${VIDEOS_BUCKET}/${path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
        "Content-Type": file.type || "application/octet-stream",
        "x-upsert": "true",
      },
      body: file,
    },
  );
  if (!res.ok) throw new UploadError(`Could not store "${file.name}" (${res.status}).`);
  return { path, kind };
}
