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

/** Streams an object to a local file rather than buffering it — these are videos. */
export async function downloadObject(key: string, destination: string): Promise<void> {
  assertSafeKey(key);
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${VIDEOS_BUCKET}/${key}`, {
    headers: headers(),
  });
  if (!res.ok || !res.body) {
    throw new Error(`download failed for ${key}: ${res.status} ${await res.text().catch(() => "")}`);
  }
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(destination));
}

export async function uploadObject(key: string, source: string, contentType = "video/mp4"): Promise<void> {
  assertSafeKey(key);
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
