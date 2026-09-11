import { pgTable, text, integer, doublePrecision, timestamp, uuid, index } from "drizzle-orm/pg-core";

/**
 * The music library, which fills itself.
 *
 * This is not a mirror of anybody's catalogue. Every row here is a bed *we*
 * generated, to our own account, from one of six moods — so the file is ours
 * to hand on, and the argument that kept music out of this product for its
 * whole life ("a track we give you is a licence we bought on your behalf")
 * does not apply to it.
 *
 * ## Why a table at all
 *
 * Because generation is priced per generation. A mood is a key: the first
 * person to ask for a calm bed pays for one to be made, it lands here, and
 * everyone after that is served the same file. Without this table the same
 * thirty seconds of music is bought again on every render, forever, and the
 * cheapest plan in the product cannot carry it. With it, the cost of the
 * entire music library is bounded by how many moods there are times how many
 * variants of each we let it accumulate — a number in the dozens, paid once.
 *
 * ## Why `bpm` is measured and not declared
 *
 * The model is asked for a steady tempo and is not asked what tempo it chose,
 * because a number a generator reports about its own output is a claim, and
 * the zoom punches land on this number. It is measured from the rendered file
 * by `beats.ts` — the same detector, with the same negative half, that refuses
 * to find a grid in a pad or a drone. Null is therefore a real and common
 * answer and means exactly one thing: do not sync anything to this file.
 *
 * ## Why rows are never edited
 *
 * A bed that is already under somebody's published video must not change. A
 * variant that turns out badly is retired by setting `retired_at`, and a new
 * one is generated beside it; the old file stays where it is because the
 * render that used it is finished and the customer has posted it.
 */
export const musicTracksTable = pgTable(
  "music_tracks",
  {
    id: uuid("id").primaryKey(),
    /** One of the six. Kept as text rather than an enum so adding a seventh is
     *  a code change and not a migration that locks the table. */
    mood: text("mood").notNull(),
    /** The object key in the videos bucket. Ours, under a fixed prefix. */
    path: text("path").notNull().unique(),
    /** Measured from the file, not from the response. */
    seconds: doublePrecision("seconds").notNull(),
    /**
     * Measured by `beatsOf`, and null when it found no grid worth trusting.
     * Null is not a gap in the data; it is the answer "nothing in this file
     * should be cut to".
     */
    bpm: doublePrecision("bpm"),
    /** Which generator made it, for the day one of them has to be recalled. */
    source: text("source").notNull(),
    /**
     * How many renders have used it. The chooser takes the least-used row for
     * the mood, so a new variant spreads instead of sitting unused behind the
     * first one ever made.
     */
    timesUsed: integer("times_used").notNull().default(0),
    /** Set when a variant should stop being handed out. Never deleted. */
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The only query this table serves: give me the least-used live bed for
    // this mood. One index, matching one access pattern.
    index("music_tracks_mood_idx").on(table.mood, table.timesUsed),
  ],
);
