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

/**
 * Paths that must reach their handler with the request stream untouched.
 *
 * Freemius signs the bytes it sent, and so does Shopify. The Shopify four are
 * the mandatory compliance webhooks plus the uninstall: the same rule, a second
 * platform, and a failure mode that is worse there — a redaction request whose
 * signature cannot be checked is an endpoint that erases a shop on demand.
 */
export const RAW_BODY_PATHS: readonly string[] = [
  "/api/billing/webhook",
  "/api/shopify/webhooks/customers/data_request",
  "/api/shopify/webhooks/customers/redact",
  "/api/shopify/webhooks/shop/redact",
  "/api/shopify/webhooks/app/uninstalled",
];

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
  /*
    A violation report is JSON that does not say it is JSON.

    Browsers send `report-uri` bodies as `application/csp-report` and Reporting
    API bodies as `application/reports+json`, and `express.json()` matches on
    `application/json` alone — so every report would have arrived with an empty
    body and been discarded as "no directive". Nothing would have failed: the
    endpoint would have answered 204 to everything, exactly as it does for a
    report it throws away, and the log would have stayed empty. Which is
    indistinguishable from a policy that never fires, and is what this whole
    round is about.

    Capped well below express's default, because these come from the open
    internet and a report is a few hundred bytes.
  */
  const reports = express.json({
    type: ["application/csp-report", "application/reports+json"],
    limit: "16kb",
  });

  return [
    (req, res, next) => (needsRawBody(req.path) ? next() : json(req, res, next)),
    (req, res, next) => (needsRawBody(req.path) ? next() : reports(req, res, next)),
    (req, res, next) => (needsRawBody(req.path) ? next() : form(req, res, next)),
  ];
}
