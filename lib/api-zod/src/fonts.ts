/**
 * The faces a caption can be drawn in.
 *
 * Shared by the renderer, the API and the picker, because all three have to
 * agree about the same three things and each of them is a way to be silently
 * wrong.
 *
 * **The family name**, which is what a style row hands to fontconfig. Get it
 * wrong and nothing fails: fontconfig substitutes, libass draws, the words are
 * right, the timing is right, and the font is not the one anybody chose.
 *
 * **The ratio**, which is how a height in pixels becomes an ASS `Fontsize`.
 * `Fontsize` is the *line height*, not the size of a letter, and how much of it
 * a letter occupies is a property of the face — measured here from 0.31 to 0.57
 * across these twelve. A layout that picks a height and divides by the wrong
 * ratio renders every caption at the wrong size, on a face nobody complained
 * about, with nothing failing anywhere.
 *
 * For a Latin face the ratio is the cap height. For an Arabic one it is the
 * alef: Arabic has no capitals, and the alef is the tall vertical stroke that
 * plays a capital's part. Equalising those is what makes an Arabic caption and
 * an English one the same size on screen.
 *
 * **The width scale**, which is how wide this face runs against the one the
 * per-character advance table was measured from. Anton and Bebas Neue are
 * condensed to a little over half of Montserrat's width per unit of height;
 * Archivo Black is slightly wider. One table with no scale would wrap a
 * condensed caption a third early — invisible, since nothing fails and the
 * words simply move to another line — or run a wide one past the platform's
 * safe area, which is the direction that costs the last word of a sentence.
 *
 * Every number here was measured by rendering through libass and counting
 * drawn pixels, at the same bold flag the renderer uses, against the exact
 * files in `artifacts/worker/fonts/`. `tools/font-test.mjs` re-measures them
 * and fails if a face has drifted from what this table says.
 *
 * ## Why these twelve
 *
 * Six per script, chosen to be different from each other rather than to be
 * many: a picker with forty faces where eight of them are the same grotesque
 * is a longer list and not more choice. All are under the SIL Open Font
 * License; the licences ship beside the files.
 *
 * Each Arabic face is repaired before it is shipped — see
 * `artifacts/worker/fonts/make-caption-faces.py`. Of the seven tried, five drew
 * empty boxes for every letter standing alone and one drew boxes for every
 * letter in the sentence. Only Noto Kufi Arabic was complete out of the box.
 * A face that fails that repair does not belong in this list, and the image
 * build refuses to be built with one.
 */

export type FaceScript = "latin" | "arabic";

export interface CaptionFace {
  /** Stable id. What a plan carries and what the picker sends. */
  id: string;
  /** What the picker shows. */
  label: string;
  script: FaceScript;
  /** The family name a style row names, and the name fontconfig resolves. */
  family: string;
  /** The file shipped into the worker image, under `artifacts/worker/fonts/`. */
  file: string;
  /**
   * Fraction of the nominal size a capital occupies — the alef, for Arabic.
   * Measured, never taken from a table in the font.
   */
  capRatio: number;
  /**
   * How wide this face runs against the face the advance table was measured
   * from: Montserrat Black for Latin, Cairo Black for Arabic. Rounded *up*,
   * because over-estimating a line's width costs a line break and
   * under-estimating costs the end of a sentence.
   */
  widthScale: number;
  /** One line in the picker. What it is for, not what it looks like. */
  note: string;
}

