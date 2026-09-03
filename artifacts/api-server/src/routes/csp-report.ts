/**
 * Where a blocked resource says so.
 *
 * The Content Security Policy was `Content-Security-Policy-Report-Only` and had
 * no `report-uri` and no `report-to`. That combination is worth naming, because
 * it is the exact shape this repository keeps finding: a header that looks like
 * a control, occupies the place a control would occupy, and does nothing. It
 * blocked nothing, by design — and it reported nothing either, to anybody, for
 * as long as it has existed. The violations went to the console of whoever
 * happened to have devtools open, which is nobody.
 *
 * The policy is enforcing now. That is a real change with a real failure mode:
 * a policy that is slightly too tight breaks the app *in the browser*, where
 * none of this repository's suites run, and the symptom is a white page rather
 * than an error anybody here can see. `tools/csp-test.mjs` loads the built app
 * under the real policy and proves it comes up. This endpoint is the other
 * half: what the suite cannot foresee arrives here from a real browser.
 *
 * ## What being public costs, and what pays for it
 *
 * A violation report is sent by the browser with no credentials of ours, and
 * often *because* our own scripts were blocked, so a token could not be
 * attached even in principle. It is therefore open, and the same three defences
 * `client-errors.ts` uses apply for the same reasons:
 *
 *   - rate limited by address;
 *   - every field truncated **here**, never trusted from the sender;
 *   - and 204 to everything, including a report that was thrown away, because
 *     a reporter that can tell acceptance from rejection is a probe.
 *
 * ## What is in a report, and what is deliberately not
 *
 * The directive that fired, the blocked origin, and the *path* of the page it
 * happened on. Not the full `document-uri` — that carries the query string, and
 * a violation on an OAuth callback would put a code in a log line. Not the
 * `script-sample`, which is the first eighty characters of the offending
 * inline script and can therefore be a fragment of somebody's page.
 *
 * The blocked URL is reduced to an **origin** for the same reason: what is
 * worth knowing is "something tried to load from example.com", and the path
 * after it is capable of carrying anything.
 */
import { Router, type IRouter } from "express";
import { rateLimitByIp, LIMITS } from "../lib/rate-limit";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const DIRECTIVE_MAX = 60;
const PATH_MAX = 200;
const ORIGIN_MAX = 120;

/** One field, cut to size and flattened to something a log line can hold. */
function clean(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const flat = value
    // Control characters out rather than escaped, like the crash reporter: a
    // report that can inject a newline can forge a second entry underneath
    // its own, and a log is read by eye as often as it is parsed.
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length === 0 ? null : flat.slice(0, max);
}

/**
 * The page it happened on, without the query string.
 *
 * `document-uri` is a full URL and the query is the dangerous half: a violation
 * on `/auth/callback?code=…` would put an authorization code into a log,
 * written there by the browser rather than by us, which is not a defence.
 */
export function pageOf(value: unknown): string {
  const raw = clean(value, PATH_MAX * 4) ?? "";
  try {
    return new URL(raw).pathname.slice(0, PATH_MAX) || "/";
  } catch {
    const path = raw.split(/[?#]/)[0] ?? "";
    return path.startsWith("/") ? path.slice(0, PATH_MAX) : "/";
  }
}

/**
 * What was blocked, as an origin.
 *
 * "Something tried to load from cdn.example.com" is the whole of what this is
 * for, and the path after the host can carry anything at all. The browser's own
 * placeholders — `inline`, `eval`, `data`, `blob` — are kept as they are,
 * because they are the answer rather than a URL.
 */
export function blockedOrigin(value: unknown): string {
  const raw = clean(value, ORIGIN_MAX * 4) ?? "";
  if (raw === "") return "unknown";
  if (!raw.includes("://")) return raw.slice(0, ORIGIN_MAX);
  try {
    return new URL(raw).origin.slice(0, ORIGIN_MAX);
  } catch {
    return "unknown";
  }
}

export interface Violation {
  directive: string;
  blocked: string;
  page: string;
}

/**
 * The report, as this server will record it.
 *
 * Two shapes reach here and both are the browser's, not ours: the original
 * `{"csp-report": {…}}` that every browser still sends to a `report-uri`, and
 * the newer Reporting API array of `{type, body}`. Reading only the first would
 * work today and quietly stop the day a browser moves, with nothing to see —
 * the reports would simply not arrive, which looks exactly like no violations.
 *
 * Exported and pure so the suite can check what a hostile body becomes without
 * a server. Every interesting case here is an input.
 */
export function violationFrom(body: unknown): Violation | null {
  if (typeof body !== "object" || body === null) return null;

  const candidates: Array<Record<string, unknown>> = [];
  const raw = body as Record<string, unknown>;

  const legacy = raw["csp-report"];
  if (typeof legacy === "object" && legacy !== null) candidates.push(legacy as Record<string, unknown>);

  if (Array.isArray(raw)) {
    for (const entry of raw as Array<Record<string, unknown>>) {
      const inner = entry?.["body"];
      if (typeof inner === "object" && inner !== null) candidates.push(inner as Record<string, unknown>);
    }
  }
  // A bare object with the fields on it, which is what a hand-rolled reporter
  // and some browser versions send.
  if (candidates.length === 0) candidates.push(raw);

  for (const report of candidates) {
    const directive = clean(
      report["effective-directive"] ?? report["violated-directive"] ?? report["effectiveDirective"],
      DIRECTIVE_MAX,
    );
    // No directive is not a report. It is the one field that says what happened.
    if (!directive) continue;
    return {
      directive,
      blocked: blockedOrigin(report["blocked-uri"] ?? report["blockedURL"] ?? report["blockedURI"]),
      page: pageOf(report["document-uri"] ?? report["documentURL"] ?? report["documentURI"]),
    };
  }
  return null;
}

router.post("/csp-report", rateLimitByIp(LIMITS.cspReport), (req, res): void => {
  const violation = violationFrom(req.body);
  if (violation) {
    /*
      `warn`, like a browser crash and for the same reason. A violation is a
      real signal and it is not an outage: an extension injecting a script into
      somebody's page produces one, and at `error` a handful of those would page
      whoever is watching. The thing that then gets turned off is the line that
      tells us the policy is biting at all.
    */
    logger.warn({ violation }, "a browser blocked something under the content policy");
  }
  // 204 either way. See the header.
  res.status(204).end();
});

export default router;
