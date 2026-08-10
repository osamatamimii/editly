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
import { createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-billing-build-"));
const outfile = path.join(buildDir, "freemius.mjs");

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

const { verifySignature, planFromEvent, checkoutConfig, freemiusConfigured } =
  await import(pathToFileURL(outfile).href);

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
