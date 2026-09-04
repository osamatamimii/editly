/**
 * The privacy policy cannot become a lie by addition.
 *
 * A policy is a promise about where a customer's data goes, and the way it
 * stops being true is never a rewrite — it is somebody wiring up a new provider
 * next month, shipping it, and the page still naming the old three. Nothing
 * fails. The customer's audio is now at a company they were never told about,
 * and the first person to notice is a regulator, a journalist, or a customer
 * reading a network tab.
 *
 * So the promise is checked against the code, in the one direction that
 * matters: **every host this product sends a request to is named in the list
 * the policy is rendered from.** Adding a provider without adding it to the
 * page turns CI red.
 *
 * ## Why hosts and not "providers"
 *
 * Because a host is a fact and a provider is a description. `fetch` calls
 * name hosts, and a suite that read a list of provider names out of a comment
 * would be checking a second copy of the thing it is supposed to verify.
 *
 * ## And the other direction, deliberately not checked
 *
 * A processor listed here with no matching host in the code is *not* an error.
 * Supabase, Vercel and Fly receive data by being the ground the product runs
 * on, not by appearing in a `fetch` — and a check that demanded a URL for each
 * would push exactly the three most important entries off the page.
 *
 * Usage: node tools/privacy-test.mjs
 * Requires: nothing.
 */
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-privacy-"));
const outfile = path.join(buildDir, "processors.mjs");
const built = spawnSync(
  require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] }),
  [
    path.join(repoRoot, "lib/api-zod/src/processors.ts"),
    "--bundle", "--platform=node", "--format=esm", "--target=node22",
    `--outfile=${outfile}`, "--log-level=error",
  ],
  { stdio: "inherit" },
);
if (built.status !== 0) process.exit(1);
const { PROCESSORS, DATA_REGION, RETENTION, ACCOUNT_MIN_AGE, knownHosts, alwaysUsed } = await import(pathToFileURL(outfile).href);

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

// ── The list itself ─────────────────────────────────────────────────────────

section("The list is complete enough to be a policy");
{
  check("there are processors", PROCESSORS.length >= 6, String(PROCESSORS.length));
  check(
    "each one says what it receives, in both languages",
    PROCESSORS.every((p) => p.sends.en.length > 15 && p.sends.ar.length > 10),
    PROCESSORS.filter((p) => p.sends.en.length <= 15).map((p) => p.name).join(", "),
  );
  check(
    "and why, in both languages",
    PROCESSORS.every((p) => p.because.en.length > 15 && p.because.ar.length > 10),
    PROCESSORS.filter((p) => p.because.en.length <= 15).map((p) => p.name).join(", "),
  );
  check(
    "and none of them describes what it receives as 'data'",
    // "We share data with our partners" is the sentence every policy has and
    // nobody can act on. Each entry here has to say the actual thing: the
    // audio, the still frames, the sentence you typed.
    PROCESSORS.every((p) => !/^(some |certain )?(your )?data$/i.test(p.sends.en.trim())),
  );
  check(
    "some run on every render and some only on a choice, and the list says which",
    alwaysUsed().length > 0 && alwaysUsed().length < PROCESSORS.length,
    // Flattening the two overstates in one direction and understates in the
    // other: "your video is sent to eleven companies" is false, and so is
    // leaving out the three that always receive it.
    `${alwaysUsed().length} always, ${PROCESSORS.length - alwaysUsed().length} on a choice`,
  );
}

// ── The check that matters ──────────────────────────────────────────────────

