/**
 * Server-side access to the private "videos" bucket.
 *
 * Browsers upload and read their own objects directly using the signed-in
 * user's token, which row-level security already confines to the user's own
 * folder. The deployment's own credential is used here for the one thing the
 * browser cannot be trusted to finish: reclaiming bytes when a project is
 * deleted.
 *
 * If the deployment has no storage credential the helpers degrade to no-ops so
 * the API still works — deletes then leave orphaned objects rather than
 * failing.
 *
 * ## Where the addresses come from
 *
 * They used to be spelled here: five `${SUPABASE_URL}/storage/v1/...` strings
 * and a header block carrying the service role key. Every one of those is a
 * statement about *which provider we are on* — R2 has no `apikey` header, no
 * `/object/list` endpoint, and a different shape of delete — so they now come
 * from `@workspace/object-store` and a provider change is a variable rather
 * than an edit to this file.
 *
 * What did **not** move is every decision about what a failure means: the
 * sweep that only believes an empty listing, the cap that turns a Storage
 * which answers 200 while removing nothing into a refusal, and the rule that
 * these functions report failure rather than throw it. Those are this file's
 * reason to exist and they are the same on any provider.
 *
 * One thing in here is deliberately not storage at all: `deleteAuthUser` talks
 * to Supabase's auth admin API, which no object store has an opinion about, so
 * it keeps its own URL and its own configuration flag.
 */
import { objectStoreFrom, ObjectStoreError, VIDEOS_BUCKET, type ObjectStore } from "@workspace/object-store";
import { logger } from "./logger";

export { VIDEOS_BUCKET };

/*
  Built once, and allowed to be absent.

  `objectStoreFrom` throws when the deployment is not configured for a store at
  all, which is a legitimate state here — the API has always been able to run
  without a storage credential, refusing the operations that need one rather
  than failing to start. So the throw becomes a null, and the null is what
  `storageAdminConfigured` reports.
*/
function buildStore(): ObjectStore | null {
  try {
    return objectStoreFrom();
  } catch {
    return null;
  }
}

const store = buildStore();

/**
 * Whether this deployment can act on stored objects at all.
 *
 * It used to be "both Supabase variables are present", which was the same
 * answer by accident: the store this API can reach is the question, and on a
 * deployment pointed at R2 the Supabase variables are not the ones that answer
 * it.
 */
export const storageAdminConfigured = store !== null;

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

/**
 * A font's object path, which is a person's and not a project's.
 *
 * The same whitelist as above, with two segments instead of three: a font
 * belongs to the person, not to one project — the whole point of uploading it
 * is that it is available in the next project too. The middle segment is fixed
 * so that a font's folder cannot be spelled as anything else, which keeps the
 * per-user prefix a bucket policy can be written against.
 */
export function isOwnedFontPath(path: string, userId: string): boolean {
  if (!path || path.startsWith("/") || path.endsWith("/")) return false;
  const segments = path.split("/");
  if (segments.length !== 3) return false;
  if (!segments.every((s) => SAFE_SEGMENT.test(s))) return false;
  return segments[0] === userId && segments[1] === "fonts";
}

/*
  Supabase's auth admin API, which is not the object store.

  `deleteAuthUser` at the bottom of this file removes the login itself. No
  object store has an opinion about logins, so this configuration stands on its
  own rather than riding on `storageAdminConfigured` — today they are the same
  two variables, and on a deployment pointed at R2 they would not be.
*/
const SUPABASE_URL = process.env["SUPABASE_URL"]?.replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env["SUPABASE_SERVICE_ROLE_KEY"];
const authAdminConfigured = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY);

