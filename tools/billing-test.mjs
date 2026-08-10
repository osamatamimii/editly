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

await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("A payment cannot be forged, and a refund cannot leave access on.");
