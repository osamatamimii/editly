/**
 * What the landing page costs to open and to scroll.
 *
 * "It feels slow when I refresh" is not something any other suite in this repo
 * can see. They read source, or they render a page and ask whether the right
 * things are on it — and a page can be entirely correct and still stall for a
 * second every time somebody scrolls it. This one measures instead.
 *
 * It measures structure rather than milliseconds on purpose. Frame timings in a
 * headless browser with no GPU are noisy enough that a threshold on them would
 * either be so loose it catches nothing or so tight it fails on a busy runner.
 * Every check below is a deterministic fact about the built page, and each one
 * is the exact shape of a regression that was measured here and fixed:
 *
 *  - a `filter` that outlives the animation it belonged to. A CSS transition
 *    cannot land on `none`, only on `blur(0)`, and a zero-radius blur is still
 *    a filter: its own composited layer, re-rasterised every frame, forever,
 *    for a result identical to no filter at all. Eighteen elements were paying
 *    it. Scrolling measured 141 janky frames out of 150.
 *  - a blur radius large enough that the surface behind it dwarfs the element.
 *  - a `<video>` in the DOM that no layout ever shows, which the browser
 *    fetches and gives a decoder to anyway, because `hidden` is a class.
 *  - the whole application in the first chunk, so opening the marketing page
 *    downloads and parses the editor, the export screen and the admin console.
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { existsSync, statSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.join(repoRoot, "dist");
if (!existsSync(root)) {
  console.error("dist/ is not built — run `pnpm run vercel:build` from the repo root first.");
  process.exit(1);
}

let pass = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function section(t) { console.log(`\n${t}`); }

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2", ".woff": "font/woff", ".jpg": "image/jpeg", ".webm": "video/webm", ".mp4": "video/mp4" };
const server = http.createServer(async (req, res) => {
  let p = path.join(root, decodeURIComponent(req.url.split("?")[0]));
  if (!existsSync(p) || statSync(p).isDirectory()) p = path.join(root, "index.html");
  try {
    const body = await readFile(p);
    res.writeHead(200, { "Content-Type": types[path.extname(p)] ?? "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404).end("no"); }
});
const PORT = 4398;
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
const origin = `http://127.0.0.1:${PORT}`;

// ── What arrives before anything can be drawn ────────────────────────────────
//
// Budgets, not records. Each is set above what the page measures today with
// enough room that ordinary growth does not trip it, and low enough that
// putting another screen back into the entry chunk does.
const ENTRY_GZIP_BUDGET_KB = 200;
const ENTRY_RAW_BUDGET_KB = 700;

section("The first chunk carries the first screen, and not the whole application");
{
  const assets = path.join(root, "assets");
  const files = readdirSync(assets).filter((f) => f.endsWith(".js"));
  const entry = files
    .map((f) => ({ f, size: statSync(path.join(assets, f)).size }))
    .sort((a, b) => b.size - a.size)[0];
  const raw = entry.size / 1024;
  const gz = gzipSync(readFileSync(path.join(assets, entry.f))).length / 1024;

  check("there is a built bundle to weigh", files.length > 0);
  check(
    `the entry chunk is under ${ENTRY_RAW_BUDGET_KB}kB unpacked`,
    raw < ENTRY_RAW_BUDGET_KB,
    `${raw.toFixed(0)}kB (${entry.f})`,
  );
  check(
    `and under ${ENTRY_GZIP_BUDGET_KB}kB over the wire`,
    gz < ENTRY_GZIP_BUDGET_KB,
    `${gz.toFixed(0)}kB gzipped`,
  );
  // The screens behind the login are the ones that made the entry chunk what it
  // was. Each has to arrive as its own file or it is back in the entry.
  for (const screen of ["dashboard", "project-editor", "export", "account", "admin", "login"]) {
    check(
      `${screen} is fetched when somebody opens it, not before`,
      files.some((f) => f.startsWith(`${screen}-`)),
      `no ${screen} chunk in dist/assets`,
    );
  }
}

// ── What the page keeps paying for after it has finished arriving ────────────
const { chromium } = await import("playwright");
function chromePath() {
  const r = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!r || !existsSync(r)) return undefined;
  for (const d of readdirSync(r)) {
    if (!/^chromium[-_]/.test(d)) continue;
    const c = path.join(r, d, "chrome-linux", "chrome");
    if (existsSync(c)) return c;
  }
  return undefined;
}
const exe = chromePath();
const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
/** Every response the page pulled, so media can be weighed rather than counted. */
const requested = [];
page.on("response", (r) => {
  requested.push([new URL(r.url()).pathname, Number(r.headers()["content-length"] ?? 0)]);
});
await page.goto(`${origin}/`, { waitUntil: "load" });

// Long enough for every reveal to have been triggered and settled.
await page.evaluate(() => {
  return new Promise((resolve) => {
    let y = 0;
    const step = () => {
      window.scrollTo(0, y);
      y += window.innerHeight;
      if (y < document.body.scrollHeight + window.innerHeight) setTimeout(step, 120);
      else setTimeout(resolve, 2000);
    };
    step();
  });
});

/** The widest blur the page is allowed to ask a compositor for. */
const MAX_BLUR_PX = 60;

