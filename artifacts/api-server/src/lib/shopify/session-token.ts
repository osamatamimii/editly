/**
 * Who is asking, when the request comes from inside Shopify's admin.
 *
 * An embedded app runs in an iframe on Shopify's domain. It has no cookie of
 * ours — it must not have one, because the review requires the app to work in
 * a browser with third-party cookies blocked — so every call it makes to this
 * API carries an **ID token** that App Bridge mints, signed with our own client
 * secret.
 *
 * That token is the entire authentication for this surface. It decides which
 * shop's projects a request may see, which means every check below is load
 * bearing and the missing ones are the classic holes:
 *
 * **The algorithm.** A verifier that reads `alg` from the token and does what
 * it says accepts `{"alg":"none"}` and forges itself. HS256 is required here
 * and nothing else is accepted.
 *
 * **The audience.** Without `aud === client_id`, a token minted for any other
 * app on the same platform is a valid token for this one.
 *
 * **The clock.** These live about a minute. Without `exp`, one captured token
 * is a permanent key to that shop.
 *
 * **The two shop claims agreeing.** `dest` is the shop the token was minted
 * for and `iss` is that shop's admin URL. A token that names one shop in one
 * claim and another in the other is not a token to reason about.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { asShopDomain } from "./domain";

/**
 * A minute of slack in both directions.
 *
 * Not generosity: the token lives about sixty seconds, and a server whose clock
 * is thirty seconds fast rejects *every* request from a correctly working app,
 * for reasons no log line would explain. Leeway large enough to absorb ordinary
 * drift and far too small to make a captured token useful.
 */
const CLOCK_LEEWAY_SECONDS = 60;

export interface SessionToken {
  shop: string;
  /** Shopify's id for the staff member, when the token carries one. */
  userId: string | null;
  expiresAt: number;
}

export type SessionTokenResult =
  | { ok: true; token: SessionToken }
  /** Never shown to a caller as-is; it names which check failed, for the log. */
  | { ok: false; reason: string };

function base64UrlToBuffer(part: string): Buffer {
  return Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function verifySessionToken(
  token: unknown,
  options: { clientId: string | undefined; secret: string | undefined; now?: number },
): SessionTokenResult {
  const { clientId, secret } = options;
  if (!clientId || !secret) return { ok: false, reason: "the app is not configured" };
  if (typeof token !== "string" || token.length === 0) return { ok: false, reason: "no token" };

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "not a token" };
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(base64UrlToBuffer(headerPart).toString("utf8")) as Record<string, unknown>;
    payload = JSON.parse(base64UrlToBuffer(payloadPart).toString("utf8")) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "not a token" };
  }

  // Read, and then required to be the one thing we accept. The token does not
  // get to choose how it is checked.
  if (header["alg"] !== "HS256") return { ok: false, reason: "unexpected algorithm" };

  const expected = createHmac("sha256", secret).update(`${headerPart}.${payloadPart}`, "utf8").digest();
  const given = base64UrlToBuffer(signaturePart);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "bad signature" };
  }

  if (payload["aud"] !== clientId) return { ok: false, reason: "minted for a different app" };

  const now = Math.floor((options.now ?? Date.now()) / 1000);
  const exp = typeof payload["exp"] === "number" ? payload["exp"] : 0;
  const nbf = typeof payload["nbf"] === "number" ? payload["nbf"] : 0;
  if (exp + CLOCK_LEEWAY_SECONDS < now) return { ok: false, reason: "expired" };
  if (nbf - CLOCK_LEEWAY_SECONDS > now) return { ok: false, reason: "not valid yet" };

  // `dest` is "https://shop.myshopify.com". Parsed rather than string-matched,
  // because a URL is the thing that knows where its own host ends.
  const dest = typeof payload["dest"] === "string" ? payload["dest"] : "";
  let destShop: string | null = null;
  try {
    destShop = asShopDomain(new URL(dest).hostname);
  } catch {
    destShop = null;
  }
  if (!destShop) return { ok: false, reason: "no shop in the token" };

  // `iss` is the same shop's admin URL. Two claims that name different shops
  // is not a token to reason about, whichever one you would have believed.
  const iss = typeof payload["iss"] === "string" ? payload["iss"] : "";
  let issShop: string | null = null;
  try {
    issShop = asShopDomain(new URL(iss).hostname);
  } catch {
    issShop = null;
  }
  if (issShop !== destShop) return { ok: false, reason: "the token names two different shops" };

  return {
    ok: true,
    token: {
      shop: destShop,
      userId: typeof payload["sub"] === "string" ? payload["sub"] : null,
      expiresAt: exp * 1000,
    },
  };
}
