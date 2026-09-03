/**
 * Talking to a shop's Admin API.
 *
 * Two requests, and they are the only two this app makes: exchange the token
 * App Bridge minted for one that can read the catalogue, and ask for a
 * product's media. Everything else about a Shopify integration is signatures
 * and bookkeeping, which live beside this file.
 */
import { isShopDomain } from "./domain";

/**
 * The API version, pinned.
 *
 * Not "latest", and this is not caution for its own sake: `latest` moves every
 * quarter and moves the *shape of the response* with it, so an app pinned to it
 * breaks on a date nobody chose and for a reason nobody deployed. Shopify
 * removes a version 12 months after release and refuses App Store submissions
 * using an API within 90 days of its sunset — so this string is a calendar
 * entry, and the environment can move it without a deploy when that day comes.
 */
export const API_VERSION = process.env["SHOPIFY_API_VERSION"] ?? "2026-07";

/** Long enough for a slow shop, short enough that nobody is left watching. */
const TIMEOUT_MS = 15_000;

export interface AdminCredentials {
  clientId: string;
  clientSecret: string;
}

export function credentials(): AdminCredentials | null {
  const clientId = process.env["SHOPIFY_API_KEY"];
  const clientSecret = process.env["SHOPIFY_API_SECRET"];
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export type Fetcher = typeof fetch;

async function post(
  url: string,
  init: RequestInit,
  fetchImpl: Fetcher,
): Promise<{ status: number; body: unknown; text: string }> {
  // `AbortSignal.timeout` rather than a hand-rolled controller, matching
  // `stock.ts` and `storage.ts`. This is a serverless function: a request with
  // no ceiling holds an invocation until the platform kills it, and what the
  // caller sees is a 504 with nothing in any log explaining which host was
  // quiet.
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body, text };
}

export type ExchangeResult =
  | { ok: true; accessToken: string; scopes: string }
  | { ok: false; reason: string };

/**
 * The ID token from App Bridge, exchanged for one that can read the catalogue.
 *
 * This is what replaced writing OAuth by hand. There is no redirect, no state
 * parameter and no callback to secure: managed installation grants the scopes
 * declared in `shopify.app.toml`, and the embedded app proves who it is with a
 * token it already has.
 *
 * An **offline** token, deliberately. The alternative expires with the staff
 * member's session, and the work this app does — rendering a video that takes
 * minutes, on a queue — happens after the merchant has closed the tab.
 */
export async function exchangeToken(
  shop: string,
  idToken: string,
  creds: AdminCredentials,
  fetchImpl: Fetcher = fetch,
  base?: string,
): Promise<ExchangeResult> {
  // Checked again here even though the token verifier already did it. This
  // function builds a URL out of the value; a validator two call sites away is
  // a validator somebody eventually reorders.
  if (!isShopDomain(shop)) return { ok: false, reason: "not a shop domain" };

  const { status, body, text } = await post(
    `${base ?? `https://${shop}`}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: idToken,
        subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
        requested_token_type: "urn:shopify:params:oauth:token-type:offline-access-token",
      }),
    },
    fetchImpl,
  );

  if (status !== 200 || !body || typeof body !== "object") {
    // Their words, truncated, never ours. "Token exchange failed" is the
    // sentence that makes a misconfigured client secret take an afternoon.
    return { ok: false, reason: `${status} ${text.slice(0, 200)}`.trim() };
  }
  const payload = body as Record<string, unknown>;
  const accessToken = payload["access_token"];
  if (typeof accessToken !== "string" || !accessToken) return { ok: false, reason: "no token in the answer" };
  return {
    ok: true,
    accessToken,
    scopes: typeof payload["scope"] === "string" ? payload["scope"] : "",
  };
}

export type GraphqlResult =
  | { ok: true; data: Record<string, unknown> }
  /** `retryable` separates "ask again in a moment" from "this will never work". */
  | { ok: false; reason: string; status?: number; retryable: boolean };

/**
 * One GraphQL call, with the one retry that is worth making.
 *
 * The Admin API is metered by cost rather than by request count, in a leaky
 * bucket that refills at a rate set by the merchant's own Shopify plan. A
 * throttled call is not an error — it is the API saying "in a moment" — and the
 * response carries exactly how long a moment is, in `throttleStatus`. Reading
 * that instead of sleeping a guessed interval is the difference between an app
 * that works on a busy store and one that does not.
 *
 * Once, and then it gives up. A serverless request has a person waiting at the
 * end of it, and a second throttle means the shop is genuinely busy: saying so
 * beats holding the invocation open until the platform kills it.
 */
