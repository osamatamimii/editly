import path from "node:path";
import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const dir = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [path.join(dir, "src/index.ts")],
  platform: "node",
  target: "node22",
  bundle: true,
  format: "esm",
  outfile: path.join(dir, "dist/index.mjs"),
  sourcemap: true,
  logLevel: "info",
  // pg loads this optionally and it is not present in the image.
  external: ["pg-native"],
  banner: {
    // pg and pino reach for CommonJS globals from inside an ESM bundle.
    js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
  },
});

// The subject tracker is Python, so esbuild cannot bundle it — it is copied
// beside the bundle, which is where `subject.ts` resolves it from. Forgetting
// this would not break the build or the render: tracking would simply stop
// happening and every clip would quietly go back to the old static framing.
await mkdir(path.join(dir, "dist"), { recursive: true });
await copyFile(
  path.join(dir, "scripts/track-subject.py"),
  path.join(dir, "dist/track-subject.py"),
);
