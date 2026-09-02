/**
 * Everything this product holds about one person, in one file they can keep.
 *
 * The other half of `account-deletion`. Deleting was built first because it is
 * the one people ask about, but the right of access is the one they exercise:
 * "what do you have on me" is a question a customer, a platform reviewer and a
 * regulator can all ask, and until now the answer was a person reading rows out
 * of a database by hand.
 *
 * ## The decision this file exists for
 *
 * Not which tables. Which *columns*.
 *
 * An export that hands somebody a JSON file containing their own YouTube
 * refresh token is a credential leak wearing a compliance feature's clothes.
 * The file gets emailed to a laptop, attached to a support ticket, dropped in a
 * shared drive — and it is a working key to their channel for as long as it
 * lives there. The same is true of the Meta page token, and of the unsubscribe
 * token, which is a URL anybody holding it can act on.
 *
 * So the rule is a *shape* rather than a list: any column whose name says it is
 * a credential is replaced by a marker, everywhere, in every table, including
 * tables nobody has written yet. A list of columns is a list somebody forgets
 * to add to; a rule about names is one a new column has to actively evade.
 *
 * `REDACTED` is a marker rather than an omission on purpose. "We hold a refresh
 * token for your YouTube connection and are not putting it in this file" is a
 * true and useful sentence; silently dropping the field says we hold nothing.
 */

/**
 * What a column has to be called before this file will let it out.
 *
 * Deliberately broad. A false positive costs one field in an export and is
 * visible the moment anybody reads one; a false negative is a live credential
 * in a file somebody forwards.
 */
export const LOOKS_LIKE_A_SECRET = /token|secret|password|credential|\bkey\b/i;

/** What stands in its place, so the person knows the field exists. */
export const REDACTED = "[held, not exported: this is a credential]";

/**
 * Column names that match the rule and are not credentials.
 *
 * Every entry is a decision somebody made once, in writing, rather than a
 * regex that grew an exception. Empty is the right size for this list; if it
 * is long, the rule is wrong.
 */
export const NOT_ACTUALLY_SECRET: readonly string[] = [];

export function redactsColumn(name: string): boolean {
  if (NOT_ACTUALLY_SECRET.includes(name)) return false;
  return LOOKS_LIKE_A_SECRET.test(name);
}

/** One row, with anything that looks like a credential replaced. */
export function redactRow<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = redactsColumn(key) && value !== null && value !== undefined ? REDACTED : value;
  }
  return out;
}

export function redactRows(rows: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map(redactRow);
}

/**
 * The shape of the file, so the person opening it knows what they have.
 *
 * A bare dump of table names is a file only we can read. The header says what
 * this is, when it was made, and what is deliberately not in it — because the
 * two things missing are the two things somebody will otherwise assume we do
 * not hold.
 */
export interface AccountExport {
  exportedAt: string;
  account: { id: string; email: string | null };
  /** Said out loud rather than left to be noticed. */
  notIncluded: readonly string[];
  tables: Record<string, readonly Record<string, unknown>[]>;
  /** Object keys in storage, which are files rather than rows. */
  files: readonly string[];
}

export const NOT_INCLUDED: readonly string[] = [
  "Access and refresh tokens for connected social accounts, and the unsubscribe token for email. These are credentials; a copy of one in a file is a working key for as long as the file exists. Every field that holds one appears with a marker in its place.",
  "The video files themselves, which are listed by name below and downloaded from the product, because a JSON file is the wrong container for four hours of footage.",
  "Server logs, which are keyed by request rather than by person and are kept for a short window by our hosts.",
];

/** The filename a browser will save it under. */
export function exportFilename(now = new Date()): string {
  return `editly-data-${now.toISOString().slice(0, 10)}.json`;
}
