/**
 * Can somebody give themselves a paid plan with a word?
 *
 * That is the question this file is for, and it has two halves that fail in
 * completely different ways.
 *
 * The **rules** half is arithmetic and can be wrong quietly: a grant that runs
 * a few days long, a code that stacks onto a paying customer's row and drops
 * them to free a year later, a refusal that spends a seat on its way to saying
 * no. None of these look like bugs from outside. They are checked here against
 * the pure module, with no database in sight.
 *
 * The **race** half cannot be reasoned about at all — only run. A code with one
 * seat, asked for twice at the same instant, must be granted once. So the
 * transaction the route actually uses is executed against a real Postgres,
 * concurrently, and the database is asked what happened.
 *
 * And one structural check that is worth more than either: every door in the
 * product must read the plan through `servedPlan`, which applies the end date,
 * rather than through the column. A rule that eight of nine sites apply is not
 * a rule, and the ninth is a free account rendering on Studio forever.
 *
 * Usage: node tools/promo-test.mjs
 * Requires: a local Postgres matching the production schema. No keys, no network.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { resolveTestDatabaseUrl } from "./lib/test-db.mjs";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
/*
  Built inside the repository's own node_modules rather than in /tmp.

  The database module is bundled here and run for real, and `pg` cannot be
  bundled: it reaches for node builtins through CommonJS requires that esbuild
  turns into a call that throws at import. So it is left external — which means
  the bundle has to sit somewhere `pg` resolves from. Under pnpm that is not the
  root and it is certainly not /tmp: it is beside the package that depends on
  it, which is `lib/db`.
*/
const buildDir = await mkdtemp(path.join(repoRoot, "lib/db/node_modules", ".editly-promo-"));

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

const bundle = (entry, name, extra = []) => {
  const outfile = path.join(buildDir, name);
  const built = spawnSync(
    require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] }),
    [
      path.join(repoRoot, entry),
      "--bundle", "--platform=node", "--format=esm", "--target=node22",
      `--outfile=${outfile}`, "--log-level=error", ...extra,
    ],
    { stdio: "inherit" },
  );
  if (built.status !== 0) {
    console.error(`could not bundle ${entry}`);
    process.exit(1);
  }
  return outfile;
};

// The database is resolved *before* anything that imports `@workspace/db` is
// bundled or loaded: that module reads DATABASE_URL at import time and throws
// without one, which would look like a broken suite rather than a missing
// server.
const databaseUrl = await resolveTestDatabaseUrl();

const promo = await import(pathToFileURL(bundle("artifacts/api-server/src/lib/promo.ts", "promo.mjs")).href);
const limits = await import(
  pathToFileURL(bundle("artifacts/api-server/src/lib/plan-limits.ts", "plan-limits.mjs")).href
);

const { normaliseCode, codeUsable, generateCode, grantEnd, refuseRedemption, grantFrom, grantablePlans } = promo;
const { servedPlan } = limits;

const AT = new Date("2026-09-12T10:00:00.000Z");
const code = (over = {}) => ({
  code: "EDITLYYEAR",
  plan: "pro",
  months: 12,
  maxRedemptions: 1,
  redeemedCount: 0,
  expiresAt: null,
  revokedAt: null,
  ...over,
});
const account = (over = {}) => ({ plan: "free", planExpiresAt: null, licenseId: null, usedThisCode: false, ...over });

// ─── What a code is, once the typing is taken off it ─────────────────────────

section("A code is whatever was typed, normalised");
{
  check("case does not matter", normaliseCode("editlyyear") === "EDITLYYEAR");
  check("and neither does a dash where a space was seen", normaliseCode("editly-year") === "EDITLYYEAR");
  check("or spaces, or a stray full stop", normaliseCode(" editly year. ") === "EDITLYYEAR");
  /*
    The market this product was built for types on a keyboard that produces ٣
    where the key says 3. NFKC does not fold those — it folds ligatures and
    width, not scripts — so before this they were stripped by the filter and the
    code came back "unknown".
  */
  check("Arabic-Indic digits are the digits they are", normaliseCode("CODE\u0662\u0663") === "CODE23");
  check("and the extended set a Persian keyboard produces too", normaliseCode("CODE\u06f2\u06f3") === "CODE23");
  check("something that is not a string at all is empty, not a crash", normaliseCode(null) === "");
  check("and a very long one is cut rather than stored", normaliseCode("A".repeat(200)).length === 32);

  check("four characters is the floor", codeUsable("NOAH") && !codeUsable("NOA"));
  check("and thirty-two the ceiling", codeUsable("A".repeat(32)) && !codeUsable("A".repeat(33)));
}

