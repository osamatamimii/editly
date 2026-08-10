/**
 * Opening a checkout.
 *
 * The thing worth being careful about here is what this file is *not* allowed
 * to do: it cannot change anyone's plan. It opens a window at Freemius, and
 * Freemius later tells our server, over a signed webhook, that money moved.
 * Nothing in this file — and nothing anyone types into a console while it runs
 * — grants access. That separation is the whole design, and it is why the
 * values below are public: the product id and the plan id both appear in the
 * checkout URL anyway.
 *
 * The script is loaded on demand rather than in `index.html`. A visitor who
 * never opens a checkout should not pay for a third-party script on first
 * paint, and the pricing section is a long way down the page.
 */
import { supabase } from "./supabase";

const SCRIPT_SRC = "https://checkout.freemius.com/checkout.js";

export interface CheckoutConfig {
  productId: string;
  publicKey: string;
  plans: Partial<Record<"creator" | "pro" | "studio", string>>;
  currentPlan: string;
}

/** Freemius injects this. Typed loosely on purpose — it is not our object. */
declare global {
  interface Window {
    FS?: {
      Checkout: new (options: Record<string, unknown>) => {
        open: (options: Record<string, unknown>) => void;
        close: () => void;
      };
    };
  }
}

let scriptPromise: Promise<void> | null = null;

/**
 * Load the checkout script once, no matter how many times someone clicks.
 *
 * The promise is cached rather than a boolean flag, so two clicks a hundred
 * milliseconds apart wait on the same load instead of racing two `<script>`
 * tags that both define `window.FS`.
 */
function loadCheckoutScript(): Promise<void> {
  if (window.FS) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      // A failed load must not be remembered as a failure forever: the usual
      // cause is a flaky network or a blocker the person can turn off, and
      // both are fixed by clicking again.
      scriptPromise = null;
      reject(new Error("Could not reach the checkout. Check your connection or any ad blocker, then try again."));
    };
    document.head.appendChild(script);
  });

  return scriptPromise;
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

export interface OpenCheckoutOptions {
  plan: "creator" | "pro" | "studio";
  /** Monthly or annual. Freemius calls these billing cycles. */
  billingCycle: "monthly" | "annual";
  /** Prefills the form, so nobody buys under an address we cannot match. */
  email?: string;
  /** Called after Freemius reports a completed purchase. */
  onPurchase?: () => void;
}

/**
 * Open the Freemius checkout for one of our plans.
 *
 * The email is prefilled deliberately. Our webhook maps a payment to an account
 * by email — it is the only identifier both sides share — so someone who pays
 * with a different address than they signed up with lands in the "paid, but we
 * cannot find you" case. Prefilling makes the matching address the default and
 * the mismatch a deliberate act rather than an accident.
 */
export async function openCheckout(config: CheckoutConfig, options: OpenCheckoutOptions): Promise<void> {
  const planId = config.plans[options.plan];
  if (!planId) {
    throw new Error(`The ${options.plan} plan is not set up for checkout yet.`);
  }

  await loadCheckoutScript();
  if (!window.FS) throw new Error("The checkout loaded but did not start. Reload and try again.");

  const handler = new window.FS.Checkout({
    product_id: config.productId,
    public_key: config.publicKey,
    plan_id: planId,
  });

  handler.open({
    name: "Editly",
    billing_cycle: options.billingCycle,
    ...(options.email ? { user_email: options.email } : {}),
    // Freemius fires this in the browser when the purchase completes. It is a
    // signal to refresh, not a grant: the plan changes when the signed webhook
    // reaches our server, which may be a second before or after this fires.
    purchaseCompleted: () => options.onPurchase?.(),
    success: () => options.onPurchase?.(),
  });
}
