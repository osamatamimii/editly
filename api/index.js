// Vercel serverless function entrypoint.
// `_bundle.js` is generated at build time by `artifacts/api-server/build-vercel.mjs`
// (run via `pnpm run vercel:build`) and contains the entire bundled Express app.
const bundle = require("./_bundle.js");

module.exports = bundle.default || bundle;
