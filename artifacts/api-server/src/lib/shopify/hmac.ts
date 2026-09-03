/**
 * The signature, which is the only thing that separates Shopify from anybody
 * with the URL.
 *
 * Every one of these endpoints is public by necessity: Shopify calls them from
 * the open internet with no session. An unverified webhook is not a webhook, it
 * is an unauthenticated endpoint that deletes a shop's data on request — which
 * is exactly what `shop/redact` does.
 *
 * The same lesson this repository already learned from Freemius, arriving
 * through a second door, and with one addition Shopify makes explicit: for the
 * mandatory compliance webhooks a bad signature must be answered **401**, not
 * ignored and not 200. Silently accepting is the obvious bug; silently
 * *dropping* is the one that passes review and fails the audit.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies `X-Shopify-Hmac-Sha256` over the bytes that arrived.
 *
 * The bytes, not the parsed object. `express.json()` consumes the stream and
 * hands back a value whose re-serialisation reorders keys and drops
 * whitespace, and the digest of that is not the digest they signed — the
 * failure is total (every real webhook rejected) and invisible to any test
 * that signs its own re-serialised body. See `lib/body-parsers.ts`, which is
 * where this endpoint is kept away from the JSON parser.
 */
export function verifyWebhook(rawBody: Buffer, header: unknown, secret: string | undefined): boolean {
  if (!secret || typeof header !== "string" || header.length === 0) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  let given: Buffer;
  try {
    given = Buffer.from(header, "base64");
  } catch {
    return false;
  }
  // Length first, because `timingSafeEqual` throws on a mismatch rather than
  // returning false — and a throw inside a verifier is an exception path that
  // some caller eventually treats as "not verified" and some other caller
  // eventually treats as a 500.
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

/**
 * The other signature: the one on a query string, when Shopify redirects a
 * browser to us.
 *
 * Different shape and a different trap. Here the `hmac` parameter is removed
 * and the remaining parameters are sorted and joined — so a verifier that
 * forgets to drop `hmac` itself, or that trusts the order they arrived in,
 * rejects every genuine request. Hex rather than base64, unlike the webhook.
 */
export function verifyQuery(query: Record<string, unknown>, secret: string | undefined): boolean {
  if (!secret) return false;
  const given = query["hmac"];
  if (typeof given !== "string" || given.length === 0) return false;

  const message = Object.keys(query)
    .filter((key) => key !== "hmac" && key !== "signature")
    .sort()
    .map((key) => `${key}=${Array.isArray(query[key]) ? (query[key] as string[]).join(",") : String(query[key])}`)
    .join("&");

  const expected = createHmac("sha256", secret).update(message, "utf8").digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(given, "hex");
  } catch {
    return false;
  }
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}
