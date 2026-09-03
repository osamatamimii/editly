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
 * six platforms speak the ordinary `refresh_token` grant. Meta does not, and
 * for two months that meant Meta was not refreshed at all: Facebook and
 * Instagram issue no refresh token, and a long-lived token is extended by
 * trading it for another one through `fb_exchange_token`. Pretending one
 * function covered both would have been a function that silently did nothing
 * for two platforms, so it did nothing openly instead and said so here.
 *
 * ## The sixty-day cliff that has now been closed
 *
 * Saying so was not enough. A Meta token lasts about sixty days, and nothing
 * extended it and nothing watched it — so every connection was going to stop
 * working two months after it was made, and the first anybody would know is a
 * post failing. Nothing throws until then. Nothing is logged before then. It is
 * this repository's own definition of the worst kind of bug: it works, for a
 * long time, and then it does not, with no event in between.
 *
 * Meta's path is now beside the other four rather than merged into them,
 * because it is a genuinely different exchange: a GET, no refresh token, and
 * the current access token as the input. What it shares with them is the part
 * that matters — it happens *before* the send, and it writes the result back.
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
import { SOCIAL_SPEC, metaExchangeUrl, type SocialPlatform } from "@workspace/api-zod";
import { withDeadline } from "./providers/deadline";

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
  // A refresh is a request to somebody else's server, so it takes the same
  // deadline every other outbound call in the worker does — otherwise a token
  // exchange that hangs wedges the publish loop before a single byte is sent.
  doFetch: typeof fetch = withDeadline(fetch),
): Promise<string> {
  const expiresSoon =
    credential.expiresAt !== null && credential.expiresAt.getTime() - now.getTime() < EARLY_MS;
  if (!expiresSoon) return credential.accessToken;

  /*
    Meta first, because its rule is the opposite of the other four: there is no
    refresh token to check for, and the input to the exchange is the token that
    is about to expire. Falling through to the guard below would mark a
    perfectly good Meta connection as needing to be reconnected, which is the
    behaviour this replaces.
  */
  if (platform === "facebook" || platform === "instagram") {
    return extendMetaToken(accountId, platform, credential, now, env, doFetch);
  }

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

  const response = await doFetch(url, {
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


/**
 * Meta's version of a refresh: the same exchange that made the token, again.
 *
 * `fb_exchange_token` takes a valid long-lived token and returns another one
 * with the clock reset. It is a GET with the secrets in the query string, which
 * is Meta's design rather than a choice; the URL is built by
 * `metaExchangeUrl` in the shared package because the API server makes exactly
 * this call when somebody connects, and two copies of it in two packages is one
 * of them to forget the day Meta moves it.
 *
 * The failure has to be told apart from the other platforms'. Meta answers with
 * an `error` object and a subcode, and `190` is the family that means the token
 * is gone for good — revoked, password changed, permissions withdrawn. That is
 * the one worth marking the account on; everything else may be transient, and
 * marking an account `expired` for a network blip would send somebody to
 * reconnect a connection that was fine.
 */
async function extendMetaToken(
  accountId: string,
  platform: "facebook" | "instagram",
  credential: Credential,
  now: Date,
  env: Record<string, string | undefined>,
  doFetch: typeof fetch = withDeadline(fetch),
): Promise<string> {
  const spec = SOCIAL_SPEC[platform];
  const response = await doFetch(
    metaExchangeUrl({
      clientId: env[spec.clientIdVar] ?? "",
      clientSecret: env[spec.clientSecretVar] ?? "",
      token: credential.accessToken,
    }),
    { headers: { Accept: "application/json" } },
  );
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    const error = (payload["error"] ?? {}) as { message?: string; code?: number; type?: string };
    const gone = Number(error.code) === 190;
    if (gone) {
      await markNeedsReconnect(
        accountId,
        "Facebook access has run out or was withdrawn. Connect it again to keep posting.",
      );
    }
    throw new TokenError(String(error.message ?? response.statusText).slice(0, 200));
  }

  const accessToken = String(payload["access_token"] ?? "");
  /*
    A trade that answered without a token is not a working token.

    Returning the old one would be the quiet failure this whole file exists
    against: the post goes out today on a credential with hours left, and the
    next one fails for a reason nobody can trace back to here.
  */
  if (!accessToken) throw new TokenError("Meta extended the connection without returning a token");

  const seconds = Number(payload["expires_in"]);
  const expiresAt = Number.isFinite(seconds) && seconds > 0 ? new Date(now.getTime() + seconds * 1000) : null;

  await db.execute(sql`
    update social_accounts
       set access_token = ${accessToken},
           expires_at = ${expiresAt},
           status = 'ok',
           status_detail = null,
           updated_at = now()
     where id = ${accountId}
  `);

  return accessToken;
}