section("Nothing on the page is filtered once it has finished animating");
{
  const state = await page.evaluate(() => {
    const read = (e) => {
      const s = getComputedStyle(e);
      const r = e.getBoundingClientRect();
      return {
        filter: s.filter,
        backdrop: s.backdropFilter,
        cls: (e.className.baseVal ?? e.className ?? "").toString().slice(0, 60),
        area: Math.round(r.width * r.height),
      };
    };
    const all = [...document.querySelectorAll("*")].map(read);
    return {
      lingering: all.filter((e) => /blur\(0(\.0+)?(px)?\)/.test(e.filter)),
      blurred: all.filter((e) => /blur\(/.test(e.filter) && !/blur\(0(\.0+)?(px)?\)/.test(e.filter)),
      backdrops: all.filter((e) => e.backdrop && e.backdrop !== "none"),
      revealsSettled: document.querySelectorAll(".reveal.visible:not(.settled)").length,
      revealsTotal: document.querySelectorAll(".reveal").length,
    };
  });

  check("the page has reveals to settle at all", state.revealsTotal > 0, `${state.revealsTotal}`);
  check(
    "every reveal that has run has had its filter taken back off",
    state.revealsSettled === 0,
    `${state.revealsSettled} still mid-reveal after scrolling the whole page`,
  );
  // The exact defect: `filter: blur(0px)` is a filter. Anything holding one is
  // on the expensive path for a picture identical to not being on it.
  check(
    "and nothing is left holding a zero-radius blur, which costs a layer and draws nothing",
    state.lingering.length === 0,
    state.lingering.map((e) => `${e.cls} (${e.filter})`).join(", "),
  );
  const wide = state.blurred.filter((e) => {
    const px = Number(/blur\(([\d.]+)px\)/.exec(e.filter)?.[1] ?? 0);
    return px > MAX_BLUR_PX;
  });
  check(
    `no element asks for a blur wider than ${MAX_BLUR_PX}px — a wash is painted, not filtered`,
    wide.length === 0,
    wide.map((e) => `${e.cls} ${e.filter} over ${Math.round(e.area / 1000)}k px`).join(", "),
  );
  // A backdrop filter costs a copy of everything behind it, every frame. The
  // page may have a few on small chrome; it may not have them on the panels
  // that cover a section.
  const bigBackdrops = state.backdrops.filter((e) => e.area > 200000);
  check(
    "and no panel larger than a section-third reads back its own backdrop to blur it",
    bigBackdrops.length === 0,
    bigBackdrops.map((e) => `${e.cls} over ${Math.round(e.area / 1000)}k px`).join(", "),
  );
}

section("The hero is drawn, so there is nothing to download and nothing to hide");
{
  /*
   * The hero was a screen recording for several rounds, and it failed three
   * ways at once: the largest element in it is the video player, and the demo
   * project has no footage, so a page selling a video editor showed an empty
   * gradient where the video goes; a 1280x800 window scaled into a 1000px hero
   * renders every label at about eight pixels; and it cost 1.4MB across four
   * files on every visit, of which two were fetched and never shown, because
   * `hidden` is a class and a class does not close a media element's sources.
   *
   * It is DOM and SVG now. These checks hold that: no media element at all on
   * the landing page, and nothing heavy behind it. The second is the one that
   * catches a quiet regression, because a video that is added back and hidden
   * looks like nothing at all in a screenshot.
   */
  const media = await page.evaluate(() =>
    [...document.querySelectorAll("video, audio")].map((el) => ({
      tag: el.tagName.toLowerCase(),
      src: (el.currentSrc || el.getAttribute("src") || "").split("/").pop() || "(no src)",
      shown: el.clientWidth > 0 && el.clientHeight > 0,
    })),
  );
  check(
    "the landing page loads no video or audio at all",
    media.length === 0,
    media.map((m) => `${m.tag} ${m.src}${m.shown ? "" : " (never shown)"}`).join(", "),
  );

  // A budget rather than a count, so a legitimate small asset is not a failure
  // and 1.4MB of video is.
  const MEDIA_BUDGET_KB = 250;
  const heavy = requested.filter(([url]) => /\.(mp4|webm|mov|m4v|mp3|wav|gif)$/i.test(url));
  const heavyKb = heavy.reduce((sum, [, bytes]) => sum + bytes, 0) / 1024;
  check(
    `and pulls under ${MEDIA_BUDGET_KB}kB of media over the wire`,
    heavyKb < MEDIA_BUDGET_KB,
    `${heavyKb.toFixed(0)}kB: ${heavy.map(([u]) => u).join(", ")}`,
  );

  // The claim the drawing makes has to be on it, or the hero is decoration.
  const text = await page.evaluate(() => document.body.innerText);
  for (const promise of ["silence", "9:16", "captions", "LUFS"]) {
    check(`the hero still says what the edit does: ${promise}`, text.includes(promise), "");
  }
}

await browser.close();
server.close();

console.log(`\n${pass}/${pass + failures.length} checks passed`);
if (failures.length > 0) {
  console.log(`${failures.length} FAILED`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("The landing page is cheap to open and cheap to scroll.");
