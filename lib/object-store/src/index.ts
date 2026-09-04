/**
 * One object store, two providers, and the seam between them.
 *
 * ## Why this exists before anything needs it
 *
 * Every other weakness in this product costs the same to fix in a year as it
 * does today. This one does not: it is guarded by live customer data, and its
 * price is a function of how many people are storing files behind it. That is
 * the whole argument for building the seam now and moving later, rather than
 * moving later and building the seam under pressure.
 *
 * The numbers it is built against: R2 charges $0.015 a gigabyte to store and
 * **nothing** to serve; Supabase charges $0.125 to store and $0.09 a gigabyte
 * to serve past 250 GB. Egress is the line that matters, because this product's
 * own loop multiplies it — every render pulls its source in full, publishing
 * pulls the output, and "ask again, it's free" pulls the source once more.
 *
 * ## What is in here and what deliberately is not
 *
 * In here: **where an object lives, and who is allowed to touch it.** Addresses,
 * credentials, signatures, and the metadata calls that are nothing but a URL
 * and a response — head, list, delete, copy.
 *
 * Not in here: **the transfer.** The worker's download has a connect clock and
 * a separate stall clock, counts bytes off the wire because a cleanly-closed
 * socket mid-body produces a truncated video that ffmpeg decodes happily, and
 * turns a 413 on upload into a sentence naming the real limit. Those were paid
 * for one outage at a time and they are provider-independent. Moving them here
 * to make the abstraction look tidier would risk every one of them for nothing.
 *
 * So a caller asks this module *where to send the request* and then sends it
 * with its own hard-won machinery. The seam is at the address, which is exactly
 * where the two providers differ.
 *
 * ## The one that is not a detail
 *
 * `signedPut` is the point of the whole package. Today the browser uploads
 * straight to Supabase Storage carrying the signed-in user's own JWT, and the
 * permission to write is an RLS policy inside Supabase. R2 has no RLS, no JWT
 * and no row policies — there is no equivalent, only an upload URL signed by
 * our own API. Which means the migration is impossible until our API mints
 * upload URLs, and it is worth doing on its own merits regardless: two of the
 * worst bugs this product has had were a browser getting a 400 from Storage on
 * a request our server never saw, and therefore never logged.
 */
import { assertSafeKey, isSafePrefix } from "./keys";
import { createSupabaseStore } from "./supabase";
import { createR2Store } from "./r2";

export { isSafeKey, assertSafeKey, isOwnedBy, isSafePrefix } from "./keys";

export type Provider = "supabase" | "r2";

/**
 * Where a request goes, what verb it uses, and what it must carry.
 *
 * The verb is part of the address and not the caller's business, because the
 * two providers disagree about it: Supabase writes an object with POST and
 * treats PUT as an update that 400s when the object does not exist yet, while
 * S3 writes with PUT and has no POST for it. A caller that hardcoded either
 * one would be a caller that only works on one provider — which is the exact
 * thing this package exists to stop.
 */
export interface ObjectAddress {
  url: string;
  method: string;
  headers: Record<string, string>;
}

export interface StoredObject {
  /** Full key, not the leaf name: a caller listing a prefix wants a usable key. */
  key: string;
  bytes: number;
  contentType: string | null;
  updatedAt: string | null;
}

/** What a signed upload permits, said back to the caller so it can be shown. */
export interface SignedUpload {
  url: string;
  method: "PUT" | "POST";
  /** Headers the browser must send for the signature to verify. */
  headers: Record<string, string>;
  expiresAt: string;
}

/**
 * What the deployment can find out about its own bucket.
 *
 * `null` fields mean the provider does not answer that question, which is not
 * the same as the answer being zero — the console renders one as "not known"
 * and the other as a number, and the difference is the whole point of the
 * audit page.
 */
export interface StoreFacts {
  provider: Provider;
  bucket: string;
  /** Per-file ceiling in bytes, or null when the provider imposes none. */
  fileSizeLimit: number | null;
  /** Content types accepted, or null when anything is accepted. */
  allowedContentTypes: string[] | null;
  /** Whether an unsigned GET can read an object. */
  publicReads: boolean;
}

