/**
 * The six places an edit can go, what each of them refuses, and whether this
 * deployment can actually send it there.
 *
 * Shared, and that is the point. Three processes have to agree about X's 280
 * characters: the browser, which greys out the schedule button; the API, which
 * refuses the request; and the worker, which is holding the file at 9pm. Three
 * copies of one number is two chances for a post to be accepted by the screen,
 * accepted by the server, and refused by the platform — with nobody watching.
 *
 * Every one of them needs an app registered with the platform, a client id and
 * secret, and — for four of the five — a review before the app may post on a
 * real person's behalf. None of that is code, all of it takes days, and the
 * code has to exist first or there is nothing to submit for review. So this
 * file is the honest middle: the product knows about six platforms, says out
 * loud which are switched on, and never shows a "Connect Instagram" button
 * that cannot work.
 *
 * ## `SocialPlatform`, not `Platform`
 *
 * `Platform` in this package already means the shape a frame is rendered for —
 * tiktok, reels, shorts, youtube, square. These are *destinations*, and the two
 * overlap in name and in nothing else: "tiktok" the safe-area profile and
 * "tiktok" the account you post to are different facts about different things.
 * One of them being silently assignable to the other is a bug waiting for a
 * refactor to find it.
 */

export const SOCIAL_PLATFORMS = ["instagram", "facebook", "tiktok", "x", "snapchat", "youtube"] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export function isSocialPlatform(value: unknown): value is SocialPlatform {
  return typeof value === "string" && (SOCIAL_PLATFORMS as readonly string[]).includes(value);
}

/** What a person calls it. */
export const SOCIAL_LABEL: Record<SocialPlatform, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  tiktok: "TikTok",
  x: "X",
  snapchat: "Snapchat",
  youtube: "YouTube",
};

/**
 * The environment variables each platform needs, and what a person should know
 * about posting there before they schedule anything.
 *
 * The limits are not decoration. A caption written for Instagram and sent to X
 * is refused at 281 characters, and finding that out when the post was due is
 * the failure this product exists to remove. They are enforced in
 * `refusalsFor` below and shown while somebody is typing.
 */
