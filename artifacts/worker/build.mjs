import path from "node:path";
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
