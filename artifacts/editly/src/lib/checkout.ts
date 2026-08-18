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

/**
 * Freemius injects this. Typed loosely on purpose — it is not our object, and
 * it has had two different shapes.
 *
 * The current script attaches `FS.Checkout` as a **plain object** with
 * `open`/`close`/`configure`. Older integrations documented it as a class you
 * instantiate. We were writing `new window.FS.Checkout(...)` against a script
 * that no longer has a constructor, so every click threw
 * "window.FS.Checkout is not a constructor" and nobody could pay.
 *
 * So the type says "either", and the code below asks which one it got rather
 * than assuming. A third-party global is not a contract; it is a fact you check.
 */
type FreemiusCheckoutObject = {
  open: (options: Record<string, unknown>) => void;
  close?: () => void;
  configure?: (options: Record<string, unknown>) => void;
};

declare global {
  interface Window {
    FS?: {
      Checkout:
        | FreemiusCheckoutObject
        | (new (options: Record<string, unknown>) => FreemiusCheckoutObject);
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
/**
 * How long to wait for the checkout script before giving up on it.
 *
 * There has to be a number here, and this is why: a blocked request does not
 * fail. Content blockers — uBlock, Brave's shields, a Pi-hole, a corporate DNS
 * filter — do not reject `checkout.freemius.com`, they black-hole it. The
 * browser fires neither `onload` nor `onerror`, the request never even appears
 * in the resource timeline, and the promise below never settles.
 *
 * Which meant the button said "Opening checkout…" and kept saying it. Forever.
 * No error, no message, no way to pay, and nothing in the console to explain
 * it. That is the worst possible failure for the one button on the site that
 * takes money, and it was invisible from the code because the code has no bug
 * in it — the bug is the absence of a clock.
 */
const SCRIPT_TIMEOUT_MS = 8000;

/** Thrown when the widget could not load, so callers can fall back rather than apologise. */
export class CheckoutBlockedError extends Error {}

function loadCheckoutScript(): Promise<void> {
  if (window.FS) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;

    const giveUp = (): void => {
      // A failed load must not be remembered as a failure forever: the usual
      // cause is a blocker the person can turn off, or one page in a browser
      // that behaves differently from the next.
      scriptPromise = null;
      reject(new CheckoutBlockedError("The checkout widget could not load."));
    };

    const timer = window.setTimeout(giveUp, SCRIPT_TIMEOUT_MS);
    script.onload = () => {
      window.clearTimeout(timer);
      resolve();
    };
    script.onerror = () => {
      window.clearTimeout(timer);
      giveUp();
    };
    document.head.appendChild(script);
  });

  return scriptPromise;
}

/**
 * The same purchase, as an ordinary page.
 *
 * Freemius hosts a checkout at a plain URL, and a plain URL is a navigation
 * rather than a third-party script — so the blockers that swallow the widget
 * generally let this through. Opening it is not a consolation prize: it is the
 * same checkout, the same plan, the same prefilled email.
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

  try {
    await loadCheckoutScript();
  } catch (error) {
    // Blocked, not broken. Send them to the hosted page instead of telling
    // them to go and change their browser settings to give us money.
    const fallback = hostedCheckoutUrl(config, options);
    if (fallback) {
      window.open(fallback, "_blank", "noopener");
      return;
    }
    throw error;
  }
  if (!window.FS) {
    const fallback = hostedCheckoutUrl(config, options);
    if (fallback) {
      window.open(fallback, "_blank", "noopener");
      return;
    }
    throw new Error("The checkout loaded but did not start. Reload and try again.");
  }

  // `plugin_id` rather than `product_id`: Freemius renamed products in its
  // dashboard and never renamed the field, and the script errors out without
  // it. Both are sent — the extra one is ignored, and the day they finish the
  // rename this keeps working.
  const identity = {
    plugin_id: config.productId,
    product_id: config.productId,
    public_key: config.publicKey,
    plan_id: planId,
  };

  const settings = {
    ...identity,
    name: "Editly",
    billing_cycle: options.billingCycle,
    ...(options.email ? { user_email: options.email } : {}),
    // Freemius fires this in the browser when the purchase completes. It is a
    // signal to refresh, not a grant: the plan changes when the signed webhook
    // reaches our server, which may be a second before or after this fires.
    purchaseCompleted: () => options.onPurchase?.(),
    success: () => options.onPurchase?.(),
  };

  const FSCheckout = window.FS.Checkout;
  try {
    if (typeof FSCheckout === "function") {
      // The old shape: a class you instantiate with the identity, then open.
      new FSCheckout(identity).open(settings);
    } else {
      // The current shape: one object, everything passed to `open`.
      FSCheckout.configure?.(identity);
      FSCheckout.open(settings);
    }
  } catch (error) {
    // The widget exists and still refused. That is not something the person
    // can act on, and there is a working checkout one navigation away.
    const fallback = hostedCheckoutUrl(config, options);
    if (fallback) {
      window.open(fallback, "_blank", "noopener");
      return;
    }
    throw error;
  }
}
