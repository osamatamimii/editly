/**
 * Where this deployment disagrees with the code running on it.
 *
 * Two bugs found in one night, both the same shape, and neither findable by a
 * test:
 *
 *   The storage bucket allowed four content types while the upload code
 *   accepted every image and every audio format. A PNG logo and an MP3 bed
 *   could not be uploaded at all.
 *
 *   The extra-files panel promised 512 MB while the bucket stopped at 50, and
 *   said so on screen.
 *
 * Both were invisible from our side **by construction**: the browser talks to
 * Storage directly, gets a 400, and our API is never called. No log in this
 * system has a line for either. And no suite can catch them, because a suite
 * runs against a local Postgres and a mock — it has no bucket to ask.
 *
 * Both were found by reading the live configuration by hand. This is that,
 * done repeatedly, by the deployment about itself.
 *
 * ## The one rule that makes it useful
 *
 * Every finding names **what the code assumes** and **what the deployment
 * does**, and never merely that they differ. "Content types mismatch" is a
 * line somebody scrolls past; "your bucket refuses image/png, which the upload
 * panel offers" is a line somebody fixes in a minute.
 *
 * And it reports what it *cannot* see as `unknown` rather than as `ok`. A
 * green tick for a question that was never asked is the failure this whole
 * file is a response to.
 */
import { UPLOAD_CONTENT_TYPES } from "@workspace/api-zod";
import { VIDEOS_BUCKET, FALLBACK_UPLOAD_BYTES } from "./storage-limits";

const SUPABASE_URL = (process.env["SUPABASE_URL"] ?? "").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = process.env["SUPABASE_SERVICE_ROLE_KEY"] ?? "";

export type Verdict = "ok" | "wrong" | "unknown";

export interface Finding {
  /** Short, stable, and the thing somebody searches for. */
  id: string;
  verdict: Verdict;
  /** What the code believes. */
  expected: string;
  /** What the deployment actually does, or why we could not tell. */
  actual: string;
  /** What breaks, in the words of somebody using the product. */
  consequence: string;
}

const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/**
 * The bucket, read whole rather than one field at a time.
 *
 * `storage-limits.ts` reads the same endpoint for the size, and caches it for
 * five minutes because it is on the path of a customer's dashboard. This is
 * not: it runs when somebody opens the console, so it asks fresh — a cached
 * answer here would be an audit reporting yesterday's configuration, which is
 * exactly the thing an audit is for.
 */
