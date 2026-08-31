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
 */

const SUPABASE_URL = (process.env["SUPABASE_URL"] ?? "").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env["SUPABASE_SERVICE_ROLE_KEY"] ?? "";

export const VIDEOS_BUCKET = "videos";

/** What we say when Storage will not. Supabase's free-plan per-object ceiling. */
export const FALLBACK_UPLOAD_BYTES =
  Number(process.env["MAX_UPLOAD_BYTES"]) || 50 * 1024 * 1024;

/**
 * Five minutes.
 *
 * The answer changes when somebody changes a plan, which is a thing that
 * happens once. The cost of being five minutes stale is that one upload is
 * measured against the old ceiling; the cost of not caching is a request to
 * Storage on every page load of the dashboard.
 */
const CACHE_MS = 5 * 60_000;

let cached: { at: number; bytes: number | null } | null = null;

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
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    cached = { at: Date.now(), bytes: null };
    return null;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    let body: unknown;
    try {
      const res = await fetch(`${SUPABASE_URL}/storage/v1/bucket/${VIDEOS_BUCKET}`, {
        headers: {
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        cached = { at: Date.now(), bytes: null };
        return null;
      }
      body = await res.json();
    } finally {
      clearTimeout(timer);
    }

    // `file_size_limit` is null on a bucket with no limit of its own, which is
    // a real answer and not a failure — it means the project's ceiling
    // applies, and that is not a number this endpoint reports. Null either
    // way, so the fallback speaks; the two cases differ only in a log nobody
    // needs.
    const raw = (body as { file_size_limit?: unknown } | null)?.file_size_limit;
    const bytes = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : null;
    cached = { at: Date.now(), bytes };
    return bytes;
  } catch {
    cached = { at: Date.now(), bytes: null };
    return null;
  }
}

/** The ceiling to enforce and to say out loud: Storage's if it will say, ours otherwise. */
export async function effectiveUploadLimitBytes(): Promise<number> {
  return (await bucketUploadLimitBytes()) ?? FALLBACK_UPLOAD_BYTES;
}
