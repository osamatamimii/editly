/**
 * AWS Signature V4, query-string form, in about a hundred lines of node:crypto.
 *
 * ## Why not the SDK
 *
 * `@aws-sdk/client-s3` is roughly twenty megabytes of dependencies to produce
 * a string. It would go into the worker image, which is rebuilt on every
 * deploy, and into the API's cold start. And this workspace holds npm packages
 * for a day before it will install them, which is the right policy and a bad
 * fit for a dependency added the night before a migration.
 *
 * More to the point: the whole reason this package exists is so that switching
 * object store is a configuration change rather than a rewrite. A seam whose
 * second implementation drags in a large SDK is a seam that will be argued
 * about instead of used.
 *
 * ## Why query-string auth and not the Authorization header
 *
 * Header signing needs the request body's hash, so it splits into a signer for
 * requests we make and a signer for URLs we hand out. Query signing needs
 * neither, works for every verb, and covers both cases with one function: the
 * URL it returns is one we can fetch ourselves *or* give to a browser.
 *
 * That is not a shortcut. It is the property that makes the browser stop
 * talking to Supabase with its own JWT, which is the one thing standing
 * between this product and a provider it can change.
 */
import { createHash, createHmac } from "node:crypto";

const ALGORITHM = "AWS4-HMAC-SHA256";

/** R2 has no regions, and signs everything as `auto`. */
export const R2_REGION = "auto";

export interface SigningIdentity {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
}

/**
 * RFC 3986, which is not what `encodeURIComponent` implements.
 *
 * It leaves `!'()*` alone; the signature specification does not. A key with an
 * apostrophe in it — which a filename can have — signs one way here and
 * verifies another way at the provider, and the failure is a 403 with no
 * explanation of which character caused it.
 */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** A key is a path: its slashes are structure, everything else is data. */
function encodeKeyPath(key: string): string {
  return key.split("/").map(uriEncode).join("/");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

/** `20260831T142530Z` and `20260831`, which is the only date format involved. */
export function stamps(at: Date): { amzDate: string; dateOnly: string } {
  const amzDate = at.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate, dateOnly: amzDate.slice(0, 8) };
}

function signingKey(identity: SigningIdentity, dateOnly: string): Buffer {
  const date = hmac(`AWS4${identity.secretAccessKey}`, dateOnly);
  const region = hmac(date, identity.region);
  const service = hmac(region, identity.service);
  return hmac(service, "aws4_request");
}

export interface PresignInput {
  identity: SigningIdentity;
  method: string;
  /** Origin only: `https://<account>.r2.cloudflarestorage.com`. */
  endpoint: string;
  /** Path-style, so the bucket is the first path segment. */
  bucket: string;
  /** Empty for a bucket-level call such as a listing. */
  key?: string;
  /** Extra query parameters. Signed with the rest; order does not matter here. */
  query?: Record<string, string>;
  expiresInSeconds: number;
  now?: Date;
}

/**
 * The signed URL.
 *
 * Path-style addressing (`/bucket/key`) rather than virtual-host, because R2's
 * account endpoint serves every bucket and a virtual-host name for it does not
 * exist unless a custom domain has been attached — which is a thing somebody
 * configures later, not a thing this code should require in order to work.
 */
export function presign(input: PresignInput): string {
  const { identity, method, bucket, key = "", expiresInSeconds } = input;
  const at = input.now ?? new Date();
  const { amzDate, dateOnly } = stamps(at);

  const endpoint = input.endpoint.replace(/\/+$/, "");
  const host = new URL(endpoint).host;
  const canonicalPath = `/${uriEncode(bucket)}${key ? `/${encodeKeyPath(key)}` : ""}`;

  const scope = `${dateOnly}/${identity.region}/${identity.service}/aws4_request`;
  const parameters: Record<string, string> = {
    ...(input.query ?? {}),
    "X-Amz-Algorithm": ALGORITHM,
    "X-Amz-Credential": `${identity.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(Math.max(1, Math.floor(expiresInSeconds))),
    "X-Amz-SignedHeaders": "host",
  };

  // Sorted by the encoded key, byte-wise. `Object.keys` order is insertion
  // order and would sign a different string than the one the provider rebuilds.
  const canonicalQuery = Object.keys(parameters)
    .map((k) => [uriEncode(k), uriEncode(parameters[k])] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalPath,
    canonicalQuery,
    `host:${host}\n`,
    "host",
    // The body is not signed. For a URL handed to a browser it cannot be:
    // we do not have the bytes it is about to send.
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signature = hmac(signingKey(identity, dateOnly), stringToSign).toString("hex");

  return `${endpoint}${canonicalPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
