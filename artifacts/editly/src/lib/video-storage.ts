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

/** The Supabase free plan refuses any single object above this size. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

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
 * Grabs a single frame as a JPEG.
 *
 * Taken a little way in rather than at zero: the first frame of a phone
 * recording is very often a black or half-exposed one, which makes for a
 * dashboard of black rectangles — which is what a missing thumbnail looked
 * like in the first place.
 */
export function captureThumbnail(file: File, atFraction = 0.25): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const element = document.createElement("video");
    const url = URL.createObjectURL(file);
    const cleanUp = () => URL.revokeObjectURL(url);

    const timer = setTimeout(() => {
      cleanUp();
      reject(new Error("timed out capturing a frame"));
    }, 20_000);

    element.preload = "auto";
    element.muted = true;
    element.playsInline = true;

    element.onloadedmetadata = () => {
      const target = Number.isFinite(element.duration) ? element.duration * atFraction : 0;
      element.currentTime = Math.min(Math.max(target, 0.1), Math.max(0.1, element.duration - 0.1));
    };

    element.onseeked = () => {
      clearTimeout(timer);
      try {
        // Cap the long edge: a poster for a 220px card does not need to be 4K,
        // and every one of these is stored and fetched per dashboard load.
        const MAX_EDGE = 640;
        const scale = Math.min(1, MAX_EDGE / Math.max(element.videoWidth, element.videoHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(element.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(element.videoHeight * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("no canvas context");
        ctx.drawImage(element, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(
          (blob) => {
            cleanUp();
            blob ? resolve(blob) : reject(new Error("could not encode the frame"));
          },
          "image/jpeg",
          0.82,
        );
      } catch (error) {
        cleanUp();
        reject(error);
      }
    };

    element.onerror = () => {
      clearTimeout(timer);
      cleanUp();
      reject(new Error("could not decode the video"));
    };
    element.src = url;
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
