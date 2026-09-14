import { pgTable, text, timestamp, uuid, jsonb, index } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

/**
 * What the product got wrong, and what the customer changed it to.
 *
 * Every other row in this schema records something the product did. This one
 * records something it *should have done differently* — the only data in the
 * business that cannot be bought, scraped or copied, because it exists only
 * where an editor and a customer disagree.
 *
 * ## It holds the instructions, never the footage
 *
 * Three places in the product tell a customer, in their own words, that we do
 * not use their **videos** to train models. That sentence is not being edited;
 * it is being built toward, which is what this repository does with a written
 * promise — and it is a sentence about their footage, not about what they told
 * us to do with it.
 *
 * So the title they typed, the font they chose and the length they asked a card
 * to hold are all kept as written: those are the corrections, and a rewrite is
 * only a lesson if both sets of words are there. What came out of the recording
 * is the burnt caption cues, and `edit-pairs.ts` turns those into a count of
 * words before either plan reaches these columns.
 *
 * That is a denylist, so it has a guard: `edit-pairs-test` walks the real plan
 * schema and fails on any field nobody has put on one side of the line. Adding
 * a field to a plan is a decision about that file, made on purpose.
 *
 * `user_id` is here for one reason, and it is not analysis: a deletion request
 * has to be able to reach these rows.
 */
export const editPairsTable = pgTable(
  "edit_pairs",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id").notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    /** The redacted plan we produced. */
    before: jsonb("before").notNull(),
    /** The redacted plan after they corrected it. */
    after: jsonb("after").notNull(),
    /** Field-level changes, already computed. */
    changes: jsonb("changes").notNull().default([]),
    /** Operations added or taken away entirely. */
    structure: jsonb("structure").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("edit_pairs_created_idx").on(table.createdAt),
    index("edit_pairs_user_idx").on(table.userId, table.createdAt),
  ],
);
