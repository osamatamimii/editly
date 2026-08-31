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
import type { SocialPlatform } from "@workspace/api-zod";

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
