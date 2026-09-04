/**
 * What a rejected request says, once, instead of twenty-two times differently.
 *
 * Every validating route in this server was written the same way:
 *
 *     res.status(400).json({ error: parsed.error.message });
 *
 * `ZodError.message` is not a message. It is `JSON.stringify(issues, null, 2)`
 * — the whole issue array, pretty-printed, with `code`, `path`, `expected`,
 * `received` and an `inclusive` flag. The generated client hands that string
 * to a toast, so somebody who typed a title one character too long was shown
 * a JSON document about `too_big` and `maximum: 200`, in a corner of the
 * screen, for four seconds.
 *
 * It is worse than ugly. The dump names our field paths and our internal
 * shapes, which is the thing `error-handler.ts` exists to keep inside — and it
 * is unreadable in Arabic, where the interface is otherwise complete, because
 * zod's default strings are English regardless of what the person is using.
 *
 * ## What this produces instead
 *
 * One sentence. The field, in the words the API uses for it, and what is wrong
 * with it. Two issues at most, because a body with nine problems is a client
 * bug and listing nine is not more helpful than listing two.
 *
 * ## What it deliberately does not do
 *
 * It does not translate. The sentences here are English, like every other
 * message this server sends, and the interface's Arabic comes from the
 * frontend's own strings — which is why the shape below is a short, stable
 * sentence rather than free prose: something the client can match on if it
 * ever wants to say it in the reader's language.
 */
import type { Response } from "express";
import type { ZodError, ZodIssue } from "@workspace/api-zod";

/** At most this many problems are named; the rest are counted. */
const NAMED_ISSUES = 2;

/**
 * The field, as a person would refer to it.
 *
 * `["operations", 0, "maxHeight"]` reads as `operations[0].maxHeight`, which
 * is what somebody debugging a request wants, and the empty path — a whole
 * body of the wrong shape — reads as "the request".
 */
export function fieldName(path: ReadonlyArray<PropertyKey>): string {
  if (path.length === 0) return "the request";
  return path.reduce<string>((so_far, part) => {
    if (typeof part === "number") return `${so_far}[${part}]`;
    // A symbol key cannot be spelled in JSON and so cannot be what a caller
    // sent; it is here because the type allows it, and `String()` is the
    // honest rendering rather than a crash.
    const name = typeof part === "symbol" ? part.description ?? "?" : String(part);
    return so_far.length === 0 ? name : `${so_far}.${name}`;
  }, "");
}

/**
 * One issue, said plainly.
 *
 * zod's own `issue.message` is already a sentence for most codes ("Expected
 * number, received string"), so the ones spelled out here are the ones where
 * it is not — where it leaks a schema word, or where a bound is the whole
 * information and zod buries it in a clause.
 */
export function sentenceForIssue(issue: ZodIssue): string {
  const field = fieldName(issue.path ?? []);
  switch (issue.code) {
    case "invalid_type":
      /*
        v4 reports the missing case as `received: "undefined"` on the same
        code as a wrong type, and the two want different sentences: "required"
        is something the caller can act on, "must be a number" is something
        else entirely.
      */
      return (issue as { received?: string }).received === "undefined"
        ? `${field} is required`
        : `${field} must be ${article(String(issue.expected))}`;
    case "too_small": {
      const bound = String(issue.minimum);
      if (issue.origin === "string")
        return bound === "1" ? `${field} cannot be empty` : `${field} must be at least ${bound} characters`;
      if (issue.origin === "array")
        return `${field} must have at least ${bound} item${bound === "1" ? "" : "s"}`;
      return `${field} must be ${issue.inclusive ? "at least" : "more than"} ${bound}`;
    }
    case "too_big": {
      const bound = String(issue.maximum);
      if (issue.origin === "string") return `${field} must be ${bound} characters or fewer`;
      if (issue.origin === "array")
        return `${field} must have ${bound} item${bound === "1" ? "" : "s"} or fewer`;
      return `${field} must be ${issue.inclusive ? "at most" : "less than"} ${bound}`;
    }
    case "invalid_value": {
      // Enums and literals both land here in v4, carrying the allowed set.
      const values = (issue as { values?: ReadonlyArray<unknown> }).values ?? [];
      return values.length > 0
        ? `${field} must be one of: ${values.map(String).join(", ")}`
        : `${field} is not one of the allowed values`;
    }
    case "invalid_format": {
      const format = (issue as { format?: string }).format;
      if (format === "uuid") return `${field} must be an id`;
      if (format === "email") return `${field} must be an email address`;
      if (format === "url") return `${field} must be a web address`;
      if (format === "datetime") return `${field} must be a date and time`;
      return `${field} is not in the right format`;
    }
    case "unrecognized_keys": {
      const keys = (issue as { keys?: readonly string[] }).keys ?? [];
      return `${keys.join(", ")} ${keys.length === 1 ? "is not a field" : "are not fields"} of this request`;
    }
    case "not_multiple_of":
      return `${field} must be a multiple of ${String((issue as { divisor?: unknown }).divisor)}`;
    default:
      /*
        The fallback still names the field.

        zod's message alone — "Invalid input" — is the sentence that sent
        people to support, because the one thing they needed was which field.
      */
      return `${field}: ${lowerFirst(issue.message)}`;
  }
}

/** "a number", "an array" — small, but "must be array" reads like a stub. */
function article(word: string): string {
  return /^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`;
}

function lowerFirst(text: string): string {
  return text.length > 0 ? text[0]!.toLowerCase() + text.slice(1) : text;
}

/**
 * The whole refusal, as one sentence ending in a full stop.
 *
 * Exported separately from the responder so it can be tested — and read — with
 * no HTTP anywhere near it.
 */
export function sentenceFor(error: ZodError): string {
  const issues = error.issues ?? [];
  if (issues.length === 0) return "That request could not be read.";
  const named = issues.slice(0, NAMED_ISSUES).map(sentenceForIssue);
  const rest = issues.length - named.length;
  const listed = named.join(", and ");
  return rest > 0 ? `${listed}, and ${rest} other problem${rest === 1 ? "" : "s"}.` : `${listed}.`;
}

/**
 * Answer 400 with that sentence.
 *
 * The one call every route makes, so the shape cannot drift back: a route that
 * writes its own 400 body from a `ZodError` is the bug this replaces, and
 * `tools/contract-test.mjs` fails when one appears.
 */
export function badRequest(res: Response, error: ZodError): void {
  res.status(400).json({ error: sentenceFor(error) });
}
