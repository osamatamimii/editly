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

section("There is one upload ceiling, and it comes from the bucket");
{
  /*
    The same failure as the MIME list, in the other dimension.

    The extra-files panel carried its own `MAX_ASSET_BYTES = 512 MB` while the
    bucket refused anything over 50, and said "up to 512 MB each" on screen. A
    60 MB logo animation failed with a 400 from Storage and no sentence
    anywhere — our API is never called on that path, so no log we own has a
    line for it.

    The real number is served from the subscription, which asks Storage. Any
    second constant is a second chance to disagree with it, so there must not
    be one.
  */
  const storage = await readFile(path.join(repoRoot, "artifacts/editly/src/lib/video-storage.ts"), "utf8");

  /*
    The rule is not "one constant". It is that **no constant may promise more
    than the bucket will take.**

    A ceiling *below* the bucket's is a legitimate product decision — a
    reference clip is only measured for its colour and a font that can be
    burned with is a couple of megabytes, so both are held tighter on purpose.
    A ceiling *above* it is the bug: it is a number the screen states and
    Storage refuses, with the refusal arriving as a 400 the browser gets
    directly and no log we own ever sees.
  */
  const sizes = [...storage.matchAll(/^export const (MAX_[A-Z_]*BYTES)[^=]*=\s*(?:Number\([^)]*\)\s*\|\|\s*)?(\d+)\s*\*\s*1024\s*\*\s*1024/gm)]
    .map((m) => ({ name: m[1], mb: Number(m[2]) }));
  const bucketMb = sizes.find((c) => c.name === "MAX_UPLOAD_BYTES")?.mb ?? 0;

  check("the fallback ceiling is readable", bucketMb > 0, `${bucketMb} MB`);
  for (const size of sizes.filter((c) => c.name !== "MAX_UPLOAD_BYTES")) {
    check(
      `${size.name} (${size.mb} MB) does not promise more than the bucket takes`,
      size.mb <= bucketMb,
      `the bucket stops at ${bucketMb} MB, so a file between the two is accepted here and refused there with no message`,
    );
  }
  check(
    "and no constant stands in for the extra-files ceiling",
    // That one was 512 MB against a 50 MB bucket, and the panel said so on
    // screen. The real number is served from the subscription.
    !/MAX_ASSET_BYTES/.test(storage),
  );
  check(
    "and the extra-files uploader is handed the ceiling rather than choosing one",
    /ceiling: number \| null;/.test(storage),
    "an uploader with a default ceiling is a caller that forgot, enforcing a number unrelated to the bucket",
  );

  for (const file of [
    "artifacts/editly/src/components/project-library.tsx",
    "artifacts/editly/src/components/stock-search.tsx",
  ]) {
    const source = await readFile(path.join(repoRoot, file), "utf8");
    check(
      `${path.basename(file)} passes a ceiling to every upload it starts`,
      (source.match(/uploadProjectAsset\(/g) ?? []).length === (source.match(/ceiling,?\s*[,}]/g) ?? []).length ||
        /ceiling,/.test(source),
      "an upload without one would not compile, but a default would have hidden it",
    );
  }

  const editor = await readFile(path.join(repoRoot, "artifacts/editly/src/pages/project-editor.tsx"), "utf8");
  /*
    `servedCeiling`, not `uploadCeiling`, and the difference is the defect.

    Both read what the server said. `uploadCeiling` then folds "the server has
    not said yet" into the build-time fallback — 50 MB, the *free* plan's order
    of magnitude — so for as long as the subscription query is in flight, and
    for the whole of any failure or 401 on it, this panel told a Pro customer
    to keep each extra file under fifty megabytes. The signing route enforces
    the real ceiling before a byte is sent, so `null` costs one round trip and
    a guess costs a customer.
  */
  check(
    "and the number handed down is the served one",
    /ceiling=\{servedCeiling\(subscription\)\}/.test(editor),
    "servedCeiling says nothing until the server has said it; uploadCeiling guesses the free plan's number",
  );
}

section("The bucket is named where somebody changing the list will read it");
{
  const source = await readFile(path.join(repoRoot, "lib/api-zod/src/limits.ts"), "utf8");
  check(
    "the list says how to change the bucket with it",
    /storage\.buckets/.test(source) && /allowed_mime_types/.test(source),
    "an instruction nobody can read is an instruction nobody follows",
  );
}

section("And the bucket the migrations build takes exactly what the product offers");
{
  /*
    This was the half the suite said it could not check, and it could.

    `UPLOAD_CONTENT_TYPES` was widened twice; the bucket was last set by
    migration 0004, to four types. So an empty Postgres plus every file in
    `lib/db/migrations` — the property that whole directory exists to
    establish — produced a bucket that refused twelve of the sixteen.

    Nothing failed on our side, which is why it survived. The API checks the
    filename, decides the type, signs the ticket and writes its log line; the
    refusal arrives as a 400 from Storage direct to the browser, on a request no
    server of ours ever sees. A PNG logo, an MP3 bed, a WebP, an MKV and every
    uploaded font were refused at the moment somebody pressed the button, and
    `addMusic` and `overlayImage` — both built, both tested — could not be
    handed a file.

    Production had been widened by hand, which made it worse rather than
    better: the database the migrations build and the database customers use
    disagreed, so every suite that runs against a fresh one was testing a
    narrower product than the deployed one.

    Read from the migration rather than from a list here, because a third copy
    of the list is a third thing to forget.
  */
  const { readdirSync } = await import("node:fs");
  const dir = path.join(repoRoot, "lib/db/migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

  // The last migration that says anything about the bucket's types is the one
  // that decides them.
  let deciding = null;
  for (const file of files) {
    const sql = await readFile(path.join(dir, file), "utf8");
    if (/allowed_mime_types\s*=/.test(sql)) deciding = { file, sql };
  }
  check("a migration sets the bucket's types", deciding !== null, "the bucket is whatever somebody typed into a dashboard");

  const declared = [...(deciding?.sql ?? "").matchAll(/'([a-z]+\/[a-z0-9.+-]+)'/g)].map((m) => m[1]);
  const inBucket = new Set(declared);
  const missing = UPLOAD_CONTENT_TYPES.filter((type) => !inBucket.has(type));
  const extra = declared.filter((type) => !allowed.has(type));

  check(
    `${deciding?.file} accepts every type the product offers`,
    missing.length === 0,
    `${missing.join(", ")} would be refused by Storage on a request the API never sees`,
  );
  check(
    "and nothing the product would never send",
    extra.length === 0,
    `${extra.join(", ")} is in the bucket and not in the list`,
  );
}

await rm(buildDir, { recursive: true, force: true });
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
console.log("Nothing is uploaded that Storage would refuse without saying so.");
