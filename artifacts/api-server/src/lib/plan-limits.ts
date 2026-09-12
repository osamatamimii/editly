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
  /**
   * Largest single upload accepted, in bytes.
   *
   * Derived from `maxUploadMinutes` rather than typed in, and that is the whole
   * point of it existing. A plan that promises four hours and refuses at two
   * gigabytes is two promises that disagree, and the one a person meets is
   * whichever they hit first — with a sentence naming the other. Derivation
   * means the pair cannot drift: change the minutes and the bytes follow.
   */
  maxUploadBytes: number;
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
  /**
   * Minutes of *source* a month, and it is deliberately invisible.
   *
   * The page sells minutes of finished video and that is the right unit to
   * sell: it is the one thing a person can count, and it is what they came
   * here to make. It is not what this costs us. Nearly all of the bill is
   * analysis — transcription and reading the picture — and analysis is paid
   * per minute of what was *uploaded*, whatever fraction of it survives the
   * edit.
   *
   * Those two units agree while the output is most of the source, and they
   * come apart completely when it is not: a two-hour podcast run through "The
   * highlight" bills half a minute and costs about $1.92 of reading. One
   * person doing that on repeat is not a customer we priced for.
   *
   * So this is a fair-use line rather than a second meter. It is not returned
   * by the subscription route, not drawn anywhere, and set high enough that
   * reaching it means uploading ten hours to publish five minutes — which is
   * not a use of this product, it is an inventory of one. Everybody else will
   * live their whole subscription without discovering that it exists.
   */
  sourceMinutesPerMonth: number;
}

/**
 * The bitrate a plan's byte ceiling is computed at: 8 Mbps, one megabyte a
 * second.
 *
 * Chosen as the ceiling of what people actually hand us rather than the
 * average. A phone recording 1080p30 lands near 6–10 Mbps; a screen recording
 * is far below it; a camera original can be far above, and somebody uploading a
 * 100 Mbps intra-frame master is doing something this product cannot afford to
 * accept at any tier — they are refused at the byte ceiling with the number
 * named, which is the honest answer.
 *
 * Stated as one constant because the alternative is four hand-typed numbers
 * that each say something slightly different about what a minute of video
 * weighs.
 */
export const UPLOAD_BYTES_PER_SECOND = 1024 * 1024;

/** A plan's byte ceiling from its minute ceiling. See `UPLOAD_BYTES_PER_SECOND`. */
export function uploadBytesFor(maxUploadMinutes: number): number {
  return maxUploadMinutes * 60 * UPLOAD_BYTES_PER_SECOND;
}