/**
 * A request to the store that did not succeed, carrying the answer's status.
 *
 * Most of this package answers a failed metadata call with `null` or an empty
 * array, which is right for the audit page — it asks questions it can live
 * without an answer to. It is exactly wrong for the two callers that arrived
 * after it: a deletion sweep that reads an empty listing as "there is nothing
 * left" would report a customer's bytes gone every time Storage answered 500,
 * and a health probe whose whole job is to tell a rejected credential from an
 * unreachable host cannot do it from an empty array.
 *
 * So `list` throws this instead of swallowing, and the status is on the error
 * because 401 and 503 mean opposite things to whoever is reading the page.
 * `status` is null when there was no answer at all — a timeout, a DNS failure,
 * a refused connection.
 */
export class ObjectStoreError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "ObjectStoreError";
    this.status = status;
  }
}

/**
 * How much of a prefix to read, and how long to wait for it.
 *
 * Without a `limit` a listing drains every page, which is what a caller that
 * wants an inventory means. With one it asks for a single page and returns it —
 * which is what a caller that deletes what it reads and then asks again means,
 * and the difference is not cosmetic: draining first and deleting after would
 * hold a project's whole inventory in memory and lose the property that only an
 * empty listing proves the sweep is finished.
 *
 * There is deliberately no `offset`. Supabase pages by offset and S3 pages by
 * continuation token, and an offset in this interface would be a promise only
 * one of the two providers could keep.
 */
export interface ListOptions {
  /** One page of at most this many, instead of every page. */
  limit?: number;
  /** Ceiling on the request, for a caller on a path a person is waiting on. */
  timeoutMs?: number;
}

export interface ObjectStore {
  readonly provider: Provider;
  readonly bucket: string;

  /**
   * A URL and headers for a transfer this process performs itself.
   *
   * Synchronous on purpose: a caller building a download has already decided
   * to make a network call and should not have to await a second one first.
   */
  address(key: string, method: "GET" | "PUT" | "HEAD" | "DELETE", options?: AddressOptions): ObjectAddress;

  /** A URL somebody else may GET. Carries no credential of ours. */
  signedGet(key: string, expiresInSeconds: number): Promise<string | null>;

  /** A URL somebody else may write to. Carries no credential of ours. */
  signedPut(key: string, options: SignedPutOptions): Promise<SignedUpload | null>;

  /**
   * The same thing for a file too big to send in one request.
   *
   * `signedPut` is one URL and one PUT. That is right up to a few hundred
   * megabytes and wrong for what this product is being built to take: a
   * two-hour podcast is about seven gigabytes, and a single request that
   * restarts from zero when a train enters a tunnel is not an upload, it is a
   * lottery. The person who most needs it is the one on the plan that costs
   * the most.
   *
   * Today the large-file path is Supabase's `tus` endpoint, reached by the
   * browser with the person's own session — which is the one piece of this
   * product that makes changing storage provider a rewrite rather than a
   * configuration change, and `routes/uploads.ts` says so where it branches.
   * S3 multipart is the shape that has an equivalent on both sides of that
   * change: our server begins the upload and signs one URL per part, the
   * browser sends the parts, and our server ends it.
   *
   * `null` means this provider has no multipart we can sign, and the caller
   * keeps whatever it was doing — the same contract `signedPut` uses, for the
   * same reason: a seam that throws on the provider it does not prefer is a
   * seam nobody dares switch.
   */
  beginMultipart(key: string, options: MultipartOptions): Promise<MultipartUpload | null>;

  /**
   * Assembles the parts into the object.
   *
   * The etags are the provider's, read from each part's response, and they are
   * not decoration: S3 verifies them and refuses the assembly if one does not
   * match, which is what makes a resumed upload safe to trust.
   */
  completeMultipart(key: string, uploadId: string, parts: readonly UploadedPart[]): Promise<void>;

  /**
   * Throws the parts away.
   *
   * Worth having and worth calling. An abandoned multipart upload keeps every
   * part it received, billed as storage, invisible to a listing and to every
   * sweep in this product — which is the shape of orphan this codebase has
   * already been bitten by twice.
   */
  abortMultipart(key: string, uploadId: string): Promise<void>;

  head(key: string): Promise<StoredObject | null>;

  /** Throws `ObjectStoreError` rather than answering an empty page. */
  list(prefix: string, options?: ListOptions): Promise<StoredObject[]>;
  remove(keys: string[]): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  facts(): Promise<StoreFacts | null>;
}

export interface AddressOptions {
  contentType?: string;
  /** Overwrite rather than refuse when the key exists. */
  upsert?: boolean;
  contentLength?: number;
}