section("A generated code avoids the characters people get wrong");
{
  // Every byte value, so the whole alphabet is exercised rather than whichever
  // letters one random draw happened to produce.
  const all = generateCode(Uint8Array.from({ length: 256 }, (_, i) => i), 256);
  check("it is the length asked for", generateCode(new Uint8Array(10), 10).length === 10);
  check("no O, 0, I or 1 anywhere in the alphabet", !/[O0I1]/.test(all), all.slice(0, 40));
  check("nothing outside letters and digits", /^[A-Z2-9]+$/.test(all));
  check(
    "and it is drawn from the whole alphabet, not a corner of it",
    new Set(all).size === 32,
    `${new Set(all).size} distinct`,
  );
}

// ─── The arithmetic nobody would notice being wrong ──────────────────────────

section("A term of months lands where a calendar says it does");
{
  check(
    "twelve months from today is this day next year",
    grantEnd(12, AT).toISOString() === "2027-09-12T10:00:00.000Z",
    grantEnd(12, AT).toISOString(),
  );
  /*
    The one JavaScript gets wrong on its own. `setUTCMonth(+1)` on the 31st of
    January makes the 31st of February, which rolls forward to the 3rd of March
    — a grant two or three days longer than it said, every time, for anybody
    who redeems at the end of a long month.
  */
  const jan31 = new Date("2026-01-31T00:00:00.000Z");
  check(
    "the 31st of January plus one month is the 28th of February, not the 3rd of March",
    grantEnd(1, jan31).toISOString() === "2026-02-28T00:00:00.000Z",
    grantEnd(1, jan31).toISOString(),
  );
  check(
    "and in a leap year it is the 29th",
    grantEnd(1, new Date("2024-01-31T00:00:00.000Z")).toISOString() === "2024-02-29T00:00:00.000Z",
    grantEnd(1, new Date("2024-01-31T00:00:00.000Z")).toISOString(),
  );
  check(
    "a month that has the day keeps the day",
    grantEnd(1, new Date("2026-03-15T09:30:00.000Z")).toISOString() === "2026-04-15T09:30:00.000Z",
  );
  check("the grant is the code's plan, not the account's", grantFrom(code({ plan: "studio" }), AT).plan === "studio");
  check("free is not a plan a code may grant", !grantablePlans().includes("free"));
  check("and the three paid ones are", ["creator", "pro", "studio"].every((p) => grantablePlans().includes(p)));
}

// ─── Who may redeem, and who may not ─────────────────────────────────────────

