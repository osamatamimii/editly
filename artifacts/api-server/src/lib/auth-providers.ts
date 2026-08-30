/**
 * Which ways of signing in this project actually has switched on.
 *
 * The login page already asks this question — it hits Supabase's
 * `/auth/v1/settings` from the browser so it never shows a button that cannot
 * work. This asks the same question from the server, and it exists for a
 * different reason: **verifying a configuration should not require opening the
 * product in a browser and clicking the thing.**
 *
 * Enabling Google is four steps across two dashboards — a client in Google
 * Cloud, a consent screen, a secret pasted into Supabase, a redirect URL
 * allowlisted — and every one of them fails the same way from the outside: you
 * click "Continue with Google", you go away, you come back to a login form.
 * Reporting it here means "is Google on in production" is a question with an
 * answer, from anywhere, without an account.
 *
 * Booleans only, and no key name and no key value ever appears — `/healthz` is
 * public. This says which doors exist, which is what the login page already
 * tells every visitor anyway.
 */

/** The providers the product has code for. Nothing else is reported. */
export const KNOWN_PROVIDERS = ["google", "apple"] as const;
export type KnownProvider = (typeof KNOWN_PROVIDERS)[number];

export type ProviderStatus = Record<KnownProvider, boolean> & {
  /**
   * Whether the answer above is an answer at all.
   *
   * `false` means Supabase could not be asked — no URL, no key, a network
   * failure, a 500. All of `google` and `apple` are then `false`, and that is
   * "we do not know", not "they are off". Those are different problems and the
   * one thing this endpoint must never do is report the second when it means
   * the first: somebody would go and re-enter credentials that were already
   * correct.
   */
  known: boolean;
};

const UNKNOWN: ProviderStatus = { google: false, apple: false, known: false };

/** Ten minutes. Auth configuration changes about once a year. */
const TTL_MS = 10 * 60 * 1000;
let cached: { at: number; value: ProviderStatus } | null = null;

/** Overridable for tests, which must not reach the network. */
export function resetProviderCache(): void {
  cached = null;
}

export async function authProviders(): Promise<ProviderStatus> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;

  const url = process.env["SUPABASE_URL"]?.trim();
  // Any key the project accepts will do; this endpoint reads configuration and
  // returns no data. The service key is the one a server has.
  const key = process.env["SUPABASE_SERVICE_ROLE_KEY"]?.trim();
  if (!url || !key) {
    cached = { at: Date.now(), value: UNKNOWN };
    return UNKNOWN;
  }

  try {
    // A short timeout on purpose: `/healthz` is read by a monitor every fifteen
    // minutes and by a deploy gate, and neither should hang because an
    // unrelated service is slow. Not knowing is a fine answer here; waiting is
    // not.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    let response: Response;
    try {
      response = await fetch(`${url.replace(/\/+$/, "")}/auth/v1/settings`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      cached = { at: Date.now(), value: UNKNOWN };
      return UNKNOWN;
    }

    const settings = (await response.json()) as { external?: Record<string, unknown> };
    const external = settings.external ?? {};
    const value: ProviderStatus = {
      google: external["google"] === true,
      apple: external["apple"] === true,
      known: true,
    };
    cached = { at: Date.now(), value };
    return value;
  } catch {
    // A timeout, a DNS failure, a body that is not JSON. All of them mean the
    // same thing and it is not "off".
    cached = { at: Date.now(), value: UNKNOWN };
    return UNKNOWN;
  }
}
