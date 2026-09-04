/**
 * Does the pricing page promise what the server enforces?
 *
 * The tiers exist twice: `plan-limits.ts`, which decides what actually happens
 * to a render, and `pricing.ts`, which is what a person reads before typing in
 * a card number. Nothing compared them. That is the shape of every expensive
 * mistake this repository has made — the OpenAPI file that drifted into
 * describing a different product, the five migrations written and never applied
 * — except that here the two sides are a page about money and the code that
 * takes it. A drift is not a bug; it is an advertisement for something the
 * product will refuse to do.
 *
 * The prose is handled differently from the numbers, and deliberately.
 *
 * A number is checked against the limit it duplicates. A *claim* is checked
 * against a predicate someone had to write down — and a claim nobody has
 * classified fails. That is the point of this file rather than a nicety: adding
 * a line to the pricing page is making a promise, and the repository should
 * require somebody to say what makes it true before it ships.
 *
 * Some claims are true because the code enforces them. Some are on the page and
 * not built yet, on purpose — the instruction here has always been to build
 * toward the copy rather than delete it. Those are listed too, so the debt is
 * something the repository knows about rather than something a customer finds.
 *
 * Usage: node tools/pricing-test.mjs
 * Requires: nothing. No keys, no network, no database.
 */
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-pricing-"));

function bundle(entry, name, resolveFrom) {
  const outfile = path.join(buildDir, name);
  const built = spawnSync(
    require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] }),
    [
      path.join(repoRoot, entry),
      "--bundle", "--platform=node", "--format=esm", "--target=node22",
      `--outfile=${outfile}`, "--log-level=error",
    ],
    { stdio: "inherit", cwd: path.join(repoRoot, resolveFrom) },
  );
  if (built.status !== 0) {
    console.error(`could not bundle ${entry}`);
    process.exit(1);
  }
  return pathToFileURL(outfile).href;
}

