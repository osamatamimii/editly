/**
 * The page in both languages, and the same page in both.
 *
 * The product has been bilingual since the first render note: every refusal,
 * every reply and every clip title has an Arabic text and an English one, and
 * the matcher that turns a sentence into an edit reads both. The landing page
 * was the one surface that did not, which meant the first thing the first
 * audience saw was in a language chosen for somebody else.
 *
 * Making it bilingual is easy. Keeping it bilingual is not, and every way it
 * decays is quiet:
 *
 *   - A line is improved in English and the Arabic keeps yesterday's claim.
 *   - A price is changed in one column. Now the page states two prices and
 *     both look confident.
 *   - A new section is added and only half of it is written, so an Arabic
 *     reader gets a paragraph of English in the middle of the page.
 *   - The layout is right in one direction and broken in the other, which
 *     nobody sees because nobody on the team reads the page in the direction
 *     they do not use.
 *
 * None of those throws. So this suite reads the copy as data and *renders the
 * built page in both directions*, which is the only way to catch the last one.
 *
 * A note on the regexes below, paid for once already: `\b` does not work on
 * Arabic. Word boundaries in JavaScript are defined against ASCII word
 * characters, so `\bومضة\b` matches in places you did not mean and fails in
 * places you did. Every pattern here that has to find an Arabic word does it
 * by inclusion or by an explicit character class.
 *
 * Usage: node tools/landing-test.mjs
 * Requires: a built `dist/` (pnpm run vercel:build) and a Chromium. No keys,
 * no network, no database.
 */
import http from "node:http";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-landing-"));

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
const section = (title) => console.log(`\n${title}`);

