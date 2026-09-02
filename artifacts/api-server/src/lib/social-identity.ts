/**
 * Who was just connected.
 *
 * A token on its own is a row that says "connected" and nothing else, and a
 * person with two Instagram accounts cannot tell which one they linked. Worse,
 * `social_accounts` is keyed on `(user, platform, external_id)` so that
 * reconnecting an account *replaces* it — without a real external id, every
 * reconnection is a second row, and "publish to both" sends the same clip
 * twice to the same feed.
 *
 * So each platform is asked who this is, once, immediately after the exchange.
 * A failure here fails the connection rather than storing a row with a made-up
 * id: a duplicate post cannot be taken back, and a connection that failed can
 * be tried again.
 */
import { SOCIAL_SPEC, metaExchangeUrl, type SocialPlatform } from "@workspace/api-zod";

const GRAPH = "https://graph.facebook.com/v21.0";

export interface Identity {
  externalId: string;
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
}

async function asJson(url: string, token: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const error = payload["error"] as { message?: string } | string | undefined;
    const message = typeof error === "string" ? error : error?.message;
    throw new Error(String(message ?? response.statusText).slice(0, 200));
  }
  return payload;
}

export async function identityFor(platform: SocialPlatform, accessToken: string): Promise<Identity> {
  switch (platform) {
    case "youtube": {
      const payload = await asJson(
        "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
        accessToken,
      );
      const items = payload["items"] as Array<Record<string, unknown>> | undefined;
      const channel = items?.[0];
      if (!channel) {
        /*
          A Google account with no YouTube channel. It is not an error at
          Google's end and it is not something to store: an upload needs a
          channel, so a row saying "connected" would be a row that fails at
          9pm. Said plainly instead, at the moment somebody can act on it.
        */
        throw new Error("That Google account has no YouTube channel yet. Create one, then connect again.");
      }
      const snippet = (channel["snippet"] ?? {}) as Record<string, unknown>;
      const thumbnails = (snippet["thumbnails"] ?? {}) as Record<string, { url?: string }>;
      return {
        externalId: String(channel["id"]),
        handle: String(snippet["customUrl"] ?? snippet["title"] ?? "channel"),
        displayName: snippet["title"] ? String(snippet["title"]) : null,
        avatarUrl: thumbnails["default"]?.url ?? null,
      };
    }
    case "facebook":
    case "instagram": {
      const payload = await asJson(
        "https://graph.facebook.com/v21.0/me?fields=id,name,picture",
        accessToken,
      );
      const picture = (payload["picture"] ?? {}) as { data?: { url?: string } };
      return {
        externalId: String(payload["id"]),
        handle: String(payload["name"] ?? "account"),
        displayName: payload["name"] ? String(payload["name"]) : null,
        avatarUrl: picture.data?.url ?? null,
      };
    }
    case "x": {
      const payload = await asJson(
        "https://api.twitter.com/2/users/me?user.fields=profile_image_url",
        accessToken,
      );
      const data = (payload["data"] ?? {}) as Record<string, unknown>;
      return {
        externalId: String(data["id"]),
        handle: `@${String(data["username"] ?? "account")}`,
        displayName: data["name"] ? String(data["name"]) : null,
        avatarUrl: data["profile_image_url"] ? String(data["profile_image_url"]) : null,
      };
    }
    case "tiktok": {
      const payload = await asJson(
        "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url",
        accessToken,
      );
      const data = ((payload["data"] ?? {}) as Record<string, unknown>)["user"] as
        | Record<string, unknown>
        | undefined;
      if (!data) throw new Error("TikTok returned no account for that token");
      return {
        externalId: String(data["open_id"]),
        handle: String(data["display_name"] ?? "account"),
        displayName: data["display_name"] ? String(data["display_name"]) : null,
        avatarUrl: data["avatar_url"] ? String(data["avatar_url"]) : null,
      };
    }
    case "snapchat": {
      const payload = await asJson("https://adsapi.snapchat.com/v1/me", accessToken);
      const me = (payload["me"] ?? {}) as Record<string, unknown>;
      return {
        externalId: String(me["id"]),
        handle: String(me["display_name"] ?? me["email"] ?? "account"),
        displayName: me["display_name"] ? String(me["display_name"]) : null,
        avatarUrl: null,
      };
    }
  }
}


// ─── Meta, which needs three more answers before it can post ────────────────

/**
 * Everything about a Meta connection that does not change between posts.
 *
 * `identityFor` above stores a Facebook **user**, and neither Instagram nor
 * Facebook will accept a post to one. A Facebook video goes to a *Page*, with
 * the Page's own token; an Instagram Reel goes to the *business account
 * attached to a Page*. Both were resolved on every single send, which is two
 * Graph calls per post for values that are fixed at connection time.
 *
 * And the token itself. Meta issues no refresh token: the code exchange returns
 * a short-lived token, which is traded for a long-lived one, which is extended
 * by the same trade again. Nothing was doing either, so `expires_at` was null —
 * the database saying "this does not expire" about the one credential here that
 * does — and every Meta connection was going to stop working about two months
 * after it was made, with no event and nothing to look at.
 */
