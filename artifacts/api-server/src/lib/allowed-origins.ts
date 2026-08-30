/**
 * Which browser origins may call this API.
 *
 * Its own module, for the reason `body-parsers.ts` is: it is a decision, and a
 * decision that lives inside `app.ts` can only be tested by standing up Express
 * — which in practice meant it was not tested at all. It had two bugs when it
 * was finally looked at.
 *
 * The API is only ever called by our own front end, so a wildcard would hand
 * any site the ability to make authenticated calls on a visitor's behalf.
 * Vercel gives every deployment a unique preview hostname, so those are matched
 * by pattern rather than listed.
 */

const CONSTANT_ORIGINS = new Set([
  "http://localhost:5173",
  "http://localhost:3000",
  // The waiting-list page. A different domain and a different deployment, so
  // it has to be named here or the browser refuses the one call it makes.
  // Listing it costs nothing extra: what an origin is allowed to *do* is
  // decided by the bearer token, and the waiting-list page has none — the
  // single route it can reach is the single route that needs none.
  "https://editlyai.io",
  "https://www.editlyai.io",
  // The app's own domain, named rather than left to `APP_ORIGIN`.
  //
  // Not redundancy for its own sake. The origin used to be baked into the
  // bundle at build time, so it could not go missing; reading it at runtime is
  // the right fix and it introduces exactly one new way to fail — an
  // environment variable nobody set. The cost of that failure is every browser
  // POST from the live app refused, which is the whole product. This domain is
  // ours and will not change without this file changing, so it belongs in the
  // list beside the waiting page rather than in a variable somebody has to
  // remember. `APP_ORIGIN` keeps working for everything else.
  "https://app.editlyai.io",
]);

const VERCEL_PREVIEW = /^https:\/\/editly-[a-z0-9-]+\.vercel\.app$/;

/**
 * `APP_ORIGIN` is read **per call**, not once at import.
 *
 * That is not fussiness. `build-vercel.mjs` used to hand esbuild a `define` for
 * it, and esbuild substitutes `process.env["APP_ORIGIN"]` as well as the dotted
 * form — so whatever origin sat in the build machine's `.env.production.local`
 * was frozen into the bundle as a string literal, and the value on the hosting
 * dashboard had no read left to answer. That file still said
 * `editly-eta.vercel.app` months after the app moved to `app.editlyai.io`.
 *
 * Reading it here, through a variable a bundler cannot fold, means the
 * allowlist can never be older than the process.
 */
export function isAllowedOrigin(origin: string): boolean {
  if (CONSTANT_ORIGINS.has(origin)) return true;

  const env = process.env;
  const configured = env["APP_ORIGIN"];
  if (configured && origin === configured) return true;

  return VERCEL_PREVIEW.test(origin);
}
