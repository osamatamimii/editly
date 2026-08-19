/**
 * The stock library, and the two ways a feature like this gets you breached.
 *
 * **A URL from the client.** The obvious design is "browser sends the file's
 * URL, server fetches it". That is server-side request forgery: our process
 * sits inside the deployment's network and would fetch a cloud metadata
 * endpoint, an internal service, or a redirect that ends at one, on request.
 * So the client sends an *id*, the provider resolves it, and the resolved URL
 * is still checked before a byte is fetched — because "the third party said
 * so" is not a security boundary.
 *
 * **A host check written with `includes`.** `pexels.com.attacker.net` contains
 * the string "pexels.com" and is not Pexels. The check has to be on the
 * registrable domain, anchored at the end.
 *
 * And one product rule: with no key configured this must say so, not return an
 * empty grid. "We have not switched this on" and "there are no photos of cats"
 * are different answers, and confusing them sends someone hunting for a bug in
 * their own search terms.
 *
 * Usage: node tools/stock-test.mjs
 */
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os"; void tmpdir;
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
/**
 * Built inside the API package rather than in /tmp, because Node resolves a
 * bare specifier by walking up from the importing file — a bundle in /tmp
 * cannot find `pino`, and the failure is an unrelated-looking crash about
 * dynamic require.
 */
const buildDir = path.join(repoRoot, "artifacts/api-server/.stock-test");
await mkdir(buildDir, { recursive: true });

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

/** Bundle the module twice: once with a key configured, once without. */
async function loadStock({ withKey }) {
  const out = path.join(buildDir, withKey ? "with-key.mjs" : "no-key.mjs");
  const result = spawnSync(
    require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] }),
    [
      path.join(repoRoot, "artifacts/api-server/src/lib/stock.ts"),
      "--bundle", "--platform=node", "--format=esm", "--target=node22",
      "--packages=external",
      `--outfile=${out}`, "--log-level=error",
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    console.error("could not bundle the stock module");
    process.exit(1);
  }
  // The module reads the key at import time, which is the point: a deployment
  // either has one or it does not, and a per-request check would let a
  // half-configured process answer differently to two callers.
  if (withKey) process.env.PEXELS_API_KEY = "test-key";
  else delete process.env.PEXELS_API_KEY;
  return await import(`${pathToFileURL(out).href}?k=${withKey ? 1 : 0}`);
}

const noKey = await loadStock({ withKey: false });
const withKey = await loadStock({ withKey: true });

console.log("\nA deployment with no key says so");
{
  check("stockConfigured is false", noKey.stockConfigured === false);
  check("and true once a key is set", withKey.stockConfigured === true);

  const route = await readFile(path.join(repoRoot, "artifacts/api-server/src/routes/stock.ts"), "utf8");
  check("the route answers 503, not an empty list", route.includes("res.status(503)"));
  check(
    "and names what is missing rather than blaming the search",
    /not switched on/.test(route) && /Pexels key/.test(route),
  );
}

console.log("\nWhere bytes are allowed to come from");
{
  const allowed = [
    "https://images.pexels.com/photos/1/x.jpg",
    "https://videos.pexels.com/video-files/1/x.mp4",
    "https://player.vimeo.com/external/1.mp4",
    "https://www.pexels.com/photo/1/",
  ];
  for (const url of allowed) {
    let ok = true;
    try { withKey.assertAllowedHost(url); } catch { ok = false; }
    check(`allows ${new URL(url).host}`, ok);
  }

  const refused = [
    ["a lookalike domain", "https://pexels.com.attacker.net/x.jpg"],
    ["a substring, not a suffix", "https://notpexels.com/x.jpg"],
    ["cloud metadata", "http://169.254.169.254/latest/meta-data/"],
    ["localhost", "https://127.0.0.1/x.jpg"],
    ["plain http, even to the right host", "http://images.pexels.com/x.jpg"],
    ["a file URL", "file:///etc/passwd"],
    ["not a URL at all", "images.pexels.com/x.jpg"],
    ["an internal name", "https://internal.svc.cluster.local/x"],
  ];
  for (const [name, url] of refused) {
    let threw = false;
    try { withKey.assertAllowedHost(url); } catch { threw = true; }
    check(`refuses ${name}`, threw, url);
  }
}

