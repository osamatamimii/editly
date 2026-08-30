/**
 * Will this actually post?
 *
 * Every platform refuses things, and each refuses different things: X stops at
 * 280 characters and 140 seconds, TikTok wants vertical and stops at ten
 * minutes, Snapchat stops at 250 characters. A person writing one caption for
 * four places cannot hold four sets of rules in their head, and the moment
 * they find out they were wrong is the moment the post was due — which is the
 * exact failure this feature exists to remove.
 *
 * So the rules live here, they are checked while somebody is typing, and they
 * are checked again before anything is queued. Both, on purpose: the first is
 * so nobody writes 400 characters for X, and the second is because a browser
 * check is a courtesy and not a control.
 *
 * The refusals are worded for the person, not for a log. "Too long" is a fact;
 * "X stops at 280 characters and this is 314" is the thing they can act on.
 */
import { PLATFORM_LABEL, PLATFORM_SPEC, type Platform } from "./social-platforms";

export interface PostRefusal {
  /** What is wrong, said to the person. */
  message: string;
  /** Which rule, so the UI can point at the field rather than the form. */
  field: "caption" | "duration" | "shape";
}

export interface PostCandidate {
  platform: Platform;
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
  const spec = PLATFORM_SPEC[candidate.platform];
  const name = PLATFORM_LABEL[candidate.platform];
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
