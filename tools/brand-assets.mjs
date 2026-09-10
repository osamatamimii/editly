/**
 * The brand's raster assets, generated rather than kept.
 *
 * `favicon.svg` is source and can be edited by hand; the PNGs beside it cannot,
 * and when the palette moved from violet to blue every one of them stayed
 * violet — including `og-image.png`, which is the card Safari, WhatsApp, Slack
 * and X show for the site. Osama found that one by opening a new tab on his
 * phone. A colour that only lives inside a binary is a colour nobody will
 * remember to change.
 *
 * So they are rendered from the same mark and the same tokens as the page:
 *
 *   node tools/brand-assets.mjs
 *
 * Writes artifacts/editly/public/{og-image,apple-touch-icon,logo}.png.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "artifacts/editly/public");

/** The mark, read from the favicon so the two can never drift apart. */
const favicon = fs.readFileSync(path.join(publicDir, "favicon.svg"), "utf8");
const MARK_PATH = /\sd="([^"]+)"/.exec(favicon)[1];
const MARK_VIEWBOX = /viewBox="([^"]+)"/.exec(favicon)[1];

/* The palette, as the page has it. `--primary` / `--cta` is 209 81% 62%. */
const INK = "#50A1ED";
const INK_LIT = "#79B7F1";
const GROUND = "#050A10";
const TILE_TOP = "#0E1B2B";
const TILE_BOTTOM = "#060C14";

const mark = (fill, extra = "") =>
  `<svg viewBox="${MARK_VIEWBOX}" xmlns="http://www.w3.org/2000/svg" ${extra}><path fill="${fill}" d="${MARK_PATH}"/></svg>`;

/* A handful of stars, the same seeded field idea as the hero, small enough to
   write out rather than import. */
function stars(count, seed) {
  let s = seed;
  const random = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 0x100000000);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const x = (random() * 100).toFixed(2);
    const yAt = 62 * random() ** 1.5;
    const a = (0.06 + 0.34 * random() ** 2.2) * (0.35 + 0.65 * (1 - (yAt / 62) ** 1.3));
    const r = (1.5 + random() * 1.6).toFixed(2);
    out.push(
      `radial-gradient(circle ${r}px at ${x}% ${yAt.toFixed(2)}%, rgba(255,255,255,${a.toFixed(3)}) 0%, rgba(255,255,255,${a.toFixed(3)}) 42%, rgba(255,255,255,0) 100%)`,
    );
  }
  return out.join(", ");
}

/* The hero's light, widened for the card. The page is 894px tall against
   1200 wide and this is 630 against 1200, so the same percentages there give a
   near-circle here — a ball rather than a lamp. Same stops, wider ellipse. */
const KEY_LIGHT =
  "radial-gradient(ellipse 48% 88% at 50% -14%, rgba(168,208,248,0.95) 0%, rgba(78,160,236,0.85) 30%, rgba(78,160,236,0.34) 52%, rgba(78,160,236,0.10) 68%, transparent 84%)";

const pages = {
  "og-image.png": {
    width: 1200,
    height: 630,
    html: `<div style="position:absolute;inset:0;background:${GROUND}"></div>
      <div style="position:absolute;inset:0;background:${KEY_LIGHT}"></div>
      <div style="position:absolute;inset:0;background-image:${stars(30, 20260910)}"></div>
      <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:26px">
        <div style="display:flex;align-items:center;gap:26px">
          <div style="width:76px;height:89px">${mark(INK, 'width="76" height="89"')}</div>
          <div style="font:800 96px/1 Inter,system-ui,sans-serif;color:#fff;letter-spacing:-0.03em">Editly</div>
        </div>
        <div style="font:600 34px/1.3 Inter,system-ui,sans-serif;color:rgba(226,238,250,0.72)">Stop editing. Start describing.</div>
      </div>`,
  },
  "apple-touch-icon.png": {
    width: 180,
    height: 180,
    html: `<div style="position:absolute;inset:0;background:linear-gradient(180deg,${TILE_TOP},${TILE_BOTTOM})"></div>
      <div style="position:absolute;inset:0;background:radial-gradient(ellipse 90% 60% at 50% -18%, rgba(121,183,241,0.30), transparent 70%)"></div>
      <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">
        <div style="width:88px;height:103px;filter:drop-shadow(0 6px 18px rgba(80,161,237,0.45))">${mark(INK_LIT, 'width="88" height="103"')}</div>
      </div>`,
  },
  "logo.png": {
    width: 512,
    height: 512,
    transparent: true,
    html: `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">
        <div style="width:322px;height:376px">${mark(INK, 'width="322" height="376"')}</div>
      </div>`,
  },
};

const { chromium } = await import("playwright");
/* The same discovery the visual suites do: the container keeps its browsers
   outside the package, and a bare launch looks in the wrong place. */
function chromePath() {
  const r = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!r || !fs.existsSync(r)) return undefined;
  for (const d of fs.readdirSync(r)) {
    if (!/^chromium[-_]/.test(d)) continue;
    const c = path.join(r, d, "chrome-linux", "chrome");
    if (fs.existsSync(c)) return c;
  }
  return undefined;
}
const exe = chromePath();
const browser = await chromium.launch({
  ...(exe ? { executablePath: exe } : {}),
  args: ["--no-sandbox", "--no-proxy-server"],
});
for (const [name, spec] of Object.entries(pages)) {
  const page = await browser.newPage({
    viewport: { width: spec.width, height: spec.height },
    deviceScaleFactor: 1,
  });
  await page.setContent(
    `<html><body style="margin:0;width:${spec.width}px;height:${spec.height}px;position:relative;overflow:hidden;${
      spec.transparent ? "background:transparent" : ""
    }">${spec.html}</body></html>`,
    { waitUntil: "load" },
  );
  await page.waitForTimeout(250);
  const out = path.join(publicDir, name);
  await page.screenshot({ path: out, omitBackground: !!spec.transparent });
  console.log(name, spec.width + "×" + spec.height, fs.statSync(out).size + " bytes");
  await page.close();
}
await browser.close();
