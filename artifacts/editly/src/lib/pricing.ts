/**
 * What the pricing page promises.
 *
 * Kept apart from the page that renders it, and not because the file was long.
 * These numbers are a second copy of `plan-limits.ts`, which is what the server
 * actually enforces — and a hand-maintained second copy of anything is the
 * shape of every expensive mistake this repository has made. The OpenAPI file
 * drifted into describing a different product; five migrations were written and
 * never applied. Both were caught late because nothing could compare the two
 * sides mechanically.
 *
 * Here the cost of drifting is worse than a bug. This is a page about money: if
 * the limits move and this does not, the product is advertising something it
 * will refuse to do. `tools/pricing-test.mjs` reads this module and the plan
 * limits and asserts they agree — which is only possible because it is a module.
 */
export const PLANS = [
  {
    key: "creator" as const,
    name: "Creator",
    price: 12,
    yearlyPrice: 115,
    minutes: 30,
    forWho: "Short-form: TikTok, Reels, Shorts",
    upload: "Upload up to 30 minutes",
    color: "emerald",
  },
  {
    key: "pro" as const,
    name: "Pro",
    price: 29,
    yearlyPrice: 279,
    minutes: 150,
    forWho: "Long-form: YouTube and podcasts",
    upload: "Upload a 4-hour episode as one file",
    color: "violet",
    popular: true,
  },
  {
    key: "studio" as const,
    name: "Studio",
    price: 79,
    yearlyPrice: 758,
    minutes: 800,
    forWho: "Teams and agencies",
    /*
      Three of these do not exist, and the line now says so.

      "3 seats, brand kit, API" sat here alone, at $79 a month. `seats` is a
      number nobody reads — five lines in `plan-limits.ts` and nothing else —
      and there is no invite endpoint, no team table, no brand kit and no public
      API anywhere in the repository. Sold like that it is a misrepresentation,
      and it is the first thing a consumer-protection complaint would name.

      Deleting it is not the fix either: the rule in this product is that what
      is on the page and not yet built stays, and gets built towards — and
      `pricing-test` enforces that rule by failing when a promise is removed
      rather than delivered.

      So the enforced things are said first, and the promised ones are labelled
      as promises. Ten-hour uploads, 4K and queue priority are all real in
      `PLAN_LIMITS.studio`, and the suite ties this line to them.
    */
    upload: "10-hour uploads, 4K, priority queue. Coming: 3 seats, brand kit, API",
    color: "fuchsia",
  },
] as const;

/**
 * The first line is the one that matters.
 *
 * "60 minutes a month" is read by a podcaster as "one episode" — the exact
 * opposite of the truth, and the reading most likely to lose the long-form
 * audience this pricing was built for. Every competitor meters uploaded hours
 * or credits, so people arrive with that model already loaded and apply it to
 * us by default.
 *
 * The fix is not a parenthetical. It is naming the unit ("minutes of finished
 * video") and then saying the difference out loud, where it stops being a
 * clarification and becomes the best line on the page.
 */
export const SHARED_FEATURES = [
  "Upload as much footage as you like. You only pay for what you publish",
  "No watermark",
  "Unlimited edits. Asking again is free",
  "Match the style of a video you like",
];

/**
 * What you get without paying, said out loud.
 *
 * This used to be nowhere on the page. The cards started at $12 and the free
 * tier existed only in the database, which reads to a visitor as "there is no
 * free tier" — so the one thing that costs us nothing to give away, and is the
 * only way anyone finds out whether the editing is any good, was invisible.
 *
 * The numbers are not written here twice: they come from `PLAN_LIMITS.free`,
 * and `tools/pricing-test.mjs` asserts that this text still matches them. A
 * free tier that quietly stops matching its own description is worse than not
 * advertising one.
 */
export const FREE_TIER = {
  name: "Free",
  price: 0,
  /** Kept in step with PLAN_LIMITS.free.minutesPerMonth. */
  minutes: 3,
  /** Kept in step with PLAN_LIMITS.free.maxUploadMinutes. */
  uploadMinutes: 20,
  headline: "Try it free, no card",
  lines: [
    "3 minutes of finished video a month",
    "Upload clips up to 20 minutes",
    /*
      It said "Every editing feature, so you can judge the result", and that is
      not true: `PLAN_LIMITS.free.referenceStyle` is false, and matching another
      video's style is the feature this codebase calls "the thing nobody else
      does". 4K is not on it either.

      The rule here is that a line on the page which is not built stays and
      gets built toward — and that rule is about promises. This was not a
      promise; it was a statement of present fact about what the free plan
      includes, and it was wrong. The Studio card two blocks up already settled
      this exact dilemma the same way: say the enforced things, label the
      promised ones, and never let a card assert something the server refuses.

      What the line is actually for survives intact, and it is the better
      claim anyway: this is the product, not a demonstration of it. The
      suite ties it to `PLAN_LIMITS.free` so it cannot drift back.
    */
    "The real editor, not a trial version, so you can judge the result",
    "Exports carry a small Editly mark",
  ],
} as const;

/**
 * The yearly price said per month, because that is the number people compare.
 *
 * Two things were wrong with showing the annual total as the headline figure.
 * The smaller one is comparison: every competitor quotes a monthly number, so
 * a card reading $115 next to one reading $15 loses before it is read. The
 * larger one is what the toggle *did*. Pressing "Yearly" — a control whose
 * whole purpose is to announce a discount — took $12 to $115 in the price
 * slot. The unit changed at the same moment as the number, and for the half
 * second before the eye reaches the word "year", the only thing that happened
 * on screen is that the price went up nine times. With both sides quoted per
 * month the toggle changes exactly one thing, downward, and needs no reading.
 *
 * Derived rather than written down. Three hand-maintained strings sat in this
 * file and three more in the Arabic copy, and each one was a division somebody
 * had done once by hand — the kind of second copy this file's own header says
 * is the shape of every expensive mistake here.
 *
 * Rounded **up** to the cent. Twelve times this figure must never come to less
 * than what the card is actually charged, or the page is quoting a price that
 * does not exist. Up costs us four cents a year in how it reads; down is a
 * false advertisement.
 */
export function yearlyPerMonth(yearlyPrice: number): string {
  return (Math.ceil((yearlyPrice / 12) * 100) / 100).toFixed(2);
}
