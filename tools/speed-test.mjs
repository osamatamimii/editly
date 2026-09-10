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
import { brightness } from "./png-pixels.mjs";
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
/*
  `?lang=en`, on a suite that is about neither language.

  What is measured here is weight and frames, which are the same in Arabic and
  in English: the same markup, the same chunk, the same reveals. The one check
  below that reads words needs to know which language it is reading, and
  pinning it to English keeps this file about bytes. The Arabic page's claims
  are checked in `tools/landing-test.mjs`, which renders both.
*/
await page.goto(`${origin}/?lang=en`, { waitUntil: "load" });

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

/*
 * The cost that does not show up as a filter, a byte or a blur: a component
 * that re-renders at frame rate.
 *
 * The pointer-following star field was written the ordinary way — position in
 * `useState`, set every frame — and `Home` is the whole landing page, so
 * moving the mouse re-rendered every section sixty times a second. It shipped,
 * and the site was reported slow within minutes. Nothing measured here caught
 * it, because the page's weight, its blurs and its scroll frames were all
 * unchanged.
 *
 * Counting React renders from outside is not something a page will tell you.
 * What it will tell you is *where the number lives*: a value that reaches only
 * a transform belongs in a custom property, where the compositor can read it
 * without waking the framework. So the check is that the moving layers are
 * driven by one, and it fails the moment somebody puts the number back into a
 * template string.
 */
