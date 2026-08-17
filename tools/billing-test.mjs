/**
 * Can someone give themselves a paid plan for free?
 *
 * That is the whole question for this file. The billing webhook is a public URL
 * that grants paid access, which makes it the single most attractive endpoint
 * in the product to forge a request to. Everything else here — plan mapping,
 * refunds, ordering — matters, but it matters second.
 *
 * So every check is written from the attacker's side: no signature, a plausible
 * signature, a signature over a *different* body, a valid signature for a plan
 * that does not exist. And then from the customer's side, where the failure is
 * quieter and just as damaging: a refund that leaves paid access on, or a
 * retried webhook that double-applies.
 *
 * Usage: node tools/billing-test.mjs
 * Requires: nothing. No keys, no network, no database.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHmac, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-billing-build-"));
const outfile = path.join(buildDir, "freemius.mjs");
const ledgerOut = path.join(buildDir, "billing-ledger.mjs");
const claimOut = path.join(buildDir, "claim-paid-events.mjs");

const SECRET = "test-secret-not-a-real-key";
const PLAN_MAP = "9001:creator,9002:pro,9003:studio";

process.env.FREEMIUS_SECRET_KEY = SECRET;
process.env.FREEMIUS_PLAN_MAP = PLAN_MAP;
process.env.FREEMIUS_PRODUCT_ID = "36845";
process.env.FREEMIUS_PUBLIC_KEY = "pk_test_public_value";

const built = spawnSync(
  require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] }),
  [
    path.join(repoRoot, "artifacts/api-server/src/lib/freemius.ts"),
    "--bundle", "--platform=node", "--format=esm", "--target=node22",
    `--outfile=${outfile}`, "--log-level=error",
  ],
  { stdio: "inherit" },
);
if (built.status !== 0) {
  console.error("could not bundle the freemius module");
  process.exit(1);
}

for (const [entry, out] of [
  ["artifacts/api-server/src/lib/billing-ledger.ts", ledgerOut],
  ["artifacts/api-server/src/lib/claim-paid-events.ts", claimOut],
]) {
  const made = spawnSync(
    require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] }),
    [
      path.join(repoRoot, entry),
      "--bundle", "--platform=node", "--format=esm", "--target=node22",
      // The claim module reaches for the database driver at call time only; the
      // pure rule above it is what is under test here.
      // The database driver and the logger are reached for at call time; the
      // pure rules above them are what is under test here, and bundling either
      // would drag a connection pool into a suite that needs no database.
      "--external:@workspace/db",
      `--alias:pino=${path.join(repoRoot, "tools/fixtures/pino-stub.mjs")}`,
      `--outfile=${out}`, "--log-level=error",
    ],
    { stdio: "inherit" },
  );
  if (made.status !== 0) {
    console.error(`could not bundle ${entry}`);
    process.exit(1);
  }
}

const { verifySignature, planFromEvent, checkoutConfig, freemiusConfigured } =
  await import(pathToFileURL(outfile).href);
const { decideApply, eventIdFor, eventTimeFrom } = await import(pathToFileURL(ledgerOut).href);
const { claimable } = await import(pathToFileURL(claimOut).href);

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

const sign = (body, secret = SECRET) => createHmac("sha256", secret).update(body).digest("hex");
const body = (obj) => Buffer.from(JSON.stringify(obj), "utf8");

console.log("\nForging a payment");
{
  const real = body({ type: "license.created", objects: { license: { plan_id: 9002 } } });

  check("a correctly signed body is accepted", verifySignature(real, sign(real)), "");
  check("no signature at all is refused", !verifySignature(real, undefined), "");
  check("an empty signature is refused", !verifySignature(real, ""), "");
  check("a plausible-looking hex string is refused", !verifySignature(real, "a".repeat(64)), "");
  check(
    "a signature made with the wrong secret is refused",
    !verifySignature(real, sign(real, "attacker-guessed-this")),
    "",
  );

  // The attack that actually works against naive implementations: take a real
  // signed event and change the plan.
  const tampered = body({ type: "license.created", objects: { license: { plan_id: 9003 } } });
  check(
    "a real signature attached to a different body is refused",
    !verifySignature(tampered, sign(real)),
    "",
  );

  // Re-serialising loses the exact bytes, which is why the raw body matters.
  const reserialised = Buffer.from(JSON.stringify(JSON.parse(real.toString())), "utf8");
  check(
    "the signature covers the bytes, not the parsed object",
    verifySignature(reserialised, sign(real)) === real.equals(reserialised),
    "",
  );

  check("case in the signature does not matter", verifySignature(real, sign(real).toUpperCase()), "");
  check("a truncated signature is refused", !verifySignature(real, sign(real).slice(0, 40)), "");
}

console.log("\nWhat an event means");
{
  const created = planFromEvent({ type: "license.created", planId: 9002 });
  check("a purchase grants the plan it paid for", created?.plan === "pro", JSON.stringify(created));

  check(
    "an upgrade moves to the new plan",
    planFromEvent({ type: "license.updated", planId: 9003 })?.plan === "studio",
    "",
  );
  check(
    "a renewal keeps the plan rather than stacking anything",
    planFromEvent({ type: "license.extended", planId: 9001 })?.plan === "creator",
    "",
  );

  for (const type of ["payment.refund", "license.cancelled", "license.expired", "subscription.cancelled"]) {
    check(`${type} drops access to free`, planFromEvent({ type, planId: 9003 })?.plan === "free", "");
  }

  check(
    "a plan id we do not recognise changes nothing rather than guessing",
    planFromEvent({ type: "license.created", planId: 9999 }) === null,
    "",
  );
  check(
    "a purchase with no plan id changes nothing",
    planFromEvent({ type: "license.created", planId: null }) === null,
    "",
  );
  check(
    "events that are not about access are ignored",
    planFromEvent({ type: "cart.abandoned", planId: 9002 }) === null,
    "",
  );
}

console.log("\nArriving twice, and out of order");
{
  // Webhooks retry, and a renewal can land before the payment that caused it.
  // Every decision is a target state, so applying one twice is the same as
  // applying it once, and a late duplicate cannot undo a newer decision.
  const first = planFromEvent({ type: "license.created", planId: 9002 });
  const again = planFromEvent({ type: "license.created", planId: 9002 });
  check("the same event twice decides the same thing", first.plan === again.plan, "");

  const upgrade = planFromEvent({ type: "license.updated", planId: 9003 });
  const lateDuplicateOfOlder = planFromEvent({ type: "license.created", planId: 9002 });
  check(
    "decisions are states, not deltas — nothing accumulates",
    upgrade.plan === "studio" && lateDuplicateOfOlder.plan === "pro",
    "a delta-based design would have compounded these",
  );

  check(
    "a refund after an upgrade still lands on free",
    planFromEvent({ type: "payment.refund", planId: 9003 })?.plan === "free",
    "",
  );
}

console.log("\nA retry that lost a race is not news");
{
  // The bug this is about, in order:
  //
  //   1. A customer upgrades Creator → Pro.
  //   2. Freemius emits `license.created` (Pro) and `license.cancelled` for the
  //      superseded Creator licence.
  //   3. Our first delivery of the cancellation fails — any transient blip.
  //   4. Freemius retries it after the Pro event has landed.
  //   5. A blind upsert writes free over Pro.
  //
  // They are charged $29 a month and see the free plan's watermark, and
  // `PATCH /subscription` refuses upgrades by design, so nothing in the product
  // can put it back. `planFromEvent` is not at fault — its answers are target
  // states, which is idempotent. Idempotence is not order-independence.
  const now = new Date("2026-08-15T12:00:00Z");
  const earlier = new Date("2026-08-15T11:00:00Z");

  const onPro = { plan: "pro", licenseId: "L-PRO", planSourceAt: now };

  const staleCancellation = decideApply(
    { plan: "free", licenseId: "L-CREATOR", eventAt: earlier },
    onPro,
  );
  check("a cancellation older than the plan it would undo is refused", staleCancellation.apply === false);
  check("and named as stale rather than as an error", staleCancellation.outcome === "stale", staleCancellation.outcome);

  // The same event with no timestamp at all still has the licence to go on.
  const supersededLicence = decideApply({ plan: "free", licenseId: "L-CREATOR", eventAt: null }, onPro);
  check(
    "so is one for a licence that is not the one granting this plan",
    supersededLicence.apply === false && supersededLicence.outcome === "superseded-licence",
    JSON.stringify(supersededLicence),
  );

  // The refusals must be narrow. Every one of them has to let a real
  // cancellation through, or we have built a product nobody can leave.
  const realCancellation = decideApply({ plan: "free", licenseId: "L-PRO", eventAt: now }, onPro);
  check("a cancellation of the live licence still applies", realCancellation.apply === true, JSON.stringify(realCancellation));

  const laterCancellation = decideApply(
    { plan: "free", licenseId: "L-OTHER", eventAt: new Date("2026-09-01T00:00:00Z") },
    { plan: "pro", licenseId: null, planSourceAt: now },
  );
  check(
    "and so does one where we never recorded which licence granted the plan",
    laterCancellation.apply === true,
    JSON.stringify(laterCancellation),
  );

  const noTimestamps = decideApply({ plan: "free", licenseId: null, eventAt: null }, { plan: "pro", licenseId: null, planSourceAt: null });
  check(
    "an event we cannot order is applied, because dropping real payments is the worse failure",
    noTimestamps.apply === true,
    JSON.stringify(noTimestamps),
  );

  // Upgrades are never refused on licence identity — a new licence has a new
  // id by definition, so the rule is deliberately one-directional.
  const upgrade = decideApply({ plan: "pro", licenseId: "L-NEW", eventAt: now }, { plan: "creator", licenseId: "L-OLD", planSourceAt: earlier });
  check("an upgrade carrying a new licence id is applied", upgrade.apply === true, JSON.stringify(upgrade));

  const olderUpgrade = decideApply({ plan: "studio", licenseId: "L-X", eventAt: earlier }, { plan: "pro", licenseId: "L-PRO", planSourceAt: now });
  check(
    "but an upgrade older than the current state is still stale — the rule is about order, not direction",
    olderUpgrade.apply === false && olderUpgrade.outcome === "stale",
    JSON.stringify(olderUpgrade),
  );

  const duplicate = decideApply({ plan: "pro", licenseId: "L-PRO", eventAt: now, alreadySeen: true }, onPro);
  check("an event we have already recorded does nothing a second time", duplicate.apply === false);
  check("and says which it was", duplicate.outcome === "duplicate", duplicate.outcome);

  const first = decideApply({ plan: "pro", licenseId: "L-PRO", eventAt: now }, null);
  check("a first payment for an account with no subscription row applies", first.apply === true, JSON.stringify(first));

  const notAboutAccess = decideApply({ plan: null, eventAt: now }, onPro);
  check("an event that is not about access changes nothing", notAboutAccess.apply === false && notAboutAccess.outcome === "ignored");
}

console.log("\nEvery event is remembered by something");
{
  const sha = (input) => createHash("sha256").update(input).digest("hex");

  const withId = eventIdFor({ id: 4815162342 }, "body", sha);
  check("Freemius's own id is used when they send one", withId === "fs_4815162342", withId);
  check(
    "including when it is nested where some of their shapes put it",
    eventIdFor({ data: { id: "abc" } }, "body", sha) === "fs_abc",
  );

  // An event with no id would otherwise be exempt from the duplicate rule —
  // which is the one case where being exempt matters, since a redelivery is
  // exactly what the rule exists for.
  const a = eventIdFor({}, "the same bytes", sha);
  const b = eventIdFor({}, "the same bytes", sha);
  const c = eventIdFor({}, "different bytes", sha);
  check("an event with no id is remembered by its own bytes", a === b, `${a} vs ${b}`);
  check("and two different events are not confused for each other", a !== c);
  check("the derived id is marked as derived", a.startsWith("sha_"), a);
}

console.log("\nWhen Freemius says it happened");
{
  // Their timestamps have no zone and are UTC by their documentation. `new
  // Date` parses that as *local* time, so on a machine set to anything but UTC
  // every ordering comparison would be shifted by the offset — which would make
  // the stale rule above either fire on live events or miss stale ones,
  // depending on which side of UTC the machine sits.
  const read = eventTimeFrom({ license: { updated: "2026-08-15 14:02:11" } }, {});
  check("a zoneless Freemius timestamp is read as UTC", read?.toISOString() === "2026-08-15T14:02:11.000Z", String(read));

  check(
    "the payload's own timestamp wins over the licence's",
    eventTimeFrom({ license: { updated: "2020-01-01 00:00:00" } }, { created: "2026-08-15 14:02:11" })?.toISOString() ===
      "2026-08-15T14:02:11.000Z",
  );
  check(
    "an ISO timestamp is left alone",
    eventTimeFrom({}, { created: "2026-08-15T14:02:11.000Z" })?.toISOString() === "2026-08-15T14:02:11.000Z",
  );
  check("and nothing at all is null, not now()", eventTimeFrom({}, {}) === null);
  check("as is a value that is not a date", eventTimeFrom({}, { created: "soon" }) === null);
}

console.log("\nA payment that arrived before its owner did");
{
  // Paying with a different address than you signed up with is the commonest
  // billing ticket there is. It used to be answered 200 with nothing written
  // down: the customer was charged, got the free plan, and support had no
  // record to reconcile from beyond a log line that deliberately excluded the
  // address.
  const older = { eventId: "e1", plan: "creator", licenseId: "L1", eventAt: "2026-07-01T00:00:00Z" };
  const newer = { eventId: "e2", plan: "pro", licenseId: "L2", eventAt: "2026-08-01T00:00:00Z" };

  check("a waiting payment is handed over", claimable([newer], "free")?.eventId === "e2");
  check("the newest of several wins", claimable([older, newer], "free")?.eventId === "e2");
  check("whatever order they are read in", claimable([newer, older], "free")?.eventId === "e2");

  // Never a downgrade. An unmatched event is by definition one nobody could act
  // on at the time, and applying a stale one now — to somebody who has since
  // been granted a plan properly — would take away access nobody asked us to.
  const cancellation = { eventId: "e3", plan: "free", licenseId: "L1", eventAt: "2026-08-02T00:00:00Z" };
  check("a pending cancellation never downgrades anybody", claimable([cancellation], "pro") === null);
  check("nor does a pending plan below the one they already have", claimable([older], "pro") === null);
  check("and an equal plan is not re-applied", claimable([newer], "pro") === null);
  check("nothing waiting means nothing happens", claimable([], "free") === null);
}

console.log("\nWhat leaves the server");
{
  const config = checkoutConfig();
  check("the checkout gets the product id", config?.productId === "36845", JSON.stringify(config));
  check("and the public key", config?.publicKey === "pk_test_public_value", "");
  check(
    "and nothing else — the secret never appears in it",
    !JSON.stringify(config).includes(SECRET),
    "",
  );
  check("the module knows whether it is configured", freemiusConfigured === true, "");
}

console.log("\nThe bytes surviving the trip");
{
  // The failure this section exists for is the one every other check in this
  // file misses by construction: they call the verifier directly with bytes
  // they made themselves. In the deployed app the request first passes through
  // `express.json()`, which consumes the stream and hands back a parsed object.
  // A route that then asks for the raw body gets nothing, so the digest is
  // computed over "[object Object]" and *every genuine payment* is answered
  // with 401 — while this file still reports 26/26.
  //
  // So this drives a real request through the real middleware and checks that
  // what arrives at the handler is byte-identical to what was sent.
  // Built inside the package rather than in /tmp, and with express left
  // external: bundling express into a standalone ESM file breaks it (it reaches
  // for `require` at load time), and the point here is to exercise the real
  // middleware rather than a copy of it.
  const parsersOut = path.join(repoRoot, "artifacts/api-server/.body-parsers.test.mjs");
  const parsersBuilt = spawnSync(
    require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] }),
    [
      path.join(repoRoot, "artifacts/api-server/src/lib/body-parsers.ts"),
      "--bundle", "--platform=node", "--format=esm", "--target=node22",
      "--external:express",
      `--outfile=${parsersOut}`, "--log-level=error",
    ],
    { stdio: "inherit" },
  );

  if (parsersBuilt.status !== 0) {
    check("the body-parser module builds", false, "esbuild failed");
  } else {
    const { bodyParsers, needsRawBody } = await import(pathToFileURL(parsersOut).href);
    const express = require(require.resolve("express", { paths: ["artifacts/api-server"] }));

    check("the webhook path is exempt from parsing", needsRawBody("/api/billing/webhook"), "");
    check("and nothing else is", !needsRawBody("/api/projects") && !needsRawBody("/api/billing/checkout"), "");

    const app = express();
    for (const parser of bodyParsers()) app.use(parser);

    let seen = null;
    app.post("/api/billing/webhook", express.raw({ type: "*/*", limit: "1mb" }), (req, res) => {
      seen = Buffer.isBuffer(req.body) ? req.body : null;
      res.json({ ok: true });
    });
    app.post("/api/projects", (req, res) => res.json({ parsed: req.body }));

    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    // Whitespace and key order chosen to be destroyed by a parse/serialise
    // round trip — which is exactly what a signature would not survive.
    const sent = Buffer.from('{ "type":"license.created",  "objects":{"license":{"plan_id":9002}} }', "utf8");

    const hookResponse = await fetch(`${base}/api/billing/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: sent,
    });

    check("the webhook answers", hookResponse.ok, String(hookResponse.status));
    check("the handler receives a Buffer, not a parsed object", Buffer.isBuffer(seen), String(seen && typeof seen));
    check(
      "and the bytes are exactly the bytes that were sent",
      Boolean(seen && seen.equals(sent)),
      seen ? `got ${JSON.stringify(seen.toString())}` : "nothing arrived",
    );
    check(
      "so a signature made over those bytes still verifies end to end",
      Boolean(seen && verifySignature(seen, sign(sent))),
      "",
    );

    // The exemption must be narrow: every other route still needs JSON.
    const normal = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "a project" }),
    });
    const normalBody = await normal.json();
    check("ordinary routes still get parsed JSON", normalBody?.parsed?.title === "a project", JSON.stringify(normalBody));

    server.close();
  }

  await rm(parsersOut, { force: true });
}

await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("A payment cannot be forged, and a refund cannot leave access on.");
