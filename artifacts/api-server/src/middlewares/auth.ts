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
export function currentUserId(req: Request): string {
  const userId = req.userId;

  if (!userId) {
    throw new Error(
      "currentUserId() called on a route that is not behind requireAuth",
    );
  }

  return userId;
}
