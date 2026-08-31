/**
 * Every content type this product sends is one the bucket will take.
 *
 * The bug this exists for shipped and sat there. A Supabase bucket carries an
 * `allowed_mime_types` list and refuses anything else with a 400 — and the
 * bucket allowed four types while the upload code accepted `video/*`,
 * `image/*` and `audio/*` and forwarded whatever the browser called the file.
 *
 * So on the live product a PNG logo was refused, an MP3 bed was refused, and
 * `addMusic` and `overlayImage` — both built, both covered by suites that
 * render real frames — could not be handed a file at all. Nothing failed
 * anywhere we could see: the browser got a 400 from Storage, the API was never
 * called, and no log in this system recorded it.
 *
 * Two halves are checkable from here and one is not:
 *
 *   - Every literal content type in the upload code is on the shared list.
 *     This is the direction drift actually goes — somebody adds an upload,
 *     picks a sensible type, and never thinks about a bucket.
 *   - The table that maps a filename to a type only ever produces members of
 *     that list, and covers what people actually upload.
 *   - Whether the *bucket* matches is infrastructure and cannot be asserted
 *     from a test. It is written where somebody changing the list will read
 *     it, and that is the honest limit of this file.
 *
 * Usage: node tools/upload-types-test.mjs
 * Requires: nothing.
 */
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-uploadtypes-"));
const outfile = path.join(buildDir, "limits.mjs");
const built = spawnSync(
  require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] }),
  [
    path.join(repoRoot, "lib/api-zod/src/limits.ts"),
    "--bundle", "--platform=node", "--format=esm", "--target=node22",
    `--outfile=${outfile}`, "--log-level=error",
  ],
  { stdio: "inherit" },
);
if (built.status !== 0) process.exit(1);
const { UPLOAD_CONTENT_TYPES, uploadContentTypeFor, uploadKindFor } = await import(
  pathToFileURL(outfile).href
);

let checks = 0;
let failures = 0;
const check = (name, ok, detail = "") => {
  checks += 1;
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};
const section = (t) => console.log(`\n${t}`);

const allowed = new Set(UPLOAD_CONTENT_TYPES);

section("The list is a list, and every entry is a real media type");
check("there are types on it", UPLOAD_CONTENT_TYPES.length >= 8, String(UPLOAD_CONTENT_TYPES.length));
check(
  "every one is `type/subtype` with no parameters",
  // A `; charset=` on a content type is a string the bucket compares literally
  // and does not match.
  UPLOAD_CONTENT_TYPES.every((t) => /^[a-z]+\/[a-z0-9.+-]+$/.test(t)),
  UPLOAD_CONTENT_TYPES.filter((t) => !/^[a-z]+\/[a-z0-9.+-]+$/.test(t)).join(", "),
);
check("and none is repeated", allowed.size === UPLOAD_CONTENT_TYPES.length);
check(
  "and there is no wildcard",
  // A bucket that admits anything is a place to keep anything, and this one
  // holds one person's private files behind signed URLs.
  !UPLOAD_CONTENT_TYPES.some((t) => t.includes("*")),
);

section("The filename table only ever produces a type on the list");
{
  const names = [
    "take.mp4", "TAKE.MOV", "clip.webm", "raw.mkv",
    "logo.png", "shot.JPEG", "frame.jpg", "sticker.webp",
    "theme.mp3", "bed.m4a", "voice.wav", "loop.ogg", "sound.aac",
    "Brand.ttf", "Brand.OTF", "sample.woff2",
  ];
  for (const name of names) {
    const type = uploadContentTypeFor(name);
    check(`${name} to ${type}`, type !== null && allowed.has(type), String(type));
  }
}

section("What people actually hand this product is covered");
{
  // Each of these is a real thing somebody uploads, and every one of them was
  // refused by the bucket before this list existed.
  check("a PNG logo, which an overlay is usually made of", uploadKindFor("logo.png") === "image");
  check("an MP3, which every music bed is", uploadKindFor("theme.mp3") === "audio");
  check("an m4a, which is what a phone records", uploadKindFor("memo.m4a") === "audio");
  check("a .mov, which is what an iPhone films", uploadKindFor("IMG_2247.MOV") === "video");
  check("and a font, which is its own kind", uploadKindFor("Brand.otf") === "font");
}

section("And nothing else gets through");
for (const name of ["notes.pdf", "archive.zip", "page.html", "script.js", "noextension", "", "sneaky.mp4.exe"]) {
  check(`${name || "(empty)"} is refused`, uploadContentTypeFor(name) === null, String(uploadContentTypeFor(name)));
}
check(
  "and a refusal is a refusal, not a default",
  // Falling back to `video/mp4` for an unknown file would upload a PDF as a
  // video and fail somewhere much further along.
  uploadKindFor("notes.pdf") === null,
);

section("Every content type the upload code sends is on the list");
{
  /*
    Read out of the source, because that is where the drift happens. A literal
    `"Content-Type": "audio/mpeg"` added to a new upload next year is exactly
    the change that would break against a bucket nobody re-read.
  */
  const files = [
    "artifacts/editly/src/lib/video-storage.ts",
    "artifacts/worker/src/storage.ts",
    "artifacts/worker/src/font-prepare.ts",
    "artifacts/worker/src/preview.ts",
    "artifacts/api-server/src/lib/storage.ts",
  ];
  const sent = new Set();
  for (const file of files) {
    const source = await readFile(path.join(repoRoot, file), "utf8").catch(() => "");
    /*
      Media types only. `application/json` on an admin request and
      `application/offset+octet-stream` on a tus PATCH are protocol headers,
      not the type an object is stored under — and no object this product
      stores is an `application/*` anything, which is asserted below rather
      than assumed here.
    */
    for (const m of source.matchAll(/"((?:video|image|audio|font)\/[a-z0-9.+-]+)"/g)) {
      sent.add(`${m[1]} ${file}`);
    }
  }
  check("the scan found content types at all", sent.size > 0, `${sent.size}`);
  for (const entry of [...sent].sort()) {
    const [type, file] = entry.split(" ");
    check(
      `${type} (${path.basename(file)}) is a type the bucket takes`,
      allowed.has(type),
      "add it to UPLOAD_CONTENT_TYPES *and* to the bucket, or the upload 400s with no message",
    );
  }
}

section("Nothing is stored under an application/* type");
check(
  "the list has none",
  // The two `application/*` strings in the upload code are protocol headers —
  // a tus PATCH body and an admin request. If one ever became the type an
  // object is *stored* under, it would need to be on the list and in the
  // bucket, and this line is where that gets noticed.
  !UPLOAD_CONTENT_TYPES.some((t) => t.startsWith("application/")),
  UPLOAD_CONTENT_TYPES.filter((t) => t.startsWith("application/")).join(", "),
);

section("The bucket is named where somebody changing the list will read it");
{
  const source = await readFile(path.join(repoRoot, "lib/api-zod/src/limits.ts"), "utf8");
  check(
    "the list says how to change the bucket with it",
    /storage\.buckets/.test(source) && /allowed_mime_types/.test(source),
    // This is the half no test can assert. The least it can do is refuse to
    // let the instruction be deleted.
    "the one thing this suite cannot check is the bucket itself",
  );
}

await rm(buildDir, { recursive: true, force: true });
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
console.log("Nothing is uploaded that Storage would refuse without saying so.");
