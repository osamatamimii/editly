/**
 * Whether the browser will be allowed to speak to the bucket at all.
 *
 * This is the one failure in the whole upload path that neither side can see.
 * The API mints a ticket and logs a 201; the browser sends the bytes to the
 * storage host and is stopped by its own CORS rules before the first one
 * leaves — and a blocked request has no status, no body and no readable error,
 * so `xhr.onerror` fires with nothing in it. The person gets "network error",
 * their connection is fine, our log says the upload was authorised, and there
 * is no third place to look. It cost an afternoon the first time.
 *
 * It is also the *default* state of a new bucket: R2 allows no cross-origin
 * request until a policy is written, so every deployment that moves to a fresh
 * bucket meets this, once, with no clue attached.
 *
 * So the deployment asks on its own behalf. A CORS preflight is an
 * unauthenticated `OPTIONS` — the same question the browser asks — and the
 * answer says exactly what a browser would be told. No credentials, no upload,
 * one request when somebody opens the console.
 *
 * The origin it asks about is the app's, and it comes from `allowed-origins.ts`
 * rather than from the request that triggered the audit. A header is whoever
 * called: an audit that asked about *its caller's* origin would report green
 * for an operator on localhost while every customer was blocked.
 */

export interface CorsVerdict {
  /** Whether the question could be asked at all. */
  asked: boolean;
  /** The origin that was asked about. */
  origin: string;
  /** Whether the bucket named that origin (or `*`) in its answer. */
  allowsOrigin: boolean;
  /** Whether a PUT from that origin is allowed, which is what an upload is. */
  allowsPut: boolean;
  /**
   * Whether the browser may read the `ETag` of each part.
   *
   * Only a multipart upload needs it, and only for the last step: every part
   * lands, the browser cannot read the receipts, and the upload cannot be
   * assembled. A bucket in this state accepts gigabytes and finishes nothing,
   * which is the most expensive way to be misconfigured.
   */
  exposesEtag: boolean;
  /** What came back, for the line the console prints. */
  detail: string;
}

const TIMEOUT_MS = 4000;

/** A header, lower-cased, or "" — `Headers` is case-insensitive but the values are not. */
const headerOf = (response: Response, name: string) => (response.headers.get(name) ?? "").toLowerCase();

/**
 * Ask the bucket what it would tell a browser at `origin`.
 *
 * The URL is the object endpoint for a key nobody will ever write. A preflight
 * is answered on the route rather than the object — there is nothing at the key
 * and there does not need to be, because CORS is decided before the request it
 * is asking about exists.
 */
export async function probeBucketCors(url: string, origin: string): Promise<CorsVerdict> {
  const blank: CorsVerdict = {
    asked: false,
    origin,
    allowsOrigin: false,
    allowsPut: false,
    exposesEtag: false,
    detail: "",
  };

  /*
    The signature is removed before the question is asked.

    The caller has a signed URL to hand — it is the one address for a key this
    product ever builds — and a preflight sent to it comes back **403 with no
    access-control headers**, which this file reads as "a bucket with no CORS
    policy". The bucket's policy was perfect. The signature covers the method,
    and `OPTIONS` is not the method it was signed for, so the request is
    refused for being unauthorised before CORS is ever considered.

    A preflight carries no credentials by definition: it is the browser asking
    "would you allow this", and the answer cannot depend on a signature the
    browser has not sent yet. So the query string goes, and what is left is the
    route — which is what a preflight is answered on anyway.

    This is worth the paragraph because of how the failure reads: the audit
    would report the one thing it exists to catch, on a deployment where that
    thing is fine, and send somebody to rewrite a correct CORS policy.
  */
  const unsigned = (() => {
    try {
      const u = new URL(url);
      u.search = "";
      return u.toString();
    } catch {
      return url;
    }
  })();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(unsigned, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "PUT",
        // The one header a signed PUT carries. Named here because a bucket that
        // allows the method and not the header refuses the same upload, one
        // step later, in the same unreadable way.
        "Access-Control-Request-Headers": "content-type",
      },
      signal: controller.signal,
    });
  } catch (error) {
    return { ...blank, detail: error instanceof Error ? error.message : "the bucket did not answer" };
  } finally {
    clearTimeout(timer);
  }

  const allowOrigin = headerOf(response, "access-control-allow-origin");
  const allowMethods = headerOf(response, "access-control-allow-methods");
  const exposed = headerOf(response, "access-control-expose-headers");

  /*
    A bucket with no policy answers the preflight with a status and no
    `Access-Control-*` headers at all, which is how a browser decides to block:
    absence is the refusal, not a 403. So the verdict reads the headers rather
    than the status.
  */
  return {
    asked: true,
    origin,
    allowsOrigin: allowOrigin === "*" || allowOrigin === origin.toLowerCase(),
    allowsPut: allowMethods.includes("put"),
    exposesEtag: exposed === "*" || exposed.split(",").some((name) => name.trim() === "etag"),
    detail: allowOrigin
      ? `allow-origin ${allowOrigin}, allow-methods ${allowMethods || "none"}, expose-headers ${exposed || "none"}`
      : `${response.status} with no access-control headers, which is a bucket with no CORS policy`,
  };
}
