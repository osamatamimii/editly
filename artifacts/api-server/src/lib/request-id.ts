/**
 * The id a customer can quote, and support can grep for.
 *
 * `error-handler.ts` has said since it was written that "the request id is the
 * join: it is in the log line, so support can find the failure without the
 * customer having to describe it." That was true of the design and false of the
 * value. Nothing set one, so it was pino-http's default: an integer that starts
 * at 1 and increments *per process*. On Vercel every invocation is a fresh
 * process, so essentially every request in production is request number 1.
 *
 * So the id was in the log line, and in the 500 the customer saw, and it joined
 * nothing to anything. Support asks for it, gets "1", and searches a month of
 * logs for the several thousand lines that also say 1. Nothing failed. The
 * field was populated, the shape was right, and the one thing it existed to do
 * it could not do.
 *
 * ## Where the id comes from
 *
 * In order, and the order is the point:
 *
 *   1. **`x-request-id` from the caller.** A client that traces its own calls
 *      should see its own id in our logs, which is what makes a report from
 *      another system worth anything. Sanitised, because it is a stranger's
 *      string that goes into a log line and back out in a header.
 *   2. **`x-vercel-id`.** The platform already generates one and it is the id
 *      in Vercel's own dashboard. Reusing it means the id the customer quotes
 *      finds the request in two places rather than one, at no cost.
 *   3. **A uuid**, so this never returns nothing. An absent id is better than a
 *      wrong one, and a duplicated one is a wrong one.
 */
import { randomUUID } from "node:crypto";

/**
 * What a request id may contain.
 *
 * A log line is a place attacker-controlled text ends up, and so is a response
 * header. Newlines forge log entries; a colon-and-space forges a header. The
 * allowed set is what real tracing systems use — uuids, W3C trace ids, Vercel's
 * `iad1::abc123-1234567890123-0000000000` — and nothing else.
 */
const ALLOWED = /^[A-Za-z0-9:_.\-=]{1,200}$/;

/** The header name, in one place, because it is read and written and tested. */
export const REQUEST_ID_HEADER = "x-request-id";

function usable(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return ALLOWED.test(trimmed) ? trimmed : null;
}

/**
 * The id for one request, from its headers.
 *
 * Pure and header-shaped rather than request-shaped, so the whole table of
 * cases can be checked without an HTTP server.
 */
export function requestIdFrom(
  headers: Record<string, string | string[] | undefined>,
  fallback: () => string = randomUUID,
): string {
  // A repeated header is a proxy that added one; the first is the caller's.
  const first = (value: string | string[] | undefined): unknown =>
    Array.isArray(value) ? value[0] : value;

  return (
    usable(first(headers[REQUEST_ID_HEADER])) ??
    usable(first(headers["x-vercel-id"])) ??
    fallback()
  );
}