export interface SocialPlatformSpec {
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

/**
 * Where Meta trades one token for a longer-lived one.
 *
 * Here rather than in either of the two files that call it, because both do:
 * the API server makes the trade when somebody connects, and the worker makes
 * the *same* trade to extend the token before it runs out. Meta issues no
 * refresh token, so extension is this exchange again, and two copies of one URL
 * in two packages is two things to edit the day Meta moves it and one of them
 * to forget.
 *
 * A GET with the secrets in the query string, which is Meta's design and not a
 * choice available here.
 */
export function metaExchangeUrl(options: {
  clientId: string;
  clientSecret: string;
  token: string;
  graph?: string;
}): string {
  const graph = options.graph ?? "https://graph.facebook.com/v21.0";
  return (
    `${graph}/oauth/access_token?grant_type=fb_exchange_token` +
    `&client_id=${encodeURIComponent(options.clientId)}` +
    `&client_secret=${encodeURIComponent(options.clientSecret)}` +
    `&fb_exchange_token=${encodeURIComponent(options.token)}`
  );
}

export const SOCIAL_SPEC: Record<SocialPlatform, SocialPlatformSpec> = {
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
  youtube: {
    clientIdVar: "YOUTUBE_CLIENT_ID",
    clientSecretVar: "YOUTUBE_CLIENT_SECRET",
    /*
      The one destination that is two destinations, and the numbers are the
      wider of the two on purpose.

      A YouTube upload is a Short when it is vertical and under three minutes,
      and an ordinary video otherwise — the platform decides, from the file,
      with no flag to set. So `shape` is "any" and the ceiling is YouTube's own
      twelve hours: a limit that refused a widescreen upload because Shorts are
      short would be this product inventing a rule the platform does not have,
      which is the one thing these numbers exist not to do.

      The caption limit is the *description*, 5000 characters, and the title is
      a separate 100 that nothing here writes yet. Worth knowing before that is
      built: a description trimmed to 5000 is fine and a title trimmed to 100
      is a title cut in half.
    */
    captionLimit: 5000,
    maxDurationSeconds: 12 * 60 * 60,
    shape: "any",
    /*
      Uploading to somebody's own channel needs `youtube.upload`, which Google
      treats as a sensitive scope: an app may do it for up to a hundred test
      users unverified, and needs a verification review to do it for the
      public. Same shape as the other four, so it is reported the same way.
    */
    needsReview: true,
  },
};

/**
 * Which platforms this deployment holds credentials for.
 *
 * The environment is passed in rather than read from `process`, and that is
 * three things at once. It keeps this module usable from a browser bundle,
 * where `process` does not exist. It makes the function testable without
 * mutating global state, which the posting suite used to have to do. And it
 * keeps the read at *call* time in every caller — `APP_ORIGIN` was frozen into
 * a bundle by exactly the kind of module-scope read that looks harmless here,
 * and a "Connect" button missing because a variable was set after the last
 * deploy is the same bug wearing different clothes.
 */
export function configuredPlatforms(
  env: Record<string, string | undefined>,
): Record<SocialPlatform, boolean> {
  const out = {} as Record<SocialPlatform, boolean>;
  for (const platform of SOCIAL_PLATFORMS) {
    const spec = SOCIAL_SPEC[platform];
    out[platform] = Boolean(env[spec.clientIdVar]?.trim() && env[spec.clientSecretVar]?.trim());
  }
  return out;
}

/** Everything the browser is allowed to know about a platform. No secrets. */
export function platformCatalogue(env: Record<string, string | undefined>): Array<{
  platform: SocialPlatform;
  label: string;
  connected: boolean;
  captionLimit: number;
  maxDurationSeconds: number;
  shape: "vertical" | "any";
  needsReview: boolean;
}> {
  const configured = configuredPlatforms(env);
  return SOCIAL_PLATFORMS.map((platform) => ({
    platform,
    label: SOCIAL_LABEL[platform],
    connected: configured[platform],
    captionLimit: SOCIAL_SPEC[platform].captionLimit,
    maxDurationSeconds: SOCIAL_SPEC[platform].maxDurationSeconds,
    shape: SOCIAL_SPEC[platform].shape,
    needsReview: SOCIAL_SPEC[platform].needsReview,
  }));
}


export interface PostRefusal {
  /** What is wrong, said to the person. */
  message: string;
  /** Which rule, so the UI can point at the field rather than the form. */
  field: "caption" | "duration" | "shape";
}

export interface PostCandidate {
  platform: SocialPlatform;
  caption: string;
  hashtags: string[];
  /** Seconds of finished video, or null when it is not known yet. */
  durationSeconds: number | null;
  /** null when the render has not reported its shape. */
  width: number | null;
  height: number | null;
}

/**
 * What a platform counts.
 *
 * Hashtags are stored apart from the caption so they can be edited as a set,
 * but every platform counts them against the same limit as the words — so the
 * check has to add them back, including the spaces between them. Counting only
 * the caption is how a post that looked like 240 characters is refused at 310.
 */
export function captionLength(caption: string, hashtags: string[]): number {
  const tags = hashtags.filter((tag) => tag.trim().length > 0);
  if (tags.length === 0) return caption.length;
  return caption.length + 1 + tags.map((t) => (t.startsWith("#") ? t : `#${t}`)).join(" ").length;
}

/** Every reason this will not post, or an empty list. */
export function refusalsFor(candidate: PostCandidate): PostRefusal[] {
  const spec = SOCIAL_SPEC[candidate.platform];
  const name = SOCIAL_LABEL[candidate.platform];
  const refusals: PostRefusal[] = [];

  const length = captionLength(candidate.caption, candidate.hashtags);
  if (length > spec.captionLimit) {
    refusals.push({
      field: "caption",
      message: `${name} stops at ${spec.captionLimit} characters and this is ${length}${
        candidate.hashtags.length > 0 ? " with the hashtags" : ""
      }.`,
    });
  }

  // A duration we do not know is not a duration that is too long. Refusing on
  // an unknown is how a correct post gets blocked by a missing field.
  if (candidate.durationSeconds !== null && candidate.durationSeconds > spec.maxDurationSeconds) {
    // The limit is formatted the same way the length is, and that is not
    // tidiness. Rounding it to minutes said "X stops at 2 minutes" for a limit
    // of 140 seconds — so somebody cuts to 2:00 they did not need to, or
    // believes 2:10 is fine because they were told the limit was two minutes.
    // A number in a refusal is the number somebody will edit against.
    refusals.push({
      field: "duration",
      message: `${name} stops at ${formatDuration(spec.maxDurationSeconds)} and this edit is ${formatDuration(candidate.durationSeconds)}.`,
    });
  }

  if (
    spec.shape === "vertical" &&
    candidate.width !== null &&
    candidate.height !== null &&
    candidate.width >= candidate.height
  ) {
    refusals.push({
      field: "shape",
      message: `${name} only takes vertical video, and this edit is ${candidate.width}x${candidate.height}. Ask for it vertical and render again.`,
    });
  }

  return refusals;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} seconds`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return rest === 0 ? `${minutes} minutes` : `${minutes}m ${rest}s`;
}

/**
 * How far in the future a post may be scheduled.
 *
 * A floor as well as a ceiling. The publisher polls, so "in ten seconds" is a
 * promise about somebody else's clock that this product cannot keep — and a
 * post that goes out four minutes late is worse than one somebody was told
 * would go out in five minutes.
 */
export const MIN_LEAD_SECONDS = 60;
export const MAX_LEAD_DAYS = 90;

export function scheduleRefusal(when: Date, now = new Date()): string | null {
  if (Number.isNaN(when.getTime())) return "That is not a time.";
  const ahead = (when.getTime() - now.getTime()) / 1000;
  if (ahead < MIN_LEAD_SECONDS) {
    return "Pick a time at least a minute from now, so there is time to send it.";
  }
  if (ahead > MAX_LEAD_DAYS * 24 * 60 * 60) {
    return `Pick a time within the next ${MAX_LEAD_DAYS} days.`;
  }
  return null;
}
