/**
 * The features section, held to the three things a recording cannot show.
 *
 * The landing page's "what it does today" is a tall section that hands you one
 * feature at a time as you scroll. It was built from a reference recording, and
 * a recording is exactly where this pattern hides its failures: a scroll that
 * has been taken away from the person and a section that is simply tall look
 * **identical** on video, the fifth feature never being reachable looks like a
 * section that ended, and a phone getting five viewports of pinned nothing
 * looks like a phone that was never opened.
 *
 * So this suite asks three questions that no screenshot answers.
 *
 * ## 1. Does the arithmetic reach every feature, and nothing past the last one
 *
 * `lib/feature-scroll.ts` is a pure function from a rectangle to an index, and
 * that is why it is a module rather than four lines inside a component: it can
 * be driven through a whole page of scroll positions here, a pixel at a time,
 * including the two positions where this always breaks — the exact top, where
 * an off-by-one shows the second feature before the first, and the exact
 * bottom, where `Math.floor(1 * count)` indexes one past the end and the last
 * panel is `undefined`. Both of those render as a blank right-hand column and
 * throw nothing at all.
 *
 * ## 2. Is every sentence on it a sentence the product understands
 *
 * Each feature carries a real request — "Cut the silences and caption it" — and
 * pressing it carries that sentence into the app. Every one of them is run
 * through the **real** `planFromText` here, in both languages, and has to
 * produce operations. The keyword parser and not the model, for the reason
 * `first-run.ts` gives: the model is better and needs a key, and the parser is
 * what answers when there is none. A prompt on a landing page that the product
 * would not understand is the most embarrassing lie available to us, and it is
 * one check away from impossible.
 *
 * ## 3. Is it still a sticky section rather than a hijacked scroll
 *
 * This is the check with the shortest half-life. The way this pattern gets
 * "improved" is a wheel listener, and the moment one appears the page stops
 * scrolling at the speed the person scrolls it. Nothing fails; the page just
 * becomes unpleasant in a way nobody files a bug about. So the component is
 * read for the listeners it must not have, for the passive scroll listener it
 * must have, and for the path that has no pin at all — below `md` and whenever
 * somebody has asked for less motion.
 *
 * Usage: node tools/feature-scroll-test.mjs
 * Requires: nothing.
 */
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { order } from "./lib/order.mjs";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-features-"));

function build(source, name) {
  const outfile = path.join(buildDir, name);
  const built = spawnSync(
    // Resolved from the API server, which is where esbuild is a dependency.
    // The front end does not depend on it and never should.
    require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] }),
    [
      path.join(repoRoot, source),
      "--bundle", "--platform=node", "--format=esm", "--target=node22",
      `--outfile=${outfile}`, "--log-level=error",
    ],
    { stdio: "inherit" },
  );
  if (built.status !== 0) process.exit(1);
  return pathToFileURL(outfile).href;
}

const scroll = await import(build("artifacts/editly/src/lib/feature-scroll.ts", "scroll.mjs"));
const { pinProgress, activeFromProgress, activeFromRect, scrollTopForIndex } = scroll;
const { LANDING } = await import(build("artifacts/editly/src/lib/landing-copy.ts", "copy.mjs"));
const { planFromText } = await import(build("artifacts/api-server/src/lib/plan-from-text.ts", "plan.mjs"));
const { askedSentence } = await import(build("artifacts/editly/src/lib/first-run.ts", "first-run.mjs"));

const read = (file) => readFile(path.join(repoRoot, file), "utf8");

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

const FEATURES = LANDING.features.list;
const COUNT = FEATURES.length;

// ── 1. The arithmetic ───────────────────────────────────────────────────────