section("A code is refused for reasons that are not the same reason");
{
  const reasonOf = (c, a) => refuseRedemption(c, a, AT)?.reason ?? null;

  check("a free account with a good code is allowed", reasonOf(code(), account()) === null);
  check("a code nobody minted", reasonOf(null, account()) === "unknown");
  check("a withdrawn code", reasonOf(code({ revokedAt: AT }), account()) === "revoked");
  check(
    "a code past its date",
    reasonOf(code({ expiresAt: new Date(AT.getTime() - 1000) }), account()) === "expired",
  );
  check(
    "and one whose date is still ahead is fine",
    reasonOf(code({ expiresAt: new Date(AT.getTime() + 1000) }), account()) === null,
  );
  check("a code with no seats left", reasonOf(code({ redeemedCount: 1 }), account()) === "used-up");
  check(
    "a code with seats left on a multi-seat code",
    reasonOf(code({ maxRedemptions: 50, redeemedCount: 49 }), account()) === null,
  );
  check("this account, again", reasonOf(code(), account({ usedThisCode: true })) === "already-used");

  /*
    The refusal that matters most, and the one this whole design turns on.

    A licence with no end date is somebody's card being charged. Writing a
    grant's expiry onto that row would drop a paying customer to free twelve
    months later while the charge continued — the product taking away something
    still being paid for, from a person who did nothing but try a code.
  */
  check(
    "a paying subscriber is turned away rather than stamped with an end date",
    reasonOf(code(), account({ plan: "pro", licenseId: "lic_123", planExpiresAt: null })) === "paid-account",
  );
  /*
    The owner's own account, and the refusal it was given.

    `license_id` is the record of what the merchant of record last said, and it
    outlives what it said: a cancellation, a refund, or — as here — a test
    event that granted nothing. The rule read "a licence and no end date" as
    "is paying", so a row sitting on **free** with a stale licence id was
    turned away as a paying customer whose card must not be disturbed. Nobody
    is charged for free, and a row serving nothing has nothing for a grant to
    take away.
  */
  check(
    "a free row carrying a spent licence id is not a paying customer",
    reasonOf(code(), account({ plan: "free", licenseId: "2021110", planExpiresAt: null })) === null,
  );
  check(
    "while a paid plan behind that same licence still is",
    reasonOf(code(), account({ plan: "pro", licenseId: "2021110", planExpiresAt: null })) === "paid-account",
  );
  check(
    "but a lapsed paid account — a licence and an end date behind it — may redeem",
    reasonOf(
      code(),
      account({ plan: "free", licenseId: "lic_123", planExpiresAt: new Date(AT.getTime() - 1000) }),
    ) === null,
  );

  check(
    "a smaller code onto a live bigger grant is refused, not applied",
    reasonOf(code({ plan: "creator" }), account({ plan: "studio", planExpiresAt: new Date(AT.getTime() + 1000) })) ===
      "not-an-upgrade",
  );
  check(
    "the same plan again is refused too",
    reasonOf(code({ plan: "pro" }), account({ plan: "pro", planExpiresAt: new Date(AT.getTime() + 1000) })) ===
      "not-an-upgrade",
  );
  check(
    "a bigger code onto a live grant is allowed",
    reasonOf(code({ plan: "studio" }), account({ plan: "pro", planExpiresAt: new Date(AT.getTime() + 1000) })) === null,
  );
  check(
    "and once a grant has run out, the same plan may be granted again",
    reasonOf(code({ plan: "pro" }), account({ plan: "pro", planExpiresAt: new Date(AT.getTime() - 1000) })) === null,
  );

  // Order: the account is judged before the code is spent, so nothing burns a
  // seat on its way to a refusal.
  check(
    "an account that already used the code is told so rather than told it is used up",
    reasonOf(code({ redeemedCount: 1 }), account({ usedThisCode: true })) === "already-used",
  );

  check(
    "every refusal carries a status the browser can act on",
    [
      refuseRedemption(null, account(), AT),
      refuseRedemption(code({ revokedAt: AT }), account(), AT),
      refuseRedemption(code({ redeemedCount: 1 }), account(), AT),
    ].every((r) => r && r.status >= 400 && r.status < 500 && typeof r.error === "string" && r.error.length > 10),
  );
}

// ─── The date, applied everywhere or nowhere ─────────────────────────────────

section("A plan that has run out is not served");
{
  check("an unexpired grant is the plan it says", servedPlan({ plan: "pro", planExpiresAt: new Date(AT.getTime() + 1) }, AT) === "pro");
  check("a lapsed one is free", servedPlan({ plan: "pro", planExpiresAt: new Date(AT.getTime() - 1) }, AT) === "free");
  check("the exact moment it ends, it is over", servedPlan({ plan: "pro", planExpiresAt: AT }, AT) === "free");
  check("a plan with no end date is untouched", servedPlan({ plan: "studio", planExpiresAt: null }, AT) === "studio");
  check("a missing row is free", servedPlan(undefined, AT) === "free");
  check("a date that arrived as a string is still read", servedPlan({ plan: "pro", planExpiresAt: "2020-01-01T00:00:00Z" }, AT) === "free");
  check(
    "and a date that cannot be read does not take somebody's plan away",
    servedPlan({ plan: "pro", planExpiresAt: "not a date" }, AT) === "pro",
  );
  check("an old plan name still resolves through the rename map", servedPlan({ plan: "starter", planExpiresAt: null }, AT) === "creator");
}