function build(source, name) {
  const outfile = path.join(buildDir, name);
  const built = spawnSync(
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

const copy = await import(build("artifacts/editly/src/lib/landing-copy.ts", "copy.mjs"));
const pricing = await import(build("artifacts/editly/src/lib/pricing.ts", "pricing.mjs"));
const planLimits = await import(build("artifacts/api-server/src/lib/plan-limits.ts", "limits.mjs"));

const ARABIC = /[؀-ۿ]/;

/** Every pair in the tree, with the path that leads to it. */
function pairsOf(node, trail = []) {
  if (node && typeof node === "object" && typeof node.ar === "string" && typeof node.en === "string") {
    return [{ path: trail.join("."), pair: node }];
  }
  if (Array.isArray(node)) return node.flatMap((child, i) => pairsOf(child, [...trail, String(i)]));
  if (node && typeof node === "object") {
    return Object.entries(node).flatMap(([key, child]) => pairsOf(child, [...trail, key]));
  }
  return [];
}

const pairs = pairsOf(copy.LANDING);

/**
 * The one pair that is deliberately the wrong way round.
 *
 * The switch is labelled in the language it switches *to*, so the Arabic page
 * shows the word "English" and the English page shows العربية. Naming it here
 * rather than loosening the rule keeps the rule sharp for the other hundred.
 */
const INVERTED = new Set(["languageToggle.label", "languageToggle.title"]);

/**
 * Latin words an Arabic sentence is allowed to keep.
 *
 * Platform and product names, and one unit. TikTok is called TikTok in Arabic
 * and transliterating it is how you look like you have not used it; LUFS is a
 * unit, and a unit translated is a unit nobody can look up. The list is short
 * on purpose: a *new* English word inside an Arabic sentence should be a
 * failing check rather than a habit that spreads one line at a time.
 */
const KEEPS_ITS_NAME = [
  "Editly", "TikTok", "Reels", "Shorts", "YouTube", "LUFS", "API",
  "Creator", "Pro", "Studio", "Noah", "English",
  "raw-take.mov",
];

// ── Both halves, every time ─────────────────────────────────────────────────

section("Every line on the page exists in both languages");
{
  check("there is a page's worth of copy to read", pairs.length > 60, `${pairs.length} pairs`);

  const empty = pairs.filter(({ pair }) => !pair.ar.trim() || !pair.en.trim());
  check("no pair has an empty side", empty.length === 0, empty.map((e) => e.path).join(", "));

  /*
    A pair whose two sides are identical is almost always one that was never
    written: somebody added the English and copied it across to make the type
    check pass. The exceptions are real and few, and they are things that are
    the same string in both languages rather than translations of each other.
  */
  const SAME_IN_BOTH = new Set(["steps.one.file", "steps.one.duration", "steps.three.output"]);
  const identical = pairs.filter(({ path: at, pair }) => pair.ar === pair.en && !SAME_IN_BOTH.has(at));
  check("and no pair is the English twice", identical.length === 0, identical.map((e) => e.path).join(", "));

  const notArabic = pairs.filter(
    ({ path: at, pair }) => !INVERTED.has(at) && !SAME_IN_BOTH.has(at) && !ARABIC.test(pair.ar),
  );
  check("the Arabic side is written in Arabic", notArabic.length === 0, notArabic.map((e) => e.path).join(", "));

  const arabicInEnglish = pairs.filter(({ path: at, pair }) => !INVERTED.has(at) && ARABIC.test(pair.en));
  check("and the English side is not", arabicInEnglish.length === 0, arabicInEnglish.map((e) => e.path).join(", "));
}

section("The Arabic is Arabic, not English with the words moved");
{
  /*
    Latin letters left inside an Arabic sentence, minus the names that belong
    there. This is what catches half a paragraph pasted across, and it is also
    what would catch somebody "translating" by leaving the hard half alone.
  */
  const leftovers = [];
  for (const { path: at, pair } of pairs) {
    if (INVERTED.has(at)) continue;
    let stripped = pair.ar;
    for (const name of KEEPS_ITS_NAME) stripped = stripped.split(name).join("");
    const latin = stripped.match(/[A-Za-z]{2,}/g);
    if (latin) leftovers.push(`${at}: ${latin.join(" ")}`);
  }
  check("no English words are left inside the Arabic", leftovers.length === 0, leftovers.join(" | "));

  // The em dash is out of this product's writing everywhere; `browser-test`
  // enforces it across every package. Said here too because this is the file
  // where new sentences are written, and a failure two suites later is a
  // failure somebody has to go looking for.
  const dashes = pairs.filter(({ pair }) => pair.ar.includes("—") || pair.en.includes("—"));
  check("and no sentence carries an em dash", dashes.length === 0, dashes.map((e) => e.path).join(", "));
}

// ── The numbers ─────────────────────────────────────────────────────────────

section("A figure is the same figure in both languages");
{
  /*
    Every digit in the pair, in order, compared as a set.

    Order is not compared because Arabic puts the words round the number
    differently, and a sentence is allowed to be a sentence. What is not
    allowed is a number appearing in one side and not the other: that is a page
    quoting two prices, or promising thirty minutes in one language and twenty
    in the other, with both stated confidently.
  */
  const numbersIn = (text) => (text.match(/\d+(?:\.\d+)?/g) ?? []).slice().sort();
  const mismatched = pairs.filter(({ path: at, pair }) => {
    if (INVERTED.has(at)) return false;
    const a = numbersIn(pair.ar);
    const b = numbersIn(pair.en);
    return a.length !== b.length || a.some((n, i) => n !== b[i]);
  });
  check(
    "no pair states one number in Arabic and another in English",
    mismatched.length === 0,
    mismatched.map((e) => `${e.path}: ${e.pair.ar} / ${e.pair.en}`).join(" | "),
  );

  // The figures the page actually leans on, spot-checked against what the
  // server enforces rather than against themselves. `pricing-test` does this
  // for the English; this is the half of the page it cannot see.
  const free = planLimits.PLAN_LIMITS.free;
  check(
    "the Arabic free tier promises the minutes the server allows",
    copy.PRICING_AR.free.lines[0].includes(String(free.minutesPerMonth)),
    copy.PRICING_AR.free.lines[0],
  );
  check(
    "and the upload length the server allows",
    copy.PRICING_AR.free.lines[1].includes(String(free.maxUploadMinutes)),
    copy.PRICING_AR.free.lines[1],
  );
  /*
    Only where the English states a limit at all.

    Studio's line is "3 seats, brand kit, API": it sells the seats rather than
    the upload length, and demanding a number of its Arabic would be demanding
    a claim the English does not make. So the rule is the one that matters,
    which is that the two sides state the *same* thing: wherever the English
    names the ceiling, the Arabic names the same ceiling, in minutes or in the
    hours the English happens to use.
  */
  for (const plan of pricing.PLANS) {
    const arabic = copy.PRICING_AR.plans[plan.key];
    const minutes = planLimits.PLAN_LIMITS[plan.key].maxUploadMinutes;
    const namesIt = (line) => line.includes(String(minutes)) || line.includes(String(minutes / 60));
    if (!namesIt(plan.upload)) continue;
    check(
      `the Arabic ${plan.key} card promises the upload length the server allows`,
      namesIt(arabic.upload),
      `${arabic.upload} vs ${minutes} minutes`,
    );
  }
}

section("The pricing sentences have one English source, not two");
{
  /*
    The four pricing strings are the only ones on the page whose English is not
    in the copy file, and that is deliberate: it lives in `lib/pricing.ts`,
    which `tools/pricing-test.mjs` reads beside the limits the server enforces.
    A second English copy here would be a page making promises nothing checks.
  */
  const source = readFileSync(path.join(repoRoot, "artifacts/editly/src/lib/landing-copy.ts"), "utf8");
  for (const line of pricing.SHARED_FEATURES) {
    check(
      `"${line.slice(0, 34)}…" is not copied into the landing file`,
      !source.includes(line),
      "the English half of a pricing line belongs to lib/pricing.ts alone",
    );
  }
  check(
    "the two lists are the same length, so no line is unpaired",
    copy.PRICING_AR.shared.length === pricing.SHARED_FEATURES.length &&
      copy.PRICING_AR.free.lines.length === pricing.FREE_TIER.lines.length,
    `${copy.PRICING_AR.shared.length}/${pricing.SHARED_FEATURES.length}, ${copy.PRICING_AR.free.lines.length}/${pricing.FREE_TIER.lines.length}`,
  );
}

section("Nothing on the page is a sentence typed into the markup");
{
  /*
    The point of the copy file is that there is one place to change a sentence.
    A line written straight into the JSX still renders, still looks right in
    English, and is simply absent in Arabic, which is the failure this whole
    point exists to end.
  */
  const home = readFileSync(path.join(repoRoot, "artifacts/editly/src/pages/home.tsx"), "utf8");
  const rendered = [...home.matchAll(/>\s*([A-Za-z][A-Za-z ,.'’!?:%-]{9,})\s*</g)].map((m) => m[1].trim());
  check("no rendered English text is left in the page", rendered.length === 0, rendered.slice(0, 6).join(" | "));

  check("the page reads its language from the copy file", /from "@\/lib\/landing-copy"/.test(home));
  check(
    "and it defaults to Arabic",
    copy.DEFAULT_LANGUAGE === "ar",
    "this is the point: the first audience is Arabic-speaking",
  );
  check(
    "the waiting-list page is untouched, as it must be",
    !home.includes("artifacts/waitlist"),
    "waitlist/index.html is out of bounds for this work",
  );
}

// ── And then the page itself, in a browser, both ways round ─────────────────

const dist = path.join(repoRoot, "dist");
if (!existsSync(dist)) {
  console.error("dist/ is not built — run `pnpm run vercel:build` from the repo root first.");
  process.exit(1);
}

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2", ".woff": "font/woff" };
const server = http.createServer(async (req, res) => {
  let file = path.join(dist, decodeURIComponent(req.url.split("?")[0]));
  if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(dist, "index.html");
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("no");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

const { chromium } = require(
  require.resolve("playwright", { paths: [`${process.env.HOME}/.npm-global/lib/node_modules`, repoRoot] }),
);
function findChromium() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (root && existsSync(root)) {
    const dir = readdirSync(root).find((d) => /^chromium-\d+$/.test(d));
    if (dir) {
      const candidate = path.join(root, dir, "chrome-linux", "chrome");
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}
const browser = await chromium.launch({
  ...(findChromium() ? { executablePath: findChromium() } : {}),
  args: ["--no-sandbox"],
});

async function open(url) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error.message)));
  await page.goto(ORIGIN + url, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  return { context, page, errors };
}

const say = (pair, language) => pair[language];

section("The page opens in Arabic, and it opens the right way round");
{
  const { context, page, errors } = await open("/");
  const landing = page.locator('[data-testid="landing"]');
  check("it renders without throwing", errors.length === 0, errors.slice(0, 3).join(" | "));
  check("the wrapper declares the language", (await landing.getAttribute("lang")) === "ar");
  check("and the direction", (await landing.getAttribute("dir")) === "rtl");
  check(
    "the browser really lays it out right to left",
    (await landing.evaluate((el) => getComputedStyle(el).direction)) === "rtl",
  );

  const text = await page.locator("body").innerText();
  check("the headline is the Arabic one", text.includes(say(copy.LANDING.hero.headlineLead, "ar")), text.slice(0, 80));
  check("and the English headline is nowhere on it", !text.includes(say(copy.LANDING.hero.headlineLead, "en")));

  /*
    The whole page, not the headline.

    A section left untranslated is exactly the failure that survives a spot
    check: the hero is the part everybody looks at, and the pricing footnote is
    the part nobody does. So every English sentence in the copy file is looked
    for, and finding one means a piece of the page did not switch.
  */
  const leaked = [];
  for (const { path: at, pair } of pairs) {
    if (INVERTED.has(at)) continue;
    if (pair.en === pair.ar) continue;
    if (pair.en.length < 12) continue;
    if (text.includes(pair.en)) leaked.push(at);
  }
  check("no English sentence is left on the Arabic page", leaked.length === 0, leaked.slice(0, 6).join(", "));

  check(
    "the drawing of the editor speaks Arabic too",
    text.includes(say(copy.LANDING.heroEditor.rawTake, "ar")) &&
      text.includes(say(copy.LANDING.heroEditor.assistant, "ar")),
    "the hero mock is the largest thing on the page and the easiest to leave in English",
  );

  // A phone is where this page is read, and a right-to-left layout is a
  // different layout: a row that fits in one direction can push the document
  // sideways in the other.
  const overflow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    view: window.innerWidth,
  }));
  check(
    "and nothing pushes the page sideways on a phone",
    overflow.scroll <= overflow.view + 1,
    `${overflow.scroll} > ${overflow.view}`,
  );

  await context.close();
}

section("A link can ask for English, and the page stays in it");
{
  const { context, page, errors } = await open("/?lang=en");
  const landing = page.locator('[data-testid="landing"]');
  check("it renders without throwing", errors.length === 0, errors.slice(0, 3).join(" | "));
  check("the wrapper says English", (await landing.getAttribute("lang")) === "en");
  check("and turns back round", (await landing.getAttribute("dir")) === "ltr");

  const text = await page.locator("body").innerText();
  check("the headline is the English one", text.includes(say(copy.LANDING.hero.headlineLead, "en")));

  const leaked = [];
  for (const { path: at, pair } of pairs) {
    if (INVERTED.has(at)) continue;
    if (pair.en === pair.ar) continue;
    if (pair.ar.length < 12) continue;
    if (text.includes(pair.ar)) leaked.push(at);
  }
  check("and no Arabic sentence is left on the English page", leaked.length === 0, leaked.slice(0, 6).join(", "));

  const overflow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    view: window.innerWidth,
  }));
  check("nothing pushes the page sideways here either", overflow.scroll <= overflow.view + 1, `${overflow.scroll} > ${overflow.view}`);

  await context.close();
}