section("Scrolling the section reaches every feature and stops at the last one");
{
  /*
    A section as the browser would report it: five viewports of travel plus the
    one that is still on screen when the pin ends. 900 is a plausible viewport
    and the numbers below are in its units, so a failure reads in pixels.
  */
  const viewport = 900;
  const height = COUNT * viewport + viewport;
  const at = (scrolled) => ({ top: -scrolled, height, viewport });

  check("nothing has happened before the section reaches the top", pinProgress(at(0)) === 0);
  check(
    "and it is still zero while the section is below the fold",
    pinProgress({ top: 600, height, viewport }) === 0,
    String(pinProgress({ top: 600, height, viewport })),
  );
  check("the pin is finished once its travel has gone by", pinProgress(at(height - viewport)) === 1);
  check(
    "and does not keep counting past the end",
    pinProgress(at(height + 10_000)) === 1,
    String(pinProgress(at(height + 10_000))),
  );

  /*
    The first feature at the top and the last at the bottom, which is the pair
    of positions this arithmetic exists to get right. `Math.floor(1 * count)`
    is `count` — one past the end of the array — and the panel it selects is
    `undefined`, which React renders as nothing at all.
  */
  check("the first feature is the one showing when the pin starts", activeFromRect(at(0), COUNT) === 0);
  check(
    "and the last one is showing when it ends, rather than nothing at all",
    activeFromRect(at(height - viewport), COUNT) === COUNT - 1,
    String(activeFromRect(at(height - viewport), COUNT)),
  );

  /*
    Then every pixel of it, which is cheap and is the only way to find the
    index that appears for four pixels between two slices.
  */
  const seen = new Set();
  let outOfRange = null;
  let wentBackwards = null;
  let previous = 0;
  for (let scrolled = 0; scrolled <= height - viewport; scrolled += 1) {
    const index = activeFromRect(at(scrolled), COUNT);
    if (!Number.isInteger(index) || index < 0 || index >= COUNT) outOfRange ??= `${scrolled}px → ${index}`;
    if (index < previous) wentBackwards ??= `${scrolled}px → ${index} after ${previous}`;
    previous = index;
    seen.add(index);
  }
  check("every feature is reachable by scrolling", seen.size === COUNT, `${seen.size} of ${COUNT}`);
  check("no scroll position selects a feature that is not there", outOfRange === null, outOfRange ?? "");
  check("and scrolling forwards never goes backwards through the list", wentBackwards === null, wentBackwards ?? "");

  /*
    Each feature gets the same share. Not tidiness: an uneven split is how one
    of five ends up visible for a tenth of the scroll the others get, which
    reads as a flicker rather than as a feature.
  */
  const spans = [...Array(COUNT)].map(() => 0);
  for (let scrolled = 0; scrolled <= height - viewport; scrolled += 1) spans[activeFromRect(at(scrolled), COUNT)] += 1;
  const spread = Math.max(...spans) - Math.min(...spans);
  check("and each of them gets the same share of it", spread <= 2, `widest ${Math.max(...spans)}px, narrowest ${Math.min(...spans)}px`);
}

section("Pressing a name lands on that feature and not on its neighbour");
{
  const viewport = 900;
  const height = COUNT * viewport + viewport;
  const sectionTop = 4321; // Somewhere down a long page, as it actually is.

  let wrong = null;
  for (let index = 0; index < COUNT; index += 1) {
    const target = scrollTopForIndex(index, COUNT, { sectionTop, height, viewport });
    const landed = activeFromRect({ top: sectionTop - target, height, viewport }, COUNT);
    if (landed !== index) wrong ??= `press ${index} → ${landed}`;
  }
  check("every name scrolls to its own feature", wrong === null, wrong ?? "");

  /*
    A press aims at the middle of a slice rather than its start, so that the
    very next scroll event does not flip it to the neighbour. Checked as a
    property: a pixel either side of where a press lands is still the same
    feature.
  */
  let fragile = null;
  for (let index = 0; index < COUNT; index += 1) {
    const target = scrollTopForIndex(index, COUNT, { sectionTop, height, viewport });
    for (const nudge of [-40, 40]) {
      const landed = activeFromRect({ top: sectionTop - (target + nudge), height, viewport }, COUNT);
      if (landed !== index) fragile ??= `press ${index} then ${nudge}px → ${landed}`;
    }
  }
  check("and a small nudge afterwards does not knock it onto the next one", fragile === null, fragile ?? "");
}

section("The maths says nothing rather than something wrong when it is asked nonsense");
{
  /*
    Every one of these arrives in a real browser. A section measured before
    layout has height 0; a `useEffect` that runs one frame early reads a
    viewport of 0; and `count` is 0 for exactly as long as it takes a copy file
    to be edited. None of them should throw and none should produce an index.
  */
  check("a section with no height yet", pinProgress({ top: 0, height: 0, viewport: 900 }) === 0);
  check("a viewport taller than the section", pinProgress({ top: -100, height: 400, viewport: 900 }) === 0);
  check("a measurement that came back as nothing", pinProgress({ top: NaN, height: 5000, viewport: 900 }) === 0);
  check("an infinite one", pinProgress({ top: -Infinity, height: 5000, viewport: 900 }) === 1);
  check("and an empty list", activeFromProgress(0.5, 0) === 0);
  check("progress of exactly one is the last feature, not the one after it", activeFromProgress(1, COUNT) === COUNT - 1);
  check("and progress below zero is the first", activeFromProgress(-3, COUNT) === 0);
  check(
    "an index pressed from outside the list is clamped into it",
    scrollTopForIndex(99, COUNT, { sectionTop: 0, height: 5400, viewport: 900 }) ===
      scrollTopForIndex(COUNT - 1, COUNT, { sectionTop: 0, height: 5400, viewport: 900 }),
  );
}

