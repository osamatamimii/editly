/**
 * What a storage key is allowed to look like, in one place.
 *
 * This rule was written three times — in the API, in the worker, and again in
 * the browser's upload path — and the three copies did not agree. The API's
 * copy once looked for a literal `..` and accepted `%2e%2e/%2e%2e/`, which the
 * URL parser resolves before the request leaves the process, and that process
 * holds the service role key. The hole is closed, but a guard that exists in
 * three places is one refactor away from existing in two.
 *
 * So it lives here now, beside the thing it guards, and every provider driver
 * calls it before it builds a URL. A driver cannot be given a key it has not
 * been checked against, because the check is the first line of every method.
 */

/**
 * One path segment.
 *
 * Deliberately narrower than "no slashes and no dots": it must start with a
 * letter or a digit, which rules out `.`, `..`, `.hidden`, and every encoding
 * of them, without this file having to enumerate encodings. Anything a person
 * uploads is renamed to an id before it reaches here, so nothing legitimate is
 * lost to the narrowness.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface KeyRule {
  /**
   * How many segments the key must have.
   *
   * A video lives at `<user>/<project>/<name>` and a font at `<user>/fonts/<name>`,
   * so three is the floor everywhere today. It is a parameter rather than a
   * constant because a rule that cannot be relaxed gets bypassed instead.
   */
  minSegments?: number;
}

export function isSafeKey(key: string, rule: KeyRule = {}): boolean {
  const min = rule.minSegments ?? 3;
  if (!key || key.startsWith("/") || key.endsWith("/")) return false;
  if (key.includes("//")) return false;
  const segments = key.split("/");
  return segments.length >= min && segments.every((s) => SAFE_SEGMENT.test(s));
}

/**
 * Throws with a message that does not contain the key.
 *
 * A hostile key is on its way into a log that somebody will later paste
 * somewhere, and its shape is enough to debug from.
 */
export function assertSafeKey(key: string, rule: KeyRule = {}): void {
  if (!isSafeKey(key, rule)) {
    throw new Error(
      `refusing to touch a storage key that is not a plain path of safe segments ` +
        `(${key.split("/").length} segments, ${key.length} characters)`,
    );
  }
}

/** True when the key is inside this account's folder, and nowhere else. */
export function isOwnedBy(key: string, userId: string): boolean {
  return isSafeKey(key) && key.split("/")[0] === userId;
}

/**
 * A prefix, for listing.
 *
 * Prefixes are not keys: they have fewer segments and they end in a slash on
 * purpose, so they get their own check rather than a relaxed version of the
 * key one. `a/b` as a prefix would also match `a/bc`, which is another
 * account's folder when the segment is a user id.
 */
export function isSafePrefix(prefix: string): boolean {
  if (!prefix || prefix.startsWith("/")) return false;
  const body = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  if (!body) return false;
  return body.split("/").every((s) => SAFE_SEGMENT.test(s));
}
