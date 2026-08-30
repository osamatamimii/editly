/**
 * Fourteen days of the numbers the console shows one of.
 *
 * Every card on the operations screen is a count taken right now: 218 accounts,
 * 34 renders yesterday, 412 minutes this month. Each of those is true and none
 * of them answers the question somebody actually opens the console with, which
 * is **which way is it going**. 19 signups this week is a good week or a bad
 * one depending entirely on a number that was nowhere on the page.
 *
 * So: a daily series, and the arithmetic that turns it into a sentence — this
 * week against the one before it. Fourteen days because that is the shortest
 * window that contains two comparable weeks; a day-on-day change on a product
 * with a weekend in it is noise wearing a percentage sign.
 *
 * Every series is filled to exactly 14 buckets, including the days with
 * nothing in them. A chart that silently drops empty days draws a busy week
 * and a dead one as the same shape.
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

export const TREND_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface Trend {
  /** Oldest first, exactly TREND_DAYS long, one entry per UTC day. */
  daily: number[];
  /** The last 7 days. */
  thisWeek: number;
  /** The 7 before those. */
  lastWeek: number;
}

/** Midnight UTC, `daysAgo` days back. The buckets are UTC because the rows are. */
function midnightUtc(daysAgo: number): Date {
  const d = new Date(Date.now() - daysAgo * DAY_MS);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** `YYYY-MM-DD` for a Date, in UTC. The key the buckets are held under. */
function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Runs one grouped-by-day query and returns a filled, ordered series.
 *
 * `value` is the aggregate — `count(*)` for a tally, `sum(...)` for minutes —
 * and it is passed in rather than switched on, because the shape of the answer
 * is the same either way and the only thing that differs is the one expression.
 */
async function series(table: string, column: string, value: string): Promise<Trend> {
  const from = midnightUtc(TREND_DAYS - 1);

  // Identifiers cannot be parameters, so they are interpolated — and every one
  // of them is a literal written in this file, never anything from a request.
  const rows = (await db.execute(
    sql.raw(
      `select to_char(date_trunc('day', ${column} at time zone 'UTC'), 'YYYY-MM-DD') as day,
              ${value} as v
         from ${table}
        where ${column} >= '${from.toISOString()}'
        group by 1`,
    ),
  )) as unknown as { rows?: Array<{ day: string; v: unknown }> } | Array<{ day: string; v: unknown }>;

  // `db.execute` returns `{rows}` on node-postgres and a bare array on some
  // drivers. Both shapes have been seen in this repo's history, and reading the
  // wrong one silently yields an empty series — a flat line, which looks like a
  // quiet fortnight rather than like a bug.
  const list = Array.isArray(rows) ? rows : (rows.rows ?? []);

  const byDay = new Map<string, number>();
  for (const row of list) byDay.set(String(row.day), Number(row.v) || 0);

  const daily: number[] = [];
  for (let i = TREND_DAYS - 1; i >= 0; i--) {
    daily.push(byDay.get(dayKey(midnightUtc(i))) ?? 0);
  }

  const thisWeek = daily.slice(TREND_DAYS - 7).reduce((a, b) => a + b, 0);
  const lastWeek = daily.slice(0, TREND_DAYS - 7).reduce((a, b) => a + b, 0);
  return { daily, thisWeek, lastWeek };
}

export interface Trends {
  signups: Trend;
  renders: Trend;
  /** Whole minutes of finished video, so the console and the bill agree. */
  minutes: Trend;
  failures: Trend;
}

export async function trends(): Promise<Trends> {
  // Four small grouped reads rather than one clever join. They are independent,
  // they run together, and a join that has to left-join four aggregates onto a
  // generated date range is a query nobody will ever edit correctly.
  const [signups, renders, minutes, failures] = await Promise.all([
    series("subscriptions", "created_at", "count(*)::int"),
    series("jobs", "finished_at", "count(*) filter (where status = 'done')::int"),
    series("jobs", "finished_at", "(coalesce(sum(billed_seconds) filter (where status = 'done'), 0) / 60)::int"),
    series("jobs", "updated_at", "count(*) filter (where status = 'failed')::int"),
  ]);
  return { signups, renders, minutes, failures };
}
