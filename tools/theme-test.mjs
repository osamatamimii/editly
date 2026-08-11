/**
 * Does the light theme still cover everything the dark one defines?
 *
 * The failure this exists to catch is not dramatic. Someone adds a token to the
 * dark block — a new surface, a new glow — uses it in a component, and never
 * opens the light theme. The token falls through to the dark value, and one
 * corner of the light interface is a dark grey box that nobody notices until a
 * customer sends a screenshot. There is no error, no warning, and no failing
 * test anywhere else in this repo that would catch it.
 *
 * So: every custom property declared for dark must be declared for light too,
 * and the colours that carry text must clear WCAG AA against the surface they
 * sit on. Both checks read the real stylesheet rather than a copy of the
 * numbers, because a test that restates the values it is checking proves only
 * that copy-paste works.
 *
 * Usage: node tools/theme-test.mjs
 * Requires: nothing. No browser, no build, no network.
 */
import { readFile } from "node:fs/promises";

const CSS_PATH = "artifacts/editly/src/index.css";
const css = await readFile(CSS_PATH, "utf8");

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

/**
 * Pull one top-level rule's body out by its selector.
 *
 * Brace-counting rather than a regex, because the blocks contain nested
 * parentheses and functions and a lazy `[^}]*` stops at the first brace inside
 * a nested at-rule — silently returning half the block, which would make every
 * check below pass for the wrong reason.
 */
function blockFor(selector) {
  const start = css.indexOf(selector + " {");
  if (start === -1) return null;
  let i = css.indexOf("{", start);
  let depth = 0;
  const from = i + 1;
  for (; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(from, i);
    }
  }
  return null;
}

function tokensIn(block) {
  const found = new Map();
  for (const [, name, value] of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    found.set(name, value.trim());
  }
  return found;
}

const darkBlock = blockFor(":root, .dark, .force-dark");
const lightBlock = blockFor(".light");

check("the dark block is where it is expected to be", Boolean(darkBlock));
check("the light block is where it is expected to be", Boolean(lightBlock));
if (!darkBlock || !lightBlock) {
  console.log("\ncannot continue without both blocks");
  process.exit(1);
}

const dark = tokensIn(darkBlock);
const light = tokensIn(lightBlock);

console.log("\nEvery dark token has a light counterpart");
{
  /*
   * Fonts, radii and the type scale are theme-independent by design — a light
   * theme with different corner radii is a different design, not a theme. Only
   * the tokens that carry *colour* have to be answered.
   */
  const THEME_INDEPENDENT = /^--(app-font|radius|.*-outline$|opaque-button-border-intensity$)/;

  const missing = [...dark.keys()].filter(
    (name) => !THEME_INDEPENDENT.test(name) && !light.has(name),
  );

  check(
    `all ${dark.size} dark tokens are answered by the light theme`,
    missing.length === 0,
    missing.length ? `missing in .light: ${missing.join(", ")}` : "",
  );

  // The reverse is a smaller problem but still a bug: a token only the light
  // theme defines is one the dark theme falls back to nothing for.
  const orphans = [...light.keys()].filter((name) => !dark.has(name) && name !== "color-scheme");
  check(
    "the light theme invents no tokens the dark theme has never heard of",
    orphans.length === 0,
    orphans.length ? `only in .light: ${orphans.join(", ")}` : "",
  );
}

console.log("\nThe two themes actually differ");
{
  // A light theme that accidentally copies the dark values is worse than none:
  // the toggle appears to do nothing and looks broken rather than absent.
  const identical = [...light.keys()].filter((name) => dark.get(name) === light.get(name));
  const ALLOWED_SAME = new Set([
    // The brand purple is one colour, not two. Everything else must move.
    "--primary",
    "--primary-foreground",
    "--secondary",
    "--secondary-foreground",
    "--ring",
    "--sidebar-primary",
    "--sidebar-primary-foreground",
    "--sidebar-ring",
    // White on red in both themes. A red button whose label changed colour
    // between themes would be the odd one out, not the consistent one.
    "--destructive-foreground",
  ]);
  const unexpected = identical.filter((name) => !ALLOWED_SAME.has(name));
  check(
    "no colour token was copied across unchanged by accident",
    unexpected.length === 0,
    unexpected.length ? unexpected.join(", ") : "",
  );
  check(
    "and the brand purple is deliberately identical in both",
    dark.get("--primary") === light.get("--primary"),
    `${dark.get("--primary")} vs ${light.get("--primary")}`,
  );
}

