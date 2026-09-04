import { pgTable, uuid, text, timestamp, boolean, index, uniqueIndex, primaryKey } from "drizzle-orm/pg-core";

/**
 * The two tables the mail package writes, declared where every other table is.
 *
 * They existed in SQL and nowhere else. `lib/mail` reaches both only through
 * `db.execute(sql\`…\`)`, so TypeScript never noticed and no query was ever
 * malformed — and three things that read the Drizzle schema were blind to them.
 *
 * **`/healthz` could not see them.** `schema-health.ts` builds its expected
 * columns from `Object.values(schema)` filtered to `PgTable`, so a deployment
 * that had not run 0041 answered `{status: "ok", missingColumns: []}` while
 * every `send()` threw `relation "mail_sends" does not exist` inside `claim()`
 * — into a catch that turns it into `{sent: false, because: "refused"}`. The
 * product would have emailed nobody, forever, with the monitor green. That is
 * the 12 August failure mode in the one module written after it.
 *
 * **`schema-test` could not see them either**, because its orphan-column check
 * reads the same list.
 *
 * **And `drizzle-kit push` would have dropped them.** `lib/db/package.json`
 * still ships `push` and `push-force`; push diffs this schema against the live
 * database, and a table that is not here is a table it removes. The
 * deduplication lock and the unsubscribe tokens were one command away from
 * being deleted, and 0011's own note records the test database being built that
 * way once already.
 *
 * The reasoning for the columns themselves is in
 * `lib/db/migrations/0041_the_product_can_write_to_you.sql`.
 */
export const mailSendsTable = pgTable(
  "mail_sends",
  {
    userId: uuid("user_id").notNull(),
    /**
     * Stable names, because they are half of a uniqueness key. Renaming one is
     * not a refactor: it is a promise that everybody gets the old message again.
     */
    event: text("event").notNull(),
    reference: text("reference").notNull(),
    /** "account" | "news". Only the second may be unsubscribed from. */
    kind: text("kind").notNull().default("account"),
    /** The claim. Written before the send, which is what makes it a lock. */
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
    /** Null means claimed and not yet confirmed sent. */
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.event, t.reference] }),
    index("mail_sends_user_idx").on(t.userId, t.claimedAt.desc()),
  ],
);

export const mailSettingsTable = pgTable(
  "mail_settings",
  {
    userId: uuid("user_id").primaryKey(),
    /** Null is "not asked", not "English". The difference is the whole feature. */
    language: text("language"),
    newsOptOut: boolean("news_opt_out").notNull().default(false),
    /**
     * The unsubscribe link's whole authorisation, and deliberately meaningless:
     * it cannot be turned back into an account id, an address or a session.
     */
    token: text("token").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Unique, because the link has to find the row from the token alone and only
  // ever one row. This is a correctness guarantee, not a speed one.
  (t) => [uniqueIndex("mail_settings_token_key").on(t.token)],
);
