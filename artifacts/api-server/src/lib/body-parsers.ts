/**
 * Which requests get their body parsed, and which one must not.
 *
 * This exists as its own module for a single reason: it is testable here and
 * untestable inside `app.ts`, which imports the database and therefore cannot
 * be loaded without one. The bug it guards against is invisible to every other
 * test in the repo — the signature verifier passes its own suite while the
 * deployed endpoint rejects every real payment — so it needs a test that drives
 * an actual HTTP request through actual middleware.
 *
 * The rule: Freemius signs the exact bytes it sent. `express.json()` consumes
 * the request stream and yields a parsed object; re-serialising that object
 * reorders keys and drops whitespace, and the digest of the result is not the
 * digest they signed. So the webhook path is skipped here and reads the raw
 * body itself.
 */
import express, { type RequestHandler } from "express";

/** Paths that must reach their handler with the request stream untouched. */
export const RAW_BODY_PATHS: readonly string[] = ["/api/billing/webhook"];

export function needsRawBody(path: string): boolean {
  return RAW_BODY_PATHS.includes(path);
}

/**
 * The parsers, in order, each skipping the raw-body paths.
 *
 * Written as a path check rather than by mounting the webhook router first,
 * because the router is assembled in another file and a reorder there must not
 * be able to break this quietly.
 */
export function bodyParsers(): RequestHandler[] {
  const json = express.json();
  const form = express.urlencoded({ extended: true });

  return [
    (req, res, next) => (needsRawBody(req.path) ? next() : json(req, res, next)),
    (req, res, next) => (needsRawBody(req.path) ? next() : form(req, res, next)),
  ];
}
