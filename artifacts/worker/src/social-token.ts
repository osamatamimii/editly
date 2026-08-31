/**
 * The access token a scheduled post needs, an hour after it stopped being valid.
 *
 * This is the gap between "connecting works" and "scheduling works", and it is
 * invisible until the first post that matters. A Google access token lasts one
 * hour. Somebody connects their channel on Tuesday and schedules a clip for
 * Thursday at 9pm; by then the token in the row has been dead for two days.
 * The upload comes back 401, the post is marked failed, and the reason on the
 * screen is whatever Google says about an invalid credential — which reads as
 * "Editly is broken", and is.
 *
 * So the token is refreshed before the send, not after a failure. Four of the
 * six platforms speak the ordinary `refresh_token` grant and are handled here.
 * Meta is not: Facebook and Instagram issue long-lived tokens that are extended
 * by a different exchange entirely, and pretending one function covers both
 * would be a function that silently does nothing for two platforms.
 *
 * ## Why it writes back
 *
 * A refresh that is not persisted is a refresh done again on the next post, and
 * on some platforms the old refresh token is rotated out by the exchange — so
 * not writing the new one back means the *second* post after an expiry fails
 * permanently. The write is the point, not a nicety.
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { SOCIAL_SPEC, type SocialPlatform } from "@workspace/api-zod";

/**
 * How long before expiry a token counts as expired.
 *
 * Five minutes. An upload takes time, and a token with forty seconds left is a
 * token that dies partway through a file — which on a resumable upload is the
 * worst moment for it, because some bytes are already on the platform.
 */
const EARLY_MS = 5 * 60 * 1000;

/** Where each platform trades a refresh token for a fresh access token. */
const REFRESH_URL: Partial<Record<SocialPlatform, string>> = {
  youtube: "https://oauth2.googleapis.com/token",
  tiktok: "https://open.tiktokapis.com/v2/oauth/token/",
  x: "https://api.twitter.com/2/oauth2/token",
  snapchat: "https://accounts.snapchat.com/login/oauth2/access_token",
};

/** TikTok spells the client id differently here too. */
const CLIENT_ID_PARAM: Partial<Record<SocialPlatform, string>> = { tiktok: "client_key" };

export interface Credential {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
}

export class TokenError extends Error {}

/**
 * A usable access token for this account, refreshed if it needs to be.
 *
 * Throws rather than returning a stale one. A caller that got a token back and
 * then failed with a 401 has no way to tell "the token was old" from "the
 * platform refused the upload", and those are two different sentences to put
 * in front of a person.
 */
export async function usableToken(
  accountId: string,
  platform: SocialPlatform,
  credential: Credential,
  now: Date = new Date(),
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  const expiresSoon =
    credential.expiresAt !== null && credential.expiresAt.getTime() - now.getTime() < EARLY_MS;
  if (!expiresSoon) return credential.accessToken;

  const url = REFRESH_URL[platform];
  if (!url || !credential.refreshToken) {
    /*
      Marked on the account, not just thrown. The person has to reconnect, and
      the only place they will find that out is the screen that lists their
      accounts — which reads `status`. A post that fails without setting this
      fails again next week for the same reason and never explains itself.
    */
    await markNeedsReconnect(
      accountId,
      credential.refreshToken
        ? `${platform} tokens cannot be refreshed automatically yet.`
        : "This connection has no refresh token, so it has to be made again.",
    );
    throw new TokenError(
      "This account needs reconnecting before anything can go out to it.",
    );
  }

  const spec = SOCIAL_SPEC[platform];
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: credential.refreshToken,
    [CLIENT_ID_PARAM[platform] ?? "client_id"]: env[spec.clientIdVar] ?? "",
    client_secret: env[spec.clientSecretVar] ?? "",
  });

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    const detail = String(payload["error_description"] ?? payload["error"] ?? response.statusText);
    /*
      `invalid_grant` is the one that means "the person revoked us", and it is
      permanent — retrying it every hour for a week is how an integration gets
      an app rate-limited. Anything else may be transient, so the account is
      left alone and only this post fails.
    */
    if (String(payload["error"] ?? "") === "invalid_grant") {
      await markNeedsReconnect(accountId, "Access was withdrawn on the platform. Connect it again to keep posting.");
    }
    throw new TokenError(detail.slice(0, 200));
  }

  const accessToken = String(payload["access_token"] ?? "");
  if (!accessToken) throw new TokenError("the platform refreshed without returning a token");

  const expiresIn = Number(payload["expires_in"]);
  const expiresAt = Number.isFinite(expiresIn) ? new Date(now.getTime() + expiresIn * 1000) : null;
  /*
    The refresh token only when a new one came back. Google returns none on a
    refresh and keeps the old one working; TikTok rotates and returns a new one
    each time. Overwriting with an empty value would break the platform that
    does not rotate, and keeping the old value would break the one that does —
    so it is written only when the platform actually said something.
  */
  const rotated = payload["refresh_token"] ? String(payload["refresh_token"]) : null;

  await db.execute(sql`
    update social_accounts
       set access_token = ${accessToken},
           refresh_token = coalesce(${rotated}, refresh_token),
           expires_at = ${expiresAt},
           status = 'ok',
           status_detail = null,
           updated_at = now()
     where id = ${accountId}
  `);

  return accessToken;
}

async function markNeedsReconnect(accountId: string, detail: string): Promise<void> {
  await db.execute(sql`
    update social_accounts
       set status = 'expired', status_detail = ${detail}, updated_at = now()
     where id = ${accountId}
  `);
}
