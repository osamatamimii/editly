/**
 * The auth client, and only the auth client.
 *
 * This file used to call `createClient` from `@supabase/supabase-js`, which is
 * the documented way to do it and the right way when you use Supabase the way
 * the documentation assumes: a Postgres client in the browser, realtime
 * subscriptions, storage, edge functions. We use none of that. Every table
 * read goes through our own API server, and since the read half of the storage
 * seam moved behind `POST /media/url`, the browser does not touch
 * `supabase.storage` either. Across this whole application there are
 * twenty-seven uses of `supabase.` and every one of them is `supabase.auth`.
 *
 * `createClient` builds all five sub-clients in its constructor, so all five
 * shipped: postgrest, storage, realtime and its phoenix socket, functions —
 * 99kB unpacked, 29kB over the wire, of code that cannot run, arriving before
 * the first paint of a marketing page. `SupabaseAuthClient` is `class
 * SupabaseAuthClient extends AuthClient {}` with nothing added, so what is
 * below is not a reimplementation of anything: it is the same class, given the
 * same arguments, without the four objects nobody asked for.
 *
 * ## The arguments, and why each one is spelled out
 *
 * These are `createClient`'s own defaults, copied deliberately rather than
 * inherited, because `AuthClient`'s defaults are different and two of the
 * differences would be silent:
 *
 *   - **`storageKey`.** `AuthClient` on its own defaults to
 *     `supabase.auth.token`; `createClient` derives `sb-<project-ref>-auth-token`
 *     from the URL's hostname. This is the localStorage key holding everybody's
 *     session. Get it wrong and nothing throws, nothing logs, and every signed-in
 *     person is signed out the next time they open the page — which is the one
 *     failure here worth being afraid of, and the reason it is not left to my
 *     memory. Four suites plant a session under `sb-${ref}-auth-token`, derived
 *     independently in their own files and written before this change, and then
 *     drive screens that only render for a signed-in person: `end-to-end-test`
 *     makes a project through the UI, `viewport-test` and `language-test` render
 *     every screen behind the login. If the key below stopped matching the key
 *     they write, all three would open at `/login` and go red. They are green.
 *   - **`url`.** `AuthClient` defaults to `http://localhost:9999`.
 *   - **`flowType`.** `implicit` in both, stated so that a change upstream is a
 *     conflict rather than a surprise.
 *   - **`headers`.** The anon key twice, as `apikey` and as a bearer, which is
 *     what every request to `/auth/v1` is authorised by.
 *   - **`hasCustomAuthorizationHeader`.** False, because we pass no global
 *     header of our own. It only changes what `getUser()` returns when there is
 *     no session, and passing it keeps that behaviour identical.
 */
import { AuthClient } from "@supabase/auth-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    "VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set. Copy .env.example to .env.local and fill them in.",
  );
}

/**
 * The project's auth endpoint and its session key, derived the way
 * `createClient` derives them.
 *
 * Exported, and pure, so a test can run it against the same input
 * `createClient` is given and compare the two answers. A constant in a file
 * nobody can call is a constant nobody can check.
 */
export function authEndpoint(supabaseUrl: string): { url: string; storageKey: string } {
  const trimmed = supabaseUrl.trim();
  const base = new URL(trimmed.endsWith("/") ? trimmed : `${trimmed}/`);
  return {
    url: new URL("auth/v1", base).href,
    // The project ref namespaces the key, so two Supabase projects open in one
    // browser do not overwrite each other's session.
    storageKey: `sb-${base.hostname.split(".")[0]}-auth-token`,
  };
}

const endpoint = authEndpoint(url);

export const supabase = {
  auth: new AuthClient({
    url: endpoint.url,
    storageKey: endpoint.storageKey,
    headers: {
      Authorization: `Bearer ${anonKey}`,
      apikey: anonKey,
    },
    // Keeps the user signed in across reloads and refreshes the access token
    // before it expires, so the API never sees an avoidable 401.
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: "implicit",
    hasCustomAuthorizationHeader: false,
  }),
};