section("Every host this product talks to is named in the policy");
{
  /*
    Read out of the source that actually runs. The browser is excluded on
    purpose: it talks to Supabase and to the API and to nothing else, and its
    bundle carries font and CDN URLs that receive nothing.
  */
  const roots = [
    "artifacts/worker/src",
    "artifacts/worker/src/providers",
    "artifacts/api-server/src/lib",
    "artifacts/api-server/src/routes",
  ];

  const found = new Map();
  for (const root of roots) {
    const dir = path.join(repoRoot, root);
    if (!existsSync(dir)) continue;
    for (const file of (await readdir(dir)).filter((f) => f.endsWith(".ts"))) {
      const source = await readFile(path.join(dir, file), "utf8");
      for (const m of source.matchAll(/https:\/\/([a-z0-9.-]+)/g)) {
        const host = m[1];
        if (!found.has(host)) found.set(host, `${root}/${file}`);
      }
    }
  }

  /*
    Hosts that receive nothing about anybody.

    A licence URL in a comment, a documentation link, our own domain, and the
    fonts.gstatic addresses a page loads a typeface from. Each is here by name
    rather than by a pattern, because "anything that looks like documentation"
    is exactly the loophole a real provider would slip through.
  */
  const RECEIVES_NOTHING = new Set([
    "editlyai.io",
    "app.editlyai.io",
    "www.editlyai.io",
    "scripts.sil.org",
    "fonts.googleapis.com",
    "fonts.gstatic.com",
    "cdnjs.cloudflare.com",
    "git-scm.com",
    "github.com",
    "raw.githubusercontent.com",
    "www.foundertype.com",
    "developers.google.com",
    "urn.fontconfig",
  ]);

  const known = knownHosts();
  const unlisted = [...found.entries()].filter(
    ([host]) =>
      !RECEIVES_NOTHING.has(host) &&
      !known.some((k) => host === k || host.endsWith(`.${k}`)),
  );

  check("the scan found hosts at all", found.size >= 8, String(found.size));
  check(
    "and every one that receives something is in the policy",
    unlisted.length === 0,
    unlisted
      .map(([host, file]) => `${host} (${file}) — add it to lib/api-zod/src/processors.ts and it will appear on the page`)
      .join("; "),
  );
}

// ── The pages exist and say what they must ──────────────────────────────────