function authHeaders(): Record<string, string> {
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

async function listUnderPrefix(store: ObjectStore, prefix: string): Promise<string[]> {
  /*
    One page, asked for explicitly, and a throw when the answer is not a page.

    Both halves matter to the sweep below. A listing that drained every page
    would delete the whole inventory in one request and lose the property the
    sweep is built on — that only an empty listing proves it is finished. And a
    listing that answered `[]` when Storage returned 500 would make "there is
    nothing left" and "we could not find out" the same sentence, which is
    exactly how a deletion gets reported as done while the bytes are still here.
  */
  const found = await store.list(prefix, { limit: LIST_PAGE });
  return found.map((object) => object.key);
}

/**
 * Does the configured credential actually work?
 *
 * `storageAdminConfigured` only says a store could be built out of the
 * environment, and that is not the question anyone cares about — a wrong key
 * looks exactly like a right one until a customer asks to delete their account
 * and the deletion fails at the only moment it must not. So this asks the store.
 *
 * It lists a prefix that cannot match anything, which is the cheapest
 * authenticated call the API has: a credential that works answers an empty
 * page, and one that does not is refused with a 401 or a 403. Nothing is
 * written and nothing is removed.
 *
 * That distinction is the whole output of this function, and it is the reason
 * `list` throws instead of answering `[]`: "the key was rejected" and "nobody
 * answered" are the two things an operator needs told apart, and an empty array
 * says neither. A status of 401 or 403 is a refusal; anything else, including
 * no answer at all, is the host.
 *
 * The prefix is a plain word rather than the `__healthcheck__` it used to be,
 * because the shared key rule requires a segment to begin with a letter or a
 * digit — the same rule that makes `..` and every encoding of it unspellable.
 *
 * The answer is cached, because this is reachable from an endpoint that needs
 * no token — without the cache, a public URL would turn every request into a
 * request against the store, which is an amplifier rather than a health check.
 * And the five-second ceiling is kept from the version that built its own
 * request: this sits on a page a person is waiting for.
 */
type StorageCheck = "ok" | "unauthorized" | "unreachable" | "not-configured";

let cachedCheck: { at: number; value: StorageCheck } | null = null;
const CHECK_TTL_MS = 60_000;
const HEALTH_PREFIX = "healthcheck";
const CHECK_TIMEOUT_MS = 5_000;

export async function verifyStorageAdmin(now: number = Date.now()): Promise<StorageCheck> {
  if (!store) return "not-configured";
  if (cachedCheck && now - cachedCheck.at < CHECK_TTL_MS) return cachedCheck.value;

  let value: StorageCheck;
  try {
    await store.list(HEALTH_PREFIX, { limit: 1, timeoutMs: CHECK_TIMEOUT_MS });
    value = "ok";
  } catch (error) {
    const status = error instanceof ObjectStoreError ? error.status : null;
    value = status === 401 || status === 403 ? "unauthorized" : "unreachable";
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
  if (!store) return { removed: false, reason: "not-configured" };
  try {
    let removedCount = 0;
    for (let pass = 0; pass < MAX_SWEEP_PASSES; pass++) {
      const keys = await listUnderPrefix(store, `${userId}/${projectId}`);
      if (keys.length === 0) {
        // Only an empty listing proves the sweep is done. Counting one page and
        // stopping is how objects past the page size survived their deletion.
        if (removedCount > 0) {
          logger.info({ projectId, removed: removedCount }, "reclaimed project storage");
        }
        return { removed: true };
      }
      // Throws on a refusal, which is what lands in the catch below and turns
      // into `removed: false`. That is the contract this sweep needs from the
      // seam and the reason it does not use a call that swallows.
      await store.remove(keys);
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
  if (!store) return { removed: false, reason: "not-configured" };
  if (keys.length === 0) return { removed: true };
  try {
    await store.remove(keys);
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
  if (!store) return { copied: false, reason: "not-configured" };
  try {
    // R2 refuses this out loud rather than doing nothing quietly: its copy
    // needs a signed `x-amz-copy-source` header its query-string signer cannot
    // produce. A refusal arrives here as a failure, the caller undoes the row
    // it made, and nobody is left with a project pointing at another project's
    // file — which is exactly what a silent no-op would produce.
    await store.copy(sourceKey, destinationKey);
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
  if (!authAdminConfigured) return false;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      method: "DELETE",
      headers: authHeaders(),
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
