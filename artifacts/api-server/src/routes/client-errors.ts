/**
 * Where a crashed browser says so.
 *
 * The app had no error boundary and no way to report one, so a React exception
 * was a white document and total silence on this side. This is the other half
 * of `components/error-boundary.tsx`: one line in our own log, from the one
 * place that can see a failure the server was never part of.
 *
 * ## Why our own log and not a service
 *
 * Because the question is small. "Is this happening, to anyone, at all" is
 * answered by a log line, and a third-party crash reporter is a new account, a
 * script from a domain the privacy policy would have to name, a row in
 * `processors.ts`, and a paragraph explaining to customers that their browser
 * talks to a company they have not heard of. That is a real price for a
 * question `logger.warn` answers.
 *
 * ## What being public costs, and what pays for it
 *
 * This has to be reachable without a token: the whole point is that it works
 * when the app is broken, and a crash on the login screen has no session to
 * carry. Open with no limit is a log anybody can write into until the log is
 * useless and the bill is not, so:
 *
 *   - it is rate limited by address, like the waiting list;
 *   - every field is truncated **here**, not trusted from the browser, above
 *     express's own hundred-kilobyte ceiling on any body at all;
 *   - and it answers 204 to everything, including a report it threw away.
 *     A reporter that can tell an accepted report from a rejected one is a
 *     probe, and there is nothing here worth letting somebody probe.
 *
 * ## What is not in a report, on purpose
 *
 * The message, the component, the pathname and a reference code. No query
 * string — an OAuth failure carries a code in one — no token, no email, no
 * field contents. The browser is careful about this and so is this file,
 * because "the client already filtered it" is a sentence about a program
 * anybody can edit.
 */
import { Router, type IRouter } from "express";
import { rateLimitByIp, LIMITS } from "../lib/rate-limit";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/** Long enough for a real stack message, short enough to be worthless to abuse. */
const MESSAGE_MAX = 300;
const COMPONENT_MAX = 300;
const PATH_MAX = 200;
const REFERENCE_MAX = 12;

/** What a browser is allowed to say happened. Anything else is "render". */
const KINDS = new Set(["render", "promise", "handler"]);

/** One field, cut to size and flattened to something a log line can hold. */
function clean(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const flat = value
    // Control characters out rather than escaped: a log is read by eye as
    // often as it is parsed, and a report that can inject a newline can forge
    // a second entry underneath its own.
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length === 0 ? null : flat.slice(0, max);
}

/**
 * The pathname, and only that.
 *
 * Parsed rather than trusted. A browser sends `/project/abc`, and anything
 * else — a full URL with a token in the query, a path with a fragment — is
 * reduced to its path before it reaches a log.
 */
export function pathOnly(value: unknown): string {
  const raw = clean(value, PATH_MAX * 2) ?? "";
  const withoutQuery = raw.split(/[?#]/)[0] ?? "";
  return withoutQuery.startsWith("/") ? withoutQuery.slice(0, PATH_MAX) : "/";
}

export interface ClientCrash {
  kind: string;
  message: string;
  component: string | null;
  path: string;
  reference: string | null;
}

/**
 * The report, as this server will record it.
 *
 * Exported and pure so the suite can check what a hostile body becomes without
 * a server: the interesting cases are all inputs, and every one of them has to
 * come out as something a log can hold.
 */
export function crashFrom(body: unknown): ClientCrash | null {
  if (typeof body !== "object" || body === null) return null;
  const raw = body as Record<string, unknown>;
  const message = clean(raw["message"], MESSAGE_MAX);
  // A report with no message is not a report. Everything else can be missing.
  if (!message) return null;
  return {
    kind: KINDS.has(String(raw["kind"])) ? String(raw["kind"]) : "render",
    message,
    component: clean(raw["component"], COMPONENT_MAX),
    path: pathOnly(raw["path"]),
    reference: clean(raw["reference"], REFERENCE_MAX),
  };
}

router.post("/client-errors", rateLimitByIp(LIMITS.clientErrors), (req, res): void => {
  const crash = crashFrom(req.body);
  if (crash) {
    /*
      `warn`, not `error`. A browser crash is a real signal and it is not an
      outage: at `error` a handful of people on an old browser would page
      whoever is watching, and the thing that would then be turned off is the
      one line telling us this happens at all.
    */
    logger.warn({ crash }, "a browser reported a crash");
  }
  // 204 either way. See the header.
  res.status(204).end();
});

export default router;
