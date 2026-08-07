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
import { Readable } from "node:stream";

const SUPABASE_URL = requireEnv("SUPABASE_URL").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

export const VIDEOS_BUCKET = "videos";

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

/** Streams an object to a local file rather than buffering it — these are videos. */
export async function downloadObject(key: string, destination: string): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${VIDEOS_BUCKET}/${key}`, {
    headers: headers(),
  });
  if (!res.ok || !res.body) {
    throw new Error(`download failed for ${key}: ${res.status} ${await res.text().catch(() => "")}`);
  }
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(destination));
}

export async function uploadObject(key: string, source: string, contentType = "video/mp4"): Promise<void> {
  const body = await readFile(source);
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${VIDEOS_BUCKET}/${key}`, {
    method: "POST",
    headers: headers({ "Content-Type": contentType, "x-upsert": "true" }),
    body: new Uint8Array(body),
  });
  if (!res.ok) {
    throw new Error(`upload failed for ${key}: ${res.status} ${await res.text().catch(() => "")}`);
  }
}