section("The switch switches, and is remembered");
{
  const { context, page } = await open("/");
  const button = page.locator('[data-testid="button-language"]');
  check("there is a switch, and it is a word rather than a flag", (await button.count()) === 1);
  check(
    "it is labelled in the language it switches to",
    (await button.innerText()).trim() === say(copy.LANDING.languageToggle.label, "ar"),
    await button.innerText(),
  );

  // A thumb, on the row this page's own comments say was the tightest one.
  const box = await button.boundingBox();
  check("and it is big enough to press", box.height >= 44 && box.width >= 44, JSON.stringify(box));

  await button.click();
  await page.waitForTimeout(200);
  const landing = page.locator('[data-testid="landing"]');
  check("pressing it turns the page round", (await landing.getAttribute("dir")) === "ltr");
  check("and into English", (await page.locator("body").innerText()).includes(say(copy.LANDING.hero.headlineLead, "en")));

  // The point of remembering: somebody who switched once should not have to
  // switch again on the next visit, or on the next page of the same visit.
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  check(
    "and it is still English after a reload",
    (await page.locator('[data-testid="landing"]').getAttribute("lang")) === "en",
    "a preference that is forgotten is a preference nobody sets twice",
  );

  await context.close();
}

await browser.close();
server.close();
await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("The page says the same thing in both languages, and reads correctly in both.");
