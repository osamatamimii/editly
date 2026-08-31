/**
 * Cloudflare R2, written now and switched on later.
 *
 * ## Why a driver nobody is running
 *
 * Because the alternative is writing it under pressure. The migration this
 * package exists for is not urgent today and will not be optional forever: R2
 * charges nothing to serve bytes and Supabase charges $0.09 a gigabyte past
 * 250 GB, on a product whose every render pulls its source in full and whose
 * "ask again, it's free" loop pulls it again. The bill crosses over long before
 * the traffic does.
 *
 * Writing it now costs a morning and turns the migration into a variable.
 * Writing it later costs a week and turns it into an outage, because by then
 * the thing being moved is somebody's videos.
 *
 * ## The differences from Supabase that actually matter
 *
 * **There is no RLS.** Supabase permits a browser's upload with a row policy
 * evaluated against the user's JWT. R2 has no such thing and never will: the
 * only way a browser writes to it is a URL our own API signed. That is why
 * `signedPut` is the centre of this package rather than a convenience on it.
 *
 * **There is no bucket metadata.** No per-file size limit, no allowed content
 * type list, no public flag to read back. `facts()` says so honestly rather
 * than reporting zeros — and that means the ceilings this product enforces have
 * to be *ours*, checked in our code before the URL is signed, which is where
 * they belonged in the first place. The 50 MB wall that the app promised past
 * was a Supabase setting nobody here could see.
 *
 * **Writes are PUT, not POST**, and a write is always an overwrite. The
 * `upsert` flag has nowhere to go and is accepted and ignored, because a caller
 * asking for it is asking for the behaviour R2 already has.
 */
import type {
  AddressOptions,
  ObjectAddress,
  ObjectStore,
  SignedPutOptions,
  SignedUpload,
  StoreFacts,
  StoredObject,
} from "./index";
import { guardKey, guardPrefix } from "./index";
import { presign, R2_REGION, type SigningIdentity } from "./sigv4";

export interface R2StoreConfig {
  bucket: string;
  /** `https://<account>.r2.cloudflarestorage.com`, origin only. */
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** A custom domain in front of the bucket, when one is attached. */
  publicBase?: string;
}

/**
 * How long a URL this process signs for itself is good for.
 *
 * Short, because it never leaves the process. A download that has not started
 * within a minute has a problem the signature is not going to fix.
 */
const INTERNAL_SECONDS = 900;

const METADATA_TIMEOUT_MS = 15_000;

/** One page of a listing, which is also S3's own maximum. */
const LIST_PAGE = 1000;

const MAX_LIST_PAGES = 200;

