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
  ListOptions,
  MultipartOptions,
  MultipartUpload,
  SignedPart,
  UploadedPart,
  ObjectAddress,
  ObjectStore,
  SignedPutOptions,
  SignedUpload,
  StoreFacts,
  StoredObject,
} from "./index";
import { guardKey, guardPrefix, MIN_PART_BYTES, ObjectStoreError } from "./index";
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

/**
 * An etag, safe to put inside the completion document.
 *
 * S3 returns it quoted — `"a1b2…"` — and the quotes are part of it, so it is
 * echoed rather than stripped. It comes back through the browser, which makes
 * it the one value in this file that did not originate here: a caller that
 * passed a `<` through would otherwise be writing XML into our request rather
 * than a part id.
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

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

  /*
    Throws rather than answering `null`.

    Its one caller is `list`, and an empty listing is a sentence with a meaning:
    "there is nothing under this prefix". A driver that says that when it means
    "the request failed" hands a deletion sweep a reason to report a customer's
    bytes gone while they are still here. The status travels with the error so
    a caller can tell a rejected signature from a host that never answered.
  */
  async function text(url: string, method: string, timeoutMs = METADATA_TIMEOUT_MS): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method, signal: controller.signal });
      if (!res.ok) throw new ObjectStoreError(`${method} on ${bucket} answered ${res.status}`, res.status);
      return await res.text();
    } catch (error) {
      if (error instanceof ObjectStoreError) throw error;
      throw new ObjectStoreError(`${method} on ${bucket} did not answer: ${String(error)}`, null);
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

    /*
      Signed, always, and the public base is not a shortcut past that.

      This used to return `${publicBase}/${key}` whenever a custom domain was
      configured — unsigned, with no expiry, and `expiresInSeconds` dropped on
      the floor. The reasoning was that a custom domain in front of a bucket
      serves objects unsigned anyway, so a signature would be noise.

      It is not noise, because of who this URL is handed to. `publisher.ts`
      passes it to Meta with the comment "signed by the object store,
      short-lived, and long enough to outlive Meta's own fetch and transcode".
      On R2-with-a-custom-domain it was neither: a permanent, unauthenticated
      URL to somebody's finished video, given to a third party and then living
      in their logs and every proxy between here and there — for good.

      And it changed with no code change and no error. Setting
      `OBJECT_STORE_PROVIDER=r2` with `R2_PUBLIC_BASE`, which is the documented
      migration path, was enough.

      A signature costs nothing here, and a bucket that also answers unsigned on
      a custom domain is a bucket configuration question rather than a reason
      for this function to stop signing.
    */
    async signedGet(key: string, expiresInSeconds: number): Promise<string> {
      guardKey(key);
      return sign("GET", key, expiresInSeconds);
    },

    /*
      Multipart, which is the whole reason a browser can stop talking to
      Supabase with its own session.

      Three calls, and only the middle one is the browser's. We ask S3 to open
      an upload, we sign one URL per part and hand them over, the browser PUTs
      the parts in any order and keeps each response's `ETag`, and we close it
      with the list. Every one of those signatures is query-string form, which
      is what makes this possible at all: header signing needs the body's hash,
      and we never see the body.

      ## The three things that make it fail in the field

      **Part size.** Every part but the last must be at least `MIN_PART_BYTES`.
      An undersized part in the middle is accepted at upload time and refused
      at assembly with `EntityTooSmall`, after every byte has been sent — so it
      is checked here, before anything is signed, against the total the caller
      declares.

      **The etag has to reach the browser.** It arrives as a response header on
      each part, and a cross-origin request cannot read a header the bucket has
      not exposed. Without `Access-Control-Expose-Headers: ETag` in the
      bucket's CORS rules, every part uploads perfectly and the completion has
      nothing to assemble with. That is a deployment setting, not code, and it
      is written down in RUNBOOK.md because it fails as "the last step does
      nothing" rather than as an error.

      **One window for the whole upload.** The parts share `expiresInSeconds`,
      so it has to cover the slowest connection that will finish, not the
      fastest. A seven-gigabyte file on a domestic upstream is hours.
    */
    async beginMultipart(key: string, options: MultipartOptions): Promise<MultipartUpload> {
      guardKey(key);

      const parts = Math.floor(options.parts);
      if (!(parts >= 1) || !Number.isFinite(parts)) {
        throw new ObjectStoreError(`a multipart upload needs at least one part, got ${options.parts}`, null);
      }
      // 10,000 is S3's own ceiling, and hitting it means the part size was
      // chosen too small for the file rather than that the file is too big.
      if (parts > 10_000) {
        throw new ObjectStoreError(`a multipart upload may have at most 10000 parts, got ${parts}`, null);
      }
      if (parts > 1) {
        const partBytes = Math.floor(options.totalBytes / parts);
        if (partBytes < MIN_PART_BYTES) {
          throw new ObjectStoreError(
            `${parts} parts of ${options.totalBytes} bytes is ${partBytes} per part, below the ${MIN_PART_BYTES}-byte minimum every part but the last must meet`,
            null,
          );
        }
      }

      // `POST /<key>?uploads`. The content type is declared here, on the
      // create, and not on the parts: it belongs to the finished object.
      const createQuery: Record<string, string> = { uploads: "" };
      if (options.contentType) createQuery["Content-Type"] = options.contentType;
      const created = await text(
        presign({ identity, method: "POST", endpoint, bucket, key, query: createQuery, expiresInSeconds: INTERNAL_SECONDS }),
        "POST",
      );
      const uploadId = created.match(/<UploadId>([\s\S]*?)<\/UploadId>/)?.[1];
      if (!uploadId) {
        throw new ObjectStoreError("S3 opened a multipart upload and did not say what its id is", null);
      }

      const signedParts: SignedPart[] = [];
      for (let partNumber = 1; partNumber <= parts; partNumber += 1) {
        signedParts.push({
          partNumber,
          url: sign("PUT", key, options.expiresInSeconds, {
            partNumber: String(partNumber),
            uploadId,
          }),
        });
      }

      return {
        key,
        uploadId,
        parts: signedParts,
        expiresAt: new Date(Date.now() + options.expiresInSeconds * 1000).toISOString(),
      };
    },

    async completeMultipart(key: string, uploadId: string, parts: readonly UploadedPart[]): Promise<void> {
      guardKey(key);
      if (parts.length === 0) {
        throw new ObjectStoreError("a multipart upload cannot be completed with no parts", null);
      }

      /*
        Sorted here rather than trusted.

        S3 assembles in the order this document lists and refuses a list that
        is not ascending. The browser sends parts concurrently and reports them
        as they finish, so the order they arrive in is the order they completed
        — which is not the order of the file.
      */
      const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
      const body =
        "<CompleteMultipartUpload>" +
        ordered
          .map(
            (part) =>
              `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${escapeXml(part.etag)}</ETag></Part>`,
          )
          .join("") +
        "</CompleteMultipartUpload>";

      const url = presign({
        identity, method: "POST", endpoint, bucket, key,
        query: { uploadId }, expiresInSeconds: INTERNAL_SECONDS,
      });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), METADATA_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          method: "POST",
          body,
          headers: { "Content-Type": "application/xml" },
          signal: controller.signal,
        });
        const answer = await res.text();
        if (!res.ok) {
          throw new ObjectStoreError(`completing the upload of ${key} answered ${res.status}`, res.status);
        }
        /*
          A 200 with an error inside it, which is how S3 refuses this one call.

          CompleteMultipartUpload streams its response while it assembles, so
          the status line is written before the outcome is known and a failure
          arrives as an `<Error>` document under a 200. Reading only the status
          here would report a finished upload for an object that does not
          exist — and the next thing to touch it is a render.
        */
        if (/<Error>/.test(answer)) {
          const code = answer.match(/<Code>([\s\S]*?)<\/Code>/)?.[1] ?? "unknown";
          throw new ObjectStoreError(`completing the upload of ${key} failed with ${code}`, null);
        }
      } catch (error) {
        if (error instanceof ObjectStoreError) throw error;
        throw new ObjectStoreError(`completing the upload of ${key} did not answer: ${String(error)}`, null);
      } finally {
        clearTimeout(timer);
      }
    },

    async abortMultipart(key: string, uploadId: string): Promise<void> {
      guardKey(key);
      await text(
        presign({
          identity, method: "DELETE", endpoint, bucket, key,
          query: { uploadId }, expiresInSeconds: INTERNAL_SECONDS,
        }),
        "DELETE",
      );
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

    async list(prefix: string, options: ListOptions = {}): Promise<StoredObject[]> {
      guardPrefix(prefix);
      const folder = `${prefix.replace(/\/+$/, "")}/`;
      const size = options.limit && options.limit > 0 ? Math.floor(options.limit) : LIST_PAGE;
      // A caller that asked for one page gets one, and does not get a
      // continuation token it has nowhere to put: the way it asks for the next
      // page is by deleting this one and asking again.
      const pages = options.limit ? 1 : MAX_LIST_PAGES;
      const found: StoredObject[] = [];
      let token: string | null = null;
      for (let page = 0; page < pages; page += 1) {
        const query: Record<string, string> = {
          "list-type": "2",
          prefix: folder,
          "max-keys": String(size),
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
        const parsed = parseListing(await text(url, "GET", options.timeoutMs));
        found.push(...parsed.objects);
        if (!parsed.next) break;
        token = parsed.next;
        /*
          A continuation token still in hand on the last pass means there is
          more and we are about to stop. Throwing rather than returning a short
          list, for the reason written on the Supabase side of this seam: the
          caller that matters is the data export, and an inventory that is
          quietly truncated is a document claiming we hold less than we do.

          The two providers stopped at wildly different totals — twenty thousand
          against two hundred thousand — so the same account exported two
          different inventories depending on which store was configured.
        */
        if (page === pages - 1 && !options.limit) {
          throw new Error(
            `listing "${prefix}" did not finish: ${MAX_LIST_PAGES} pages and still more`,
          );
        }
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
      /*
        And bounded, like every other call in this driver.

        `remove` was the one that reached `fetch` directly, and `fetch` in Node
        has no timeout. It is awaited from inside the worker's render loop — the
        retention sweep runs there, before the claim — so a provider that
        accepts the connection and goes quiet was a queue that stopped: no
        claims, no heartbeat, and `/healthz` still answering 200 because it
        reports whether the process is up rather than whether it is doing
        anything.
      */
      for (const key of keys) {
        guardKey(key);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), METADATA_TIMEOUT_MS);
        try {
          const res = await fetch(sign("DELETE", key, INTERNAL_SECONDS), {
            method: "DELETE",
            signal: controller.signal,
          });
          // 404 is the state the caller asked for, so it is not a failure.
          if (!res.ok && res.status !== 404) {
            throw new ObjectStoreError(`DELETE on ${bucket} answered ${res.status}`, res.status);
          }
        } catch (error) {
          if (error instanceof ObjectStoreError) throw error;
          throw new ObjectStoreError(`DELETE on ${bucket} did not answer: ${String(error)}`, null);
        } finally {
          clearTimeout(timer);
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