export interface SignedPutOptions {
  expiresInSeconds: number;
  contentType?: string;
  upsert?: boolean;
}

/**
 * The smallest part S3 and R2 accept, for every part but the last.
 *
 * Five mebibytes, and it is a provider rule rather than a preference: a
 * complete with an undersized part in the middle fails with
 * `EntityTooSmall` *after* every byte has been uploaded, which is the worst
 * possible moment to find out. Exported so the caller that decides how many
 * parts to ask for is reading the same number the check enforces.
 */
export const MIN_PART_BYTES = 5 * 1024 * 1024;

export interface MultipartOptions {
  /** How long each part URL stays valid. One window covers the whole upload. */
  expiresInSeconds: number;
  /** Total size, so the part count can be checked against the provider's floor. */
  totalBytes: number;
  /** How many parts to sign. */
  parts: number;
  contentType?: string;
}

export interface SignedPart {
  /** One-based, and the order the provider assembles them in. */
  partNumber: number;
  url: string;
}

export interface MultipartUpload {
  key: string;
  /** The provider's handle for this upload. Needed to complete or abort it. */
  uploadId: string;
  parts: SignedPart[];
  /** When the part URLs stop working. */
  expiresAt: string;
}

export interface UploadedPart {
  partNumber: number;
  /** As the provider returned it on that part's response. */
  etag: string;
}

/**
 * The bucket name, which is the same word on both providers by choice.
 *
 * Three files declared this constant independently before this package existed.
 * They now import it, so a rename is one edit rather than three and a bug.
 */
export const VIDEOS_BUCKET = "videos";

export interface StoreConfig {
  provider?: Provider;
  bucket?: string;
  supabase?: { url: string; serviceKey: string };
  r2?: { endpoint: string; accessKeyId: string; secretAccessKey: string; publicBase?: string };
}

/**
 * Reads the deployment's configuration and hands back the store it describes.
 *
 * `OBJECT_STORE_PROVIDER` decides, and it defaults to supabase — so a
 * deployment that has never heard of this package behaves exactly as it did.
 * That default is the reason this can ship on a Tuesday with nothing to test
 * in production: the new path is not taken until somebody sets a variable.
 */
export function objectStoreFrom(env: NodeJS.ProcessEnv = process.env, config: StoreConfig = {}): ObjectStore {
  const bucket = config.bucket ?? env["OBJECT_STORE_BUCKET"]?.trim() ?? VIDEOS_BUCKET;
  const provider: Provider =
    config.provider ?? (env["OBJECT_STORE_PROVIDER"]?.trim() === "r2" ? "r2" : "supabase");

  if (provider === "r2") {
    const endpoint = config.r2?.endpoint ?? env["R2_ENDPOINT"]?.trim() ?? "";
    const accessKeyId = config.r2?.accessKeyId ?? env["R2_ACCESS_KEY_ID"]?.trim() ?? "";
    const secretAccessKey = config.r2?.secretAccessKey ?? env["R2_SECRET_ACCESS_KEY"]?.trim() ?? "";
    if (!endpoint || !accessKeyId || !secretAccessKey) {
      /*
        Refused at construction rather than at the first upload.

        A store that is half-configured fails on a customer's file, hours after
        the deploy that broke it, with a 403 from a host nobody recognises. The
        deploy is the moment to find out.
      */
      throw new Error(
        "OBJECT_STORE_PROVIDER is r2, but R2_ENDPOINT, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are not all set.",
      );
    }
    return createR2Store({ bucket, endpoint, accessKeyId, secretAccessKey, publicBase: config.r2?.publicBase ?? env["R2_PUBLIC_BASE"]?.trim() });
  }

  const url = (config.supabase?.url ?? env["SUPABASE_URL"] ?? "").replace(/\/+$/, "");
  const serviceKey = config.supabase?.serviceKey ?? env["SUPABASE_SERVICE_ROLE_KEY"] ?? "";
  if (!url || !serviceKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to reach storage.");
  }
  return createSupabaseStore({ bucket, url, serviceKey });
}

/** Shared by both drivers, so neither can forget it. */
export function guardKey(key: string): void {
  assertSafeKey(key);
}

export function guardPrefix(prefix: string): void {
  if (!isSafePrefix(prefix)) {
    throw new Error(`refusing to list a prefix that is not a plain path (${prefix.length} characters)`);
  }
}