async function readBucket(): Promise<Record<string, unknown> | null> {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const res = await fetch(`${SUPABASE_URL}/storage/v1/bucket/${VIDEOS_BUCKET}`, {
        headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
        signal: controller.signal,
      });
      if (!res.ok) return null;
      return (await res.json()) as Record<string, unknown>;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

export async function auditDeployment(env: NodeJS.ProcessEnv = process.env): Promise<Finding[]> {
  const findings: Finding[] = [];
  const bucket = await readBucket();

  // ── The bucket ────────────────────────────────────────────────────────────

  if (!bucket) {
    findings.push({
      id: "storage.reachable",
      verdict: "unknown",
      expected: `the ${VIDEOS_BUCKET} bucket answers a request with the service key`,
      actual: SERVICE_ROLE_KEY
        ? "it did not answer, or answered with an error"
        : "SUPABASE_SERVICE_ROLE_KEY is not set on this deployment, so nothing could be asked",
      consequence:
        "everything below about storage is unchecked, and the two worst bugs this product has had were both in there",
    });
  } else {
    const allowed = Array.isArray(bucket["allowed_mime_types"])
      ? (bucket["allowed_mime_types"] as string[])
      : null;

    if (allowed === null) {
      /*
        A bucket with no list takes anything. That is not a failure and it is
        not what this product wants: the list is what keeps a private bucket
        from becoming a place to keep arbitrary files.
      */
      findings.push({
        id: "storage.types",
        verdict: "wrong",
        expected: `the bucket accepts exactly the ${UPLOAD_CONTENT_TYPES.length} types this product uploads`,
        actual: "the bucket has no list at all, so it accepts anything",
        consequence:
          "nothing breaks for a customer, and this private bucket will take any file anybody can name",
      });
    } else {
      const refused = UPLOAD_CONTENT_TYPES.filter((t) => !allowed.includes(t));
      const extra = allowed.filter((t) => !(UPLOAD_CONTENT_TYPES as readonly string[]).includes(t));
      findings.push({
        id: "storage.types",
        verdict: refused.length > 0 ? "wrong" : "ok",
        expected: `accepts ${UPLOAD_CONTENT_TYPES.join(", ")}`,
        actual:
          refused.length > 0
            ? `refuses ${refused.join(", ")}${extra.length > 0 ? `, and allows ${extra.join(", ")} which nothing uploads` : ""}`
            : `accepts all of them${extra.length > 0 ? `, plus ${extra.join(", ")} which nothing uploads` : ""}`,
        consequence:
          refused.length > 0
            ? "a person picks one of those files, the browser gets a 400 straight from Storage, and no log here records it"
            : "",
      });
    }

    const limit = bucket["file_size_limit"];
    const bytes = typeof limit === "number" && limit > 0 ? limit : null;
    findings.push({
      id: "storage.size",
      verdict: bytes === null ? "unknown" : bytes >= FALLBACK_UPLOAD_BYTES ? "ok" : "wrong",
      expected: `at least ${megabytes(FALLBACK_UPLOAD_BYTES)} per file, which is what the browser falls back to promising`,
      actual: bytes === null ? "the bucket names no limit of its own" : `${megabytes(bytes)} per file`,
      consequence:
        bytes !== null && bytes < FALLBACK_UPLOAD_BYTES
          ? "the app offers a larger file than Storage will take, and the refusal arrives with no sentence attached"
          : "",
    });

    findings.push({
      id: "storage.private",
      verdict: bucket["public"] === false ? "ok" : "wrong",
      expected: "the bucket is private, so every file is reached through a signed link",
      actual: bucket["public"] === false ? "it is private" : "it is public",
      consequence:
        bucket["public"] === false
          ? ""
          : "every customer's video is readable by anybody who can guess a path, and paths contain account ids",
    });
  }

  // ── What this deployment can do at all ────────────────────────────────────

  /*
    Each of these is a capability that fails *silently* when its key is absent:
    the product does something worse and says nothing. They are reported as
    facts rather than as errors, because a deployment deliberately without a
    vision model is a choice and not a fault — what matters is that the console
    says which choice was made.
  */
  const capabilities: Array<{ id: string; vars: string[]; without: string }> = [
    {
      id: "planner",
      vars: ["OPENAI_API_KEY"],
      without: "every sentence is read by the keyword matcher instead of the model, which understands less",
    },
    {
      id: "transcription",
      vars: ["DEEPGRAM_API_KEY", "ELEVENLABS_API_KEY"],
      without: "no captions and no silence cutting, on a product whose main promise is both",
    },
    {
      id: "vision",
      vars: ["GEMINI_API_KEY"],
      without: "reframing falls back to a static crop instead of following the speaker",
    },
    {
      id: "stock",
      vars: ["PEXELS_API_KEY"],
      without: "the stock library returns nothing",
    },
    {
      id: "admins",
      vars: ["ADMIN_USER_IDS"],
      without: "this console answers 404 to everybody, including whoever is reading it now",
    },
    {
      id: "billing",
      vars: ["FREEMIUS_SECRET_KEY"],
      without: "payments are taken and never applied to an account",
    },
  ];

  for (const capability of capabilities) {
    const missing = capability.vars.filter((v) => !env[v]?.trim());
    findings.push({
      id: `capability.${capability.id}`,
      // Absent is not "wrong": some of these are deliberate. It is unknown-by-
      // choice, and the console's job is to say so out loud rather than to
      // grade it.
      verdict: missing.length === 0 ? "ok" : missing.length === capability.vars.length ? "unknown" : "wrong",
      expected: capability.vars.join(" and "),
      actual:
        missing.length === 0
          ? "set"
          : missing.length === capability.vars.length
            ? "not set on this deployment"
            : `${missing.join(", ")} missing, the rest set`,
      consequence: missing.length === 0 ? "" : capability.without,
    });
  }

  // ── Where the product thinks it lives ─────────────────────────────────────

  /*
    `APP_ORIGIN` is the string every OAuth redirect is built from, and every
    platform matches it literally against what is registered with them. A
    trailing slash or the wrong host is a connection that fails with an error
    from the platform and nothing from us — which is the shape of every bug on
    this page.
  */
  const origin = env["APP_ORIGIN"]?.trim();
  findings.push({
    id: "origin",
    verdict: !origin ? "unknown" : /^https:\/\/[^/]+$/.test(origin) ? "ok" : "wrong",
    expected: "an https origin with no path and no trailing slash",
    actual: origin ? origin : "APP_ORIGIN is not set, so the built-in domain is used",
    consequence:
      origin && !/^https:\/\/[^/]+$/.test(origin)
        ? "every social connection fails: the platforms match this string exactly against what is registered"
        : "",
  });

  return findings;
}

/** One line for a log, and the number the console leads with. */
export function summarise(findings: Finding[]): { wrong: number; unknown: number; ok: number } {
  return {
    wrong: findings.filter((f) => f.verdict === "wrong").length,
    unknown: findings.filter((f) => f.verdict === "unknown").length,
    ok: findings.filter((f) => f.verdict === "ok").length,
  };
}

/**
 * What this deployment is storing and what it has moved this month.
 *
 * Here rather than in the overview because it answers the same kind of
 * question as everything else on this page: not "how is the product doing"
 * but "is the shape of this deployment still the right one".
 *
 * ## Why egress is the number and not storage
 *
 * Storage is a rent that grows slowly and can be swept. Egress is a toll paid
 * on every render, and this product's own loop — ask again, it is free —
 * multiplies it: a published video costs three or more full downloads of its
 * source. It is the largest line on the bill long before compute is, and it is
 * the one number that differs by two orders of magnitude between object stores.
 *
 * Both figures are measured, not estimated. `jobs.bytes_in` is counted by the
 * worker off the wire, and the stored total comes from `storage.objects`,
 * which knows the exact size of every object.
 */
export interface Usage {
  storedBytes: number | null;
  objects: number | null;
  /** Downloaded by renders since the first of this month. */
  egressBytes: number;
  /** How many of this month's renders were counting. See `jobs.bytes_in`. */
  measuredRenders: number;
  unmeasuredRenders: number;
}

export async function readUsage(): Promise<Usage> {
  const { db } = await import("@workspace/db");
  const { sql } = await import("drizzle-orm");

  /*
    Two queries and not one, because they fail differently. `storage_usage()`
    is a definer function that may not exist on a database the migrations have
    not reached, and a missing function must not take the egress number down
    with it — the egress number is the one that decides something.
  */
  let storedBytes: number | null = null;
  let objects: number | null = null;
  try {
    const stored = await db.execute(sql`select objects, bytes from public.storage_usage()`);
    const row = stored.rows[0] as { objects: string | number; bytes: string | number } | undefined;
    if (row) {
      objects = Number(row.objects);
      storedBytes = Number(row.bytes);
    }
  } catch {
    // Left null, which the console renders as "not known" rather than as zero.
  }

  const moved = await db.execute(sql`
    select coalesce(sum(bytes_in), 0)::bigint          as egress,
           count(*) filter (where bytes_in is not null) as measured,
           count(*) filter (where bytes_in is null)     as unmeasured
      from jobs
     where created_at >= date_trunc('month', now())
  `);
  const row = moved.rows[0] as { egress: string; measured: string; unmeasured: string };

  return {
    storedBytes,
    objects,
    egressBytes: Number(row.egress),
    measuredRenders: Number(row.measured),
    unmeasuredRenders: Number(row.unmeasured),
  };
}
