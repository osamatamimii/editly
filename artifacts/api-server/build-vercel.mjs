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

if (process.env.DATABASE_URL) {
  // Inline the connection string so the function is fully self-contained.
  define["process.env.DATABASE_URL"] = JSON.stringify(process.env.DATABASE_URL);
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