export interface MetaPage {
  id: string;
  name: string;
  /** The Page's own token. Not the user's, and it is what actually posts. */
  token: string;
  /** The Instagram business account attached to it, when there is one. */
  instagramUserId: string | null;
}

export interface MetaTargets {
  /** The long-lived token, traded for the short one the code exchange returned. */
  accessToken: string;
  /** When that token stops working. Around sixty days out. */
  expiresAt: Date | null;
  pages: MetaPage[];
}

/**
 * How long a Meta token has, from what Meta said about it.
 *
 * `expires_in` is seconds, and it is occasionally absent — Meta documents some
 * long-lived tokens as not expiring at all. Absent is stored as null, which is
 * this column's existing meaning, rather than as a date invented from a
 * documented average. A wrong expiry is worse than none: it would either
 * refresh a working token for no reason or, in the other direction, let a dead
 * one sit until a post failed on it.
 */
export function metaExpiryFrom(payload: Record<string, unknown>, now: Date = new Date()): Date | null {
  const seconds = Number(payload["expires_in"]);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(now.getTime() + seconds * 1000);
}

/**
 * Trade a short-lived Meta token for a long-lived one.
 *
 * The same call extends an existing long-lived token, which is why
 * `social-token.ts` calls this too rather than having its own copy: one
 * exchange, one place, and the day Meta changes it there is one thing to edit.
 */
export async function exchangeForLongLivedMetaToken(
  platform: "facebook" | "instagram",
  accessToken: string,
  env: Record<string, string | undefined> = process.env,
  doFetch: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<{ accessToken: string; expiresAt: Date | null }> {
  const spec = SOCIAL_SPEC[platform];
  const url = metaExchangeUrl({
    clientId: env[spec.clientIdVar] ?? "",
    clientSecret: env[spec.clientSecretVar] ?? "",
    token: accessToken,
    graph: GRAPH,
  });

  const response = await doFetch(url);
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const error = payload["error"] as { message?: string } | undefined;
    throw new Error(String(error?.message ?? response.statusText).slice(0, 200));
  }
  const longLived = String(payload["access_token"] ?? "");
  /*
    A failed exchange is not a reason to store the short token.

    Sixty days and one hour look identical in the row, and the difference only
    shows up as a post failing next week for a reason nobody can see. If the
    trade did not happen, say so and let the connection fail — a connection that
    failed can be made again.
  */
  if (!longLived) throw new Error("Meta did not return a long-lived token for that connection");
  return { accessToken: longLived, expiresAt: metaExpiryFrom(payload, now) };
}

/** The Pages this token manages, each with its token and its Instagram account. */
export async function metaPagesFor(
  accessToken: string,
  doFetch: typeof fetch = fetch,
): Promise<MetaPage[]> {
  const response = await doFetch(
    `${GRAPH}/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=${encodeURIComponent(accessToken)}`,
  );
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const error = payload["error"] as { message?: string } | undefined;
    throw new Error(String(error?.message ?? response.statusText).slice(0, 200));
  }
  const rows = (payload["data"] as Array<Record<string, unknown>> | undefined) ?? [];
  return rows
    .filter((row) => row["id"] && row["access_token"])
    .map((row) => {
      const linked = row["instagram_business_account"] as { id?: string } | undefined;
      return {
        id: String(row["id"]),
        name: String(row["name"] ?? "your Page"),
        token: String(row["access_token"]),
        instagramUserId: linked?.id ? String(linked.id) : null,
      };
    });
}

/** Both, in one place, because a connection needs both or it is not connected. */
export async function metaTargetsFor(
  platform: "facebook" | "instagram",
  shortLivedToken: string,
  env: Record<string, string | undefined> = process.env,
  doFetch: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<MetaTargets> {
  const exchanged = await exchangeForLongLivedMetaToken(platform, shortLivedToken, env, doFetch, now);
  const pages = await metaPagesFor(exchanged.accessToken, doFetch);
  return { accessToken: exchanged.accessToken, expiresAt: exchanged.expiresAt, pages };
}

/**
 * Which Page to use, when the answer does not need asking.
 *
 * Exactly one Page is not a choice, it is the answer. Several is a question,
 * and this returns null rather than picking — which is the whole bug this
 * replaces. Taking the first of several is what put somebody's video on the
 * wrong Page with nothing failing.
 *
 * None is also null, and the caller says the sentence: both destinations go
 * through a Page, so an account that manages none cannot post, and hearing that
 * while connecting is far better than hearing it when a post is due.
 */
export function chooseSinglePage(pages: MetaPage[]): MetaPage | null {
  return pages.length === 1 ? pages[0]! : null;
}

/** Just the names, for a screen. Never the tokens. */
export function pageChoicesFrom(pages: MetaPage[]): Array<{ id: string; name: string }> {
  return pages.map((page) => ({ id: page.id, name: page.name }));
}

/** True for the two platforms that go through a Page. */
export function isMeta(platform: SocialPlatform): platform is "facebook" | "instagram" {
  return platform === "facebook" || platform === "instagram";
}
