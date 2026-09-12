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
    /*
      The one plain grotesque in the catalogue, at a real bold.

      Every other row here is Black or ExtraBold, which is the loud short-form
      look and is most of what this product makes. The `glow` style is not that:
      the light around the letters does the separating, so the letters
      themselves want a clean 700 rather than a 900 that closes its own
      counters under a halo.

      It was a 300 first, matched to the reference's own weight, and that was
      wrong twice over: «الخط مش بولد فشكله سيء», and without a shadow a light
      face has nothing to hold a bright frame with. 700 fixes both.

      The file already carries the weight, so the style asks libass for
      `Bold: 0`. A synthesised bold on top of a real one is a smear, and it is
      the same mistake in the other direction.
    */
    id: "inter-bold",
    label: "Inter Bold",
    script: "latin",
    family: "Inter Bold",
    file: "Inter-Bold.ttf",
    capRatio: 0.55,
    widthScale: 0.9,
    note: "A plain grotesque at a real bold. For the look where the glow does the work.",
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
    /*
      Latin only, and the reason written here was wrong.

      Rubik covers both scripts, so it was added to both lists — and then a real
      Arabic *word* rendered a box where لا should be. The conclusion drawn at
      the time, and written here for months, was that the font has no lam-alef
      ligature glyph for plain alef at all, and that this was "not a cmap
      problem and not fixable by one".

      Both halves are false, measured. Rubik's GSUB carries the ligature twice
      over — `uniFEDF+uniFE8E → uniFEFB` for the isolated pair and
      `uniFEE0+uniFE8E → uniFEFC` for the final one — and it is precisely a cmap
      problem, because FriBidi asks for U+FEFB by codepoint and no modern font
      puts those codepoints in its cmap. Filling them in is the whole job of
      `facerepair.py`, and its lam-alef lookup had never once succeeded: it
      searched under the base glyph names, `uni0644+uni0627`, which not one font
      on this machine keys it by. With that fixed, Rubik draws لا.

      So the box was ours. The rebuilt `Rubik-Black.ttf` (this repair's
      output: 125 presentation forms filled, U+FEFB/FEFC among them) now ships,
      and the Arabic row lives at the end of the Arabic list with numbers
      measured through libass — 0.5 and 0.9, exactly the estimate this note
      used to carry, but measured rather than copied. The brief (تكليف ٠١ هـ)
      is what made the call. Its Arabic is complete: all 28 letters, every
      hamza form, the harakat, the Arabic-Indic digits and the punctuation;
      what it lacks against Cairo is thirteen Urdu and Persian letters, which
      are not Arabic.

      The lesson the old note drew is still right, and worth keeping: the checks
      at the time drew isolated letters and measured heights, and Rubik passed
      every one of them. Drawing one real word is what found it.
    */
    note: "Slightly rounded corners, and a touch narrower than Montserrat.",
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
    /*
      Arabic's half of that pair, and the same face as `cairo-black` at a
      different weight rather than a different family: two weights of one face
      sit beside each other, where two families have to be judged against each
      other every time a line mixes scripts.

      The 700 instance was missing 36 isolated presentation forms that the
      black one has. `make-caption-faces.py` filled them; without that, every
      letter standing alone in an Arabic caption would have come from whatever
      other Arabic font the machine happened to have.
    */
    id: "cairo-bold",
    label: "Cairo Bold",
    script: "arabic",
    family: "Cairo Bold",
    file: "Cairo-Bold.ttf",
    capRatio: 0.4,
    widthScale: 0.95,
    note: "Cairo at a bold. The Arabic half of the glow look.",
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
  /*
    The second row over Rubik's one file — the gap the long note above closes.

    The rebuilt `Rubik-Black.ttf` carries the repaired cmap (125 presentation
    forms filled, lam-alef's U+FEFB/FEFC among them), so the face finally
    draws لا and earns its Arabic listing. The numbers are measured through
    libass exactly as `tools/font-test.mjs` measures them, not copied from
    the estimate: alef ink 50px at nominal 100 → capRatio 0.5; per-cap width
    0.881 of Cairo's baseline → declared 0.9, rounded up per the one-sided
    rule (a scale too small runs past the safe area; too large costs only a
    line break).
  */
  {
    id: "rubik-black-arabic",
    label: "Rubik Black عربي",
    script: "arabic",
    family: "Rubik Black",
    file: "Rubik-Black.ttf",
    capRatio: 0.5,
    widthScale: 0.9,
    note: "مستدير الزوايا ولاتيني الروح. عربيّته كاملة الحروف بعد إصلاح الخريطة.",
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
 * The faces a particular render or picker may choose from: the ones we ship,
 * plus the ones this person uploaded.
 *
 * Uploaded faces come *after*, so a person cannot shadow a shipped id by
 * uploading a font and naming it `montserrat-black`. Ids for uploaded faces
 * are generated, so this cannot happen today; the order is what makes it still
 * true the day somebody lets a person choose one.
 */
export function facesWith(extra: readonly CaptionFace[] | undefined): readonly CaptionFace[] {
  if (!extra || extra.length === 0) return CAPTION_FACES;
  const shipped = new Set(CAPTION_FACES.map((face) => face.id));
  return [...CAPTION_FACES, ...extra.filter((face) => !shipped.has(face.id))];
}

/**
 * A face by id, or the default for that script.
 *
 * Never throws and never returns undefined. An id that no longer exists — a
 * plan saved before a face was removed, a hand-edited request — has to render
 * *something*, and the default is a caption in the wrong font rather than a
 * render that fails at the last step of a job somebody paid minutes for.
 */
export function faceById(
  id: string | null | undefined,
  script: FaceScript,
  extra?: readonly CaptionFace[],
): CaptionFace {
  const found = facesWith(extra).find((face) => face.id === id && face.script === script);
  if (found) return found;
  return CAPTION_FACES.find((face) => face.id === DEFAULT_FACE[script])!;
}

/** Whether an id names a face this deployment actually ships. */
export function isCaptionFace(id: string, extra?: readonly CaptionFace[]): boolean {
  return facesWith(extra).some((face) => face.id === id);
}
