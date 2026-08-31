/**
 * Supabase Storage, behind the interface.
 *
 * This driver is a description of what the product does today, written down
 * rather than invented. Every URL in it already existed somewhere in this
 * codebase — in the worker, in the API, in the browser — and the point of
 * collecting them is that until now nobody could answer "which endpoints does
 * this product depend on" without reading three files and hoping they agreed.
 *
 * ## The one place it is not a straight translation
 *
 * `signedPut` returns an upload URL our API mints. That endpoint exists in
 * Supabase and is not the one the browser uses today: the browser uploads
 * carrying the signed-in user's own JWT and is permitted by an RLS policy.
 * Both work. Only one of them has an equivalent on another provider, and only
 * one of them puts our server on the path — where it can refuse a file with a
 * sentence, instead of leaving Storage to answer 400 to a browser nobody is
 * watching and no log here records.
 */
import type {
  AddressOptions,
  ListOptions,
  ObjectAddress,
  ObjectStore,
  SignedPutOptions,
  SignedUpload,
  StoreFacts,
  StoredObject,
} from "./index";
import { guardKey, guardPrefix, ObjectStoreError } from "./index";

export interface SupabaseStoreConfig {
  bucket: string;
  url: string;
  serviceKey: string;
}

/** One page of a listing. */
const LIST_PAGE = 100;

/** Beyond this the prefix is not a folder but a mistake, and we stop asking. */
const MAX_LIST_PAGES = 200;

const METADATA_TIMEOUT_MS = 15_000;

/** Slashes are structure; everything else in a segment is data. */
const encodeKey = (key: string): string => key.split("/").map(encodeURIComponent).join("/");