console.log("\nText stays readable");
{
  /** `H S% L%` as written in the tokens, to sRGB. */
  function hslToRgb(triplet) {
    const [h, s, l] = triplet
      .trim()
      .split(/\s+/)
      .map((part) => Number(part.replace("%", "")));
    const S = s / 100;
    const L = l / 100;
    const c = (1 - Math.abs(2 * L - 1)) * S;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = L - c / 2;
    const seg = Math.floor(h / 60) % 6;
    const [r, g, b] = [
      [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
    ][seg];
    return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
  }

  const luminance = ([r, g, b]) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };

  const contrast = (a, b) => {
    const [hi, lo] = [luminance(hslToRgb(a)), luminance(hslToRgb(b))].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  // Sanity: the maths itself. Black on white is 21:1, and a formula that has
  // been broken by a refactor will fail here before it misjudges a real pair.
  check(
    "the contrast formula is right (black on white is 21:1)",
    Math.abs(contrast("0 0% 0%", "0 0% 100%") - 21) < 0.01,
    contrast("0 0% 0%", "0 0% 100%").toFixed(2),
  );

  const PAIRS = [
    ["body text on the page", "--foreground", "--background", 4.5],
    ["muted text on the page", "--muted-foreground", "--background", 4.5],
    ["body text on a card", "--card-foreground", "--card", 4.5],
    ["muted text on a card", "--muted-foreground", "--card", 4.5],
    ["text on an accent fill", "--accent-foreground", "--accent", 4.5],
    ["label on a primary button", "--primary-foreground", "--primary", 4.5],
    // Both halves of the destructive split, because the whole reason there are
    // two tokens is that one of them could not satisfy both of these at once.
    ["label on a destructive button", "--destructive-foreground", "--destructive-fill", 4.5],
    ["destructive text on the page", "--destructive", "--background", 4.5],
  ];

  for (const [theme, tokens] of [["dark", dark], ["light", light]]) {
    for (const [what, fg, bg, floor] of PAIRS) {
      const f = tokens.get(fg) ?? dark.get(fg);
      const b = tokens.get(bg) ?? dark.get(bg);
      if (!f || !b) {
        check(`${theme}: ${what}`, false, `missing ${!f ? fg : bg}`);
        continue;
      }
      const r = contrast(f, b);
      check(`${theme}: ${what} — ${r.toFixed(2)}:1`, r >= floor, `needs ${floor}:1`);
    }
  }
}

console.log("\nThe no-flash script and the provider agree");
{
  const html = await readFile("artifacts/editly/index.html", "utf8");
  const provider = await readFile("artifacts/editly/src/lib/theme.tsx", "utf8");

  // The key is written out twice — once in the head, before any module system
  // exists, and once in the provider. If they ever drift, the inline script
  // reads a key nobody writes and every returning visitor gets the flash the
  // script was added to prevent, on a page that otherwise looks fine.
  const inHtml = html.match(/localStorage\.getItem\("([^"]+)"\)/)?.[1];
  const inProvider = provider.match(/THEME_STORAGE_KEY = "([^"]+)"/)?.[1];

  check("the inline script reads a storage key", Boolean(inHtml), String(inHtml));
  check("the provider declares one", Boolean(inProvider), String(inProvider));
  check("and they are the same key", inHtml === inProvider, `${inHtml} vs ${inProvider}`);

  check(
    "the inline script is not deferred — it has to beat the first paint",
    /<script>\s*\(function/.test(html) && !/<script[^>]*\bdefer\b[^>]*>\s*\(function/.test(html),
    "",
  );
  check(
    "and it sets color-scheme too, so native controls match from the start",
    /colorScheme\s*=/.test(html),
    "",
  );
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("Both themes are complete, distinct, and readable.");
