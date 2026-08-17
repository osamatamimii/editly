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

export type OAuthProvider = "google" | "apple";

export const PROVIDER_LABEL: Record<OAuthProvider, string> = {
  google: "Google",
  apple: "Apple",
};

export class ProviderNotEnabledError extends Error {
  constructor(public provider: OAuthProvider) {
    super(`${PROVIDER_LABEL[provider]} sign-in is not switched on for this project yet.`);
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
