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
  //
  // playwright-core is external for a different reason: it is not a library so
  // much as a launcher, full of dynamic requires and files it expects to find
  // beside itself. Bundling it produces something that builds cleanly and
  // cannot start a browser. The runtime image installs it as a real package.
  external: ["pg-native", "playwright-core"],
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

// The font repair is Python for the same reason — fontTools is Python — and it
// is copied for a second reason too: this is the *only* copy of it that ships.
// `make-caption-faces.py` runs on a developer's machine and builds the
// thirteen faces we ship; these two run in the image, over a file somebody
// uploaded, and they import each other. A missing one here does not break the
// build or any render: uploaded fonts would simply never leave `pending`.
for (const name of ["facerepair.py", "prepare-user-font.py"]) {
  await copyFile(path.join(dir, "fonts", name), path.join(dir, "dist", name));
}
