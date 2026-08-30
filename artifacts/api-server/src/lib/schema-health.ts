/**
 * Does the database the server is talking to have the columns the server reads?
 *
 * On 12 August the answer was no, and nothing said so. Five migrations had been
 * written, reviewed and committed, and never applied to the production
 * database. So every query the app makes named a column that did not exist,
 * every one of them failed, and the product looked like this from the outside:
 * an empty project list, a Create button that did nothing, and no error anywhere
 * a user could see. It ran that way for two days. `/healthz` returned `{status:
 * "ok"}` the entire time, because it was a function that returned a constant.
 *
 * A health check that cannot fail is not a health check. This one asks the
 * database what columns it has and compares them to what the code declares —
 * and the list of what the code declares is read out of the Drizzle tables
 * themselves, never hand-maintained, because a hand-maintained list of columns
 * is the same forgetting one layer up.
 *
 * It reports missing columns by name. "The database is behind" is a sentence
 * someone can act on in a minute; "500" is an afternoon.
 */
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { is, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import * as schema from "@workspace/db";

/**
 * Every table the schema declares, discovered rather than listed.
 *
 * This was five tables written out by hand, and the file's own argument two
 * paragraphs up is exactly why that was wrong: a hand-maintained list is the
 * same forgetting one layer up. It had already happened. Eight more tables have
 * been added since — `assets`, `clips`, `billing_events`, `rate_limits`,
 * `admin_actions`, `render_followups`, `waitlist`, `worker_heartbeats` — and
 * every one of them is read on a live request path while being invisible here.
 *
 * So the exact failure this module exists to catch could recur in the majority
 * of the database and `/healthz` would answer `{status: "ok"}` with an empty
 * `missingColumns` throughout: `/projects/:id/assets` 500ing on every request,
 * `/waitlist` throwing, and the rate limiter — which **fails open** — quietly
 * off, taking the paid-model spend guard with it. The uptime monitor would stay
 * green the whole time, because it reads this.
 *
 * A table added to the schema is now checked from the moment it exists.
 */
const TABLES: PgTable[] = Object.values(schema as Record<string, unknown>).filter(
  (value): value is PgTable => is(value, PgTable),
);

export interface SchemaHealth {
  reachable: boolean;
  /** "jobs.output_seconds" — qualified, because a bare column name is ambiguous. */
  missingColumns: string[];
  /** Present only when the database could not be reached at all. */
  error?: string;
}

export const BEHIND_MESSAGE =
  "The database is missing columns this build expects. Apply the migrations in lib/db/migrations, in order.";

/**
 * What the code says the database should have.
 *
 * Exported so the schema suite can assert this is the real set rather than a
 * list somebody remembered to update.
 */
export function expectedColumns(): Map<string, Set<string>> {
  const expected = new Map<string, Set<string>>();
  for (const table of TABLES) {
    const config = getTableConfig(table);
    expected.set(config.name, new Set(config.columns.map((column) => column.name)));
  }
  return expected;
}

/**
 * Compares what is declared with what exists. Pure, so the suite can drive it
 * with a schema that is deliberately behind.
 */
export function compareSchema(
  expected: Map<string, Set<string>>,
  actual: Map<string, Set<string>>,
): string[] {
  const missing: string[] = [];
  for (const [table, columns] of expected) {
    const present = actual.get(table);
    if (!present) {
      // A whole table missing is reported as its columns rather than as one
      // line, so the message names everything that has to be created and the
      // reader is not left to work out which migration introduced the table.
      for (const column of columns) missing.push(`${table}.${column}`);
      continue;
    }
    for (const column of columns) {
      if (!present.has(column)) missing.push(`${table}.${column}`);
    }
  }
  // Columns the database has and the code does not read are deliberately not
  // reported. A column added ahead of the code that will use it is how a safe
  // migration is deployed, and failing on it would make the safe order the
  // failing one.
  return missing.sort();
}

/**
 * Cached briefly.
 *
 * The answer changes only when someone runs a migration, and this is the one
 * endpoint an uptime monitor hits every thirty seconds. A cold serverless
 * invocation pays for the query once; a warm one does not pay at all.
 */
const CACHE_MS = 30_000;
let cached: { at: number; result: SchemaHealth } | null = null;

export async function checkSchema(now = Date.now()): Promise<SchemaHealth> {
  if (cached && now - cached.at < CACHE_MS) return cached.result;

  let result: SchemaHealth;
  try {
    const expected = expectedColumns();
    // Spelled out as an IN list rather than `= ANY($1)`: handed a JavaScript
    // array, Drizzle expands it into a tuple of placeholders, and `ANY((…))` is
    // not valid SQL. That failed as "could not reach the database" — a health
    // check that reports the wrong failure is worse than one that reports none,
    // and it took a suite running against a real Postgres to see it.
    const names = [...expected.keys()];
    const rows = await db.execute<{ table_name: string; column_name: string }>(sql`
      SELECT table_name, column_name
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN (${sql.join(names.map((name) => sql`${name}`), sql`, `)})
    `);

    const actual = new Map<string, Set<string>>();
    for (const row of rows.rows) {
      const set = actual.get(row.table_name) ?? new Set<string>();
      set.add(row.column_name);
      actual.set(row.table_name, set);
    }

    result = { reachable: true, missingColumns: compareSchema(expected, actual) };
  } catch (error) {
    // Unreachable is a different failure from behind, and conflating them sends
    // whoever is reading this to the wrong place.
    result = {
      reachable: false,
      missingColumns: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }

  cached = { at: now, result };
  return result;
}

/** Drops the cache. For tests, and for anything that has just migrated. */
export function forgetSchemaHealth(): void {
  cached = null;
}
