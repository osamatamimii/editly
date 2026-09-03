/**
 * Sign-in with Google and Apple.
 *
 * Supabase does the OAuth dance; the app's only jobs are to start it and to
 * behave sensibly when a provider is configured in the code but not yet turned
 * on in the project. That case is not hypothetical — enabling each provider
 * needs credentials from Google and Apple that arrive later than the code does,
 * and a button that fails with a raw API error in the meantime is worse than
 * one that explains itself.
 */
import { supabase } from "./supabase";
import { fill, say } from "./landing-copy";
import { storedLanguage } from "./language-routes";
import { TRANSFER } from "./copy/transfer";

export type OAuthProvider = "google" | "apple";

export const PROVIDER_LABEL: Record<OAuthProvider, string> = {
  google: "Google",
  apple: "Apple",
};

export class ProviderNotEnabledError extends Error {
  constructor(public provider: OAuthProvider) {
    super(fill(TRANSFER.providerOff, storedLanguage(), PROVIDER_LABEL[provider]));
  }
}

/**
 * Which providers the project actually has enabled, straight from Supabase.
 *
 * Asking rather than assuming means the buttons can be hidden until they work,
 * instead of being present and broken.
 */
export async function enabledProviders(): Promise<Set<OAuthProvider>> {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
  try {
    const res = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: key } });
    // A 500 or a 429 from this endpoint says nothing about which providers are
    // configured — it is exactly as uninformative as the network error handled
    // below, and it used to be treated as the opposite. An empty Set hides the
    // buttons, and hiding them is not a neutral act: somebody who created their
    // account with "Continue with Google" has no password, so a login page with
    // only an email form tells them their account is gone. Showing a button
    // that might be off costs one honest error message on click.
    if (!res.ok) return new Set(["google", "apple"] as const);
    const settings = (await res.json()) as { external?: Record<string, boolean> };
    return new Set((["google", "apple"] as const).filter((p) => settings.external?.[p]));
  } catch {
    // A network hiccup should not hide a working button forever; the click
    // itself still reports honestly if the provider turns out to be off.
    return new Set(["google", "apple"] as const);
  }
}

/**
 * Starts the redirect. Returns only if something went wrong — on success the
 * browser has already left for the provider.
 */
export async function signInWithProvider(provider: OAuthProvider): Promise<never | void> {
  const { error } = await supabase.auth.signInWithOAuth({
    provider,
    options: {
      // Land back inside the app, not on the marketing page. `detectSessionInUrl`
      // in the Supabase client picks the session out of the callback URL.
      redirectTo: `${window.location.origin}/dashboard`,
    },
  });

  if (error) {
    if (/not enabled|unsupported provider/i.test(error.message)) {
      throw new ProviderNotEnabledError(provider);
    }
    throw error;
  }
}

/**
 * The other half of the redirect: the one that comes back carrying a refusal.
 *
 * `signInWithProvider` reports what goes wrong *before* the browser leaves.
 * Everything that goes wrong after it leaves comes back the only way OAuth can
 * answer — as `error` and `error_description` on the URL it returns to. And
 * that URL is `/dashboard`, where there is no session, so the router redirects
 * to `/login` and the redirect drops the query and the hash with it.
 *
 * The result was the worst answer this product knows how to give: somebody
 * clicks "Continue with Google", disappears for two seconds, and arrives back
 * at an empty sign-in form with nothing anywhere saying why. A misconfigured
 * redirect URL, a provider switched on with the wrong credentials, Supabase's
 * own "Database error saving new user" — every one of them looked identical to
 * a button that does nothing.
 *
 * So the error is taken off the URL before the router can throw it away. This
 * runs once, at start-up, before React renders.
 *
 * **It never touches a URL that is not an error.** A successful callback comes
 * back with `access_token` in the hash, and the Supabase client reads that hash
 * itself to establish the session — stripping it would turn every successful
 * Google sign-in into a silent failure, which is the bug this exists to end,
 * inverted.
 */
const ERROR_KEYS = ["error", "error_code", "error_description"] as const;

let captured: string | null = null;

/** What the provider said, in a sentence, or null when it said nothing. */
function messageFrom(params: URLSearchParams): string | null {
  const code = params.get("error");
  if (!code) return null;
  // Cancelling is not a failure, and an alarming red line about a decision the
  // person made on purpose is worse than saying nothing at all.
  if (code === "access_denied") return say(TRANSFER.signInCancelled, storedLanguage());
  // `error_description` is the provider's own words and is written for people;
  // the code is a slug. Prefer the sentence, fall back to the slug.
  const described = params.get("error_description")?.trim();
  return described && described.length > 0
    ? described
    : fill(TRANSFER.signInFailed, storedLanguage(), code);
}

export function captureOAuthError(): string | null {
  if (typeof window === "undefined") return null;
  const query = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));

  const message = messageFrom(query) ?? messageFrom(hash);
  if (!message) return null;

  for (const key of ERROR_KEYS) {
    query.delete(key);
    hash.delete(key);
  }
  const search = query.toString();
  const fragment = hash.toString();
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${search ? `?${search}` : ""}${fragment ? `#${fragment}` : ""}`,
  );

  captured = message;
  return message;
}

/** Read it once. The screen that shows it is not the screen it arrived on. */
export function takeOAuthError(): string | null {
  const message = captured;
  captured = null;
  return message;
}