section("The two pages exist, and nothing is left half-written on them");
{
  const privacy = await readFile(path.join(repoRoot, "artifacts/editly/src/pages/privacy.tsx"), "utf8").catch(() => "");
  const terms = await readFile(path.join(repoRoot, "artifacts/editly/src/pages/terms.tsx"), "utf8").catch(() => "");

  check("a privacy page", privacy.length > 500, `${privacy.length} bytes`);
  check("and terms", terms.length > 500, `${terms.length} bytes`);

  /*
    No bracket ever reaches a reader.

    The company registration details are not known yet, and a page carrying
    `[[LEGAL_NAME]]` is worse than no page: a bracket tells a reader nobody
    ever read the document, and they stop trusting the parts that are true. So
    the gaps go through `PendingDetail`, which draws them as gaps, and a notice
    at the top says which half of the page is complete.

    Checked in both directions — the raw shape must be absent, and the notice
    must be present — so the honest rendering cannot be quietly dropped later
    while the gaps remain.

    The scan reads the whole file, comments included, and that bluntness is
    deliberate: telling JSX from a comment means parsing TSX, and a check that
    needs a parser to decide whether a promise is broken is a check that will
    be wrong in some case nobody anticipated. A comment can describe the shape
    without being it.
  */
  for (const [name, source] of [["privacy", privacy], ["terms", terms]]) {
    const raw = [...source.matchAll(/\[\[([A-Z_]+)\]\]/g)].map((m) => m[1]);
    check(
      `${name}: no placeholder is rendered as a bracket`,
      raw.length === 0,
      `${[...new Set(raw)].join(", ")} — render it through <PendingDetail> instead`,
    );
    const gaps = (source.match(/<PendingDetail /g) ?? []).length;
    check(
      `${name}: the ${gaps} detail${gaps === 1 ? "" : "s"} still missing ${gaps === 1 ? "is" : "are"} drawn as missing`,
      gaps === 0 || source.includes("<PendingNotice />"),
      "a page with gaps and no notice is a page that looks finished and is not",
    );
  }

  check(
    "the privacy page renders the processor list rather than repeating it",
    /PROCESSORS/.test(privacy),
    "a second copy of the list is a second thing to forget",
  );

  /*
    The claim about where somebody's video physically is.

    "Your videos are stored and edited in Frankfurt" is the sentence a reader
    checks the policy for, and it is the one most likely to quietly stop being
    true: infrastructure moves, and a paragraph typed into a page is not
    something anybody re-reads when it does. So the page prints the region from
    the same constant the deploy is compared against, and the comparison is
    here.
  */
  const fly = await readFile(path.join(repoRoot, "artifacts/worker/fly.toml"), "utf8");
  const deployed = fly.match(/primary_region\s*=\s*"([^"]+)"/)?.[1];
  check("fly.toml names a region", Boolean(deployed), String(deployed));
  check(
    "and the policy's claim about where files are is that region",
    deployed === DATA_REGION.flyRegion,
    `the renderer runs in ${deployed}, the page says ${DATA_REGION.flyRegion}`,
  );
  check(
    "the page prints it from there rather than typing it out",
    /DATA_REGION\.where/.test(privacy),
    "a region typed into the page is a claim nobody re-checks when infrastructure moves",
  );
  // Whitespace flattened first: JSX wraps prose at the column, so "United
  // States" is routinely split across two lines in the source and a check that
  // reads the file as written would be testing the formatter.
  const prose = privacy.replace(/\s+/g, " ");
  /*
    And the rendered half on its own, with the comments taken out.

    `prose` is the whole file. Several of the checks below look for a sentence
    the page is supposed to *say* — and the comments in that file quote those
    sentences, because they explain what the page used to say instead. So
    deleting a promise from the page would leave the check green on the
    strength of the comment describing it, which is exactly the shape of the
    two vacuous checks found tonight. A positive check reads this; the bracket
    scan above still reads the whole file, because there a comment can only
    cause a false *failure*.
  */
  const rendered = privacy
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s+/g, " ");
  check(
    "and it says the transfer out exists rather than implying there is none",
    /United States/.test(rendered) && /transfer/i.test(rendered),
    "naming EU storage without naming the model providers overstates in the safe direction",
  );

  /*
    And the rights section describes rights this product can actually deliver.

    It said "write to us" for a copy, which was true when nothing else existed
    and became a worse answer than the truth the day the export shipped. A
    policy that under-describes what the product does is the same failure as one
    that over-describes it: both are pages nobody can act on.
  */
  const route = await readFile(path.join(repoRoot, "artifacts/api-server/src/routes/account.ts"), "utf8");
  check(
    "the export the policy points at exists",
    /account\/export/.test(route),
    "the page tells somebody to press a button",
  );
  check(
    "and the page points at the button rather than at an inbox",
    /Download my data/.test(rendered),
    privacy.includes("write to us for the others") ? "still says write to us for a copy" : "",
  );
  check(
    "it says the export leaves the tokens out, since that is a gap somebody will notice",
    /access tokens/i.test(rendered),
  );

  /*
    The retention sentence, against the sweep that enforces it.

    The page said "your files stay until you delete them" and stopped there,
    which was true only because `DEFAULT_RETENTION.mode` is `dry` and the sweep
    removes nothing. It is one environment variable away from being false, and a
    policy that becomes a lie when a setting changes is a policy nobody can rely
    on — nor can anybody tell when it stopped being true, because flipping the
    variable produces no diff on the page.

    So the page prints the windows, and this compares them against the worker's
    own constants.
  */
  const sweep = await readFile(path.join(repoRoot, "artifacts/worker/src/sweep.ts"), "utf8");
  const defaults = sweep.match(/DEFAULT_RETENTION[^{]*\{([\s\S]*?)\}/)?.[1] ?? "";
  const dayOf = (name) => Number(defaults.match(new RegExp(`${name}:\\s*(\\d+)`))?.[1]);

  check("the worker states its windows", Number.isFinite(dayOf("previewDays")), defaults.slice(0, 80));
  check(
    "and the policy's preview window is that one",
    dayOf("previewDays") === RETENTION.previewDays,
    `the sweep uses ${dayOf("previewDays")}, the page says ${RETENTION.previewDays}`,
  );
  check(
    "as is the one for a video that never produced an edit",
    dayOf("unusedSourceDays") === RETENTION.unusedSourceDays,
    `the sweep uses ${dayOf("unusedSourceDays")}, the page says ${RETENTION.unusedSourceDays}`,
  );
  check(
    "the page prints them rather than describing them in prose that can go stale",
    /RETENTION\.previewDays/.test(privacy) && /RETENTION\.unusedSourceDays/.test(privacy),
  );
  check(
    "and it still says the masters are kept, which is the part people are asking about",
    /stay until you delete them/.test(rendered),
    "a comment quoting the sentence is not the sentence",
  );
  // Poster frames are deliberately not swept. A page that listed a window for
  // them would be describing a setting nobody has turned on.
  check(
    "poster frames are not swept by default, which is why the page says they are kept",
    dayOf("thumbnailDays") === 0,
    String(dayOf("thumbnailDays")),
  );

  /*
    One age, in the three places it has to be the same.

    The privacy page said sixteen. The terms — the document that actually binds
    — never mentioned an account age at all, only eighteen in a sentence about
    content involving minors, which is a different rule about a different thing.
    And the sign-up screen, where the agreement is made, said nothing. A number
    in one of three is a number in none of them.
  */
  const login = await readFile(path.join(repoRoot, "artifacts/editly/src/pages/login.tsx"), "utf8");
  for (const [name, source] of [["privacy", privacy], ["terms", terms], ["sign-up", login]]) {
    check(
      `${name} states the account age from the shared constant`,
      /ACCOUNT_MIN_AGE/.test(source),
      "a number typed into a page is a number that disagrees with the other two",
    );
  }
  check("and it is a real age", Number.isInteger(ACCOUNT_MIN_AGE) && ACCOUNT_MIN_AGE >= 13, String(ACCOUNT_MIN_AGE));

  /*
    And the fonts, which the paragraph about analytics invites you to forget.

    "No analytics script, no advertising pixel, no third-party cookie" is true
    and reads as "nothing leaves your browser except to us" — while the page
    fetches its typefaces from two CDNs that therefore see every visitor's
    address. Not a tracker, and not nothing.
  */
  const html = await readFile(path.join(repoRoot, "artifacts/editly/index.html"), "utf8");
  const fontHosts = ["fonts.googleapis.com", "api.fontshare.com"].filter((host) => html.includes(host));
  check("the page really does load fonts from somebody else", fontHosts.length > 0, JSON.stringify(fontHosts));
  check(
    "and the policy says so beside the sentence that would otherwise imply it does not",
    /Google Fonts/.test(rendered) && /Fontshare/.test(rendered),
    "the no-analytics paragraph is doing work it should not be doing alone",
  );
  check(
    "naming what they receive rather than leaving it to be assumed",
    /address your browser connects from/.test(rendered),
  );

  check(
    "and a person told they can complain is told where",
    /data protection authority/i.test(rendered),
    "the right to complain to a supervisory authority is one this page has to name",
  );

  check(
    "and each points at the other",
    privacy.includes('href="/terms"') && terms.includes('href="/privacy"'),
    "somebody reading one is usually looking for both",
  );
}

section("They can be found, and read without signing in");
{
  /*
    The footer is in the landing page rather than a component of its own, so
    that is where this looks. A policy that exists at a URL nobody links is a
    policy that is not published — and every platform review starts by looking
    for the link, signed out.
  */
  const home = await readFile(path.join(repoRoot, "artifacts/editly/src/pages/home.tsx"), "utf8");
  check("the landing page links to the privacy policy", home.includes('href="/privacy"'), "home.tsx");
  check("and to the terms", home.includes('href="/terms"'), "home.tsx");

  const router = await readFile(path.join(repoRoot, "artifacts/editly/src/App.tsx"), "utf8").catch(() => "");
  check("both are routes, not just links", /path="\/privacy"/.test(router) && /path="\/terms"/.test(router), "App.tsx");
  check(
    "and neither is behind a sign-in",
    // `Protected` around either of these would mean a reviewer, and anybody
    // deciding whether to sign up, cannot read them at all.
    /<Route path="\/privacy" component=/.test(router) && /<Route path="\/terms" component=/.test(router),
    "a policy you have to sign in to read is not a policy anybody can check first",
  );
}

await rm(buildDir, { recursive: true, force: true });
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
console.log("What the policy promises is what the code does.");
