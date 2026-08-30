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
    yearlyPerMonth: "$9.6/month billed yearly",
    minutes: 60,
    forWho: "Short-form: TikTok, Reels, Shorts",
    upload: "Upload up to 30 minutes",
    color: "emerald",
  },
  {
    key: "pro" as const,
    name: "Pro",
    price: 29,
    yearlyPrice: 279,
    yearlyPerMonth: "$23.25/month billed yearly",
    minutes: 400,
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
    yearlyPerMonth: "$63.2/month billed yearly",
    minutes: 1000,
    forWho: "Teams and agencies",
    upload: "3 seats, brand kit, API",
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
  minutes: 5,
  /** Kept in step with PLAN_LIMITS.free.maxUploadMinutes. */
  uploadMinutes: 10,
  headline: "Try it free, no card",
  lines: [
    "5 minutes of finished video a month",
    "Upload clips up to 10 minutes",
    "Every editing feature, so you can judge the result",
    "Exports carry a small Editly mark",
  ],
} as const;