// ── 2. The words ────────────────────────────────────────────────────────────

section("Every sentence the section offers is one the product understands");
{
  check("there are features to show", COUNT >= 4, String(COUNT));
  check(
    "each says what it is and what that means, in both languages",
    FEATURES.every((f) => f.title.ar && f.title.en && f.detail.ar.length > 20 && f.detail.en.length > 20),
  );
  check(
    "and each carries a request somebody could actually make",
    FEATURES.every((f) => f.prompt && f.prompt.ar.length > 8 && f.prompt.en.length > 10),
  );

  for (const [index, feature] of FEATURES.entries()) {
    for (const language of ["en", "ar"]) {
      const plan = planFromText(feature.prompt[language], {});
      const types = plan.operations.map((o) => o.type);
      /*
        Two, matching `onboarding-test`, and for the same reason: one operation
        is the floor for "it parsed at all", two is the floor for "this was
        worth putting on a landing page". A prompt that produces a single
        caption pass advertises a product that does one thing.
      */
      check(
        `feature ${index + 1} (${language}) asks for a real edit`,
        types.length >= 2,
        types.join(", ") || "nothing at all",
      );
    }
  }

  check(
    "no Arabic prompt is a transliteration of its English one",
    FEATURES.every((f) => !/[a-z]{4}/i.test(f.prompt.ar)),
  );
  /*
    Numbers are the half of a bilingual pair that drifts silently: "3 clips" in
    one column and «مقطعين» in the other is two different promises, and both
    render perfectly. `landing-test` holds the whole copy file to this; it is
    repeated here because the prompts are the strings that get *sent*, and a
    mismatch in one of them means the product does something other than what
    the page said it would.
  */
  let mismatched = null;
  for (const feature of FEATURES) {
    const digits = (s) => (s.match(/\d+/g) ?? []).join(",");
    if (digits(feature.prompt.ar) !== digits(feature.prompt.en)) {
      mismatched ??= `${feature.prompt.en} / ${feature.prompt.ar}`;
    }
  }
  check("and a prompt asks for the same number in both languages", mismatched === null, mismatched ?? "");

  check(
    "nothing customer-facing here uses an em dash",
    !FEATURES.some((f) =>
      [f.title, f.detail, f.prompt].some((pair) => pair.ar.includes("—") || pair.en.includes("—")),
    ),
  );
  check(
    "the section introduces itself in both languages",
    Boolean(LANDING.features.lead?.ar && LANDING.features.lead?.en && LANDING.features.tryIt?.ar),
  );
}

section("The sentence somebody presses survives the trip into the product");
{
  /*
    The chip carries its sentence in the URL because a sign-in happens in
    between and a module variable does not survive the reload. Which makes the
    query string an input written by whoever made the link.
  */
  check("a pressed sentence arrives", askedSentence("?ask=Cut%20the%20silences") === "Cut the silences");
  check("with or without the question mark", askedSentence("ask=Cut%20the%20silences") === "Cut the silences");
  check("nothing asked for is nothing carried", askedSentence("") === "" && askedSentence("?other=1") === "");
  check("an empty ask is not a sentence", askedSentence("?ask=") === "" && askedSentence("?ask=%20%20") === "");
  check("Arabic comes through as Arabic", askedSentence("?ask=" + encodeURIComponent("اقصص الصمت")) === "اقصص الصمت");
  check(
    "a line break cannot turn one sentence into two",
    askedSentence("?ask=" + encodeURIComponent("one\ntwo")) === "one two",
  );
  check(
    "control characters are not carried into a text box",
    askedSentence("?ask=" + encodeURIComponent("a bc")) === "a b c",
  );
  check(
    "and neither is a bidi override, on a page that reads both directions",
    askedSentence("?ask=" + encodeURIComponent("‮reversed")) === "reversed",
  );
  check(
    "a link cannot place a message the server would refuse",
    askedSentence("?ask=" + "x".repeat(9000)).length === 2000,
    String(askedSentence("?ask=" + "x".repeat(9000)).length),
  );
  /*
    A half-written percent escape is not an error to anybody: `URLSearchParams`
    keeps the bytes it can make sense of and leaves the rest alone. What matters
    is that it comes back as an ordinary string rather than as a throw on the
    render of a screen - so this asks for that, and not for a particular
    salvage.
  */
  const malformed = askedSentence("?ask=%E0%A4%A");
  check("and a malformed query string is a string rather than a crash", typeof malformed === "string");

  const onboarding = await read("artifacts/editly/src/pages/onboarding.tsx");
  check("the first-run screen reads it", /askedSentence\(window\.location\.search\)/.test(onboarding));
  check(
    "and reads it once, at mount, rather than fighting the person typing",
    /useState\(\(\) =>\s*\n?\s*typeof window === "undefined" \? "" : askedSentence/.test(onboarding),
  );
  const scroller = await read("artifacts/editly/src/components/feature-scroller.tsx");
  check(
    "the chip points at the screen that reads it",
    /setLocation\(`\/onboarding\?ask=\$\{encodeURIComponent\(prompt\)\}`\)/.test(scroller),
    "the prompt is being sent somewhere that does not read it, which loses the sentence silently",
  );
  const app = await read("artifacts/editly/src/App.tsx");
  check("that route exists", /<Route path="\/onboarding">/.test(app));
  check(
    "and the sign-in in between carries the sentence rather than dropping it",
    /window\.location\.pathname\}\$\{window\.location\.search\}/.test(app),
    "Protected forwards only the path, so signing in would drop the sentence somebody pressed",
  );
}