// ─── Nobody reads the column ─────────────────────────────────────────────────

section("Every door reads the plan through the date, not around it");
{
  const serverRoot = path.join(repoRoot, "artifacts/api-server/src");
  const sources = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) sources.push([full, readFileSync(full, "utf8")]);
    }
  };
  walk(serverRoot);

  check("the API server's sources were found", sources.length > 20, `${sources.length}`);

  /*
    `planKeyFrom(sub.plan)` is the shape this is looking for: a subscription row
    whose plan is resolved without its end date. It is the exact line that was
    at every door before promo codes existed, and the exact line somebody will
    write again out of habit.
  */
  const around = sources
    .filter(([file]) => !file.endsWith("plan-limits.ts"))
    .filter(([, text]) => /planKeyFrom\(\s*(sub|subscription|existing)\??\.\s*plan/.test(text))
    .map(([file]) => path.relative(repoRoot, file));
  check("no route resolves a subscription row's plan without its end date", around.length === 0, around.join(", "));

  const served = sources.filter(([, text]) => /servedPlan\(/.test(text)).length;
  check("and the doors that decide what a plan may do go through servedPlan", served >= 6, `${served} files`);

  // Both paid write paths must clear the grant columns in the same statement
  // that sets the plan. Either one forgetting is a paying customer who drops to
  // free on a date nobody chose.
  for (const file of ["artifacts/api-server/src/routes/billing.ts", "artifacts/api-server/src/lib/claim-paid-events.ts"]) {
    const text = readFileSync(path.join(repoRoot, file), "utf8");
    check(
      `${path.basename(file)} clears the grant when a payment sets a plan`,
      /plan_expires_at\s*=\s*NULL/i.test(text) && /promo_code\s*=\s*NULL/i.test(text),
    );
  }

  const route = readFileSync(path.join(repoRoot, "artifacts/api-server/src/routes/promo.ts"), "utf8");
  check("the redeem door is rate limited", /rateLimit\(LIMITS\.promoRedeem\)/.test(route));
  check("and it never reads a plan from the request", !/req\.body[\s\S]{0,80}plan/.test(route));

  const index = readFileSync(path.join(repoRoot, "artifacts/api-server/src/routes/index.ts"), "utf8");
  check(
    "and it is mounted behind the auth middleware",
    index.indexOf("router.use(requireAuth)") < index.indexOf("router.use(promoRouter)"),
  );
}

// ─── The race, run rather than described ─────────────────────────────────────

section("One seat cannot be handed to two people");
{
  const { applyRedemption } = await import(
    pathToFileURL(bundle("artifacts/api-server/src/lib/promo-grant.ts", "promo-grant.mjs", ["--external:pg"])).href
  );
  const { db, pool } = await import(
    pathToFileURL(bundle("lib/db/src/index.ts", "db.mjs", ["--external:pg"])).href
  );

  const mint = async (over = {}) => {
    const row = {
      code: `T${randomUUID().replace(/-/g, "").slice(0, 9).toUpperCase()}`,
      plan: "pro",
      months: 12,
      max_redemptions: 1,
      expires_at: null,
      revoked_at: null,
      note: "a test",
      created_by: randomUUID(),
      ...over,
    };
    await pool.query(
      `INSERT INTO promo_codes (code, plan, months, max_redemptions, expires_at, revoked_at, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [row.code, row.plan, row.months, row.max_redemptions, row.expires_at, row.revoked_at, row.note, row.created_by],
    );
    return row.code;
  };
  const planOf = async (userId) => {
    const { rows } = await pool.query(
      `SELECT plan, plan_expires_at, promo_code, license_id FROM subscriptions WHERE user_id = $1`,
      [userId],
    );
    return rows[0] ?? null;
  };
  const grant = { plan: "pro", expiresAt: grantEnd(12, AT) };

  try {
    // Two different people, one seat, at the same instant.
    const oneSeat = await mint();
    const [a, b] = [randomUUID(), randomUUID()];
    const both = await Promise.all([
      applyRedemption(db, { code: oneSeat, userId: a, grant, now: new Date() }),
      applyRedemption(db, { code: oneSeat, userId: b, grant, now: new Date() }),
    ]);
    const granted = both.filter((r) => r.outcome === "granted");
    check("exactly one of two simultaneous requests is granted", granted.length === 1, JSON.stringify(both));
    check("and the other is told the code is used up", both.some((r) => r.outcome === "used-up"), JSON.stringify(both));

    const { rows: counted } = await pool.query(`SELECT redeemed_count FROM promo_codes WHERE code = $1`, [oneSeat]);
    check("the count matches what was handed out", Number(counted[0].redeemed_count) === 1, JSON.stringify(counted));
    const { rows: redemptions } = await pool.query(`SELECT user_id FROM promo_redemptions WHERE code = $1`, [oneSeat]);
    check("and exactly one redemption was written", redemptions.length === 1, JSON.stringify(redemptions));

    const winner = redemptions[0].user_id;
    const loser = winner === a ? b : a;
    const won = await planOf(winner);
    check("the winner is on the plan the code gives", won?.plan === "pro", JSON.stringify(won));
    check("with the end date on the row", won?.plan_expires_at !== null);
    check("and the code recorded beside it", won?.promo_code === oneSeat);
    check("the loser has no subscription row at all", (await planOf(loser)) === null);

    // The same account, twice, at the same instant, on a code with room for two.
    const twoSeats = await mint({ max_redemptions: 2 });
    const twice = randomUUID();
    const again = await Promise.all([
      applyRedemption(db, { code: twoSeats, userId: twice, grant, now: new Date() }),
      applyRedemption(db, { code: twoSeats, userId: twice, grant, now: new Date() }),
    ]);
    check(
      "one account asking twice at once takes one seat, not two",
      again.filter((r) => r.outcome === "granted").length === 1,
      JSON.stringify(again),
    );
    const { rows: twoCount } = await pool.query(`SELECT redeemed_count FROM promo_codes WHERE code = $1`, [twoSeats]);
    check(
      "and the refused half rolled its increment back with it",
      Number(twoCount[0].redeemed_count) === 1,
      JSON.stringify(twoCount),
    );

    // A withdrawn code, and one past its date, are refused by the claim itself
    // rather than only by the check in front of it — the check reads a moment
    // earlier than the write, and an operator can withdraw a code in between.
    const withdrawn = await mint({ revoked_at: new Date() });
    check(
      "a code withdrawn between the check and the claim is not granted",
      (await applyRedemption(db, { code: withdrawn, userId: randomUUID(), grant, now: new Date() })).outcome ===
        "used-up",
    );
    const stale = await mint({ expires_at: new Date(Date.now() - 60_000) });
    check(
      "and one past its date is not either",
      (await applyRedemption(db, { code: stale, userId: randomUUID(), grant, now: new Date() })).outcome === "used-up",
    );

    /*
      A licence is left alone.

      The one account a code can be redeemed on that has a licence id is a
      *lapsed* paid subscriber, and that id is what the billing ledger compares
      a redelivered cancellation against. Overwriting it would blind the rule
      that stops an old event undoing a live plan.
    */
    const lapsed = randomUUID();
    await pool.query(
      `INSERT INTO subscriptions (user_id, plan, license_id, plan_expires_at)
       VALUES ($1, 'free', 'lic_old', now() - interval '1 day')`,
      [lapsed],
    );
    const onLapsed = await mint();
    await applyRedemption(db, { code: onLapsed, userId: lapsed, grant, now: new Date() });
    const after = await planOf(lapsed);
    check("a grant onto a lapsed paid account keeps the licence id", after?.license_id === "lic_old", JSON.stringify(after));
    check("and moves the plan", after?.plan === "pro", JSON.stringify(after));
  } finally {
    await pool.end();
  }
}

// ─── The half that cannot be built here, said out loud ───────────────────────

section("What a code is not, written where somebody will look for it");
{
  /*
    Osama asked for two things in one sentence: a code that makes the payment
    zero, and codes that take something off a price. The first is a grant and is
    built here. The second is a rule about a charge, and the charge is made by
    the merchant of record — there is no honest way to write it on this side,
    because we would be recording a smaller number while the card was charged
    the larger one.

    A feature that cannot exist yet has to say so in the file somebody opens
    looking for it, or it gets rebuilt badly by whoever looks next.
  */
  const rules = readFileSync(path.join(repoRoot, "artifacts/api-server/src/lib/promo.ts"), "utf8");
  check("the rules module explains that a code is a grant, not a discount", /not a coupon|not a discount/i.test(rules));
  check(
    "and names where a partial discount has to live instead",
    /merchant of record|checkout/i.test(rules),
  );

  const copy = readFileSync(path.join(repoRoot, "artifacts/editly/src/lib/copy/admin.ts"), "utf8");
  check("and the console says the same thing to the person minting one", /checkout|جهة الدفع/.test(copy));
}

console.log("\nThe door itself, which is the only public thing here");
{
  /*
    Everything above tests the rules with no database and no server, which is
    the right way round — and left `promo.ts` as an area `inventory.mjs --check`
    reported as tested by nothing, because no suite named its one endpoint.

    That is not a bookkeeping complaint. This route is the only place in the
    product where a plan is granted without a payment, and it is reachable by
    anybody with an account and a guess. What it must do is checked here
    against the route as written: the guess is rate limited, the seat is
    claimed in the same statement that checks it is still free, and the
    refusals from the pure rules above are the ones actually sent.
  */
  const route = readFileSync(path.join(repoRoot, "artifacts/api-server/src/routes/promo.ts"), "utf8");

  check("the door is POST /promo/redeem", route.includes('router.post("/promo/redeem"'));
  check(
    "and it is rate limited, because it is a credential a stranger can type",
    /rateLimit\(LIMITS\.promoRedeem\)/.test(route),
  );
  check("the typed word is normalised before anything is looked up", /normaliseCode\(/.test(route));
  check("the refusal comes from the pure rules rather than being restated here", /refuseRedemption\(/.test(route));
  check(
    "and its status is the one those rules chose, not one restated at the door",
    /res\.status\(answer\.status\)\.json\(\{ error: answer\.error, reason: answer\.reason \}\)/.test(route),
  );
  check(
    "a code nobody has heard of answers the same as one that does not exist",
    /refusal \?\? \{ status: 404, reason: "unknown"/.test(route),
  );
  check("the grant written is the one the rules computed", /grantFrom\(/.test(route));
  check(
    "the seat is claimed under the condition that it is still free",
    /applyRedemption\(/.test(readFileSync(path.join(repoRoot, "artifacts/api-server/src/routes/promo.ts"), "utf8")),
  );

  const grant = readFileSync(path.join(repoRoot, "artifacts/api-server/src/lib/promo-grant.ts"), "utf8");
  check(
    "and that claim is one conditional UPDATE, not a read followed by a write",
    /\.update\(promoCodesTable\)[\s\S]{0,600}?redeemedCount\} < \$\{promoCodesTable\.maxRedemptions\}/.test(grant),
    "two people redeeming the last seat at the same moment must not both win it",
  );
  check(
    "the count is incremented by the database rather than by a number we read",
    /redeemedCount: sql`\$\{promoCodesTable\.redeemedCount\} \+ 1`/.test(grant),
  );
  check(
    "inside a transaction, so the count and the redemption cannot disagree",
    /transaction\(/.test(grant),
  );
}

await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log(`A code gives a plan for a while, once, to one account. (${databaseUrl.replace(/:[^:@]*@/, ":***@")})`);
