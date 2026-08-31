/**
 * Connecting a real account, which is the step scheduling has never had.
 *
 * The queue was built, the composer was built, the limits are enforced and the
 * publisher runs on a schedule — and there has never been a way to put a real
 * account into any of it. `social_accounts` could only ever have been filled by
 * hand. That is the gap this closes.
 *
 * ## What is here and what is not
 *
 * Here: the two halves of an authorization code exchange, per platform, with
 * the state and PKCE handling that makes it safe. Not here: credentials, and
 * platform review. Neither is code — both take days of somebody else's time —
 * and the code has to exist first or there is nothing to submit for review.
 * So a platform without credentials answers "not switched on" exactly as it
 * did before, and the button that cannot work is still not shown.
 *
 * ## Three things this has to get right
 *
 * **The state cannot be guessable, and it has to say who.** An OAuth callback
 * arrives as a plain GET that anybody can cause. Without a state bound to the
 * signed-in person, an attacker sends their own `code` to this endpoint and the
 * victim's Editly account ends up connected to the *attacker's* Instagram —
 * after which everything the victim schedules is published to a stranger's
 * feed. So the state is an HMAC over the user, the platform and an expiry,
 * signed with a secret this deployment already holds.
 *
 * **The verifier may not travel in the state.** X and TikTok require PKCE, and
 * a verifier that rides in a URL parameter is a verifier the browser's history,
 * the referrer and every proxy on the path have seen — which is the whole thing
 * PKCE exists to prevent. It goes in an httpOnly cookie, which the callback can
 * read and JavaScript cannot.
 *
 * **The redirect must be exact.** Every one of these platforms matches the
 * redirect URI as a literal string against what is registered. A trailing
 * slash, http against https, or a preview deployment's hostname is a failed
 * connection with an error from the platform and nothing from us. It is built
 * from `APP_ORIGIN`, read per call — the same rule `allowed-origins.ts` states
 * for the same reason.
 */
import { createHmac, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { SOCIAL_SPEC, type SocialPlatform } from "@workspace/api-zod";
import { appOrigin } from "./allowed-origins";

/**
 * How long somebody has to finish signing in at the platform.
 *
 * Ten minutes. Long enough to find a password and pass a second factor, short
 * enough that a state left in a browser history is useless by the time anybody
 * reads it.
 */
const STATE_TTL_MS = 10 * 60 * 1000;

export const VERIFIER_COOKIE = "editly_pkce";

/**
 * The secret the state is signed with.
 *
 * The service role key, which this deployment already holds and which is
 * already the thing that must never leak. A separate variable would be one more
 * thing to set — and one more thing that, unset, would silently fall back to a
 * constant and make every state forgeable. This throws instead.
 */
function signingSecret(): string {
  const secret = process.env["SUPABASE_SERVICE_ROLE_KEY"]?.trim();
  if (!secret) throw new Error("no signing secret: SUPABASE_SERVICE_ROLE_KEY is not set");
  return secret;
}

const base64url = (input: Buffer | string) =>
  Buffer.from(input).toString("base64url");

export interface StateClaims {
  userId: string;
  platform: SocialPlatform;
  /** Milliseconds since the epoch. */
  expiresAt: number;
}

/** `<payload>.<signature>`, where the payload is readable and the signature is not. */
export function signState(claims: StateClaims, secret = signingSecret()): string {
  const payload = base64url(JSON.stringify(claims));
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

/**
 * The claims, or null.
 *
 * Null for every kind of wrong — malformed, mis-signed, expired — and
 * deliberately not an error that says which. A callback that reports *why* a
 * state was rejected is an oracle for constructing one that is not.
 */
export function readState(state: string, secret = signingSecret(), now = Date.now()): StateClaims | null {
  const [payload, signature] = state.split(".");
  if (!payload || !signature) return null;

  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  // Constant time, and length-checked first because `timingSafeEqual` throws on
  // a length mismatch rather than returning false.
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as StateClaims;
    if (typeof claims.userId !== "string" || typeof claims.platform !== "string") return null;
    if (typeof claims.expiresAt !== "number" || claims.expiresAt < now) return null;
    return claims;
  } catch {
    return null;
  }
}

/** A PKCE pair. The verifier is kept; the challenge is what the platform sees. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Where a platform sends somebody back. Exact, and the same in both halves. */
export function redirectUri(platform: SocialPlatform, env = process.env): string {
  return `${appOrigin(env)}/api/social/callback/${platform}`;
}

interface Endpoint {
  authorizeUrl: string;
  tokenUrl: string;
  /** Space-separated, because that is what every one of these expects. */
  scope: string;
  /** Whether the platform requires PKCE. Two of the six do. */
  pkce: boolean;
  /**
   * Extra parameters this platform needs on the authorize URL.
   *
   * Google's pair is not optional and is the one most often left out: without
   * `access_type=offline` no refresh token is issued at all, and without
   * `prompt=consent` none is issued on the *second* connection — so an account
   * reconnected after a token expiry works for an hour and then silently stops,
   * which is the worst version of this bug because the first connection looked
   * fine.
   */
  extra?: Record<string, string>;
  /** TikTok spells the client id differently from everybody else. */
  clientIdParam?: string;
}

export const ENDPOINTS: Record<SocialPlatform, Endpoint> = {
  instagram: {
    authorizeUrl: "https://www.facebook.com/v21.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v21.0/oauth/access_token",
    scope: "instagram_basic,instagram_content_publish,pages_show_list,business_management",
    pkce: false,
  },
  facebook: {
    authorizeUrl: "https://www.facebook.com/v21.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v21.0/oauth/access_token",
    scope: "pages_show_list,pages_manage_posts,pages_read_engagement",
    pkce: false,
  },
  tiktok: {
    authorizeUrl: "https://www.tiktok.com/v2/auth/authorize/",
    tokenUrl: "https://open.tiktokapis.com/v2/oauth/token/",
    scope: "user.info.basic,video.publish,video.upload",
    pkce: true,
    clientIdParam: "client_key",
  },
  x: {
    authorizeUrl: "https://twitter.com/i/oauth2/authorize",
    tokenUrl: "https://api.twitter.com/2/oauth2/token",
    scope: "tweet.read tweet.write users.read offline.access media.write",
    pkce: true,
  },
  snapchat: {
    authorizeUrl: "https://accounts.snapchat.com/accounts/oauth2/auth",
    tokenUrl: "https://accounts.snapchat.com/accounts/oauth2/token",
    scope: "snapchat-marketing-api",
    pkce: false,
  },
  youtube: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    // Upload, plus the read that lets us show which channel was connected. A
    // person looking at "connected" needs to see the channel's name, and
    // `youtube.upload` alone cannot tell them what it is.
    scope: "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly",
    pkce: false,
    extra: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
  },
};

