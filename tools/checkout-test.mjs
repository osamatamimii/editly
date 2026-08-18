/**
 * The one button that takes money, and the way it used to fail.
 *
 * A content blocker does not reject `checkout.freemius.com`. It black-holes it:
 * no `onload`, no `onerror`, no entry in the resource timeline, no console
 * line. The promise that waits on the script therefore never settles, and the
 * button says "Opening checkout…" for the rest of the session.
 *
 * I reproduced exactly that on the live site before writing this: the script
 * tag was appended, and twenty seconds later `performance.getEntriesByType`
 * still showed zero freemius requests and neither handler had run.
 *
 * So these checks are about a clock and a way out, not about Freemius:
 *   1. a load that never answers must still settle, and quickly
 *   2. it must fall back to the hosted checkout, which is a navigation rather
 *      than a third-party script and so usually survives the same blocker
 *   3. the fallback URL must carry the right product, plan, cycle and email
 *
 * Usage: node tools/checkout-test.mjs
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-checkout-test-"));
const modulePath = path.join(buildDir, "checkout.mjs");

// The module imports the Supabase client for the session token. esbuild will
// not alias a relative specifier, so the stand-in is written where the real one
// resolves from — a copy of the source tree is not needed for two functions.
const srcDir = path.join(buildDir, "src");
const fs = await import("node:fs/promises");
await fs.mkdir(srcDir, { recursive: true });
await fs.copyFile(path.join(repoRoot, "artifacts/editly/src/lib/checkout.ts"), path.join(srcDir, "checkout.ts"));
await fs.writeFile(
  path.join(srcDir, "supabase.ts"),
  "export const supabase = { auth: { getSession: async () => ({ data: { session: null } }) } } as any;\n",
);

const esbuild = spawnSync(
  require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/worker"] }),
  [
    path.join(srcDir, "checkout.ts"),
    "--bundle", "--platform=neutral", "--format=esm", "--target=es2022",
    `--outfile=${modulePath}`, "--log-level=error",
  ],
  { stdio: "inherit" },
);
if (esbuild.status !== 0) {
  console.error("could not bundle the checkout module");
  process.exit(1);
}

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
 * A browser whose network swallows the request: the script element is created
 * and appended, and then nothing ever happens to it. This is the real
 * behaviour, not an approximation of it.
 */
function blackHoleDom() {
  const opened = [];
  const created = [];
  globalThis.window = {
    FS: undefined,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    open: (url) => opened.push(url),
  };
  globalThis.document = {
    createElement: () => {
      const el = {};
      created.push(el);
      return el;
    },
    head: { appendChild: () => {} },
  };
  return { opened, created };
}

const { openCheckout, hostedCheckoutUrl } = await import(pathToFileURL(modulePath).href);

const config = {
  productId: "36845",
  publicKey: "pk_test",
  plans: { creator: "61099", pro: "61100", studio: "61102" },
  currentPlan: "free",
};

console.log("\nThe hosted checkout URL");
{
  const url = hostedCheckoutUrl(config, { plan: "pro", billingCycle: "annual", email: "a b@x.com" });
  const parsed = new URL(url);
  check("names the product and the plan in the path", parsed.pathname === "/product/36845/plan/61100/", parsed.pathname);
  check("carries the billing cycle", parsed.searchParams.get("billing_cycle") === "annual");
  check("prefills the email, encoded", parsed.searchParams.get("user_email") === "a b@x.com", url);
  check("is on Freemius, not on us", parsed.host === "checkout.freemius.com", parsed.host);
  check(
    "returns nothing for a plan we do not sell",
    hostedCheckoutUrl({ ...config, plans: {} }, { plan: "pro", billingCycle: "monthly" }) === null,
  );
}

console.log("\nA request that is never answered");
{
  const dom = blackHoleDom();
  const started = Date.now();
  await openCheckout(config, { plan: "creator", billingCycle: "monthly", email: "x@y.com" });
  const took = Date.now() - started;

  check("settles instead of hanging forever", took < 20000, `${took}ms`);
  check("and does not sit there for a minute first", took < 15000, `${took}ms`);
  check("opens the hosted checkout instead", dom.opened.length === 1, JSON.stringify(dom.opened));
  check(
    "for the plan that was asked for",
    dom.opened[0]?.includes("/plan/61099/"),
    dom.opened[0] ?? "nothing opened",
  );
  check("in a new tab, without handing it our window", dom.opened.length === 1);
}


console.log("\nThe shape Freemius actually ships");
{
  // The live script attaches FS.Checkout as a plain object with open/close.
  // We were calling `new FS.Checkout(...)` against it, which throws
  // "window.FS.Checkout is not a constructor" — and that is precisely what a
  // real customer saw when they clicked Pro.
  const opened = [];
  globalThis.window = {
    FS: {
      Checkout: {
        configure: (o) => opened.push({ call: "configure", o }),
        open: (o) => opened.push({ call: "open", o }),
      },
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    open: (url) => opened.push({ call: "window.open", url }),
  };
  globalThis.document = { createElement: () => ({}), head: { appendChild: () => {} } };

  await openCheckout(config, { plan: "studio", billingCycle: "monthly", email: "z@y.com" });

  const call = opened.find((c) => c.call === "open");
  check("opens the widget rather than trying to construct it", Boolean(call), JSON.stringify(opened.map((c) => c.call)));
  check("never falls back when the widget works", !opened.some((c) => c.call === "window.open"));
  check("sends plugin_id, which is the name the script requires", call?.o.plugin_id === "36845", JSON.stringify(call?.o.plugin_id));
  check("sends the public key", call?.o.public_key === "pk_test");
  check("and the plan that was clicked", call?.o.plan_id === "61102", String(call?.o.plan_id));
  check("with the billing cycle and email", call?.o.billing_cycle === "monthly" && call?.o.user_email === "z@y.com");
}

console.log("\nThe older shape, still honoured");
{
  const seen = [];
  class LegacyCheckout {
    constructor(identity) { seen.push({ call: "new", identity }); }
    open(o) { seen.push({ call: "open", o }); }
  }
  globalThis.window = {
    FS: { Checkout: LegacyCheckout },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    open: (url) => seen.push({ call: "window.open", url }),
  };
  globalThis.document = { createElement: () => ({}), head: { appendChild: () => {} } };

  await openCheckout(config, { plan: "creator", billingCycle: "annual" });
  check("constructs it when it is a constructor", seen[0]?.call === "new", JSON.stringify(seen.map((c) => c.call)));
  check("then opens it", seen[1]?.call === "open");
}

console.log("\nA widget that loads and then throws");
{
  const seen = [];
  globalThis.window = {
    FS: { Checkout: { open: () => { throw new Error("nope"); } } },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    open: (url) => seen.push(url),
  };
  globalThis.document = { createElement: () => ({}), head: { appendChild: () => {} } };

  await openCheckout(config, { plan: "pro", billingCycle: "monthly" });
  check("still ends up at a checkout", seen.length === 1 && seen[0].includes("/plan/61100/"), JSON.stringify(seen));
}

await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log("Someone who cannot load the widget still cannot pay.");
  process.exit(1);
}
console.log("A blocked widget is a detour, not a dead end.");
