/**
 * The last thing that runs, and the only thing that decides what an unhandled
 * failure looks like from outside.
 *
 * Until this existed there was no error middleware at all, so every throw fell
 * through to Express's default handler. That handler sends **HTML**, which the
 * generated client parses as JSON and fails on — so a database blip reached the
 * browser as a parse error rather than as a status anybody could branch on. And
 * outside production it sends the **stack**, which names our file paths, our
 * table names and sometimes the query, to whoever made the request.
 *
 * Two rules here, and they pull against each other on purpose.
 *
 * **Nothing internal leaves.** The body is a sentence and a request id. Not the
 * message, because a Postgres error message is a column list; not the stack,
 * ever. The request id is the join: it is in the log line, so support can find
 * the failure without the customer having to describe it.
 *
 * **Everything is logged.** A swallowed error is worse than a leaked one — the
 * leak is a risk, the swallow is a bug nobody will ever find.
 */
import type { ErrorRequestHandler, Request, Response, NextFunction } from "express";

/** Said to the person. Deliberately the same for every cause. */
export const UNEXPECTED =
  "Something went wrong on our side. Nothing you did caused this, and nothing has been lost. Please try again in a moment.";

export const ORIGIN_REFUSED = "This origin is not allowed to call the API.";

/**
 * What status an error deserves.
 *
 * Pulled out so it can be checked without an HTTP server. The default is 500
 * and the default is correct: a failure we have not classified is a failure we
 * do not understand, and calling it a 400 would blame the caller for our bug.
 */
export function statusFor(error: unknown): number {
  if (!error || typeof error !== "object") return 500;
  const e = error as { status?: unknown; statusCode?: unknown; message?: unknown; type?: unknown; code?: unknown };

  // CORS: `app.ts` rejects a disallowed origin by calling back with an Error,
  // which lands here. That is a refusal, not a fault — 500 makes an ordinary
  // configuration mistake look like an outage.
  if (isOriginRefusal(error)) return 403;

  // A body that is not JSON, or is larger than the parser allows. Express's
  // json parser sets both.
  if (e.type === "entity.parse.failed") return 400;
  if (e.type === "entity.too.large") return 413;

  const declared = typeof e.status === "number" ? e.status : typeof e.statusCode === "number" ? e.statusCode : null;
  // Only believe a status somebody deliberately set, and only in the range that
  // means something. A `status: 0` from a fetch failure is not a 0 response.
  if (declared !== null && declared >= 400 && declared <= 599) return declared;

  return 500;
}

/**
 * Is this the error `app.ts` throws for a browser origin that is not on the
 * allowlist?
 *
 * Asked as its own question because the answer used to be assumed. `bodyFor`
 * read a 403 and said "This origin is not allowed to call the API." — for
 * *every* 403, whatever caused it. A suspended account, a storage bucket that
 * answered 403, a library that sets `status` on its errors: each of them told
 * the person, with total confidence, about a CORS rule they had not broken.
 *
 * It was true when it was written — CORS was the only thing here that could
 * produce a 403. It stopped being true the first time anything else could, and
 * nothing failed, because a wrong sentence is still a sentence.
 */
function isOriginRefusal(error: unknown): boolean {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" && message.startsWith("Origin not allowed:");
}

/** The sentence for a status. Never the error's own message above 499. */
export function bodyFor(status: number, error: unknown): { error: string } {
  if (status === 403 && isOriginRefusal(error)) return { error: ORIGIN_REFUSED };
  // Same rule as the 403 above: say what actually happened, not what usually
  // happens at this status. The body parser marks its own failures with `type`.
  const type = (error as { type?: unknown } | null)?.type;
  if (status === 400 && type === "entity.parse.failed") return { error: "Body could not be read as JSON." };
  if (status === 413 && type === "entity.too.large") return { error: "That request body is too large." };
  if (status >= 500) return { error: UNEXPECTED };
  // A 4xx somebody set deliberately is theirs to word, as long as it is a
  // string they chose rather than a driver's.
  const message = (error as { expose?: boolean; message?: string } | null)?.expose
    ? (error as { message?: string }).message
    : undefined;
  return { error: message ?? "That request could not be completed." };
}

export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const status = statusFor(error);

  // Headers already sent means a response was streaming when this happened.
  // Anything written now is appended to a body the client is already parsing,
  // so hand it to Express, whose only remaining move is to destroy the socket.
  if (res.headersSent) {
    req.log?.error({ err: error }, "error after the response had started");
    next(error);
    return;
  }

  if (status >= 500) req.log?.error({ err: error }, "unhandled error");
  else req.log?.warn({ err: error, status }, "request refused");

  const body = bodyFor(status, error);
  const requestId = (req as unknown as { id?: string | number }).id;

  res.status(status).json(requestId === undefined ? body : { ...body, requestId: String(requestId) });
};