// ── 3. The mechanism ────────────────────────────────────────────────────────

section("It is a tall section, not a scroll taken away from somebody");
{
  const scroller = await read("artifacts/editly/src/components/feature-scroller.tsx");

  /*
    The listeners that turn this pattern from "the page is taller" into "the
    page decides how fast you move". Every one of them is how the reference
    pattern is usually built and every one of them is why people hate it.
  */
  for (const [name, pattern] of [
    ["wheel", /addEventListener\(\s*"wheel"/],
    ["touchmove", /addEventListener\(\s*"touchmove"/],
    ["keydown on the window", /window\.addEventListener\(\s*"keydown"/],
  ]) {
    check(`nothing listens for ${name}`, !pattern.test(scroller));
  }
  check(
    "and nothing cancels a scroll event",
    !/(scroll|wheel|touchmove)[\s\S]{0,120}preventDefault/.test(scroller),
  );
  check(
    "the one scroll listener it has is passive, so the page moves before JavaScript does",
    /window\.addEventListener\("scroll", onScroll, \{ passive: true \}\)/.test(scroller),
  );
  check(
    "and it does its reading once a frame rather than once an event",
    /requestAnimationFrame/.test(scroller) && /cancelAnimationFrame/.test(scroller),
  );
  /*
    The only `scrollTo` that belongs here is the one a click asks for. A second
    one — snapping to a slice as the person scrolls past it — is the thing that
    makes a trackpad feel broken.
  */
  check("the only scrollTo is the one a press asks for", (scroller.match(/scrollTo\(/g) ?? []).length === 1);
  check(
    "the height is what the pin is made of",
    /height: `calc\(\$\{count \* VIEWPORTS_PER_FEATURE\} \* 100vh \+ 100vh\)`/.test(scroller),
  );
  check("and the contents are held still with sticky", /sticky top-0 h-screen/.test(scroller));
  check(
    "one viewport per feature, because more is what makes a section feel stuck",
    /const VIEWPORTS_PER_FEATURE = 1;/.test(scroller),
  );
}

section("On a phone, and for anybody who asked for less motion, there is no pin at all");
{
  const scroller = await read("artifacts/editly/src/components/feature-scroller.tsx");
  check(
    "the pin is decided by the width and by the motion preference together",
    /\(min-width: 768px\)/.test(scroller) && /\(prefers-reduced-motion: reduce\)/.test(scroller),
  );
  check(
    "both of which are listened to, because both can change while the page is open",
    (scroller.match(/addEventListener\("change", decide\)/g) ?? []).length === 2,
  );
  check("and without the pin the five are simply five blocks", /data-testid="features-stacked"/.test(scroller));
  const decided = order(scroller, "if (!pinned) return;", "window.addEventListener(\"scroll\"");
  check(
    "nothing listens to the scroll on the path that has no pin",
    decided.ok,
    decided.why,
  );
  check(
    "and a press with no pin still changes the feature, rather than doing nothing",
    /if \(!node \|\| !pinned\) \{\s*\n\s*setActive\(index\);/.test(scroller),
  );
}

section("It is a tab set, so it can be read without a mouse");
{
  const scroller = await read("artifacts/editly/src/components/feature-scroller.tsx");
  check('the list says it is one', /role="tablist"/.test(scroller));
  check("each name is a button, not a decorated div", /role="tab"/.test(scroller) && /<button/.test(scroller));
  check("the panel is named as the thing they control", /role="tabpanel"/.test(scroller) && /aria-controls="feature-panel"/.test(scroller));
  check("which one is current is stated and not only coloured", /aria-selected=\{current\}/.test(scroller));
  check(
    "only the current one is in the tab order, which is what a tab set means",
    /tabIndex=\{current \? 0 : -1\}/.test(scroller),
  );
  check(
    "the arrow keys move between features",
    /ArrowRight/.test(scroller) && /ArrowLeft/.test(scroller) && /ArrowDown/.test(scroller),
  );
  /*
    And they move the right way round. "Next" is the right arrow in English and
    the left arrow in Arabic, and getting this backwards is invisible to anyone
    testing in one language — which is every way this repository has found this
    class of bug so far.
  */
  check(
    "and forwards means forwards in the language being read",
    /const forward = rtl \? "ArrowLeft" : "ArrowRight";/.test(scroller),
  );
  check("the panels that are not showing are hidden from a screen reader", /aria-hidden=\{item\.index !== active\}/.test(scroller));
  check(
    "and cannot be pressed through",
    /pointer-events-none/.test(scroller),
    "a panel at opacity 0 still takes clicks unless it is told not to",
  );
}

section("The old section is gone, and nothing is left pointing at it");
{
  const home = await read("artifacts/editly/src/pages/home.tsx");
  const copy = await read("artifacts/editly/src/lib/landing-copy.ts");
  check("the page renders the section", /<FeatureScroller \/>/.test(home));
  check("and imports it", /import \{ FeatureScroller \} from "@\/components\/feature-scroller";/.test(home));
  check(
    "the grid of tiles it replaced is gone from the page",
    !/LANDING\.features\.grid/.test(home),
    "the page still reads a copy field that no longer exists",
  );
  check("and from the copy file", !/\n    grid: \[/.test(copy));
  check(
    "nothing is left over from it",
    !/MIRROR_CELL/.test(home) && !/CheckCircle2/.test(home),
    "a constant or an icon the old section owned is still imported",
  );
  const art = await read("artifacts/editly/src/components/feature-art.tsx");
  /*
    No text in the drawings, which is a rule with three separate reasons: text
    in an SVG does not take the page's font, `scale(-1,1)` renders the letters
    backwards when the page is mirrored for Arabic, and a string in here is a
    string outside the copy file, where the bilingual check cannot see it.
  */
  check("no drawing contains text", !/<text/.test(art));
  /*
    Mirrored as one group or not at all. Flipping shape by shape is how a
    drawing ends up with its arrow reversed and its boxes where they were, and
    the only way to see it is to load the page in Arabic - which is why it is
    one transform on one `<g>` and checked here instead.
  */
  check(
    "and the ones that read left to right are mirrored whole, rather than per-shape",
    /const flipAbout = \(x0: number, width: number\) =>/.test(art) &&
      /transform=\{flow && rtl \? flipAbout\(x, width\) : undefined\}/.test(art),
  );
  /*
    And mirrored about the box they are shown through, not about the grid they
    were drawn on. Those are the same number only for a drawing that uses the
    whole grid; for every other one, mirroring about 320 slides the picture
    sideways by exactly the margin that was cropped - off the edge of the panel,
    in Arabic, where whoever wrote it will not be looking.
  */
  check(
    "about the box they are shown through rather than the grid they were drawn on",
    /`translate\(\$\{2 \* x0 \+ width\},0\) scale\(-1,1\)`/.test(art),
  );
  check(
    "and the ones that do not read in a direction are left alone",
    /flow=\{false\}/.test(art),
    "every drawing is being mirrored, including the ones that are compositions rather than flows",
  );
  /*
    `speed-test` penalises filters and blur radii on this page and refuses a
    hidden `<video>`; drawings are the cheapest thing that can carry a claim,
    and they stop being cheap the moment one of them is animated.
  */
  check("nothing in them is filtered or animated", !/filter=|<animate|blur\(/.test(art));
}

await rm(buildDir, { recursive: true, force: true });
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
console.log("Scrolling hands over every feature, and every sentence on it is one the product answers.");