export const PLAN_LIMITS: Record<PlanKey, PlanLimits> = {
  // A trial, not a home. Two short videos is enough to see the quality and
  // not enough to live in.
  free: {
    /*
     * Three, down from five, and the reason is that five was a home.
     *
     * "A trial, not a home" is what the line above has always said. The
     * numbers said otherwise: five minutes is ten thirty-second shorts, and
     * the creator this plan is meant to convert publishes 2.15 times a week
     * under 2,000 followers — 9.3 posts a month, about **4.65 minutes**. The
     * free plan covered the median small creator entirely, forever, and no
     * amount of copy fixes a ceiling nobody reaches.
     */
    minutesPerMonth: 3,
    /*
     * And twenty, *up* from ten, which is the opposite move for the opposite
     * reason.
     *
     * Two of the three paid plans are sold to long-form — Pro is "a 4-hour
     * episode as one file" and Studio is podcast operations — and the trial
     * that is supposed to convert them capped uploads at ten minutes. A
     * podcaster could not put a real segment through this product before
     * paying for it. Twenty is enough to watch it cut a real piece of an
     * episode, and still under Creator's thirty so it takes nothing from the
     * plan above it.
     */
    maxUploadMinutes: 20,
    maxUploadBytes: uploadBytesFor(20),
    pricePerMonth: 0,
    watermark: true,
    maxHeight: 1280,
    referenceStyle: false,
    priorityQueue: false,
    seats: 1,
    /** Two twenty-minute uploads, or six five-minute ones. Enough to watch it work on real footage. */
    sourceMinutesPerMonth: 30,
  },
  /*
   * Short-form, and thirty is measured against the person rather than against
   * the plan above it.
   *
   * A busy short-form creator publishes 7 times a week at 21–34 seconds:
   * about **16 minutes a month**. Sixty was nearly four times that — a ceiling
   * nobody could see, which is a ceiling that sells no upgrade and costs us
   * the difference on the ones who do reach it.
   *
   * Thirty rather than twenty because until the browser player lands, every
   * comparison a person exports is billed: two versions of each of seven
   * weekly posts is 32 minutes, and the person we most want happy would hit
   * the wall. After the player, iteration is a free preview and one export at
   * the end — and thirty stops being *enough* and becomes *roomy*.
   */
  creator: {
    minutesPerMonth: 30,
    maxUploadMinutes: 30,
    maxUploadBytes: uploadBytesFor(30),
    pricePerMonth: 12,
    watermark: false,
    maxHeight: 1920,
    referenceStyle: true,
    priorityQueue: false,
    seats: 1,
    /** Three hours in for thirty minutes out — six times what a short-form creator actually shoots. */
    sourceMinutesPerMonth: 180,
  },
  // Long-form: YouTube and podcasts. The number that sells this tier is the
  // four-hour upload — a whole episode as one file — not the minutes.
  pro: {
    /*
     * A hundred and fifty, down from four hundred.
     *
     * One long video a week at twelve minutes plus twenty shorts is 58
     * minutes; two a week is about 110. Four hundred was not generosity, it
     * was the one number in this file with no working behind it — the plan
     * approved in August said 200 — and at our cost per source minute it put
     * this tier's margin at full consumption at **44%**, the worst of the
     * four by a distance. At 150 it is 79% and the price did not move.
     */
    minutesPerMonth: 150,
    maxUploadMinutes: 240,
    maxUploadBytes: uploadBytesFor(240),
    pricePerMonth: 29,
    watermark: false,
    maxHeight: 2160,
    referenceStyle: true,
    priorityQueue: true,
    seats: 1,
    /** Twenty hours: five four-hour episodes, or a long video a week with all its raw. */
    sourceMinutesPerMonth: 1200,
  },
  /*
   * Podcast operations: hours in, hours out.
   *
   * Eight hundred, and this one is set by the *ladder* rather than by the
   * segment. Each step up should roughly halve the price of a minute, and it
   * did not: Creator $0.400, Pro $0.193 — a 52% improvement — and Studio at
   * 600 minutes would be $0.132, only 32%. The most expensive tier was the
   * weakest value on the page, which any customer with a calculator finds.
   * 800 puts it at $0.099 and the step back to a clean −49%.
   *
   * It is also the cheapest place in this file to be generous. A Studio
   * output minute costs us about **half** what a Creator one does — a podcast
   * is three hours of source for two hours of episode where a short is three
   * minutes of source for one — so the minutes that make this tier obviously
   * worth its price are the ones we pay least for.
   */
  studio: {
    minutesPerMonth: 800,
    maxUploadMinutes: 600,
    maxUploadBytes: uploadBytesFor(600),
    pricePerMonth: 79,
    watermark: false,
    maxHeight: 2160,
    referenceStyle: true,
    priorityQueue: true,
    seats: 3,
    /** Sixty hours. Fifteen four-hour recordings a month, which is a full-time podcast operation. */
    sourceMinutesPerMonth: 3600,
  },
};

export const DEFAULT_PLAN: PlanKey = "free";

/**
 * The reference a render on this plan may actually apply.
 *
 * Matching another video's look is a paid feature, and the project remembers
 * the reference file across a downgrade — so a person who set one while paying
 * and then dropped to free kept getting the paid edit on every render, because
 * the only gate was on *setting* the reference, not on using it. This is that
 * gate on the render side: a plan without `referenceStyle` gets no reference,
 * whatever the project still holds. Both render doors read it, so the
 * entitlement lives in one place rather than being re-derived per route.
 */
export function referenceForPlan(plan: PlanKey, referencePath: string | null | undefined): string | null {
  return PLAN_LIMITS[plan].referenceStyle ? (referencePath ?? null) : null;
}

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

/** As much of a subscription row as deciding the plan requires. */
export interface PlanBearingRow {
  plan?: string | null;
  planExpiresAt?: Date | string | null;
}

/**
 * The plan this account is actually on right now.
 *
 * `planKeyFrom` answers what the column says; this answers whether it is still
 * true. They differ for exactly one kind of row — a plan that was given rather
 * than bought, carrying the date it runs out — and on that row the difference
 * is a free account being served a paid plan forever.
 *
 * The date is checked here, once, rather than at each of the nine places that
 * read a subscription: the upload door, the render door, the export door, the
 * clip door, the reference-style gate, the meter, the watermark, the page that
 * says what you are on, and the console. A rule that eight of nine sites apply
 * is not a rule. `tools/promo-test.mjs` fails the build if a site goes back to
 * asking the column directly.
 *
 * A lapsed grant is not written back to the row here, because reads must not
 * write — `GET /subscription` does that, the first time the person looks.
 * Until then every door already answers free, which is the part that matters.
 */