const { PLANS, SHARED_FEATURES, FREE_TIER } = await import(
  bundle("artifacts/editly/src/lib/pricing.ts", "pricing.mjs", "artifacts/editly")
);
const { PLAN_LIMITS, referenceForPlan } = await import(
  bundle("artifacts/api-server/src/lib/plan-limits.ts", "plan-limits.mjs", "artifacts/api-server")
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
const section = (title) => console.log(`\n${title}`);

// ─── The numbers ─────────────────────────────────────────────────────────────

section("Every price on the page is the price the server charges");
{
  check("the page offers some plans", PLANS.length >= 3, String(PLANS.length));

  for (const plan of PLANS) {
    const limits = PLAN_LIMITS[plan.key];
    check(`${plan.name} is a plan the server knows`, Boolean(limits), plan.key);
    if (!limits) continue;

    check(
      `${plan.name} is priced at what the plan costs`,
      plan.price === limits.pricePerMonth,
      `page $${plan.price}, server $${limits.pricePerMonth}`,
    );
    check(
      `${plan.name} promises the minutes the meter actually allows`,
      plan.minutes === limits.minutesPerMonth,
      `page ${plan.minutes}, server ${limits.minutesPerMonth}`,
    );
    // A yearly price below twelve months of the monthly one is the discount
    // being advertised; above it is a mistake nobody would report.
    check(
      `${plan.name}'s yearly price is a discount rather than a penalty`,
      plan.yearlyPrice < plan.price * 12,
      `$${plan.yearlyPrice} vs $${plan.price * 12}`,
    );
    check(
      `and the per-month figure beside it is that price divided by twelve`,
      Math.abs(Number(plan.yearlyPerMonth.match(/\$([\d.]+)/)?.[1]) - plan.yearlyPrice / 12) < 0.05,
      `${plan.yearlyPerMonth} for $${plan.yearlyPrice}/year`,
    );
  }
}

section("An upload limit named on the page is the one the worker enforces");
{
  /** "Upload up to 30 minutes" → 30. "a 4-hour episode" → 240. */
  const minutesIn = (text) => {
    const hours = text.match(/(\d+(?:\.\d+)?)[\s-]*hour/i);
    if (hours) return Number(hours[1]) * 60;
    const minutes = text.match(/(\d+(?:\.\d+)?)[\s-]*minute/i);
    return minutes ? Number(minutes[1]) : null;
  };

  /*
    Every plan's line has to name a ceiling this check can read.

    The `null` branch used to be `check(…, true)` — a pass — on the grounds
    that a plan may sell something other than a ceiling. That was true of
    Studio's line once, and stopped being true; the branch is now dead and its
    comment was stale. Worse, it made a *parse failure* and a *deliberate
    silence* the same outcome: reword any line to "half-hour files" and that
    plan's page-against-worker comparison silently becomes a pass.

    All three lines name minutes or hours today. If one genuinely stops
    claiming a length, this check is the thing to change deliberately, which is
    the whole difference.
  */
  const silent = PLANS.filter((plan) => minutesIn(plan.upload) === null).map((plan) => plan.name);
  check(
    "every plan's upload line names a length this check can read",
    silent.length === 0,
    `${silent.join(", ")} — an unreadable line is not compared against the worker at all`,
  );

  for (const plan of PLANS) {
    const stated = minutesIn(plan.upload);
    if (stated === null) continue;
    check(
      `${plan.name} says ${stated} minutes and the ceiling is ${PLAN_LIMITS[plan.key].maxUploadMinutes}`,
      stated === PLAN_LIMITS[plan.key].maxUploadMinutes,
      plan.upload,
    );
  }

  // The number that sells Pro is its four-hour upload, and it is the one a
  // podcaster checks first.
  check(
    "the four-hour episode is four hours",
    PLAN_LIMITS.pro.maxUploadMinutes === 240,
    String(PLAN_LIMITS.pro.maxUploadMinutes),
  );
}

// ─── The prose ───────────────────────────────────────────────────────────────

/**
 * Every line on the pricing page, and what makes it true.
 *
 * `enforced` runs against each advertised plan's limits. `promised` is a line
 * that is on the page ahead of the thing it describes — kept there on purpose,
 * because the instruction here has always been to build toward the copy rather
 * than delete it — with `absent` naming a symbol whose appearance in the code
 * means it has been built and the line should be reclassified.
 */
const CLAIMS = {
  "Upload as much footage as you like. You only pay for what you publish": {
    kind: "enforced",
    // Nothing meters uploaded minutes anywhere: the ceiling is per-file, and
    // the month's allowance counts `output_seconds` on finished jobs.
    holds: (limits) => limits.minutesPerMonth > 0 && limits.maxUploadMinutes > 0,
  },
  "No watermark": {
    kind: "enforced",
    holds: (limits) => limits.watermark === false,
  },
  /*
    The one line on this page that is not true yet, filed as what it is.

    It was `kind: "enforced"` with `holds: (limits) => limits.minutesPerMonth > 0`
    — which is true of all four plans including free, so the check could not
    fail, and the comment beside it argued against itself: "re-asking costs a
    render, and a render costs minutes, so this is only true because the meter
    counts finished output rather than attempts". Counting finished output
    rather than attempts is a distinction for renders that *fail*. Every
    re-ask that succeeds produces output and is billed for it.

    And the product has already acted on the sentence: `project-editor.tsx`
    deliberately dropped its "you have used all your edits" branch, on the
    stated grounds that the pricing page promises unlimited edits.

    Concretely: free plan, five minutes, a two-minute clip. "Add captions" —
    2 minutes billed. "Now cut the silences" — about 1.8. "Make it vertical" —
    about 1.8. Exhausted after three sentences about one two-minute video, by a
    person the page told that asking again was free.

    The rule in this repository is that a line on the page which is not built
    stays there and gets built toward. So it stays, and it is a promise until
    the meter charges a project once a month rather than once a render — which
    is what `builtWhen` is watching for.
  */
  "Unlimited edits. Asking again is free": {
    kind: "promised",
    builtWhen: /\bchargeOncePerProject\b|\bprojectMonthlyCharge\b|\bbilledOncePerProject\b/,
  },
  "Match the style of a video you like": {
    kind: "enforced",
    holds: (limits) => limits.referenceStyle === true,
  },
};

/**
 * Promises made on a card, ahead of the code.
 *
 * Each names something that would exist if the feature did. When one of these
 * starts matching, this file fails — which is the point: the line should stop
 * being a promise the moment it stops being one.
 */
//
// The patterns name identifiers rather than words. The first version matched
// /invite/, which fired on two comments explaining that "limit reached" invites
// an argument — a check that goes off when somebody writes a good sentence is a
// check that gets deleted.
const PROMISED = [
  { claim: "3 seats", builtWhen: /\bseatsUsed\b|\bteamMembersTable\b|\binviteMember\b/ },
  { claim: "brand kit", builtWhen: /\bbrandKit\b|\bbrand_kit\b/ },
  { claim: "API", builtWhen: /\bapiKeysTable\b|\bapi_keys\b/ },
];

section("Every claim on the page is one somebody has justified");
{
  const unclassified = SHARED_FEATURES.filter((line) => !(line in CLAIMS));
  check(
    "no line is on the page that nothing here explains",
    unclassified.length === 0,
    `${unclassified.join(" | ")} — a new promise needs somebody to say what makes it true`,
  );

  // And the other way: a claim classified here that no longer appears is a
  // rule guarding a sentence that was deleted.
  const orphaned = Object.keys(CLAIMS).filter((line) => !SHARED_FEATURES.includes(line));
  check("and no rule here guards a line that is gone", orphaned.length === 0, orphaned.join(" | "));

  for (const line of SHARED_FEATURES) {
    const claim = CLAIMS[line];
    if (!claim || claim.kind !== "enforced") continue;
    const broken = PLANS.filter((plan) => !claim.holds(PLAN_LIMITS[plan.key]));
    check(
      `"${line.slice(0, 46)}${line.length > 46 ? "…" : ""}" is true of every plan it is shown beside`,
      broken.length === 0,
      broken.map((p) => p.name).join(", "),
    );
  }

  /*
    And the promised ones, held to the same rule the card promises are:
    still on the page, still not built, and reclassified the day they are.
  */
  const appSource = readdirSync(path.join(repoRoot, "artifacts"), { recursive: true })
    .filter((f) => typeof f === "string" && /\.(ts|tsx)$/.test(f) && !f.includes("node_modules"))
    .map((f) => {
      try {
        return readFileSync(path.join(repoRoot, "artifacts", f), "utf8");
      } catch {
        return "";
      }
    })
    .join("\n");

  for (const [line, claim] of Object.entries(CLAIMS)) {
    if (claim.kind !== "promised") continue;
    check(
      `"${line.slice(0, 46)}${line.length > 46 ? "…" : ""}" is still on the page rather than quietly deleted`,
      SHARED_FEATURES.includes(line),
      "a promise removed instead of delivered",
    );
    check(
      "and still filed as a promise rather than as a feature nobody reclassified",
      !claim.builtWhen.test(appSource),
      `${line} appears to be built now — move it back to enforced with a holds() that means something`,
    );
  }
}

section("What the page promises ahead of the code is written down, not forgotten");
{
  const source = readdirSync(path.join(repoRoot, "artifacts"), { recursive: true })
    .filter((f) => typeof f === "string" && /\.(ts|tsx)$/.test(f) && !f.includes("node_modules"))
    .map((f) => {
      try {
        return readFileSync(path.join(repoRoot, "artifacts", f), "utf8");
      } catch {
        return "";
      }
    })
    .join("\n");

  for (const { claim, builtWhen } of PROMISED) {
    const onThePage = PLANS.some((plan) => plan.upload.includes(claim));
    check(`"${claim}" is still on a card`, onThePage, "the promise was removed rather than built");
    // The instruction has always been to build toward the copy, not delete it.
    // So this does not fail for the promise existing — it fails when the thing
    // arrives and the promise is still filed as a promise.
    check(
      `and is still a promise rather than a feature nobody reclassified`,
      !builtWhen.test(source),
      `${claim} appears to be built now — move it out of PROMISED`,
    );
  }

  check(
    "seats are declared in the limits but enforced nowhere, which is why it is listed here",
    PLAN_LIMITS.studio.seats === 3 && !/\bseatsUsed\b|\bteamMembersTable\b/.test(source),
    "if seats are now enforced this line has become a fact",
  );
}

// ─── The tier order ──────────────────────────────────────────────────────────

section("Paying more never buys less");
{
  const ordered = [...PLANS].sort((a, b) => a.price - b.price);
  for (let i = 1; i < ordered.length; i += 1) {
    const cheaper = PLAN_LIMITS[ordered[i - 1].key];
    const dearer = PLAN_LIMITS[ordered[i].key];
    const name = `${ordered[i - 1].name} → ${ordered[i].name}`;
    check(`${name}: more minutes`, dearer.minutesPerMonth > cheaper.minutesPerMonth);
    check(`${name}: a longer upload`, dearer.maxUploadMinutes >= cheaper.maxUploadMinutes);
    check(`${name}: no less resolution`, dearer.maxHeight >= cheaper.maxHeight);
    check(
      `${name}: nothing taken away`,
      (!cheaper.referenceStyle || dearer.referenceStyle) &&
        (!cheaper.priorityQueue || dearer.priorityQueue) &&
        (cheaper.watermark || !dearer.watermark) &&
        dearer.seats >= cheaper.seats,
      JSON.stringify({ cheaper, dearer }),
    );
  }

  // The free tier IS on the page now — as a band above the cards rather than a
  // fourth card, because it is not a plan anyone chooses between, it is the
  // door. What matters is that the sentence and the limit cannot drift apart:
  // a free tier advertising more than it grants is the worst copy on the site.
  check(
    "the free tier's minutes match what the server grants",
    FREE_TIER.minutes === PLAN_LIMITS.free.minutesPerMonth,
    `page ${FREE_TIER.minutes} vs server ${PLAN_LIMITS.free.minutesPerMonth}`,
  );
  check(
    "and its upload ceiling matches too",
    FREE_TIER.uploadMinutes === PLAN_LIMITS.free.maxUploadMinutes,
    `page ${FREE_TIER.uploadMinutes} vs server ${PLAN_LIMITS.free.maxUploadMinutes}`,
  );
  check(
    "every number it prints is one of those two",
    FREE_TIER.lines.every((line) => {
      const numbers = (line.match(/\d+/g) ?? []).map(Number);
      return numbers.every((n) => n === FREE_TIER.minutes || n === FREE_TIER.uploadMinutes);
    }),
    JSON.stringify(FREE_TIER.lines),
  );
  check(
    "it says the mark out loud rather than letting it be a surprise",
    FREE_TIER.lines.some((line) => /mark|watermark/i.test(line)) === PLAN_LIMITS.free.watermark,
  );
  check("it costs nothing, and says so", FREE_TIER.price === 0 && PLAN_LIMITS.free.pricePerMonth === 0);

  /*
    And it does not claim to include what it does not include.

    The line was "Every editing feature, so you can judge the result", beside a
    plan whose `referenceStyle` is false and whose `maxHeight` is below the
    paid tiers — and the dashboard repeated it in the band a free customer
    reads every day. The editor then offered the reference control with no
    gate, so the way somebody found out was a finished 25 MB upload followed by
    "That's a paid feature".

    Written as a relationship rather than as a banned phrase: any free-tier
    line that claims *all* of something has to be true of a plan that is
    strictly smaller than the cheapest paid one, and it never can be.
  */
  const cheapestPaid = PLAN_LIMITS[ordered[0].key];
  const freeIsSmaller =
    PLAN_LIMITS.free.referenceStyle !== cheapestPaid.referenceStyle ||
    PLAN_LIMITS.free.maxHeight !== cheapestPaid.maxHeight ||
    PLAN_LIMITS.free.watermark !== cheapestPaid.watermark;
  const claimsEverything = FREE_TIER.lines.filter((line) =>
    /\b(every|all)\b[^.]*\b(feature|features|tool|tools)\b/i.test(line),
  );
  /*
    And the same claim in Arabic, which is the language most of these readers
    are in.

    The English line was withdrawn and the Arabic was not, so the claim went on
    being made to the default audience for as long as nobody happened to read
    that file. This guard did not catch it because it was written as an English
    regexp, and `landing-test` compares digits — neither of them could see a
    sentence in the other language.

    `كل ميزات` is "every feature" and `جميع الميزات` is the other way to say
    it; both are pinned rather than a general rule, because a rule about Arabic
    prose written by somebody matching patterns is a rule that fails in both
    directions.
  */
  const arabicCopy = readFileSync(
    path.join(repoRoot, "artifacts/editly/src/lib/landing-copy.ts"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  const arabicClaims = /(كل|جميع)\s+(ال)?ميزات/.test(arabicCopy);
  check(
    "nor does the Arabic card, which is the one most people read",
    !(freeIsSmaller && arabicClaims),
    "the English claim was withdrawn and the Arabic was left saying it",
  );

  check(
    "the free tier does not say it has every feature while having fewer than the cheapest paid plan",
    !(freeIsSmaller && claimsEverything.length > 0),
    `${claimsEverything.join(" | ")} — free lacks ${[
      PLAN_LIMITS.free.referenceStyle ? null : "reference styling",
      PLAN_LIMITS.free.maxHeight < cheapestPaid.maxHeight ? "the paid resolution" : null,
    ].filter(Boolean).join(" and ")}`,
  );
  check(
    "and the dashboard's free band does not say it either",
    !/every editing feature/i.test(readFileSync(path.join(repoRoot, "artifacts/editly/src/pages/dashboard.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")),
    "the band under the dashboard heading still repeats the claim",
  );

  // The free tier still has to make sense
  // against the cheapest paid one — it is what everybody starts on.
  const free = PLAN_LIMITS.free;
  const cheapest = PLAN_LIMITS[ordered[0].key];
  check("free gives less than the cheapest paid plan", free.minutesPerMonth < cheapest.minutesPerMonth);
  check("and is the only tier that carries a mark", free.watermark && !cheapest.watermark);
  check(
    "but is not so small it cannot show the product — two short videos",
    free.minutesPerMonth >= 3 && free.maxUploadMinutes >= 5,
    JSON.stringify(free),
  );
}

// ─── The free tier, where somebody on it actually is ────────────────────────
//
// It was on the pricing page and nowhere else, which is the one place a person
// already using the product never looks. A meter reading "0 / 5" and a badge
// reading "free plan" are facts, not an answer to "am I on a countdown, and
// does anyone have my card?".
console.log("\nThe free plan is legible from inside the product");
{
  const dashboard = await readFile(path.join(repoRoot, "artifacts/editly/src/pages/dashboard.tsx"), "utf8");
  check("the dashboard says something about the free plan at all", dashboard.includes("free-plan-band"));
  check("only to people who are on it", /subscription\?\.plan === "free"/.test(dashboard));
  check(
    "and it reads the numbers from the same place the pricing page does",
    dashboard.includes("FREE_TIER.minutes") && dashboard.includes("FREE_TIER.uploadMinutes"),
  );
  check(
    "rather than retyping them, which is how the two drift apart",
    !/\b5 minutes of finished video a month\b/.test(dashboard),
  );
  check("it offers a way up without demanding one", dashboard.includes("button-see-plans"));
}

// --- The sentence under the buttons ---------------------------------------
//
// The footnote sits below the paid cards and above nothing, which makes it the
// last thing read before a button is pressed. It said "no credit card
// required" while every one of those buttons opened a checkout with
// `trial=paid` on the URL, which is Freemius for "seven days, card taken up
// front". Nothing in the product failed. A person read a true sentence about
// the free plan, printed under the paid ones, and met a card form.
//
// So the two are compared: if the checkout asks for a card, the sentence under
// the buttons that open it may not say no card is needed.
//
// Each Arabic pattern carries an English gloss above it, because a right-to-left
// literal inside a left-to-right expression reorders on screen and the next
// person to read this file cannot otherwise tell what it matches.
console.log("\nThe sentence under the paid buttons matches the checkout it opens");
{
  /** "no card", at the start of the sentence. */
  const NO_CARD_AR = /^بلا بطاقة/;
  /** "the free one". */
  const FREE_AR = /المجاني/;
  /** "card required". */
  const CARD_REQUIRED_AR = /البطاقة مطلوبة/;

  const checkout = await readFile(path.join(repoRoot, "artifacts/editly/src/lib/checkout.ts"), "utf8");
  const copy = await readFile(path.join(repoRoot, "artifacts/editly/src/lib/landing-copy.ts"), "utf8");
  const footnote = copy.match(/footnote:\s*p\(\s*"([^"]*)",\s*"([^"]*)"/);

  check("there is a footnote to check", footnote !== null);
  const arabic = footnote?.[1] ?? "";
  const english = footnote?.[2] ?? "";

  const cardRequired = /set\("trial",\s*"paid"\)/.test(checkout);
  check("the checkout's trial mode is readable from the code", cardRequired, "trial=paid means a card is taken");

  if (cardRequired) {
    check(
      "it does not open by saying a card is unnecessary, under buttons that ask for one",
      !/^No credit card required/.test(english) && !NO_CARD_AR.test(arabic),
      english,
    );
    check("it names the plan that promise belongs to", /free/i.test(english) && FREE_AR.test(arabic), english);
    check(
      "and it says what the paid buttons will actually ask for",
      /card required/i.test(english) && CARD_REQUIRED_AR.test(arabic),
      english,
    );
  }

  // And the trial length is one number, not two. Seven on one side and
  // fourteen on the other is a promise nobody here could keep.
  const days = english.match(/(\d+)-day/)?.[1];
  check("the trial length on the page is a number", Boolean(days), english);
  check("and the Arabic says the same number", arabic.includes(days ?? " "), arabic);
}

section("A paid reference does not survive a downgrade");
{
  /*
    Matching another video's look is a paid feature, and the project remembers
    the reference file across a downgrade. The only gate was on *setting* the
    reference, so a person who set one while paying kept getting the paid edit
    on every render after dropping to free. `referenceForPlan` is the gate on
    the render side, and both render doors have to go through it.
  */
  // Guarded so a revert that removes the helper fails these cleanly rather than
  // throwing: with no gate there is no gating, which is the bug.
  const ref = (plan, p) => (typeof referenceForPlan === "function" ? referenceForPlan(plan, p) : "UNGATED");
  check(
    "a free plan gets no reference, whatever the project holds",
    ref("free", "user/proj/reference.mp4") === null,
    String(ref("free", "user/proj/reference.mp4")),
  );
  for (const plan of ["creator", "pro", "studio"]) {
    check(
      `a ${plan} plan keeps its reference`,
      ref(plan, "user/proj/reference.mp4") === "user/proj/reference.mp4",
      String(ref(plan, "user/proj/reference.mp4")),
    );
  }
  check(
    "and no reference is no reference on any plan",
    ref("pro", null) === null && ref("free", undefined) === null,
    "",
  );

  // Both render doors must gate through the helper, not read the stored path
  // raw — the raw read is exactly the bug.
  const startRender = readFileSync(path.join(repoRoot, "artifacts/api-server/src/lib/start-render.ts"), "utf8");
  const exports = readFileSync(path.join(repoRoot, "artifacts/api-server/src/routes/exports.ts"), "utf8");
  /*
    Either spelling, because the value moved and the property did not.

    This matched `referencePath: referenceForPlan(...)` at the insert. The
    reference is now decided a few lines earlier, beside the allowance and
    inside the same transaction — deliberately, so a job can never be written
    with one plan's minutes and another plan's reference. The claim being made
    here is that the stored path reaches the row *through the helper*, so both
    the inline call and a binding named `referencePath` that is assigned from
    it satisfy it; what must never appear is the raw read.
  */
  const gatedInline = /referencePath:\s*referenceForPlan\(/.test(startRender);
  const gatedByBinding =
    /const referencePath = referenceForPlan\(/.test(startRender) && /^\s*referencePath,$/m.test(startRender);
  check(
    "start-render gates the reference on the plan",
    (gatedInline || gatedByBinding) &&
      !/referencePath:\s*project\.referenceVideoPath\s*\?\?\s*null/.test(startRender),
    "start-render.ts",
  );
  check(
    "the export route gates the reference on the plan",
    /referencePath:\s*referenceForPlan\(/.test(exports) &&
      !/referencePath:\s*project\.referenceVideoPath\s*\?\?\s*null/.test(exports),
    "exports.ts",
  );
}

await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("The page promises what the server will actually do.");
