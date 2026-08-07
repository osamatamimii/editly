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
