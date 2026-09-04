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
 * Requires: the build, for the one check that reads what actually ships. No
 * browser, no network.
 */
import { readFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { order } from "./lib/order.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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

/*
 * `-mix` is a ratio, not a colour.
 *
 * `--aura-ring-bottom-mix: 92%` is a percentage handed to `color-mix`, and
 * the colour it mixes is the button's own tint — so the same number produces
 * a different colour in each theme, which is exactly the point. Requiring it
 * to differ would mean writing two numbers that mean the same thing and
 * changing one of them for the sake of a check.
 */
const THEME_INDEPENDENT = /^--(app-font|radius|.*-outline$|.*-mix$|opaque-button-border-intensity$)/;


console.log("\nEvery dark token has a light counterpart");
{
  /*
   * Fonts, radii and the type scale are theme-independent by design — a light
   * theme with different corner radii is a different design, not a theme. Only
   * the tokens that carry *colour* have to be answered.
   */

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

console.log("\nEvery token a utility class points at exists");
{
  /*
   * The bug: `@theme inline` maps `--color-primary-border` to
   * `var(--primary-border)`, `button.tsx` writes `border-primary-border` on
   * every solid button — and nothing anywhere defined `--primary-border`.
   *
   * An undefined custom property does not warn. It makes the declaration
   * invalid, `border-color` falls back to its initial value, and that value is
   * `currentColor`. On the primary button `currentColor` is the label, which is
   * white. So every filled button in this product wore a white ring, in both
   * themes, from the day the variant was written, and it looked like a design
   * decision. Five tokens were in that state.
   *
   * This reads the `@theme` block and asks the only question that matters
   * about it: does the thing on the right-hand side exist.
   */
  const themeBlock = blockFor("@theme inline");
  check("the @theme block is where it is expected to be", Boolean(themeBlock));

  const pointsAt = [];
  for (const [, mapped, target] of (themeBlock ?? "").matchAll(
    /(--color-[a-z0-9-]+)\s*:\s*(?:hsl\()?\s*var\((--[a-z0-9-]+)\)/gi,
  )) {
    pointsAt.push([mapped, target]);
  }
  check("and it maps a good number of tokens", pointsAt.length > 20, String(pointsAt.length));

  const defined = new Set([...dark.keys(), ...light.keys()]);
  const dangling = pointsAt.filter(([, target]) => !defined.has(target));
  check(
    `all ${pointsAt.length} tokens the theme exposes are actually defined`,
    dangling.length === 0,
    dangling.length
      ? `undefined, so anything using them falls back to currentColor: ${dangling
          .map(([mapped, target]) => `${mapped} -> ${target}`)
          .join(", ")}`
      : "",
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
  // A token that is not a colour has nothing to differ about: see
  // THEME_INDEPENDENT above. This check used to have its own idea of that, so
  // adding a ratio meant editing two lists or inventing a second number that
  // meant the same as the first.
  const unexpected = identical.filter(
    (name) => !ALLOWED_SAME.has(name) && !THEME_INDEPENDENT.test(name),
  );
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
    // Status colours are read, not admired. These were tuned against a
    // near-black page and shipped as text-green-400 and text-amber-400, which
    // measure 1.8:1 and 2.2:1 on white — the "Ready to Share" heading and the
    // "waiting for a machine" warning were decoration on the light theme.
    ["success text on the page", "--success", "--background", 4.5],
    ["success text on a card", "--success", "--card", 4.5],
    ["warning text on the page", "--warning", "--background", 4.5],
    ["warning text on a card", "--warning", "--card", 4.5],
    // Secondary carries text (labels, icons) *and* sits under white text on the
    // send button and the progress fill. On light both were 3.55:1 at once.
    /*
      The brand colour as *text*, which nothing here measured.

      `--primary-foreground` on `--primary` is a label on a button and it was
      the only direction covered. Used as text on the page, `--primary`
      measures 3.55:1 — and that is what every link on the sign-in screen used:
      Terms, Privacy Policy, "Create an account", "Forgot it?". The words
      somebody has to read before they can have an account, below AA, on the
      theme that is the default. `--link` is the same hue at a lightness that
      clears it on both grounds.
    */
    ["a link on the page", "--link", "--background", 4.5],
    ["a link on a card", "--link", "--card", 4.5],
    ["secondary text on a card", "--secondary", "--card", 4.5],
    ["label on a secondary fill", "--secondary-foreground", "--secondary", 4.5],
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

/**
 * Glass is a material, not a blur.
 *
 * Four properties separate a pane from a grey box at half opacity, and every
 * one of them is the sort of thing that gets "simplified" out by someone
 * tidying a stylesheet who has never seen the two side by side. They are cheap
 * to assert and impossible to argue with once written down.
 */
console.log("\nThe glass is a material rather than a scrim");
{
  const panel = blockFor(".glass-panel") ?? "";
  const ring = blockFor(".glass-panel::before") ?? "";

  // 1. Saturation. Blur alone averages what is behind the pane towards grey.
  //    This is the single change that stops a panel reading as a scrim.
  check(
    "the backdrop keeps its colour instead of turning to grey",
    /backdrop-filter:[^;]*saturate\(/.test(panel),
    "blur without saturate is a scrim with extra steps",
  );
  // Prefixed — but in the *built* stylesheet, which is the one a browser gets.
  //
  // This used to grep the source, and the source obliged: a hand-written
  // `-webkit-backdrop-filter` sat right under the standard property. The
  // minifier knows the two are the same declaration, keeps the last, and threw
  // the standard one away — so the check passed while Chromium computed
  // `backdrop-filter: none` on every panel in the product. A check that reads a
  // different file from the one that ships is a check that can be satisfied
  // without being true.
  //
  // Prefixes are the build's job. This asserts it did the job, and did it in
  // the order that survives minification: alias first, standard last.
  const built = (() => {
    const dir = path.join(repoRoot, "dist/assets");
    if (!existsSync(dir)) return null;
    const file = readdirSync(dir).find((f) => f.endsWith(".css"));
    return file ? readFileSync(path.join(dir, file), "utf8") : null;
  })();
  check(
    "the build was run, so there is a shipped stylesheet to read",
    built !== null,
    "run `pnpm run vercel:build` first — this check reads what ships, not what is written",
  );
  const shippedPanel = built?.match(/\.glass-panel\{[^}]*\}/)?.[0] ?? "";
  check(
    "and is prefixed in the built stylesheet, because Safari is most of this product's audience",
    /-webkit-backdrop-filter:blur\([^)]*\)\s*saturate\(/.test(shippedPanel),
    shippedPanel.slice(0, 160),
  );
  check(
    "with the standard property last, so the minifier keeps it",
    order(shippedPanel, "-webkit-backdrop-filter:", ";backdrop-filter:").ok,
    "alias written after the standard property is how the standard one gets dropped",
  );

  // 2. A tint lit from above rather than a flat fill.
  check(
    "the tint is lit from above rather than poured flat",
    /background-image:\s*linear-gradient/.test(panel),
    "a flat fill is a sheet of plastic",
  );

  // 3. The edge. A one-colour border is the tell that gives away every CSS
  //    glass panel: a real edge catches light at the top and loses it lower.
  check("the edge is drawn as a ring rather than a border", /mask-composite:\s*exclude/.test(ring));
  for (const [name, tokens] of [["dark", dark], ["light", light]]) {
    const lit = tokens.get("--glass-ring-lit");
    const dim = tokens.get("--glass-ring-dim");
    check(
      `and it is brighter at the top than at the bottom in ${name}`,
      Boolean(lit) && Boolean(dim) && lit !== dim,
      `lit ${lit} vs dim ${dim} — the same value on both ends is a plain border`,
    );
  }

  // 4. The fallback, which matters more than it looks: with no backdrop filter
  //    the tint is a window, and text would sit on whatever is behind it.
  check(
    "and where the backdrop cannot be filtered, the panel goes opaque",
    /@supports not \(\(backdrop-filter/.test(css) && /background-color:\s*hsl\(var\(--card\)\)/.test(css),
    "readable beats pretty on a browser that cannot blur",
  );
}

/**
 * And the display face does not tighten Arabic.
 *
 * Cabinet Grotesk is drawn tight and wants negative tracking at heading sizes.
 * It has no Arabic, so an Arabic heading falls through to the sans stack — and
 * the tracking would follow it there and squeeze a script whose letters *join*,
 * which is the difference between a heading and a smudge.
 */
console.log("\nThe headings are set for both scripts");
{
  check("headings take the display face from one rule", /h1, h2, h3, h4 \{[\s\S]{0,200}?font-family: var\(--app-font-display\)/.test(css));
  check(
    "and Arabic headings are given back their tracking and their leading",
    /\[dir="rtl"\][\s\S]{0,220}?letter-spacing: 0;[\s\S]{0,80}?line-height/.test(css),
    "negative tracking on a joined script is a smudge, not a heading",
  );
  check(
    "the Arabic face is in the stack after Inter, so Latin never reaches it",
    /--app-font-sans:\s*'Inter',\s*'IBM Plex Sans Arabic'/.test(css),
    "in front of Inter it would set the English too",
  );
  // The italic serif is a voice, not a structure: it has no Arabic at all, so
  // anything leaning on it structurally collapses the moment this is translated.
  check(
    "and the italic serif is not load-bearing in any heading rule",
    !/h[1-4][^{]*\{[^}]*--app-font-serif/.test(css),
    "an italic serif has no Arabic — a heading built on one cannot be translated",
  );
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

console.log("\nA raw token where a colour belongs voids the whole declaration");
{
  /*
    The defect that removed every focus ring in the product.

    These tokens hold a raw HSL triple, not a colour: `--background: 255 10% 4%`.
    That is the Tailwind convention and it is why every use goes through
    `hsl(var(--token))`. Write `0 0 0 3px var(--background)` instead and the
    value expands to `0 0 0 3px 255 10% 4%`, which is not a length-and-colour —
    so the browser discards the **entire** `box-shadow` declaration at
    computed-value time.

    On a `:focus-visible` rule that also sets `outline: none`, discarding the
    box-shadow leaves nothing at all. Every primary button in the product — the
    five sign-in buttons, Generate Edit, every `.glow-btn` and `.aura-btn` —
    had no visible focus indicator, on a dark interface, and nothing anywhere
    said so: the CSS parses, the class applies, and only somebody navigating by
    keyboard would ever find out.

    So: any token declared as a bare triple may only appear inside a colour
    function. The list of such tokens is read from the stylesheet rather than
    written here, so a new one is covered the day it is added.
  */
  const tripled = new Set();
  for (const [, name, value] of css.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
    // A raw HSL triple: three space-separated numbers, the last two percentages.
    if (/^-?[\d.]+\s+-?[\d.]+%\s+-?[\d.]+%$/.test(value.trim())) tripled.add(name);
  }
  check("the stylesheet still declares tokens as raw triples", tripled.size > 10, String(tripled.size));

  /*
    Comments stripped, and blanked rather than removed, so a reported line
    number still points at the line it came from. This file's own prose talks
    about the bad spelling — the check would otherwise catch the explanation of
    the bug rather than the bug.
  */
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "));
  const bare = [];
  const lines = withoutComments.split("\n");
  lines.forEach((line, i) => {
    for (const [, name] of line.matchAll(/(?<!hsl\()(?<!hsla\()var\((--[a-z0-9-]+)\)/g)) {
      if (!tripled.has(name)) continue;
      // `hsl(var(--x))` and `hsl(var(--x) / 0.4)` are the correct spellings and
      // both put the token inside the function, so the lookbehind above misses
      // only when the function is on an earlier line — which this catches.
      const before = line.slice(0, line.indexOf(`var(${name})`));
      if (/hsla?\($/.test(before) || /hsla?\([^)]*$/.test(before)) continue;
      bare.push(`${CSS_PATH}:${i + 1} ${line.trim().slice(0, 70)}`);
    }
  });
  check(
    "and never uses one outside a colour function",
    bare.length === 0,
    `${bare.join(" | ")} — the declaration is dropped entirely, which on a :focus-visible rule means no focus ring`,
  );

  /*
    And the class that had no rule at all.

    `.aura-chip` is the outline style: Export, "Try that render again", the
    board bar. It sets `box-shadow` in three states and never for
    `:focus-visible` — which does not merely fail to draw a ring, it *removes*
    the one Tailwind would have drawn, because Tailwind's focus ring is also a
    box-shadow and this rule's specificity wins.
  */
  for (const cls of ["glow-btn", "aura-btn", "aura-chip"]) {
    check(
      `.${cls} says what focus looks like`,
      new RegExp(`\\.${cls}:focus-visible\\s*\\{`).test(css),
      "a class that sets box-shadow and not :focus-visible outranks the framework's ring and shows nothing",
    );
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("Both themes are complete, distinct, and readable.");
