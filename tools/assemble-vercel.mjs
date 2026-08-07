/**
 * Copies the built frontend (artifacts/editly/dist/public) into <repo root>/dist,
 * which is the Vercel outputDirectory. Run after the frontend build.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rm, cp } from "node:fs/promises";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(repoRoot, "artifacts/editly/dist/public");
const dest = path.join(repoRoot, "dist");

await rm(dest, { recursive: true, force: true });
await cp(src, dest, { recursive: true });

console.log("Static site assembled at", dest);
