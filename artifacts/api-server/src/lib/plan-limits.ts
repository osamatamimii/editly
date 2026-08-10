/**
 * What each plan includes.
 *
 * The meter is **minutes of finished video**, not videos. Counting videos was
 * wrong in both directions: it charged the same for a nine-second hook and a
 * ninety-minute episode, and it made the interesting question — how long can I
 * upload — invisible.
 *
 * The quotas come from what people actually publish, not from a round number.
 * A short-form creator posts 2–7 times a week at 21–34 seconds, which is five
 * to twenty minutes a month; sixty is comfortable headroom, not a leash. A
 * long-form YouTuber publishes around ninety-six minutes a month. A podcaster
 * publishing twice a week at an hour is four hundred and eighty — above Pro on
 * purpose, because that person is a professional and belongs on Studio.
 *
 * Nobody upgrades to buy minutes they will never use, so the tiers are
 * separated by what is felt every day: how long a file you can upload, whether
 * you can hand us a reference video, the watermark, 4K, queue priority.
 *
 * One asymmetry worth stating, because it shapes the numbers: our cost is
 * driven by minutes **analysed**, not minutes produced. A podcast episode is
 * analysed once and keeps most of itself, so four hundred minutes of podcast
 * costs us about $3. Four hundred minutes of YouTube cut from raw multi-take
 * footage can mean thirty hours analysed and cost four times that. Same meter,
 * very different bill — which is why clipping, where the ratio is worst, is a
 * separate product on a separate meter entirely.
 */
export type PlanKey = "free" | "creator" | "pro" | "studio";

export interface PlanLimits {
  /** Minutes of finished video per calendar month. */
  minutesPerMonth: number;
  /** Longest single upload accepted, in minutes. The real tier differentiator. */
  maxUploadMinutes: number;
  pricePerMonth: number;
  /** Free renders carry a mark; it is the growth loop, not a punishment. */
  watermark: boolean;
  /** Longest edge of the export. */
  maxHeight: number;
  /** "Edit mine like this one" — the thing nobody else does. */
  referenceStyle: boolean;
  /** Claimed before older jobs when the queue is busy. */
  priorityQueue: boolean;
  seats: number;
}

export const PLAN_LIMITS: Record<PlanKey, PlanLimits> = {
  // A trial, not a home. Two short videos is enough to see the quality and
  // not enough to live in.
  free: {
    minutesPerMonth: 5,
    maxUploadMinutes: 10,
    pricePerMonth: 0,
    watermark: true,
    maxHeight: 1280,
    referenceStyle: false,
    priorityQueue: false,
    seats: 1,
  },
  // Short-form. Sixty minutes is three times what a busy creator publishes.
  creator: {
    minutesPerMonth: 60,
    maxUploadMinutes: 30,
    pricePerMonth: 12,
    watermark: false,
    maxHeight: 1920,
    referenceStyle: true,
    priorityQueue: false,
    seats: 1,
  },
  // Long-form: YouTube and podcasts. The number that sells this tier is the
  // four-hour upload — a whole episode as one file — not the minutes.
  pro: {
    minutesPerMonth: 400,
    maxUploadMinutes: 240,
    pricePerMonth: 29,
    watermark: false,
    maxHeight: 2160,
    referenceStyle: true,
    priorityQueue: true,
    seats: 1,
  },
  studio: {
    minutesPerMonth: 1000,
    maxUploadMinutes: 600,
    pricePerMonth: 79,
    watermark: false,
    maxHeight: 2160,
    referenceStyle: true,
    priorityQueue: true,
    seats: 3,
  },
};

export const DEFAULT_PLAN: PlanKey = "free";

export function isPlanKey(value: string): value is PlanKey {
  return value in PLAN_LIMITS;
}

/**
 * Old subscriptions still say "starter" and "scale". Mapping them here rather
 * than migrating the column means a row written by a version we have not
 * deployed yet still resolves to something sane instead of throwing.
 */
const RENAMED: Record<string, PlanKey> = {
  starter: "creator",
  scale: "studio",
};

export function planKeyFrom(value: string | null | undefined): PlanKey {
  if (!value) return DEFAULT_PLAN;
  if (isPlanKey(value)) return value;
  return RENAMED[value] ?? DEFAULT_PLAN;
}

/** Minutes, rounded up: a 61-second render costs two minutes, as anyone would expect. */
export function minutesFrom(seconds: number): number {
  return Math.ceil(Math.max(0, seconds) / 60);
}