export function servedPlan(row: PlanBearingRow | null | undefined, now: Date = new Date()): PlanKey {
  const key = planKeyFrom(row?.plan);
  if (key === DEFAULT_PLAN) return key;
  const until = row?.planExpiresAt;
  if (!until) return key;
  const at = until instanceof Date ? until : new Date(until);
  // An unparseable date is not a reason to take somebody's plan away.
  if (Number.isNaN(at.getTime())) return key;
  return at.getTime() <= now.getTime() ? DEFAULT_PLAN : key;
}

/** Minutes, rounded up: a 61-second render costs two minutes, as anyone would expect. */
export function minutesFrom(seconds: number): number {
  return Math.ceil(Math.max(0, seconds) / 60);
}

/**
 * The sentence a user sees when they run out.
 *
 * It lives here, beside the numbers it quotes, rather than next to the query
 * that counts them — this module imports nothing, so the policy layer and its
 * tests can reach the wording without dragging a database driver along.
 *
 * It names the number, the plan and the way out, because "limit reached" on its
 * own is a dead end. And it repeats the meter, because running out is exactly
 * the moment someone decides whether the meter was fair.
 */
export function exhaustedMessage(plan: PlanKey, minutesIncluded: number, minutesUsed = minutesIncluded): string {
  // "Uploading is unlimited" was here, and it stopped being true the day a plan
  // grew a byte ceiling. It was never quite the claim it sounded like — it
  // meant uploading does not spend the meter — and the day one promise in this
  // product contradicts another is the day somebody reads both and believes the
  // wrong one. Said as what it actually means instead.
  const meter = "Uploading doesn't spend it; only the exported minutes count.";

  // "You've used all 60 minutes" is a true sentence about somebody who used
  // sixty. It is a false one about somebody who used two hundred on Pro and
  // then pressed "Switch to Creator" on the twentieth — and that person is
  // refused for the rest of the month by a sentence whose arithmetic they can
  // check and find wrong. Downgrading mid-month does not refund the meter and
  // was never going to; saying the real number is the least it can do.
  if (minutesUsed > minutesIncluded) {
    return `You've rendered ${minutesUsed} minutes this month and the ${plan} plan includes ${minutesIncluded}. ${meter} Your allowance resets on the 1st.`;
  }

  return `You've used all ${minutesIncluded} minutes of finished video on the ${plan} plan this month. ${meter} Upgrade for more, or your allowance resets on the 1st.`;
}

/**
 * The same wall, reached by work that has not been charged for yet.
 *
 * `exhausted` used to mean one thing — finished video — and now means finished
 * video plus renders already accepted. Those want different sentences: being
 * told "you've used all 5 minutes" while the meter on the same screen reads
 * zero is the kind of contradiction that makes a person stop believing both
 * numbers. This one names what is actually holding the allowance, and says the
 * thing that matters about it, which is that it clears by itself.
 */
export function inFlightMessage(plan: PlanKey, minutesIncluded: number, minutesInFlight: number): string {
  return `Renders already going account for ${minutesInFlight} of your ${minutesIncluded} minutes on the ${plan} plan this month. Nothing is lost. Start this one when they finish, or upgrade for more.`;
}

/**
 * The ceiling that actually applies to one upload, and which promise set it.
 *
 * Two numbers meet here and they are not the same kind of thing. One is what
 * the plan was sold as; the other is what the bucket will physically accept,
 * which on the free Supabase plan is 50 MB — a minute of what this renderer
 * encodes, against a pricing page that sells four-hour episodes.
 *
 * Which one binds decides what the refusal may offer. If the plan is the
 * smaller, "the Pro plan takes four hours in one file" is a true and useful
 * sentence. If storage is the smaller, that same sentence sells somebody an
 * upgrade that will refuse their file at exactly the same size — and this
 * codebase has already shipped one screen that promised 512 MB against a bucket
 * that stopped at 50.
 *
 * Ties go to storage, deliberately: when the two are equal, upgrading does not
 * help, so the refusal must not imply that it would.
 */
export function uploadCeiling(
  plan: PlanKey,
  storageBytes: number,
): { bytes: number; bound: "plan" | "storage" } {
  const planBytes = PLAN_LIMITS[plan].maxUploadBytes;
  return planBytes < storageBytes
    ? { bytes: planBytes, bound: "plan" }
    : { bytes: storageBytes, bound: "storage" };
}

/**
 * The cheapest plan that would take a file this size, or null if none would.
 *
 * The byte twin of `smallestPlanFor` in `render-policy.ts`, and kept beside the
 * numbers rather than there because this module imports nothing — the refusal
 * that quotes it is built where there is no database.
 */
export function smallestPlanForBytes(bytes: number): PlanKey | null {
  const order: PlanKey[] = ["free", "creator", "pro", "studio"];
  return order.find((key) => PLAN_LIMITS[key].maxUploadBytes >= bytes) ?? null;
}
