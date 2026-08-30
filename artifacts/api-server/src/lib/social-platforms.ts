/**
 * The five places an edit can go, and whether this deployment can actually
 * send it there.
 *
 * Every one of them needs an app registered with the platform, a client id and
 * secret, and — for four of the five — a review before the app may post on a
 * real person's behalf. None of that is code, all of it takes days, and the
 * code has to exist first or there is nothing to submit for review.
 *
 * So this file is the honest middle: the product knows about five platforms,
 * says out loud which ones are switched on, and never shows a "Connect
 * Instagram" button that cannot work. It is the same shape as
 * `auth-providers.ts`, for the same reason — the difference between "we could
 * not ask" and "it is off" is the difference between an evening spent
 * re-entering a correct secret and a minute spent setting one.
 */

export const PLATFORMS = ["instagram", "facebook", "tiktok", "x", "snapchat"] as const;
export type Platform = (typeof PLATFORMS)[number];

export function isPlatform(value: unknown): value is Platform {
  return typeof value === "string" && (PLATFORMS as readonly string[]).includes(value);
}

/** What a person calls it. */
export const PLATFORM_LABEL: Record<Platform, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  tiktok: "TikTok",
  x: "X",
  snapchat: "Snapchat",
};

/**
 * The environment variables each platform needs, and what a person should know
 * about posting there before they schedule anything.
 *
 * The limits are not decoration. A caption written for Instagram and sent to X
 * is refused at 281 characters, and finding that out when the post was due is
 * the failure this product exists to remove. They are enforced in
 * `lib/post-limits.ts` and shown while somebody is typing.
 */
interface PlatformSpec {
  /** Both must be present for the platform to be considered configured. */
  clientIdVar: string;
  clientSecretVar: string;
  /** Characters, caption plus hashtags. */
  captionLimit: number;
  /** Seconds. A clip longer than this is refused by the platform, not by us. */
  maxDurationSeconds: number;
  /** Portrait, landscape or either. */
  shape: "vertical" | "any";
  /**
   * Whether the platform requires review before it will post for a real
   * person. Reported so the console can say why a configured platform is
   * still not usable.
   */
  needsReview: boolean;
}

export const PLATFORM_SPEC: Record<Platform, PlatformSpec> = {
  instagram: {
    clientIdVar: "INSTAGRAM_CLIENT_ID",
    clientSecretVar: "INSTAGRAM_CLIENT_SECRET",
    captionLimit: 2200,
    maxDurationSeconds: 90 * 60,
    shape: "any",
    needsReview: true,
  },
  facebook: {
    clientIdVar: "FACEBOOK_CLIENT_ID",
    clientSecretVar: "FACEBOOK_CLIENT_SECRET",
    captionLimit: 63206,
    maxDurationSeconds: 240 * 60,
    shape: "any",
    needsReview: true,
  },
  tiktok: {
    clientIdVar: "TIKTOK_CLIENT_KEY",
    clientSecretVar: "TIKTOK_CLIENT_SECRET",
    captionLimit: 2200,
    maxDurationSeconds: 10 * 60,
    shape: "vertical",
    needsReview: true,
  },
  x: {
    clientIdVar: "X_CLIENT_ID",
    clientSecretVar: "X_CLIENT_SECRET",
    captionLimit: 280,
    maxDurationSeconds: 140,
    shape: "any",
    needsReview: false,
  },
  snapchat: {
    clientIdVar: "SNAPCHAT_CLIENT_ID",
    clientSecretVar: "SNAPCHAT_CLIENT_SECRET",
    captionLimit: 250,
    maxDurationSeconds: 180,
    shape: "vertical",
    needsReview: true,
  },
};

/**
 * Which platforms this deployment holds credentials for.
 *
 * Read at call time, never cached and never inlined. `APP_ORIGIN` was frozen
 * into a bundle by exactly the kind of build-time read that looks harmless
 * here, and a "Connect" button that is missing because a variable was set
 * after the last deploy is the same bug wearing different clothes.
 */
export function configuredPlatforms(): Record<Platform, boolean> {
  const env = process.env;
  const out = {} as Record<Platform, boolean>;
  for (const platform of PLATFORMS) {
    const spec = PLATFORM_SPEC[platform];
    out[platform] = Boolean(env[spec.clientIdVar]?.trim() && env[spec.clientSecretVar]?.trim());
  }
  return out;
}

/** Everything the browser is allowed to know about a platform. No secrets. */
export function platformCatalogue(): Array<{
  platform: Platform;
  label: string;
  connected: boolean;
  captionLimit: number;
  maxDurationSeconds: number;
  shape: "vertical" | "any";
  needsReview: boolean;
}> {
  const configured = configuredPlatforms();
  return PLATFORMS.map((platform) => ({
    platform,
    label: PLATFORM_LABEL[platform],
    connected: configured[platform],
    captionLimit: PLATFORM_SPEC[platform].captionLimit,
    maxDurationSeconds: PLATFORM_SPEC[platform].maxDurationSeconds,
    shape: PLATFORM_SPEC[platform].shape,
    needsReview: PLATFORM_SPEC[platform].needsReview,
  }));
}
