import type { Request, Response, NextFunction, RequestHandler } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";

/**
 * Verifies the Supabase access token on every request and exposes the caller's
 * user id to route handlers.
 *
 * Supabase signs access tokens asymmetrically (ES256) and publishes the public
 * keys at a JWKS endpoint, so verification happens locally — no network round
 * trip to Supabase per request. `createRemoteJWKSet` fetches the key set once
 * and refreshes it only when it sees an unknown key id, which is what makes key
 * rotation transparent to us.
 */

const SUPABASE_URL = process.env["SUPABASE_URL"];

if (!SUPABASE_URL) {
  throw new Error(
    "SUPABASE_URL must be set so access tokens can be verified against the project's JWKS.",
  );
}

const issuer = `${SUPABASE_URL.replace(/\/+$/, "")}/auth/v1`;
const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Present on every request that passed `requireAuth`. */
      userId?: string;
      /**
       * The address on the token, when Supabase put one there.
       *
       * Read rather than looked up because it is already in the token we just
       * verified, and the one thing that needs it — matching a payment made
       * with this address before the account existed — would otherwise mean a
       * query into `auth.users` on every subscription read.
       */
      userEmail?: string;
      /**
       * Whether the token says that address has been confirmed.
       *
       * Separate from the address itself because the two are used for
       * different things and only one of them is a claim about identity.
       * Showing somebody their own email on the account page needs the
       * address; handing over a paid plan that was bought with that address
       * needs to know it is *theirs*.
       *
       * Supabase reports it in more than one place depending on the token's
       * age, so `emailIsConfirmed` reads all of them and defaults to false.
       */
      userEmailVerified?: boolean;
    }
  }
}

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;

  const [scheme, token] = header.split(" ");
  if (!token || scheme?.toLowerCase() !== "bearer") return null;

  return token.trim() || null;
}

/**
 * Rejects the request unless it carries a valid, unexpired Supabase access
 * token. On success `req.userId` holds the authenticated user's id.
 */
export const requireAuth: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const token = bearerToken(req);

  if (!token) {
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer,
      // Supabase issues access tokens with aud "authenticated".
      audience: "authenticated",
    });

    // `sub` is the auth user id. Without it the token is unusable to us even if
    // the signature checks out, so treat it as an authentication failure.
    if (typeof payload.sub !== "string" || !payload.sub) {
      res.status(401).json({ error: "Token is missing a subject" });
      return;
    }

    req.userId = payload.sub;
    if (typeof payload["email"] === "string" && payload["email"]) {
      req.userEmail = payload["email"].trim().toLowerCase();
      req.userEmailVerified = emailIsConfirmed(payload);
    }
    next();
  } catch {
    // Deliberately opaque: distinguishing "expired" from "bad signature" from
    // "wrong issuer" only helps someone probing the endpoint.
    res.status(401).json({ error: "Invalid or expired token" });
  }
};

/**
 * Narrows `req.userId` to a string for route handlers running behind
 * `requireAuth`. Throwing here means a route was mounted without the
 * middleware — a programming error, not a client error.
 */
/**
 * Does this token say the address on it has been confirmed?
 *
 * Supabase has put the flag in three places over the life of the product: a
 * top-level `email_verified`, the same key inside `user_metadata`, and — for
 * accounts created through a social provider, where the provider vouched for
 * it — inside `app_metadata`. A reader that knows about only one of them
 * refuses a legitimate customer on the day the token shape moves, so all three
 * are accepted; none of them present is `false`, which is the only safe
 * default for a question this one gates.
 */
export function emailIsConfirmed(payload: Record<string, unknown>): boolean {
  const nested = (key: string): unknown => {
    const bag = payload[key];
    return bag && typeof bag === "object" ? (bag as Record<string, unknown>)["email_verified"] : undefined;
  };
  return (
    payload["email_verified"] === true ||
    nested("user_metadata") === true ||
    nested("app_metadata") === true
  );
}

/** The address on the token, confirmed or not. For showing somebody their own account. */
export function currentUserEmail(req: Request): string | null {
  return req.userEmail ?? null;
}

/**
 * The address only when the token says it has been confirmed.
 *
 * This is the one that may be used to *give something away*.
 *
 * `claimPaidEvents` matches an unclaimed payment to an account by address:
 * somebody buys with `x@example.com` before signing up, then signs up, and the
 * plan is handed over on their first page load. It read `currentUserEmail`,
 * which is whatever the token says — and Supabase issues a session before an
 * address is confirmed, so signing up with an address somebody else had paid
 * with, and never opening the confirmation mail, handed over their plan. The
 * address is not a secret; the receipt is.
 *
 * Returning null when unconfirmed is deliberately not an error. Nothing is
 * refused: the claim simply does not happen yet, and the same page load after
 * confirming does it — which is the behaviour anybody who actually paid sees,
 * because they confirm.
 */
export function verifiedUserEmail(req: Request): string | null {
  return req.userEmailVerified === true ? (req.userEmail ?? null) : null;
}

export function currentUserId(req: Request): string {
  const userId = req.userId;

  if (!userId) {
    throw new Error(
      "currentUserId() called on a route that is not behind requireAuth",
    );
  }

  return userId;
}