export async function adminGraphql(
  shop: string,
  accessToken: string,
  query: string,
  variables: Record<string, unknown>,
  options: { fetchImpl?: Fetcher; base?: string; sleep?: (ms: number) => Promise<void> } = {},
): Promise<GraphqlResult> {
  if (!isShopDomain(shop)) return { ok: false, reason: "not a shop domain", retryable: false };
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const url = `${options.base ?? `https://${shop}`}/admin/api/${API_VERSION}/graphql.json`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { status, body, text } = await post(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query, variables }),
      },
      fetchImpl,
    );

    // A dead token. Not retryable and worth reporting as its own thing: it
    // means the app was uninstalled or the scopes changed, and the row we hold
    // is a key to nothing.
    if (status === 401 || status === 403) {
      return { ok: false, reason: "this shop's token is no longer accepted", status, retryable: false };
    }

    if (status === 429) {
      if (attempt === 0) {
        await sleep(1000);
        continue;
      }
      return { ok: false, reason: "the shop is rate limiting us", status, retryable: true };
    }

    if (status !== 200 || !body || typeof body !== "object") {
      return { ok: false, reason: `${status} ${text.slice(0, 200)}`.trim(), status, retryable: status >= 500 };
    }

    const payload = body as Record<string, unknown>;
    const errors = payload["errors"];
    if (Array.isArray(errors) && errors.length > 0) {
      const throttled = errors.some(
        (error) => (error as Record<string, unknown> | null)?.["extensions"] &&
          ((error as { extensions: Record<string, unknown> }).extensions["code"] === "THROTTLED"),
      );
      if (throttled && attempt === 0) {
        await sleep(waitFor(payload));
        continue;
      }
      const first = errors[0] as Record<string, unknown> | undefined;
      const message = typeof first?.["message"] === "string" ? first["message"] : "the query was refused";
      return { ok: false, reason: message.slice(0, 200), status, retryable: throttled };
    }

    const data = payload["data"];
    if (!data || typeof data !== "object") return { ok: false, reason: "no data in the answer", status, retryable: false };
    return { ok: true, data: data as Record<string, unknown> };
  }

  return { ok: false, reason: "the shop is rate limiting us", retryable: true };
}

/**
 * How long the bucket says to wait, from the numbers in the response.
 *
 * `restoreRate` is points per second and `currentlyAvailable` is what is left,
 * so the wait is the shortfall over the rate. Clamped: a computed wait of forty
 * seconds is a wait nobody is standing there for, and one of zero is a retry
 * that arrives before the bucket has moved.
 */
function waitFor(payload: Record<string, unknown>): number {
  const cost = (payload["extensions"] as Record<string, unknown> | undefined)?.["cost"] as
    | Record<string, unknown>
    | undefined;
  const throttle = cost?.["throttleStatus"] as Record<string, unknown> | undefined;
  const requested = typeof cost?.["requestedQueryCost"] === "number" ? (cost["requestedQueryCost"] as number) : 0;
  const available = typeof throttle?.["currentlyAvailable"] === "number" ? (throttle["currentlyAvailable"] as number) : 0;
  const restore = typeof throttle?.["restoreRate"] === "number" ? (throttle["restoreRate"] as number) : 0;
  if (restore <= 0) return 1000;
  const seconds = (requested - available) / restore;
  return Math.min(5000, Math.max(500, Math.ceil(seconds * 1000)));
}

/**
 * The one query this app runs.
 *
 * `first: 50` on the media connection rather than more: connection cost
 * multiplies by the page size, a single query is refused above 1,000 points
 * whatever the shop's plan, and a product with more than fifty media items has
 * more than this app could use forty times over.
 */
export const PRODUCT_MEDIA_QUERY = `
  query ProductForAd($id: ID!) {
    product(id: $id) {
      id
      title
      handle
      priceRangeV2 { minVariantPrice { amount currencyCode } }
      media(first: 50) {
        nodes {
          alt
          mediaContentType
          ... on MediaImage { image { url width height } }
          ... on Video { id }
        }
      }
    }
  }
`;