export const CAPTION_FACES: readonly CaptionFace[] = [
  // ── Latin ────────────────────────────────────────────────────────────────
  {
    id: "montserrat-black",
    label: "Montserrat Black",
    script: "latin",
    family: "Montserrat Black",
    file: "Montserrat-Black.ttf",
    capRatio: 0.47,
    widthScale: 1,
    note: "Round, heavy, neutral. The one most short-form captions look like.",
  },
  {
    id: "anton",
    label: "Anton",
    script: "latin",
    family: "Anton",
    file: "Anton.ttf",
    capRatio: 0.52,
    widthScale: 0.6,
    note: "Condensed and loud. Fits far more words on a line.",
  },
  {
    id: "bebas-neue",
    label: "Bebas Neue",
    script: "latin",
    family: "Bebas Neue",
    file: "Bebas-Neue.ttf",
    capRatio: 0.57,
    widthScale: 0.6,
    note: "Tall capitals only. Reads as a title rather than a sentence.",
  },
  {
    id: "archivo-black",
    label: "Archivo Black",
    script: "latin",
    family: "Archivo Black",
    file: "Archivo-Black.ttf",
    capRatio: 0.55,
    widthScale: 1.05,
    note: "Wide and flat-sided. Solid on a busy shot.",
  },
  {
    id: "poppins-extrabold",
    label: "Poppins ExtraBold",
    script: "latin",
    family: "Poppins ExtraBold",
    file: "Poppins-ExtraBold.ttf",
    capRatio: 0.41,
    widthScale: 0.95,
    note: "Geometric and friendly. Circles where Montserrat has ovals.",
  },
  {
    id: "oswald-bold",
    label: "Oswald Bold",
    script: "latin",
    family: "Oswald Bold",
    file: "Oswald-Bold.ttf",
    capRatio: 0.5,
    widthScale: 0.65,
    note: "Narrow with a news feel. Good for long sentences.",
  },
  {
    id: "rubik-black",
    label: "Rubik Black",
    script: "latin",
    family: "Rubik Black",
    file: "Rubik-Black.ttf",
    capRatio: 0.46,
    widthScale: 1,
    note: "Slightly rounded corners. The same file draws the Arabic list too.",
  },

  // ── Arabic ───────────────────────────────────────────────────────────────
  {
    id: "cairo-black",
    label: "Cairo Black",
    script: "arabic",
    family: "Cairo Black",
    file: "Cairo-Black.ttf",
    capRatio: 0.38,
    widthScale: 1,
    note: "حديث وعريض. الأقرب إلى إحساس Montserrat في الإنجليزية.",
  },
  {
    id: "tajawal-black",
    label: "Tajawal Black",
    script: "arabic",
    family: "Tajawal Black",
    file: "Tajawal-Black.ttf",
    capRatio: 0.44,
    widthScale: 1.25,
    note: "أنعم قليلًا وأوسع. جيّد للجُمل القصيرة.",
  },
  {
    id: "almarai-extrabold",
    label: "Almarai ExtraBold",
    script: "arabic",
    family: "Almarai ExtraBold",
    file: "Almarai-ExtraBold.ttf",
    capRatio: 0.48,
    widthScale: 1.05,
    note: "واضح ومحايد. يقرأ جيّدًا على الشاشات الصغيرة.",
  },
  {
    id: "changa-extrabold",
    label: "Changa ExtraBold",
    script: "arabic",
    family: "Changa ExtraBold",
    file: "Changa-ExtraBold.ttf",
    capRatio: 0.31,
    widthScale: 1.15,
    note: "مضغوط وحادّ. يسع كلمات أكثر في السطر.",
  },
  {
    id: "noto-kufi-black",
    label: "Noto Kufi Arabic Black",
    script: "arabic",
    family: "Noto Kufi Arabic Black",
    file: "Noto-Kufi-Arabic-Black.ttf",
    capRatio: 0.36,
    widthScale: 1.05,
    note: "كوفيّ هندسيّ. الأثقل والأكثر حِدّة في القائمة.",
  },
  {
    id: "alexandria-extrabold",
    label: "Alexandria ExtraBold",
    script: "arabic",
    family: "Alexandria ExtraBold",
    file: "Alexandria-ExtraBold.ttf",
    capRatio: 0.52,
    widthScale: 0.95,
    note: "طويل ومتّزن. أقرب إلى النصوص منه إلى العناوين.",
  },
  {
    /*
      The same file as `rubik-black` above, listed once per script.

      Rubik covers both, and somebody setting captions in both languages wants
      the option of one typeface rather than a pair that nearly match. Two
      entries because the ratios differ — a Latin cap and an Arabic alef are
      different heights in the same font, 0.46 against 0.50 — and one entry
      would size one of the two scripts wrong.
    */
    id: "rubik-black-ar",
    label: "Rubik Black",
    script: "arabic",
    family: "Rubik Black",
    file: "Rubik-Black.ttf",
    capRatio: 0.5,
    widthScale: 1,
    note: "زوايا مستديرة قليلًا. نفس الملفّ يرسم القائمة الإنجليزية أيضًا.",
  },
];

/** What a caption is drawn in when nobody has chosen. */
export const DEFAULT_FACE: Record<FaceScript, string> = {
  latin: "montserrat-black",
  arabic: "cairo-black",
};

export function facesFor(script: FaceScript): CaptionFace[] {
  return CAPTION_FACES.filter((face) => face.script === script);
}

/**
 * A face by id, or the default for that script.
 *
 * Never throws and never returns undefined. An id that no longer exists — a
 * plan saved before a face was removed, a hand-edited request — has to render
 * *something*, and the default is a caption in the wrong font rather than a
 * render that fails at the last step of a job somebody paid minutes for.
 */
export function faceById(id: string | null | undefined, script: FaceScript): CaptionFace {
  const found = CAPTION_FACES.find((face) => face.id === id && face.script === script);
  if (found) return found;
  return CAPTION_FACES.find((face) => face.id === DEFAULT_FACE[script])!;
}

/** Whether an id names a face this deployment actually ships. */
export function isCaptionFace(id: string): boolean {
  return CAPTION_FACES.some((face) => face.id === id);
}