export function createR2Store(config: R2StoreConfig): ObjectStore {
  const identity: SigningIdentity = {
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: R2_REGION,
    service: "s3",
  };
  const endpoint = config.endpoint.replace(/\/+$/, "");
  const bucket = config.bucket;

  const sign = (method: string, key: string, expiresInSeconds: number, query?: Record<string, string>): string =>
    presign({ identity, method, endpoint, bucket, key, query, expiresInSeconds });

  async function text(url: string, method: string): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), METADATA_TIMEOUT_MS);
    try {
      const res = await fetch(url, { method, signal: controller.signal });
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /*
    A parser rather than an XML library.

    S3 listings are the one XML this product will ever read, the two fields it
    needs are unambiguous, and every value inside them is a key or a number we
    put there ourselves. A dependency for this would be a dependency in the
    worker image forever.
  */
  function parseListing(xml: string): { objects: StoredObject[]; next: string | null } {
    const objects: StoredObject[] = [];
    for (const [, body] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = body.match(/<Key>([\s\S]*?)<\/Key>/)?.[1];
      if (!key) continue;
      const size = Number(body.match(/<Size>(\d+)<\/Size>/)?.[1] ?? "0");
      objects.push({
        key: key.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"),
        bytes: Number.isFinite(size) ? size : 0,
        // A listing does not carry content types. `head` is where that lives.
        contentType: null,
        updatedAt: body.match(/<LastModified>([\s\S]*?)<\/LastModified>/)?.[1] ?? null,
      });
    }
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    const next = truncated
      ? (xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1] ?? null)
      : null;
    return { objects, next };
  }

  return {
    provider: "r2",
    bucket,

    address(key: string, method, options: AddressOptions = {}): ObjectAddress {
      guardKey(key);
      const headers: Record<string, string> = {};
      // Signed with `host` alone, so any other header is free to vary — which
      // is what lets the caller keep its own Content-Length and content type
      // without the signature caring.
      if (options.contentType) headers["Content-Type"] = options.contentType;
      if (typeof options.contentLength === "number") {
        headers["Content-Length"] = String(options.contentLength);
      }
      return { url: sign(method, key, INTERNAL_SECONDS), method, headers };
    },

    async signedGet(key: string, expiresInSeconds: number): Promise<string> {
      guardKey(key);
      // A custom domain in front of the bucket serves objects unsigned, so a
      // signature there would be noise on a URL that is already public.
      if (config.publicBase) {
        return `${config.publicBase.replace(/\/+$/, "")}/${key.split("/").map(encodeURIComponent).join("/")}`;
      }
      return sign("GET", key, expiresInSeconds);
    },

    async signedPut(key: string, options: SignedPutOptions): Promise<SignedUpload> {
      guardKey(key);
      const headers: Record<string, string> = {};
      if (options.contentType) headers["Content-Type"] = options.contentType;
      return {
        url: sign("PUT", key, options.expiresInSeconds),
        method: "PUT",
        headers,
        expiresAt: new Date(Date.now() + options.expiresInSeconds * 1000).toISOString(),
      };
    },

    async head(key: string): Promise<StoredObject | null> {
      guardKey(key);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), METADATA_TIMEOUT_MS);
      try {
        const res = await fetch(sign("HEAD", key, INTERNAL_SECONDS), {
          method: "HEAD",
          signal: controller.signal,
        });
        if (!res.ok) return null;
        const bytes = Number(res.headers.get("content-length"));
        return {
          key,
          bytes: Number.isFinite(bytes) ? bytes : 0,
          contentType: res.headers.get("content-type"),
          updatedAt: res.headers.get("last-modified"),
        };
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },

    async list(prefix: string): Promise<StoredObject[]> {
      guardPrefix(prefix);
      const folder = `${prefix.replace(/\/+$/, "")}/`;
      const found: StoredObject[] = [];
      let token: string | null = null;
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const query: Record<string, string> = {
          "list-type": "2",
          prefix: folder,
          "max-keys": String(LIST_PAGE),
        };
        if (token) query["continuation-token"] = token;
        const url = presign({
          identity,
          method: "GET",
          endpoint,
          bucket,
          query,
          expiresInSeconds: INTERNAL_SECONDS,
        });
        const xml = await text(url, "GET");
        if (!xml) break;
        const parsed = parseListing(xml);
        found.push(...parsed.objects);
        if (!parsed.next) break;
        token = parsed.next;
      }
      return found;
    },

    async remove(keys: string[]): Promise<void> {
      /*
        One request per key rather than the batch delete.

        `DeleteObjects` signs the *body*, which query-string authentication
        cannot do — it would mean a second signer, for the one operation in this
        driver that is never on a person's critical path. Deletions here run in
        a sweep, and a sweep can afford a round trip per object.
      */
      for (const key of keys) {
        guardKey(key);
        const res = await fetch(sign("DELETE", key, INTERNAL_SECONDS), { method: "DELETE" });
        // 404 is the state the caller asked for, so it is not a failure.
        if (!res.ok && res.status !== 404) {
          throw new Error(`delete failed: ${res.status}`);
        }
      }
    },

    async copy(from: string, to: string): Promise<void> {
      guardKey(from);
      guardKey(to);
      /*
        `x-amz-copy-source` is a signed header on a real S3 copy, and this
        driver signs only `host`. Rather than build a second signer for one
        call, this refuses out loud: the only caller today is the API's
        duplicate-project path, and a copy that silently did nothing would
        leave a project whose files belong to another project.
      */
      throw new Error(
        "copying an object is not implemented on R2 yet: it needs a signed x-amz-copy-source header, " +
          "which this driver's query-string signer cannot produce. Download and re-upload, or add a header signer.",
      );
    },

    async facts(): Promise<StoreFacts | null> {
      /*
        R2 has no bucket metadata to read.

        Reported as "no ceiling of its own" rather than as unknown, because that
        is the truth and it has a consequence worth surfacing: on R2 every limit
        this product enforces has to be enforced by us, before the URL is signed.
        A console that showed a comfortable number here would be describing a
        wall that does not exist.
      */
      return {
        provider: "r2",
        bucket,
        fileSizeLimit: null,
        allowedContentTypes: null,
        publicReads: Boolean(config.publicBase),
      };
    },
  };
}
