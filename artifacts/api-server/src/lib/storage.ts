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
 *
 * Checking for a literal ".." is not enough, and the reason is worth spelling
 * out. This string passes a literal check — it contains no dots at all:
 *
 *     <myId>/<myProject>/%2e%2e/%2e%2e/<victimId>/<victimProject>/source.mp4
 *
 * The worker interpolates the key straight into a URL, and the URL parser
 * resolves percent-encoded dot segments before the request is sent, so what
 * actually leaves the process is `.../videos/<victimId>/<victimProject>/…`.
 * The worker holds the service role key and bypasses row-level security, so it
 * would fetch the other person's footage and render it into the attacker's own
 * project. Encoding the traversal is not exotic; it is the first thing anyone
 * tries after `../` fails.
 *
 * So the rule is a whitelist rather than a blacklist: every segment must be
 * made of characters that cannot mean anything but themselves. A percent sign
 * is the whole mechanism above and no legitimate key we write contains one, so
 * it is simply not allowed.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isOwnedObjectPath(path: string, userId: string, projectId: string): boolean {
  if (!path || path.startsWith("/") || path.endsWith("/")) return false;
  const segments = path.split("/");
  if (segments.length < 3) return false;
  // A leading digit or letter is required, so "." and ".." are unrepresentable
  // however they are spelled, and so is a hidden dotfile.
  if (!segments.every((s) => SAFE_SEGMENT.test(s))) return false;
  return segments[0] === userId && segments[1] === projectId;
}

function adminHeaders(): Record<string, string> {
  return {
    apikey: SERVICE_ROLE_KEY as string,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
}

/**
 * One page of the objects stored under a project, as full bucket keys.
 *
 * A page, not everything: the Storage list endpoint caps what it returns, and
 * asking once used to be the whole sweep. That was fine when a project held a
 * handful of files, and quietly stopped being fine when clips arrived — one
 * clips render writes up to twelve objects, so a project a person actually
 * used could hold more than a single page, and the sweep deleted the first
 * hundred while reporting all of them gone. The caller now drains pages until
 * the prefix answers empty.
 */
const LIST_PAGE = 100;

async function listUnderPrefix(prefix: string): Promise<string[]> {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${VIDEOS_BUCKET}`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ prefix, limit: LIST_PAGE, offset: 0 }),
  });
  if (!res.ok) throw new Error(`list failed: ${res.status} ${await res.text()}`);
  const entries = (await res.json()) as Array<{ name: string; id: string | null }>;
  // Entries with a null id are pseudo-folders, not objects.
  return entries.filter((e) => e.id !== null).map((e) => `${prefix}/${e.name}`);
}

/**
 * Does the configured key actually work?
 *
 * `storageAdminConfigured` only says a string is present, and the string being
 * present is not the question anyone cares about — the wrong key looks exactly
 * like the right one until a customer asks to delete their account and the
 * deletion fails at the only moment it must not. So this asks Storage.
 *
 * It lists a prefix that cannot match anything, which is the cheapest
 * authenticated call the API has: a key that works answers `[]`, and a key that
 * does not answers 401 or 403. Nothing is written and nothing is removed.
 *
 * The answer is cached, because this is reachable from an endpoint that needs
 * no token — without the cache, a public URL would turn every request into a
 * request against Supabase, which is an amplifier rather than a health check.
 */
type StorageCheck = "ok" | "unauthorized" | "unreachable" | "not-configured";

let cachedCheck: { at: number; value: StorageCheck } | null = null;
const CHECK_TTL_MS = 60_000;

export async function verifyStorageAdmin(now: number = Date.now()): Promise<StorageCheck> {
  if (!storageAdminConfigured) return "not-configured";
  if (cachedCheck && now - cachedCheck.at < CHECK_TTL_MS) return cachedCheck.value;

  let value: StorageCheck;
  try {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${VIDEOS_BUCKET}`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ prefix: "__healthcheck__", limit: 1, offset: 0 }),
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) value = "ok";
    else if (res.status === 401 || res.status === 403) value = "unauthorized";
    else value = "unreachable";
  } catch {
    value = "unreachable";
  }

  cachedCheck = { at: now, value };
  return value;
}

/**
 * Removes every object belonging to a project, and says whether it managed to.
 *
 * It still never throws — a caller that has already deleted the rows cannot
 * usefully be handed an exception — but it no longer swallows the answer. It
 * used to return `void`, and the route returned 204 whatever happened, so a
 * deployment with no service role key told every customer their video was
 * deleted while every byte of it stayed on our disks. `account-deletion.ts`
 * refuses outright in exactly that situation and explains why: a refusal can be
 * acted on, a false confirmation cannot. Deleting a project is the path people
 * actually use, and it was the one that lied.
 */