/** The URL a person is sent to, with everything that platform requires on it. */
export function authorizeUrlFor(
  platform: SocialPlatform,
  state: string,
  challenge: string | null,
  env: Record<string, string | undefined> = process.env,
): string {
  const endpoint = ENDPOINTS[platform];
  const url = new URL(endpoint.authorizeUrl);
  url.searchParams.set(endpoint.clientIdParam ?? "client_id", env[SOCIAL_SPEC[platform].clientIdVar] ?? "");
  url.searchParams.set("redirect_uri", redirectUri(platform, env));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", endpoint.scope);
  url.searchParams.set("state", state);
  if (endpoint.pkce && challenge) {
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  for (const [key, value] of Object.entries(endpoint.extra ?? {})) url.searchParams.set(key, value);
  return url.toString();
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** Absolute, not a duration: a duration is only meaningful next to the moment it was read. */
  expiresAt: Date | null;
}

/**
 * The code for a token.
 *
 * `fetch` rather than a platform SDK, six times over, because six SDKs is six
 * dependency trees and a shared cadence of breaking changes for six form posts
 * that are nearly identical.
 */
export async function exchangeCode(
  platform: SocialPlatform,
  code: string,
  verifier: string | null,
  env: Record<string, string | undefined> = process.env,
): Promise<TokenSet> {
  const endpoint = ENDPOINTS[platform];
  const spec = SOCIAL_SPEC[platform];
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(platform, env),
    [endpoint.clientIdParam ?? "client_id"]: env[spec.clientIdVar] ?? "",
    client_secret: env[spec.clientSecretVar] ?? "",
  });
  if (endpoint.pkce && verifier) body.set("code_verifier", verifier);

  const response = await fetch(endpoint.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    /*
      The platform's own words, not ours, and truncated.

      A person who cannot connect needs the actual reason — "redirect_uri
      mismatch" is a thing somebody can fix and "could not connect" is not.
      Truncated because some of these answer with a page.
    */
    const detail = String(payload["error_description"] ?? payload["error"] ?? response.statusText);
    throw new Error(detail.slice(0, 200));
  }

  const accessToken = String(payload["access_token"] ?? "");
  if (!accessToken) throw new Error("the platform returned no access token");
  const expiresIn = Number(payload["expires_in"]);
  return {
    accessToken,
    refreshToken: payload["refresh_token"] ? String(payload["refresh_token"]) : null,
    expiresAt: Number.isFinite(expiresIn) ? new Date(Date.now() + expiresIn * 1000) : null,
  };
}
