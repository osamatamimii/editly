/**
 * Which shop this is, and who that makes them here.
 *
 * Two questions that look like string handling and are not. The shop domain is
 * interpolated into a URL that carries an access token — get the validation
 * wrong and the token is delivered to whoever chose the string. And the id
 * derived from it becomes `user_id` on projects, jobs and storage keys, which
 * is the column every query in this product filters on.
 */
import { createHash } from "node:crypto";

/**
 * A shop domain, and nothing that merely looks like one.
 *
 * Exactly one label in front of `.myshopify.com`. That "exactly" is the whole
 * check: shop names cannot contain a dot, so anything with two labels is not a
 * shop, it is somebody's domain arranged to end in ours — and the request this
 * string builds carries `X-Shopify-Access-Token`.
 *
 * Lowercase, because Shopify's own value is and a case-varying key would let
 * one shop own two rows in a table whose primary key is this string.
 *
 * The length bound is Shopify's: a subdomain is a DNS label.
 */
const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]\.myshopify\.com$/;

export function isShopDomain(value: unknown): value is string {
  if (typeof value !== "string") return false;
  // Trimmed and lowered *before* the test rather than as part of it: a value
  // that needs cleaning to pass is a value the caller should be handing us
  // cleaned, and normalising inside a validator hides which of the two the
  // stored key came from.
  return value.length <= 76 && SHOP_DOMAIN.test(value);
}

/** The same, for a value that arrived from a header or a query string. */
export function asShopDomain(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().toLowerCase();
  return isShopDomain(cleaned) ? cleaned : null;
}

/**
 * The namespace every Shopify-derived account id is minted under.
 *
 * A constant, and it must never change: it is what makes the id for a shop the
 * same id tomorrow. Changing it would not corrupt anything — it would silently
 * orphan every project a shop had ever made, which is worse, because the shop
 * would simply see an empty account and nothing anywhere would have failed.
 */
const NAMESPACE = "1f0c6a52-9a52-4a7e-b1a6-2d3f6a7c5e10";

/**
 * The Editly account a shop is, as a UUID version 5.
 *
 * A Shopify install has no Editly sign-in behind it. There is no email to make
 * an account from — reading one needs a protected-data approval this app has
 * no reason to ask for — and inviting a merchant to create a second account
 * before they can see a video would lose most of them at the first screen.
 *
 * So the shop *is* the account, and the id is derived from the domain rather
 * than allocated. Two properties make that safe, and both are checked in
 * `tools/shopify-test.mjs`:
 *
 * **It is stable.** The same shop resolves to the same id on every request,
 * across deploys and reinstalls, with nothing stored to look it up. A mapping
 * table would be a row that can go missing; arithmetic cannot.
 *
 * **It can never be a Supabase account.** Version 5 is stamped into the id.
 * Supabase issues version 4, so no sign-in anywhere can ever be handed an id
 * this function can produce, and no shop can ever be handed a person's. The
 * two identity spaces share a column and cannot collide in it — which is the
 * only reason it is safe for them to share one.
 *
 * RFC 4122 §4.3, written out because Node has no v5 and a dependency for
 * twelve lines of SHA-1 is a dependency to keep updated for ever.
 */
export function accountIdForShop(shop: string): string {
  const namespaceBytes = Buffer.from(NAMESPACE.replace(/-/g, ""), "hex");
  const hash = createHash("sha1").update(namespaceBytes).update(Buffer.from(shop, "utf8")).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  // Version 5 in the high nibble of byte 6, and the RFC 4122 variant in the
  // top bits of byte 8. These two lines are the safety property above.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