console.log("\nThe client names an id, never a file");
{
  check("a photo id parses", withKey.parseStockId("photo:12345").numericId === "12345");
  check("a video id parses", withKey.parseStockId("video:9").kind === "video");

  const bad = [
    "https://evil.test/x.mp4",
    "photo:../../etc/passwd",
    "photo:12345/../9",
    "audio:1",
    "photo:",
    "photo:12345678901234567890",
    "PHOTO:1",
    "photo:1 video:2",
  ];
  for (const id of bad) {
    let threw = false;
    try { withKey.parseStockId(id); } catch { threw = true; }
    check(`refuses ${JSON.stringify(id)}`, threw);
  }

  const source = await readFile(path.join(repoRoot, "artifacts/api-server/src/lib/stock.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check(
    "and every resolved URL goes through the host check",
    (code.match(/assertAllowedHost\(/g) ?? []).length >= 3,
  );
  check("the key is never sent to the browser", !code.includes("res.json({ key") && !/publicKey/.test(code));
}

console.log("\nWhat gets downloaded is not the biggest thing available");
{
  const route = await readFile(path.join(repoRoot, "artifacts/api-server/src/routes/stock.ts"), "utf8");
  check("there is a ceiling on what streams through", /MAX_FILE_BYTES/.test(route));
  check(
    "enforced on the bytes as well as on the declared length",
    /seen \+= chunk\.length/.test(route),
    "a Content-Length can lie",
  );
  check("and the response is streamed, not buffered", route.includes("pipe(res)") && !route.includes("arrayBuffer()"));

  const lib = await readFile(path.join(repoRoot, "artifacts/api-server/src/lib/stock.ts"), "utf8");
  check("a 4K clip is not chosen for a 1080p timeline", lib.includes("<= 1080"));
  check("the photographer's credit is carried into the label", /Pexels/.test(lib) && lib.includes("credit"));
}

console.log("\nLooking before adding");
{
  const component = await readFile(
    path.join(repoRoot, "artifacts/editly/src/components/stock-search.tsx"),
    "utf8",
  );
  check(
    "clicking a tile opens it rather than buying it",
    component.includes("onClick={() => setPreviewing(item)}"),
    "a poster frame says almost nothing about how a clip moves",
  );
  check("adding is its own press", component.includes("button-stock-add"));
  check("and there is a way back out", component.includes("button-stock-close-preview"));
  check(
    "a clip actually plays in the preview",
    component.includes("stock-preview-video") && component.includes("/api/stock/preview/"),
  );
  check(
    "and its bytes come from us, not from a domain we do not control",
    !/previewVideoUrl/.test(component),
  );
  check(
    "a browser that cannot decode is told so, not left spinning",
    component.includes("stock-preview-unplayable") && component.includes("playbackVerdict"),
    "readyState 0, networkState loading, no error — from a local blob",
  );
  check(
    "using the same verdict the editor uses, on a shorter clock",
    component.includes("PREVIEW_CEILING_MS"),
  );
  check(
    "the object URL is revoked, so browsing does not accumulate clips",
    component.includes("revokeObjectURL"),
  );
  check(
    "muted, because a grid that starts shouting is a grid people close",
    /<video[\s\S]{0,400}muted/.test(component),
  );
  check("the photographer is named where the decision is made", component.includes("creditUrl"));

  const lib = await readFile(path.join(repoRoot, "artifacts/api-server/src/lib/stock.ts"), "utf8");
  check(
    "the preview is the smallest rendition, not the one that would be kept",
    lib.includes("smallestPlayable") && lib.includes("resolveStockPreview"),
  );

  const route = await readFile(path.join(repoRoot, "artifacts/api-server/src/routes/stock.ts"), "utf8");
  check("the preview has its own route", route.includes("/stock/preview/:id"));
  check(
    "sharing one streaming path with the download, cap and all",
    (route.match(/streamStock/g) ?? []).length >= 3,
  );
  check(
    "and a preview is cached while a download is barely",
    /preview[\s\S]{0,300}max-age=3600/.test(route),
  );
}

console.log("\nThe size recorded is the size downloaded");
{
  const lib = await readFile(path.join(repoRoot, "artifacts/api-server/src/lib/stock.ts"), "utf8");
  check(
    "a photo's size is read from the rendition, not from the original",
    lib.includes("sizeFromSrcUrl"),
    "Pexels lists a 6000px original and serves an 1880px copy",
  );
  check(
    "and a clip's from the file chosen, not from the parent entry",
    /width: Number\(best\.width\)/.test(lib),
  );

  const component = await readFile(
    path.join(repoRoot, "artifacts/editly/src/components/stock-search.tsx"),
    "utf8",
  );
  check(
    "the browser registers what arrived rather than what it searched",
    component.includes("x-stock-width") && component.includes("servedWidth"),
  );
  check(
    "so the search result's dimensions are not written to the library",
    !/width: item\.width/.test(component),
  );
}

console.log("\nStock arrives as an ordinary asset");
{
  const component = await readFile(
    path.join(repoRoot, "artifacts/editly/src/components/stock-search.tsx"),
    "utf8",
  );
  check(
    "it is uploaded through the same path as a file the customer chose",
    component.includes("uploadProjectAsset"),
  );
  check("and registered through the same endpoint", component.includes("/assets"));
  check(
    "the bytes come from us, not from the provider's CDN",
    component.includes("/api/stock/file/") && !component.includes("pexels.com"),
    "a cross-origin fetch depends on someone else's CORS headers",
  );
  check(
    "a missing key reads as 'not switched on', not as an error",
    component.includes("stock-unavailable") && component.includes("res.status === 503"),
  );
}

await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
