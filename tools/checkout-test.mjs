/**
 * The one button that takes money.
 *
 * It failed in production with `window.FS.Checkout is not a constructor`, and
 * the constructor was never the problem. `checkout.freemius.com/checkout.js`
 * is three IIFEs and the last one ends `})(jQuery);` — with no global jQuery
 * that argument throws a ReferenceError before the function is entered, so the
 * IIFE that assigns `FS.Checkout` never runs. What survives is the first one,
 * which defines `FS.Logger`. So `window.FS` exists — every "did it load?"
 * check passes — and `window.FS.Checkout` is undefined.
 *
 * Confirmed against production in a real browser: inject checkout.js alone and
 * `window.FS` has exactly one key, `Logger`. Inject jQuery first and it has
 * `Logger`, `PostMessage`, `Checkout`, the last with configure/open/close.
 *
 * The widget is therefore gone, and with it a 90KB CDN dependency and two
 * blockable requests in front of the only button that takes money. What is
 * left is a URL. These checks are about that URL and about the handoff:
 *
 *   1. the link carries the right product, plan, cycle and email, encoded
 *   2. a plan with no id is an error the caller can show, not a dead click
 *   3. a popup blocker must not swallow the purchase — it navigates instead
 *   4. a successful new tab must NOT also navigate this one
 *   5. the opener is severed, so the checkout cannot reach back into the app
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
 * A browser, with the two behaviours that matter made switchable:
 * whether `window.open` yields a window, and whether it throws outright.
 */
function fakeBrowser({ popupBlocked = false, openThrows = false } = {}) {
  const opened = [];
  const navigated = [];
  const handles = [];
  globalThis.window = {
    open: (url, target) => {
      opened.push({ url, target });
      if (openThrows) throw new Error("blocked by policy");
      if (popupBlocked) return null;
      const handle = { opener: { real: true } };
      handles.push(handle);
      return handle;
    },
    location: { assign: (url) => navigated.push(url) },
  };
  return { opened, navigated, handles };
}

const { openCheckout, hostedCheckoutUrl } = await import(pathToFileURL(modulePath).href);

const config = {
  productId: "36845",
  publicKey: "pk_test",
  plans: { creator: "61099", pro: "61100", studio: "61102" },
  currentPlan: "free",
};

console.log("\nThe link itself");
{
  const url = hostedCheckoutUrl(config, { plan: "pro", billingCycle: "annual", email: "a b@x.com" });
  const parsed = new URL(url);
  check("points at Freemius", parsed.host === "checkout.freemius.com", parsed.host);
  check("carries the product", parsed.pathname.includes("/product/36845/"), parsed.pathname);
  check("carries the plan for the tier asked for", parsed.pathname.includes("/plan/61100/"), parsed.pathname);
  check("carries the billing cycle", parsed.searchParams.get("billing_cycle") === "annual");
  check("prefills the email exactly", parsed.searchParams.get("user_email") === "a b@x.com");
  check("encodes rather than interpolates", !url.includes("a b@x.com"), url);
  check("ends the path in a slash, as Freemius serves it", parsed.pathname.endsWith("/"), parsed.pathname);
}
{
  const url = hostedCheckoutUrl(config, { plan: "creator", billingCycle: "monthly" });
  check("omits the email when there is none", !url.includes("user_email"), url);
  check("uses the creator plan id", url.includes("/plan/61099/"), url);
}
{
  const url = hostedCheckoutUrl(config, { plan: "studio", billingCycle: "monthly" });
  check("uses the studio plan id", url.includes("/plan/61102/"), url);
}
check(
  "a tier with no plan id has no link",
  hostedCheckoutUrl({ ...config, plans: {} }, { plan: "pro", billingCycle: "monthly" }) === null,
);

console.log("\nA browser that allows the new tab");
{
  const dom = fakeBrowser();
  let purchased = 0;
  await openCheckout(config, {
    plan: "pro", billingCycle: "monthly", email: "buyer@example.com",
    onPurchase: () => { purchased += 1; },
  });
  check("opens exactly one window", dom.opened.length === 1, String(dom.opened.length));
  check("opens it in a new tab", dom.opened[0]?.target === "_blank", String(dom.opened[0]?.target));
  check("opens the hosted checkout", (dom.opened[0]?.url ?? "").startsWith("https://checkout.freemius.com/product/36845/plan/61100/"));
  check("does NOT also navigate this tab", dom.navigated.length === 0, dom.navigated.join(","));
  check("severs the opener", dom.handles.every((h) => h.opener === null));
  check("tells the caller to refresh the plan", purchased === 1, String(purchased));
}

console.log("\nA browser that blocks the popup");
{
  const dom = fakeBrowser({ popupBlocked: true });
  await openCheckout(config, { plan: "studio", billingCycle: "annual" });
  check("still tried the tab first", dom.opened.length === 1);
  check("navigates this tab instead", dom.navigated.length === 1, String(dom.navigated.length));
  check("navigates to the same checkout", (dom.navigated[0] ?? "").includes("/plan/61102/"), dom.navigated[0]);
  check("carries the cycle through the fallback", (dom.navigated[0] ?? "").includes("billing_cycle=annual"));
}

console.log("\nA browser where opening throws");
{
  const dom = fakeBrowser({ openThrows: true });
  let threw = null;
  try {
    await openCheckout(config, { plan: "creator", billingCycle: "monthly" });
  } catch (error) { threw = error; }
  check("does not surface the failure", threw === null, threw?.message ?? "");
  check("falls through to a navigation", dom.navigated.length === 1, String(dom.navigated.length));
}

console.log("\nA tier that was never set up");
{
  const dom = fakeBrowser();
  let threw = null;
  try {
    await openCheckout({ ...config, plans: { creator: "61099" } }, { plan: "studio", billingCycle: "monthly" });
  } catch (error) { threw = error; }
  check("refuses rather than opening nothing", threw !== null);
  check("says which plan", (threw?.message ?? "").includes("studio"), threw?.message ?? "");
  check("opened no window at all", dom.opened.length === 0 && dom.navigated.length === 0);
}

console.log("\nThe widget is really gone");
{
  const source = await fs.readFile(path.join(repoRoot, "artifacts/editly/src/lib/checkout.ts"), "utf8");
  // The comments in that file explain the widget at length, and explaining it
  // is not shipping it. Only the code is searched.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("no script tag is created", !code.includes("createElement"), "createElement is back");
  check("checkout.js is not loaded", !code.includes("checkout.freemius.com/checkout.js"));
  check("nothing reads window.FS", !/window\.FS/.test(code));
  check("noopener is not used, because it always returns null", !code.includes("noopener"));
}

await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
