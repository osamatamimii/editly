/**
 * Opening a checkout.
 *
 * The thing worth being careful about here is what this file is *not* allowed
 * to do: it cannot change anyone's plan. It sends someone to Freemius, and
 * Freemius later tells our server, over a signed webhook, that money moved.
 * Nothing in this file — and nothing anyone types into a console while it runs
 * — grants access. That separation is the whole design, and it is why the
 * values below are public: the product id and the plan id both appear in the
 * checkout URL anyway.
 *
 * ── Why there is no widget here any more ──────────────────────────────────
 *
 * Freemius publishes a drop-in at https://checkout.freemius.com/checkout.js
 * that opens the checkout as a modal over your own page. We shipped it, and
 * every single click threw `window.FS.Checkout is not a constructor`.
 *
 * The reason is not the constructor. The file is three IIFEs; the last one
 * ends, literally, with:
 *
 *     })(jQuery);
 *
 * With no global `jQuery`, evaluating that argument throws a ReferenceError
 * before the function is ever entered — so the IIFE that assigns
 * `FS.Checkout` never runs. What survives is the *first* IIFE, which defines
 * `FS.Logger`. The result is the worst possible shape: `window.FS` exists, so
 * every "did the script load?" check passes, and `window.FS.Checkout` is
 * `undefined`, so the next line fails with a message about constructors that
 * points nowhere near the cause. Verified in the browser against production:
 * with jQuery loaded first, `FS.Checkout` appears with `configure`, `open`,
 * `close`, `clearOptions`; without it, only `FS.Logger`.
 *
 * So the modal costs us a ~90KB third-party dependency, loaded from a CDN,
 * *plus* the Freemius script, on the one button on this site that takes money
 * — and each of those is a request a content blocker can swallow without
 * firing `onerror`. The hosted checkout is the same checkout, the same plan,
 * the same prefilled email, and it is a plain navigation: nothing to load,
 * nothing to block, nothing to be undefined. It wins on every axis that
 * matters here, and the only thing it costs is a modal.
 */
import { supabase } from "./supabase";

export interface CheckoutConfig {
  productId: string;
  publicKey: string;
  plans: Partial<Record<"creator" | "pro" | "studio", string>>;
  currentPlan: string;
}

export interface OpenCheckoutOptions {
  plan: "creator" | "pro" | "studio";
  /** Monthly or annual. Freemius calls these billing cycles. */
  billingCycle: "monthly" | "annual";
  /** Prefills the form, so nobody buys under an address we cannot match. */
  email?: string;
  /**
   * Kept because the caller still wants to refetch the plan when the person
   * comes back. It is a hint to refresh, never a grant: the plan changes when
   * the signed webhook reaches our server, and that is the only evidence that
   * exists. With the hosted checkout the purchase completes on another page,
   * so this fires when we hand off rather than when money moves.
   */
  onPurchase?: () => void;
}

/**
 * The purchase, as an ordinary URL.
 *
 * Exported separately so it can be asserted on without a browser: everything
 * that can be wrong with a checkout link — wrong product, missing plan,
 * unencoded email, a billing cycle Freemius does not recognise — is wrong
 * here, in a string, where a test can see it.
 */
export function hostedCheckoutUrl(config: CheckoutConfig, options: OpenCheckoutOptions): string | null {
  const planId = config.plans[options.plan];
  if (!planId) return null;
  const url = new URL(`https://checkout.freemius.com/product/${config.productId}/plan/${planId}/`);
  url.searchParams.set("billing_cycle", options.billingCycle);
  if (options.email) url.searchParams.set("user_email", options.email);
  return url.toString();
}

/** Ask our server which product and plans to open. Public values only. */
export async function fetchCheckoutConfig(): Promise<CheckoutConfig> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;

  const response = await fetch("/api/billing/checkout", {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

  if (response.status === 503) {
    throw new Error("Checkout is not switched on for this deployment yet.");
  }
  if (!response.ok) {
    throw new Error("Could not start checkout. Try again in a moment.");
  }
  return (await response.json()) as CheckoutConfig;
}

/**
 * Send someone to the checkout for one of our plans.
 *
 * The email is prefilled deliberately. Our webhook maps a payment to an
 * account by email — it is the only identifier both sides share — so someone
 * who pays with a different address than they signed up with lands in the
 * "paid, but we cannot find you" case. Prefilling makes the matching address
 * the default and a mismatch a deliberate act rather than an accident.
 *
 * A new tab is preferred so the app is still there when they come back. But a
 * popup blocker can refuse it, and by the time we get here the click that
 * would have authorised one has been spent waiting on our own API — so a
 * refusal is likely, not exotic. When it happens we navigate this tab
 * instead. The one outcome that is not allowed is the button doing nothing.
 */
export async function openCheckout(config: CheckoutConfig, options: OpenCheckoutOptions): Promise<void> {
  const url = hostedCheckoutUrl(config, options);
  if (!url) {
    throw new Error(`The ${options.plan} plan is not set up for checkout yet.`);
  }

  // Deliberately not `noopener`: that feature makes `window.open` return null
  // *by specification*, even on success, which would make the check below
  // think it was blocked and navigate this tab as well — two checkouts from
  // one click. The opener is severed on the next line instead, which achieves
  // the same thing and still tells us whether a window actually opened.
  let opened: Window | null = null;
  try {
    opened = window.open(url, "_blank");
    if (opened) opened.opener = null;
  } catch {
    opened = null;
  }

  if (!opened) {
    window.location.assign(url);
  }

  options.onPurchase?.();
}