export function createSupabaseStore(config: SupabaseStoreConfig): ObjectStore {
  const base = `${config.url.replace(/\/+$/, "")}/storage/v1`;
  const bucket = config.bucket;

  const auth = (extra: Record<string, string> = {}): Record<string, string> => ({
    apikey: config.serviceKey,
    Authorization: `Bearer ${config.serviceKey}`,
    ...extra,
  });

  const objectUrl = (key: string): string => `${base}/object/${bucket}/${encodeKey(key)}`;

  /*
    Every metadata call is bounded.

    `fetch` in Node has no timeout of any kind. These calls are small and they
    sit on paths a person is waiting on — opening a project, deleting an
    account, loading the console — so a provider that accepts the connection
    and then goes quiet is an await that never returns.
  */
  async function ask(path: string, init: RequestInit, timeoutMs = METADATA_TIMEOUT_MS): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${base}${path}`, { ...init, signal: controller.signal });
      if (!res.ok) throw new ObjectStoreError(`${init.method ?? "GET"} ${path} answered ${res.status}`, res.status);
      return await res.json();
    } catch (error) {
      // A refusal keeps its status; anything else — a timeout, a dropped
      // connection, a body that is not JSON — has none, and saying so is the
      // difference between "the key was rejected" and "nobody answered".
      if (error instanceof ObjectStoreError) throw error;
      throw new ObjectStoreError(`${init.method ?? "GET"} ${path} did not answer: ${String(error)}`, null);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The same call for the questions this store can live without an answer to.
   *
   * `signedGet`, `signedPut` and `facts` all have a caller that renders "not
   * known" and carries on, so they keep the swallow they were written with.
   * `list` does not, and that is why it is the one that calls `ask` directly.
   */
  async function json(path: string, init: RequestInit): Promise<unknown | null> {
    try {
      return await ask(path, init);
    } catch {
      return null;
    }
  }

  return {
    provider: "supabase",
    bucket,

    address(key: string, method, options: AddressOptions = {}): ObjectAddress {
      guardKey(key);
      const headers = auth();
      if (options.contentType) headers["Content-Type"] = options.contentType;
      if (options.upsert) headers["x-upsert"] = "true";
      // Without an explicit length undici sends chunked, and an object store is
      // entitled to refuse that.
      if (typeof options.contentLength === "number") {
        headers["Content-Length"] = String(options.contentLength);
      }
      return { url: objectUrl(key), method: method === "PUT" ? "POST" : method, headers };
    },

    async signedGet(key: string, expiresInSeconds: number): Promise<string | null> {
      guardKey(key);
      const body = await json(`/object/sign/${bucket}/${encodeKey(key)}`, {
        method: "POST",
        headers: auth({ "Content-Type": "application/json" }),
        body: JSON.stringify({ expiresIn: Math.max(1, Math.floor(expiresInSeconds)) }),
      });
      // Supabase answers with a path beginning `/object/sign/...`, not a URL.
      const signed = (body as { signedURL?: string } | null)?.signedURL;
      return signed ? `${base}${signed.startsWith("/") ? "" : "/"}${signed}` : null;
    },

    async signedPut(key: string, options: SignedPutOptions): Promise<SignedUpload | null> {
      guardKey(key);
      const body = await json(`/object/upload/sign/${bucket}/${encodeKey(key)}`, {
        method: "POST",
        headers: auth({ "Content-Type": "application/json" }),
        body: JSON.stringify({ expiresIn: Math.max(1, Math.floor(options.expiresInSeconds)) }),
      });
      const path = (body as { url?: string } | null)?.url;
      if (!path) return null;

      const headers: Record<string, string> = {};
      if (options.contentType) headers["Content-Type"] = options.contentType;
      if (options.upsert) headers["x-upsert"] = "true";
      return {
        url: `${base}${path.startsWith("/") ? "" : "/"}${path}`,
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
        const res = await fetch(objectUrl(key), { method: "HEAD", headers: auth(), signal: controller.signal });
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
      const folder = prefix.replace(/\/+$/, "");
      const size = options.limit && options.limit > 0 ? Math.floor(options.limit) : LIST_PAGE;
      // One page when the caller asked for one, every page when it did not.
      const pages = options.limit ? 1 : MAX_LIST_PAGES;
      const found: StoredObject[] = [];
      for (let page = 0; page < pages; page += 1) {
        const body = await ask(
          `/object/list/${bucket}`,
          {
            method: "POST",
            headers: auth({ "Content-Type": "application/json" }),
            body: JSON.stringify({ prefix: folder, limit: size, offset: page * size }),
          },
          options.timeoutMs,
        );
        const rows = Array.isArray(body) ? (body as Array<Record<string, unknown>>) : [];
        for (const row of rows) {
          const name = typeof row["name"] === "string" ? row["name"] : null;
          // A row with no id is a folder, not an object.
          if (!name || row["id"] === null || row["id"] === undefined) continue;
          const meta = (row["metadata"] ?? {}) as Record<string, unknown>;
          found.push({
            key: `${folder}/${name}`,
            bytes: typeof meta["size"] === "number" ? meta["size"] : 0,
            contentType: typeof meta["mimetype"] === "string" ? meta["mimetype"] : null,
            updatedAt: typeof row["updated_at"] === "string" ? row["updated_at"] : null,
          });
        }
        if (rows.length < size) break;
      }
      return found;
    },

    async remove(keys: string[]): Promise<void> {
      if (keys.length === 0) return;
      for (const key of keys) guardKey(key);
      const res = await fetch(`${base}/object/${bucket}`, {
        method: "DELETE",
        headers: auth({ "Content-Type": "application/json" }),
        body: JSON.stringify({ prefixes: keys }),
      });
      if (!res.ok) throw new Error(`delete failed: ${res.status}`);
    },

    async copy(from: string, to: string): Promise<void> {
      guardKey(from);
      guardKey(to);
      const res = await fetch(`${base}/object/copy`, {
        method: "POST",
        headers: auth({ "Content-Type": "application/json" }),
        body: JSON.stringify({ bucketId: bucket, sourceKey: from, destinationKey: to }),
      });
      if (!res.ok) throw new Error(`copy failed: ${res.status}`);
    },

    async facts(): Promise<StoreFacts | null> {
      const body = (await json(`/bucket/${bucket}`, { headers: auth() })) as Record<string, unknown> | null;
      if (!body) return null;
      const limit = body["file_size_limit"];
      const types = body["allowed_mime_types"];
      return {
        provider: "supabase",
        bucket,
        fileSizeLimit: typeof limit === "number" && limit > 0 ? limit : null,
        allowedContentTypes: Array.isArray(types) ? (types as string[]) : null,
        publicReads: body["public"] === true,
      };
    },
  };
}