/**
 * Fifty pages is five thousand objects — far past any project a person can
 * actually make. Reaching it means Storage keeps answering 200 while removing
 * nothing, and a sweep that spins forever against a lying backend helps nobody.
 * Giving up is reported as failure, never as success: "we could not say your
 * bytes are gone" is something a person can act on, "they are gone" when they
 * are not is not.
 */
const MAX_SWEEP_PASSES = 50;

export async function deleteProjectObjects(
  userId: string,
  projectId: string,
): Promise<{ removed: boolean; reason?: "not-configured" | "failed" }> {
  if (!storageAdminConfigured) return { removed: false, reason: "not-configured" };
  try {
    let removedCount = 0;
    for (let pass = 0; pass < MAX_SWEEP_PASSES; pass++) {
      const keys = await listUnderPrefix(`${userId}/${projectId}`);
      if (keys.length === 0) {
        // Only an empty listing proves the sweep is done. Counting one page and
        // stopping is how objects past the page size survived their deletion.
        if (removedCount > 0) {
          logger.info({ projectId, removed: removedCount }, "reclaimed project storage");
        }
        return { removed: true };
      }
      const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${VIDEOS_BUCKET}`, {
        method: "DELETE",
        headers: adminHeaders(),
        body: JSON.stringify({ prefixes: keys }),
      });
      if (!res.ok) throw new Error(`delete failed: ${res.status} ${await res.text()}`);
      removedCount += keys.length;
    }
    throw new Error(`prefix still lists objects after ${MAX_SWEEP_PASSES} passes`);
  } catch (error) {
    logger.error({ err: error, projectId }, "could not reclaim project storage");
    return { removed: false, reason: "failed" };
  }
}

/**
 * Removes the named objects, and says whether it managed to.
 *
 * The clip-deletion path: a clip's master and its preview mirror are two
 * exactly-known keys, and listing a prefix to find two names you already hold
 * is a round trip for nothing. Missing objects are fine — the batch reports
 * what it removed — and the caller decides what honesty about failure means
 * for its route, exactly as deleteProjectObjects's callers do.
 */
export async function deleteObjects(
  keys: string[],
): Promise<{ removed: boolean; reason?: "not-configured" | "failed" }> {
  if (!storageAdminConfigured) return { removed: false, reason: "not-configured" };
  if (keys.length === 0) return { removed: true };
  try {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${VIDEOS_BUCKET}`, {
      method: "DELETE",
      headers: adminHeaders(),
      body: JSON.stringify({ prefixes: keys }),
    });
    if (!res.ok) throw new Error(`delete failed: ${res.status} ${await res.text()}`);
    return { removed: true };
  } catch (error) {
    logger.error({ err: error, keys }, "could not remove objects");
    return { removed: false, reason: "failed" };
  }
}

/**
 * Duplicates one object inside the bucket.
 *
 * Used when a clip is opened as its own project. The alternative — pointing
 * the new project's row at the clip's existing key — would make two rows own
 * one set of bytes, and the first deletion of either would break the other.
 * Storage-level copy keeps the invariant this whole codebase leans on: every
 * object lives under exactly one "<userId>/<projectId>/" prefix, so deleting
 * a project still means deleting its bytes and nobody else's.
 *
 * Returns whether it worked rather than throwing, so the caller can undo the
 * row it made instead of leaving a project pointing at a file that is not
 * there.
 */
export async function copyObject(
  sourceKey: string,
  destinationKey: string,
): Promise<{ copied: boolean; reason?: "not-configured" | "failed" }> {
  if (!storageAdminConfigured) return { copied: false, reason: "not-configured" };
  try {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/copy`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ bucketId: VIDEOS_BUCKET, sourceKey, destinationKey }),
    });
    if (!res.ok) throw new Error(`copy failed: ${res.status} ${await res.text()}`);
    return { copied: true };
  } catch (error) {
    logger.error({ err: error, sourceKey, destinationKey }, "could not copy object");
    return { copied: false, reason: "failed" };
  }
}

/**
 * Removes the login itself.
 *
 * The one operation in this file that is not about bytes, and the one that
 * makes "delete my account" mean what the words say. The admin auth endpoint
 * needs the service role key — the same key that reclaims storage — so a
 * deployment that can do one can do the other.
 *
 * Returns whether it worked rather than throwing, because by the time this runs
 * the person's data is already gone: failing the request at this point would
 * report a deletion that did happen as one that did not, and they would try
 * again and get an empty account back.
 */
export async function deleteAuthUser(userId: string): Promise<boolean> {
  if (!storageAdminConfigured) return false;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      method: "DELETE",
      headers: adminHeaders(),
    });
    // 404 means somebody already deleted it, which is the outcome we wanted.
    if (!res.ok && res.status !== 404) {
      throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    return true;
  } catch (error) {
    logger.error({ err: error, userId }, "could not remove the login after deleting the account");
    return false;
  }
}
