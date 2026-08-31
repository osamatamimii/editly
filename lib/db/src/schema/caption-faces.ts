import { pgTable, uuid, text, timestamp, integer, real, index, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * A font somebody brought themselves.
 *
 * The reasoning is in `lib/db/migrations/0035_uploaded_caption_faces.sql`. The
 * short version: a font is not a file here, it is a file plus three measured
 * numbers, and each of the three is a way for a render to be wrong without
 * anything failing. They are measured by rendering, so they are kept.
 */
export const captionFacesTable = pgTable(
  "caption_faces",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id").notNull(),

    /** What the person called it, and what the file called itself. */
    label: text("label").notNull(),
    declared: text("declared"),

    /** "latin" | "arabic". A font covering both is two rows. */
    script: text("script").notNull(),

    /**
     * The family a style row names — ours, not the foundry's. A file calling
     * itself "Rubik" would otherwise resolve from wherever Rubik already is on
     * the machine, and the render would draw a font nobody uploaded.
     */
    family: text("family"),

    /** What was uploaded, what is burned with, and what the picker draws. */
    sourcePath: text("source_path").notNull(),
    facePath: text("face_path"),
    previewPath: text("preview_path"),

    /** Measured by rendering. Null until the job has run. */
    capRatio: real("cap_ratio"),
    widthScale: real("width_scale"),

    /** "pending" | "ready" | "refused" */
    status: text("status").notNull().default("pending"),

    refusalCode: text("refusal_code"),
    refusalEn: text("refusal_en"),
    refusalAr: text("refusal_ar"),

    bytes: integer("bytes").notNull().default(0),

    /** What the person said about their right to use it. Recorded, not checked. */
    rights: text("rights").notNull().default("own"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("caption_faces_user_idx").on(t.userId, t.script, t.status),
    // Uploading the same file twice is one face, not two identical rows in a
    // picker somebody then has to tell apart.
    uniqueIndex("caption_faces_source_idx").on(t.userId, t.sourcePath),
  ],
);

export type CaptionFaceRow = typeof captionFacesTable.$inferSelect;
export type CaptionFaceStatus = "pending" | "ready" | "refused";