section("Anything that moves every frame moves without re-rendering the page");
{
  const drift = await page.evaluate(() =>
    ["star-far", "star-near"].map((id) => {
      const e = document.querySelector(`[data-testid="${id}"]`);
      return { id, found: !!e, transform: e?.getAttribute("style")?.match(/transform:[^;]*/)?.[0] ?? "" };
    }),
  );
  check("the drifting layers are on the page at all", drift.every((d) => d.found), JSON.stringify(drift));
  /*
   * And that they can be seen. The field shipped once with a 0.85px gradient
   * radius, which is a sub-pixel smudge: present in the DOM, present in the
   * computed style, invisible on the screen, and reported by the person who
   * asked for it. A count and a floor on the radius is the cheapest thing that
   * would have caught it.
   */
  const sky = await page.evaluate(() => {
    const read = (id) => {
      const e = document.querySelector(`[data-testid="${id}"]`);
      const bg = e ? getComputedStyle(e).backgroundImage : "";
      const radii = [...bg.matchAll(/radial-gradient\(([\d.]+)px/g)].map((m) => Number(m[1]));
      return { id, dots: radii.length, smallest: radii.length ? Math.min(...radii) : 0 };
    };
    return [...document.querySelectorAll(".star-layer")].map((e) => read(e.dataset.testid));
  });
  const MIN_STAR_PX = 1;
  const MIN_STARS = 60;
  // Counted across the layers, not within one: the field is split three ways
  // so the twinkle can run on three phases, and how it is split is a
  // rendering decision, not a promise about how many stars there are.
  const total = sky.reduce((n, layer) => n + layer.dots, 0);
  check(
    "there are enough dots across the layers to read as a sky",
    total >= MIN_STARS,
    `${total} dots in ${sky.length} layers`,
  );
  for (const layer of sky) {
    check(
      `${layer.id}'s faintest dot is at least ${MIN_STAR_PX}px, so it renders at all`,
      layer.smallest >= MIN_STAR_PX,
      `smallest radius ${layer.smallest}px`,
    );
  }
  for (const layer of drift) {
    check(
      `${layer.id} takes its offset from a custom property, not from a re-render`,
      /var\(--drift-/.test(layer.transform),
      layer.transform || "no inline transform",
    );
  }
}

/*
 * And that the light and the sky are actually on the screen.
 *
 * Everything above this reads the DOM, and the DOM said the hero background
 * was fine while it was completely invisible. The wash is `fixed inset-0
 * -z-10`; a negative stack level paints at step 2 of its *stacking context*,
 * and the wrapper was not one, so the layers joined the root's — where step 2
 * comes before in-flow block backgrounds, and the app shell's own opaque
 * background is one of those. Elements present, styles correct, boxes right,
 * opacity 1, nothing on screen. It was found by painting the star layers red
 * and finding the screenshot unchanged.
 *
 * So this section does not ask the page anything. It photographs it and looks
 * at the pixels: the top of the hero has a light in it and must be brighter
 * than the bottom, and the sky must have something in it brighter than the
 * ground it sits on.
 */
section("The light and the sky survive all the way to the screen");
{
  const mean = async (clip) =>
    brightness(await page.screenshot({ clip, animations: "disabled", timeout: 150000 }));
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
  // Two empty bands of the hero: one under the key light, one well below it.
  const lit = await mean({ x: 250, y: 96, width: 900, height: 54 });
  const unlit = await mean({ x: 250, y: 600, width: 900, height: 54 });
  check(
    "the top of the hero is lit — the key light reaches the screen, not just the DOM",
    lit.mean > unlit.mean + 3,
    `top ${lit.mean.toFixed(1)} vs lower ${unlit.mean.toFixed(1)}`,
  );
  // A strip down the left edge, where there is no text and no button.
  /*
   * A ratio, not a floor. The stars are deliberately faint — the reference
   * they were fitted to has an ordinary one peaking at 24 against a ground of
   * 8 — so "brighter than 60" would fail a sky that is exactly right and pass
   * one bleached white. What has to hold is that something in the band stands
   * off its own ground.
   */
  const skyBand = await mean({ x: 0, y: 190, width: 280, height: 320 });
  check(
    "and the sky has stars standing off the ground they sit on",
    skyBand.peak > skyBand.mean * 2 && skyBand.peak - skyBand.mean > 12,
    `brightest ${skyBand.peak.toFixed(0)} against a band mean of ${skyBand.mean.toFixed(1)}`,
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
  /*
   * The rule changed, on purpose, and this is the new one.
   *
   * "No video at all" was the right rule while the page had nothing worth
   * playing. It now has three finished exports in the output section, which
   * are the product: a paragraph describing what a clip looks like when it
   * comes back is weaker than three of them playing. What must not come back
   * is the old failure — 1.4MB fetched on every visit, two files of it never
   * shown — so the cost is what is checked, not the presence.
   *
   * Every media element must declare `preload="none"` and carry a poster, and
   * nothing may be fetched before somebody scrolls to it. That makes a clip
   * cost a 10kB JPEG until it is on screen, which is the same as costing
   * nothing for the visitor who never gets there.
   */
  const media = await page.evaluate(() =>
    [...document.querySelectorAll("video, audio")].map((el) => ({
      tag: el.tagName.toLowerCase(),
      src: (el.currentSrc || el.getAttribute("src") || "").split("/").pop() || "(no src)",
      preload: el.getAttribute("preload"),
      poster: el.tagName === "VIDEO" ? !!el.getAttribute("poster") : true,
      autoplay: el.hasAttribute("autoplay"),
    })),
  );
  const eager = media.filter((m) => m.preload !== "none" || m.autoplay);
  check(
    "no media element loads itself — every one is preload=none and waits to be scrolled to",
    eager.length === 0,
    eager.map((m) => `${m.tag} ${m.src} preload=${m.preload}${m.autoplay ? " autoplay" : ""}`).join(", "),
  );
  const posterless = media.filter((m) => !m.poster);
  check(
    "and every clip has a poster, so its box is never an empty black rectangle",
    posterless.length === 0,
    posterless.map((m) => m.src).join(", "),
  );

  /*
   * A budget on what was actually fetched. The page has been loaded and
   * scrolled the whole way down by this point, and the clips are below the
   * fold behind an observer, so this is the cost of *arriving* — which is the
   * number that was 1.4MB and must stay near zero.
   */
  const MEDIA_BUDGET_KB = 250;
  const heavy = requested.filter(([url]) => /\.(mp4|webm|mov|m4v|mp3|wav)$/i.test(url));
  const heavyKb = heavy.reduce((sum, [, bytes]) => sum + bytes, 0) / 1024;
  check(
    `and pulls under ${MEDIA_BUDGET_KB}kB of media over the wire on arrival`,
    heavyKb < MEDIA_BUDGET_KB,
    `${heavyKb.toFixed(0)}kB: ${heavy.map(([u]) => u).join(", ")}`,
  );

  /* And a cap on the clips themselves, weighed on disk rather than fetched:
     three exports at about 105kB each is a section that costs a third of a
     megabyte to watch, and that is the trade. Ten would not be. */
  const REEL_BUDGET_KB = 420;
  const reelDir = path.join(root, "reel");
  const reels = existsSync(reelDir) ? readdirSync(reelDir).filter((f) => f.endsWith(".mp4")) : [];
  const reelKb = reels.reduce((sum, f) => sum + statSync(path.join(reelDir, f)).size, 0) / 1024;
  check(
    `the clips themselves come to under ${REEL_BUDGET_KB}kB all together`,
    reelKb < REEL_BUDGET_KB,
    `${reels.length} clips, ${reelKb.toFixed(0)}kB`,
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
