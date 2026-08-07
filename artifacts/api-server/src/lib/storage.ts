/**
 * Server-side access to the private "videos" Storage bucket.
 *
 * Browsers upload and read their own objects directly using the signed-in
 * user's token, which row-level security already confines to the user's own
 * folder. The service role key is only used here for the one thing the browser
 * cannot be trusted to finish: reclaiming bytes when a project is deleted.
 *
 * If SUPABASE_SERVICE_ROLE_KEY is absent the helpers degrade to no-ops so the
 * API still works — deletes then leave orphaned objects rather than failing.
 */
import { logger } from "./logger";

export const VIDEOS_BUCKET = "videos";

const SUPABASE_URL = process.env["SUPABASE_URL"]?.replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env["SUPABASE_SERVICE_ROLE_KEY"];

export const storageAdminConfigured = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY);

/**
 * Object keys are always "<userId>/<projectId>/<name>". Anything else is
 * rejected before it reaches the database so a client cannot record a pointer
 * to a folder it does not own.
 */
export function isOwnedObjectPath(path: string, userId: string, projectId: string): boolean {
  if (path.includes("..") || path.startsWith("/")) return false;
  const segments = path.split("/");
  return segments.length >= 3 && segments[0] === userId && segments[1] === projectId;
}

function adminHeaders(): Record<string, string> {
  return {
    apikey: SERVICE_ROLE_KEY as string,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
}

/** Every object stored under a project, as full bucket keys. */
async function listUnderPrefix(prefix: string): Promise<string[]> {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${VIDEOS_BUCKET}`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ prefix, limit: 100, offset: 0 }),
  });
  if (!res.ok) throw new Error(`list failed: ${res.status} ${await res.text()}`);
  const entries = (await res.json()) as Array<{ name: string; id: string | null }>;
  // Entries with a null id are pseudo-folders, not objects.
  return entries.filter((e) => e.id !== null).map((e) => `${prefix}/${e.name}`);
}

/**
 * Best-effort removal of every object belonging to a project. Never throws:
 * failing to reclaim storage must not stop the user from deleting their work.
 */
export async function deleteProjectObjects(userId: string, projectId: string): Promise<void> {
  if (!storageAdminConfigured) return;
  try {
    const keys = await listUnderPrefix(`${userId}/${projectId}`);
    if (keys.length === 0) return;
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${VIDEOS_BUCKET}`, {
      method: "DELETE",
      headers: adminHeaders(),
      body: JSON.stringify({ prefixes: keys }),
    });
    if (!res.ok) throw new Error(`delete failed: ${res.status} ${await res.text()}`);
    logger.info({ projectId, removed: keys.length }, "reclaimed project storage");
  } catch (error) {
    logger.error({ err: error, projectId }, "could not reclaim project storage");
  }
}
