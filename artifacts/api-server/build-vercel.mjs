/**
 * Bundles the API server into a single self-contained serverless bundle
 * for Vercel at <repo root>/api/_bundle.js (required by the committed
 * function stub <repo root>/api/index.js).
 *
 * Usage: node build-vercel.mjs
 * Env:   DATABASE_URL (optional) — when set, it is inlined into the bundle
 *        so the deployed function works without Vercel env vars. Prefer
 *        setting DATABASE_URL in the Vercel dashboard when possible.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import { rm, mkdir } from "node:fs/promises";

const artifactDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(artifactDir, "../..");
const outDir = path.resolve(repoRoot, "api");

// Load DATABASE_URL from .env.production.local at the repo root if present.
try {
  const { readFileSync } = await import("node:fs");
  const env = readFileSync(path.join(repoRoot, ".env.production.local"), "utf8");
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {
  // no .env.production.local — rely on process env
}

// Note: do NOT wipe outDir — it contains the committed function stub api/index.js.
await rm(path.join(outDir, "_bundle.js"), { force: true });
await mkdir(outDir, { recursive: true });

const define = {
  "process.env.NODE_ENV": '"production"',
};

// Inline configuration that is known at build time so the function is fully
// self-contained. Anything absent here still resolves from the runtime
// environment, which is how Vercel supplies it in production.
//
// APP_ORIGIN is deliberately NOT in this list, and the reason is worth keeping.
// It was, and the sentence above was true of it in exactly the wrong way: it
// was never absent, because the loader a few lines up reads it out of the
// build machine's `.env.production.local`. So every locally built bundle froze
// that file's origin into the CORS allowlist as a string literal — esbuild
// substitutes `process.env["APP_ORIGIN"]` as well as the dotted form — and the
// value set on the hosting dashboard could not override it, because there was
// no read left for it to answer. The file still said `editly-eta.vercel.app`
// months after the app moved to app.editlyai.io.
//
// An allowlist is a runtime decision. It stays a runtime decision.
//
// And `DATABASE_URL` is not in the list either, now, for a sharper version of
// the same argument. Baking it in froze a live Postgres password into
// `api/_bundle.js` as a string literal — so the credential could not be rotated
// by changing a value on the dashboard, and a build artifact on any machine
// that had ever run `vercel:build` locally carried it. It is read at runtime
// like every other secret, which is what the header of this file recommends.
for (const key of ["SUPABASE_URL"]) {
  if (process.env[key]) {
    define[`process.env.${key}`] = JSON.stringify(process.env[key]);
  }
}

await esbuild({
  entryPoints: [path.resolve(artifactDir, "src/serverless.ts")],
  platform: "node",
  target: "node20",
  bundle: true,
  format: "cjs",
  outfile: path.join(outDir, "_bundle.js"),
  logLevel: "info",
  define,
  external: ["pg-native", "*.node"],
});

console.log("Serverless bundle written to", path.join(outDir, "_bundle.js"));
