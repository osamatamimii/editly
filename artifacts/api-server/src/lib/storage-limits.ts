/**
 * How large a file Storage will actually accept.
 *
 * The browser has always had a ceiling and has always been honest about it:
 * an over-size file is refused before the upload starts, with the number in
 * the sentence. What it did not have was the *right* ceiling.
 *
 * The value came from `VITE_MAX_UPLOAD_BYTES`, and its comment said the quiet
 * part out loud without noticing: "the value is configuration rather than a
 * constant: the day the ceiling moves, nothing in this codebase needs to be
 * touched." That is not what a Vite variable is. It is read at *build* time
 * and baked into the bundle, so the day the ceiling moves the app goes on
 * refusing at the old number until somebody remembers to set a variable and
 * redeploy — and the symptom is uploads that are refused for a limit that no
 * longer exists, with a sentence naming it confidently.
 *
 * That day is coming: this project is on Supabase's free plan, where a bucket
 * cannot exceed 50 MB per object, which is roughly a minute of what this
 * renderer encodes. The pricing page sells four-hour episodes. The gap closes
 * with a plan change on their side, and on the morning it does, this should
 * already be right.
 *
 * So the number is asked for rather than assumed. Storage knows it; it is one
 * request; and a cache makes it one request per five minutes for the whole
 * deployment.
 *
 * ## What it does when it cannot tell
 *
 * Returns null, and every caller falls back to the configured number. A guess
 * that is too small refuses files that would have worked; a guess that is too
 * large accepts an upload that dies at the end. Neither is worth inventing, so
 * when Storage will not say, the fallback answers — and the fallback is the
 * same 50 MB the browser used before any of this existed.
 *
 * ## And the case that is not "cannot tell"
 *
 * A store can also answer, clearly, that it imposes no per-file ceiling. R2
 * does: it has no bucket metadata to read and `facts()` says so on purpose.
 * That is the opposite of not knowing, and it was being treated as the same
 * thing — `fileSizeLimit: null` fell through to `FALLBACK_UPLOAD_BYTES`, which
 * is fifty megabytes and is described three lines up as *Supabase's free-plan
 * per-object ceiling*. So the migration whose entire economic case is larger
 * files would have landed and gone on refusing anything over 50 MB, naming a
 * limit that does not exist on the provider in use, with every suite green.
 *
 * When the store names no ceiling, the ceiling is ours, and it has to be a
 * number rather than "none": the upload is one signed `PUT`, and S3-compatible
 * stores cap a single `PUT` at five gigabytes. Past that the request does not
 * get refused politely at the start, it dies at the end of a five-gigabyte
 * upload — which is the one failure this whole file exists to prevent.
 */

import { objectStoreFrom } from "@workspace/object-store";

export const VIDEOS_BUCKET = "videos";

/** What we say when Storage will not. Supabase's free-plan per-object ceiling. */
export const FALLBACK_UPLOAD_BYTES =
  Number(process.env["MAX_UPLOAD_BYTES"]) || 50 * 1024 * 1024;

/**
 * What we say when the store answers that it has no ceiling of its own.
 *
 * Not the same number as the fallback and not the same question. Five
 * gigabytes is the largest object an S3-compatible store will take in a single
 * signed `PUT`, which is how every upload here is done; a deployment that
 * wants a smaller wall sets `MAX_UPLOAD_BYTES` and gets it in both cases.
 */
export const UNCAPPED_STORE_BYTES =
  Number(process.env["MAX_UPLOAD_BYTES"]) || 5 * 1024 * 1024 * 1024;

/**
 * Five minutes.
 *
 * The answer changes when somebody changes a plan, which is a thing that
 * happens once. The cost of being five minutes stale is that one upload is
 * measured against the old ceiling; the cost of not caching is a request to
 * Storage on every page load of the dashboard.
 */
const CACHE_MS = 5 * 60_000;

/**
 * `bytes: null` with `answered: true` is "this store has no ceiling"; with
 * `answered: false` it is "we could not ask". Two different numbers follow
 * from them, which is why they stopped being the same value.
 */
let cached: { at: number; bytes: number | null; answered: boolean } | null = null;

/** Test seam, and the way a deploy that changed the plan can be made to look again. */
export function forgetStorageLimit(): void {
  cached = null;
}

/**
 * The bucket's own `file_size_limit`, in bytes, or null if it cannot be read.
 *
 * Never throws. This is called from a route that answers a customer's
 * dashboard, and a Storage hiccup must not turn that into a 500 — the worst
 * this may do is fall back to a number that was right yesterday.
 */
export async function bucketUploadLimitBytes(): Promise<number | null> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.bytes;

  /*
    Asked through the seam, not by building a Supabase URL by hand.

    This file constructed `<SUPABASE_URL>/storage/v1/bucket/videos` itself —
    the exact pattern `lib/object-store` exists to remove, and which the worker
    already stopped doing. On an R2 deployment `SUPABASE_URL` is unset, so this
    answered null and every caller fell back to `FALLBACK_UPLOAD_BYTES`: fifty
    megabytes, described three lines up as "Supabase's free-plan per-object
    ceiling", enforced on a provider that has no per-object ceiling at all. The
    migration whose entire economic case is larger files would have gone on
    refusing anything over 50 MB, and named a limit that does not exist on the
    provider in use.

    `facts()` answers the same question for whichever store is configured, and
    already returns `fileSizeLimit: null` where there is no ceiling — which is
    the same "cannot say" this function has always returned.
  */
  try {
    const facts = await objectStoreFrom().facts();
    const raw = facts?.fileSizeLimit ?? null;
    const bytes = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : null;
    // A `facts()` that returned an object answered the question, even when the
    // answer is "no ceiling". A null return, or a throw, did not.
    cached = { at: Date.now(), bytes, answered: facts !== null };
    return bytes;
  } catch {
    cached = { at: Date.now(), bytes: null, answered: false };
    return null;
  }
}

/**
 * Did the store answer at all, and with what?
 *
 * Exported so the one caller that has to tell "no ceiling" from "no answer"
 * can, without every other caller having to care.
 */
export async function storeCeiling(): Promise<{ bytes: number | null; answered: boolean }> {
  const bytes = await bucketUploadLimitBytes();
  return { bytes, answered: cached?.answered ?? false };
}

/** The ceiling to enforce and to say out loud: Storage's if it will say, ours otherwise. */
export async function effectiveUploadLimitBytes(): Promise<number> {
  const ceiling = await storeCeiling();
  if (ceiling.bytes !== null) return ceiling.bytes;
  // No ceiling at the store is our ceiling, not the Supabase free plan's.
  return ceiling.answered ? UNCAPPED_STORE_BYTES : FALLBACK_UPLOAD_BYTES;
}
