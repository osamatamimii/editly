/**
 * Where a caption is allowed to sit.
 *
 * Every one of these platforms draws its own furniture over the video after we
 * hand it over: an action rail down the right, the creator's own caption and
 * hashtags across the bottom, a music ticker, a progress bar. None of it is in
 * our frame, all of it is on top of our frame, and a caption placed without
 * accounting for it is simply invisible to half the audience.
 *
 * This is the least glamorous file in the project and one of the highest
 * leverage. A caption engine can have perfect timing, perfect line breaks and a
 * beautiful wipe, and still be worthless because the last line sits under the
 * username. The old style row put captions 180 px from the bottom of a 1920 px
 * frame — comfortably inside TikTok's bottom furniture, which runs to about
 * 250. Everything below is the correction.
 *
 * The numbers are the platforms' published safe areas for a 1080x1920 frame,
 * expressed as fractions so they hold at any size. They are deliberately the
 * conservative reading: being 3% further from an edge than strictly necessary
 * costs nothing, and being 3% too close costs the caption.
 */
import type { Platform } from "@workspace/api-zod";
import { faceById, type CaptionFace } from "@workspace/api-zod/fonts";
export type { CaptionFace };

export interface SafeArea {
  /** Fraction of frame height reserved at the top. */
  top: number;
  /** Fraction of frame height reserved at the bottom — the expensive one. */
  bottom: number;
  /** Fraction of frame width reserved at each side. */
  side: number;
  /**
   * Fraction of frame width taken by the action rail. Captions are centred, so
   * this is applied to *both* sides to keep the block centred and clear of it.
   */
  rail: number;
}

/**
 * TikTok: ~130 px top, ~250 px bottom, ~60 px sides on 1080x1920, and the right
 * third is where the like/comment/share stack and the follow button live.
 * Instagram Reels reserves more at the bottom (~320 px) because its caption
 * sheet is taller. Shorts is the mildest — its guidance is to keep text out of
 * the bottom 10-15% for the progress bar and captions.
 */
const SAFE_AREAS: Record<Platform, SafeArea> = {
  tiktok: { top: 0.068, bottom: 0.13, side: 0.056, rail: 0.16 },
  reels: { top: 0.056, bottom: 0.167, side: 0.056, rail: 0.15 },
  shorts: { top: 0.05, bottom: 0.15, side: 0.056, rail: 0.13 },
  // The two shapes that are not vertical feeds have no side rail at all —
  // nothing stacks a like/comment/share column down the right of a YouTube
  // player or a square post. Inheriting the vertical rail would push every
  // caption a sixth of the frame left of centre for no reason. What YouTube
  // does reserve is the bottom strip its progress bar and controls sit over.
  youtube: { top: 0.05, bottom: 0.1, side: 0.05, rail: 0 },
  square: { top: 0.05, bottom: 0.08, side: 0.05, rail: 0 },
};

/** When no platform is named, the strictest of the three keeps us safe everywhere. */
const UNIVERSAL: SafeArea = { top: 0.068, bottom: 0.167, side: 0.056, rail: 0.16 };

export function safeAreaFor(platform: Platform | null | undefined): SafeArea {
  return platform ? (SAFE_AREAS[platform] ?? UNIVERSAL) : UNIVERSAL;
}

export interface CaptionLayout {
  /**
   * Nominal ASS size for the Latin face, in the frame's own coordinate space.
   *
   * Kept because a style row needs one and the harness reads it, but it is a
   * *derived* number now: `capHeight` is what the layout decides, and each face
   * converts it to its own nominal size through `nominalSizeFor`.
   */
  fontSize: number;
  /**
   * The height of a capital letter, in pixels. This is the thing the layout
   * actually controls, and the thing a person sees.
   */
  capHeight: number;
  marginL: number;
  marginR: number;
  /** Distance from the bottom edge, for bottom-centred alignment. */
  marginV: number;
  /** 2 is bottom-centre in ASS. */
  alignment: number;
  /** Width the text may occupy, after both margins. */
  usableWidth: number;
  /** How many characters fit on one line at this size and width. */
  maxCharsPerLine: number;
  /** Lines a cue may use before it would climb into the picture. */
  maxLines: number;
}

/**
 * The faces a caption is drawn in, and what they actually measure.
 *
 * The captions in this product were drawn in DejaVu Sans for its whole life,
 * which is not a choice — it is the font a Debian image happens to have. It is
 * a perfectly good text face and it reads, on a phone, over a moving picture,
 * as *unstyled*. Nobody files a bug about it. It is the exact shape of failure
 * this codebase keeps finding: the render succeeds, the words are right, the
 * timing is right, and the result looks like a default.
 *
 * Montserrat Black is the face short-form captions converged on — geometric,
 * heavy, wide-apertured, legible at a glance and at a thumb's distance. That
 * part is taste. The numbers below are not.
 *
 * ## Why a ratio, and why it is measured
 *
 * `Fontsize` in ASS is the **line height**, not the em size, and the fraction
 * of it a capital letter actually occupies is a property of the face. DejaVu
 * Sans draws a capital at 0.65 of it; Montserrat Black draws one at 0.54. So
 * swapping the family name and keeping the number would have shrunk every
 * caption by 17% — silently, because the file still renders, the words still
 * fit, and the only symptom is that the captions look a bit small.
 *
 * Both numbers were measured the only way that means anything: rendered
 * through libass at a known size and the drawn pixels counted. A font's own
 * OS/2 table would have been a claim about how it was built; ink on a frame is
 * a fact about what it does. The Dockerfile makes the same argument twice.
 */
/* `CaptionFace` now comes from the shared catalogue, above. It used to be
   declared here with two fields, which was the right shape while there were
   exactly two faces and nobody could choose. */

/**
 * The pair of faces one render draws with, resolved from the plan.
 *
 * There is a face per *script*, not per render, because one caption track can
 * carry both: a sentence of Arabic followed by an English product name is one
 * person's video, and libass would fall back per glyph on its own — correctly
 * shaped, and at the fallback face's own proportions against a nominal size
 * chosen for a different one. Naming both is how the two come out the same
 * height.
 *
 * The catalogue itself is in `@workspace/api-zod/fonts`, shared with the API
 * and the picker, because the family name and the ratio have to be the same
 * three places or the thing that renders is not the thing that was chosen.
 */
export interface FacePair {
  latin: CaptionFace;
  arabic: CaptionFace;
}

/**
 * A stored row as the renderer's catalogue sees it.
 *
 * Here, and not beside the code that fetches it, because everything in that
 * file reaches Storage — and this is arithmetic on six fields that a suite
 * should be able to check without credentials. The type is structural for the
 * same reason: the shape is the contract, not the table.
 *
 * The three numbers are already measured; this only renames the columns. The
 * fallbacks exist because a `ready` row without them would be a bug elsewhere
 * and a division by zero here, and captions at a plausible size beat a render
 * that throws in its last step.
 */
export function asCaptionFace(row: {
  id: string;
  label: string;
  declared: string | null;
  script: string;
  family: string | null;
  capRatio: number | null;
  widthScale: number | null;
}): CaptionFace {
  return {
    id: row.id,
    label: row.label,
    script: row.script === "arabic" ? "arabic" : "latin",
    family: row.family ?? "",
    file: `${row.id}.ttf`,
    capRatio: row.capRatio ?? 0.45,
    widthScale: row.widthScale ?? 1,
    note: row.declared ?? "",
  };
}

export function facePair(
  chosen?: { latin?: string | null; arabic?: string | null },
  /**
   * Faces this person uploaded, resolved and measured by the caller.
   *
   * Optional, and the default is the thirteen we ship. An id that names
   * nothing in either list falls back rather than throwing — see `faceById`:
   * a plan saved before a font was deleted has to render *something*, and a
   * caption in the wrong face beats a job that fails at its last step after
   * somebody paid minutes for it.
   */
  extra?: readonly CaptionFace[],
): FacePair {
  return {
    latin: faceById(chosen?.latin, "latin", extra),
    arabic: faceById(chosen?.arabic, "arabic", extra),
  };
}

/** The pair a render gets when the plan names none. */
export const DEFAULT_FACES: FacePair = facePair();

/**
 * Kept for the layout's own arithmetic and for the suites that read it.
 *
 * It used to be the whole story — a hardcoded object with one Latin face and
 * one Arabic one — and it is now a view of the default pair. Every caller that
 * needs a *chosen* face takes a `CaptionFace` instead.
 */
export const CAPTION_FACES = DEFAULT_FACES;

/**
 * Caption size is a fraction of frame *width*, not a constant.
 *
 * 6.5% of the frame's **short side** is 70 px on a 1080×1920 frame, which is the
 * size short-form captions have converged on — big enough to read at arm's
 * length on a phone, small enough that three or four words still fit on a line.
 * Fixing the number instead of the fraction means the same caption is
 * unreadable on a 720p export and absurd on a 4K one.
 *
 * The short side, not the width, and that is the whole of a bug this file used
 * to have. Read against the width it is right for a vertical frame, where the
 * width *is* the short side — and on a 1920×1080 export the same fraction gives
 * a 125 px face, 11.6% of the frame's height. The caption band is a quarter of
 * the height, so exactly one line of that fits, and `wrapToLayout` truncated
 * every cue to its first line with an ellipsis. The words were already grouped
 * three lines deep by then, so roughly two thirds of every caption on every
 * widescreen export was thrown away, and the note said `burned 42 captions`.
 *
 * Against the short side the caption is the same physical size relative to the
 * frame in all three shapes, which is what "6.5%" was always meant to mean.
 * Vertical and square are unchanged — their short side is their width.
 *
 * ## And it is a fraction of the *capital letter*, not of the nominal size
 *
 * Written as `0.065 * 0.65` rather than as `0.04225`, because those are two
 * different facts and one of them is about to change again. 6.5% is the
 * decision: how big a caption should look. 0.65 is DejaVu Sans's cap ratio —
 * the face the 6.5% was tuned against, so multiplying the two says "whatever
 * this looked like before, keep looking like that" in a form that survives the
 * next font. Collapsing them into one decimal would have thrown away which
 * half was taste and which half was a measurement of a font nobody draws
 * captions in any more.
 */
const CAP_FRACTION_OF_SHORT_SIDE = 0.065 * 0.65;

/**
 * How wide each character is, in cap heights.
 *
 * Measured from the two caption faces' own metrics and merged by taking the
 * **wider** of the two per character, so the estimate always falls outward.
 * They agree closely — `M` is 1.363 caps in Montserrat Black and 1.365 in
 * DejaVu Sans — which is why one table can serve both, and rounded up to the
 * nearest 0.02 so it stays reviewable.
 *
 * ## Why a table and not an average
 *
 * There was an average, 0.85, and the average is right: the sample sentence
 * below measures 0.851 across it. The trouble is that `W` is 1.74 and `i` is
 * 0.48, a factor of three and a half, so a line of shouting fits half the
 * characters a line of ordinary speech does. Against one average, A LINE LIKE
 * THIS was planned at eighteen characters and drew off both edges of the
 * frame.
 *
 * That did not show, because libass was quietly rescuing it — and the rescue
 * was itself the bug this table exists to let us turn off. See `WrapStyle` in
 * `writeSubtitleFile`.
 */
const ADVANCE_IN_CAPS: Array<[number, string]> = [
  [0.42, "'"],
  [0.48, " ijl"],
  [0.52, "I|"],
  [0.54, ",."],
  [0.56, ":;"],
  [0.58, "-"],
  [0.62, "f"],
  [0.64, "!()/[\\]"],
  [0.66, "t"],
  [0.68, "r"],
  [0.72, "\"*_"],
  [0.82, "Jsz"],
  [0.86, "`"],
  [0.88, "?c"],
  [0.90, "L"],
  [0.92, "vy"],
  [0.94, "FTaex"],
  [0.96, "$1235679"],
  [0.98, "8Eo{}"],
  [1.0, "0SZbpqu"],
  [1.02, "4Ydghkn"],
  [1.08, "CPR"],
  [1.1, "KX"],
  [1.12, "B"],
  [1.14, "GUV"],
  [1.16, "#+<=>AHN^~"],
  [1.18, "D"],
  [1.2, "&"],
  [1.22, "OQ"],
  [1.38, "%M"],
  [1.4, "w"],
  [1.5, "@m"],
  [1.74, "W"],

  /*
    And Arabic, measured the same way off the same face.

    These letters used to fall through to `fallbackAdvance`'s single 0.8, which
    was a fair average of DejaVu and is a bad average of anything: س and ش are
    1.42 and ا is 0.48, three times narrower. One number for a script whose
    letters differ by 3x either wraps a line of alefs and lams a third early or
    lets a line of seens run past the safe area, and neither of those fails.

    The measurement is what a letter costs *in running text*, not in isolation:
    each was rendered ten times and twenty times and the difference divided,
    which cancels the side bearings and gives the joined width — the only width
    Arabic ever actually occupies.

    The combining marks are 0.0 because they are: a fatha rides on the letter
    before it and takes no width of its own. Counting them as characters is how
    a vowelled line wraps half way across the frame.
  */
  [0.0, "ًٌٍَُِّْ"],
  [0.38, "،"],
  [0.4, "؛"],
  [0.48, "اآ٠"],
  [0.5, "أإ"],
  [0.52, "رز"],
  [0.54, "بلنىئ١"],
  [0.64, "٤"],
  [0.66, "؟"],
  [0.7, "تثي"],
  [0.72, "دذ"],
  [0.78, "٦"],
  [0.8, "٢"],
  [0.84, "ء٩"],
  [0.86, "وؤ"],
  [0.9, "جحخ"],
  [0.92, "ة"],
  [0.96, "فق٧٨"],
  [0.98, "عغ"],
  [1.0, "مه"],
  [1.02, "ك٥"],
  [1.14, "٣"],
  [1.18, "طظ"],
  [1.28, "صض"],
  [1.42, "سش"],
];

const ADVANCE = new Map<string, number>();
for (const [width, chars] of ADVANCE_IN_CAPS) {
  for (const ch of chars) ADVANCE.set(ch, width);
}

/**
 * What a character costs when it is not one of the 95 above.
 *
 * Three numbers, because one would be wrong for two of the three. All measured
 * the same way — rendered through libass and the drawn pixels counted — and
 * each rounded up from what came back.
 *
 * Arabic is now in the table above, letter by letter, so this catches only
 * what is left of the range: presentation forms, Hebrew, Syriac, Thaana, and
 * the letters of the extended Arabic blocks. 0.95 rather than the old 0.8,
 * because 0.8 was an average of DejaVu and the face is Cairo now, whose seen
 * and sheen are 1.42 — an average that runs a line past the safe area does not
 * fail, it just puts the last words under the username.
 *
 * CJK is the opposite: one character is a full square, 1.22 caps measured.
 *
 * Everything else — Cyrillic, Greek, accented Latin — behaves like Latin, and
 * takes a number a little above Latin's own average.
 */
function fallbackAdvance(codePoint: number): number {
  const ch = String.fromCodePoint(codePoint);
  // A combining mark stacks on the letter before it and takes no width of its
  // own: the harakat, the superscript alef, a combining madda. Counted as 0.95
  // each, a vocalised Arabic line measured far wider than it draws and wrapped
  // early — every short vowel a whole cap of phantom width. They draw no
  // advance, so they cost none.
  if (/\p{M}/u.test(ch)) return 0;
  // Emoji draw about half again as wide as a Latin cap: 1.47 measured, against
  // the 1.05 the default returned. Under-measuring is the dangerous way to be
  // wrong — a line of emoji ran past the safe area and sat under the username —
  // so the emoji blocks get the number the pixels gave.
  if (codePoint >= 0x1f000 && /\p{Extended_Pictographic}/u.test(ch)) return 1.47;
  // Arabic, Hebrew, Syriac, Thaana, and the Arabic presentation forms.
  if (
    (codePoint >= 0x0590 && codePoint <= 0x08ff) ||
    (codePoint >= 0xfb1d && codePoint <= 0xfdff) ||
    (codePoint >= 0xfe70 && codePoint <= 0xfeff)
  ) {
    return 0.95;
  }
  // CJK, kana, Hangul, and the full-width forms.
  if (
    (codePoint >= 0x1100 && codePoint <= 0x11ff) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60)
  ) {
    return 1.3;
  }
  return 1.05;
}

/**
 * Break a line into the lines it will actually occupy.
 *
 * One greedy pass, and it lives here rather than in the wrapper because two
 * different steps need the answer and they must not compute it differently.
 * `wrapToLayout` breaks a cue onto lines with it; `buildCaptionCues` decides
 * how many words a cue may hold by asking how many lines they would take.
 *
 * That used to be a character budget — lineLength × lines — which sounds
 * equivalent and is not, because greedy line-filling leaves room at the end of
 * every line. A cue whose text measures exactly three lines' worth of width
 * lands on four, the fourth is over the limit, and it is truncated with an
 * ellipsis. The words are simply gone, and nothing anywhere says two estimates
 * disagreed about the same sentence.
 */
export function linesFor(text: string, widthInCapsAllowed: number, widthScale = 1): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    /*
      A token wider than the whole line has nowhere to be put whole.

      This loop assumed every word fits on a line of its own, because in
      ordinary prose it does. A URL, a sixty-five-character compound, a wall of
      hashtags with no spaces in it — each of those was pushed onto a line by
      itself and drawn straight past both edges of the frame: measured at 1080
      px in the 734 the safe area allows. And nothing rescues it downstream:
      the subtitle format is written with `WrapStyle: 2`, which means libass
      does no wrapping of its own, so what this function returns is exactly
      what gets drawn.

      Broken rather than dropped, and only when it cannot fit alone. Every
      character survives; what changes is that it survives inside the picture.
    */
    for (const piece of fitOnALine(word, widthInCapsAllowed, widthScale)) {
      const candidate = line ? `${line} ${piece}` : piece;
      if (line && widthInCaps(candidate, widthScale) > widthInCapsAllowed) {
        lines.push(line);
        line = piece;
      } else {
        line = candidate;
      }
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * One token, cut into pieces that each fit a line.
 *
 * Returns the token untouched — one piece — whenever it already fits, which is
 * every word in ordinary text, so this costs a width measurement and nothing
 * else on the path that matters.
 *
 * Cut on grapheme clusters rather than on code units, because a cut inside a
 * surrogate pair or between a letter and its combining mark is a replacement
 * glyph on somebody's video. Arabic is unaffected in practice — a single
 * Arabic word wider than a whole caption line does not occur — but the same
 * rule protects it if one ever does.
 */
export function fitOnALine(token: string, widthInCapsAllowed: number, widthScale = 1): string[] {
  if (widthInCapsAllowed <= 0) return [token];
  if (widthInCaps(token, widthScale) <= widthInCapsAllowed) return [token];

  const graphemes =
    typeof Intl !== "undefined" && "Segmenter" in Intl
      ? [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(token)].map((s) => s.segment)
      : [...token];

  const pieces: string[] = [];
  let piece = "";
  for (const glyph of graphemes) {
    const candidate = piece + glyph;
    if (piece && widthInCaps(candidate, widthScale) > widthInCapsAllowed) {
      pieces.push(piece);
      piece = glyph;
    } else {
      piece = candidate;
    }
  }
  if (piece) pieces.push(piece);
  return pieces;
}

/**
 * The same break, made even.
 *
 * `linesFor` is greedy: it fills each line to the last word that fits. That is
 * the right way to *find* how many lines a caption needs and the wrong shape to
 * draw — it produces a full line over a short one, which on a centred caption
 * block reads as ragged rather than as typeset. Rendered, an ordinary sentence
 * came out as
 *
 *     This is the part
 *     nobody ever tells you
 *
 * with the two lines a third apart in width. Every caption in the product had
 * that shape, and nothing about it fails: the words are all there, inside the
 * safe area, correctly timed.
 *
 * The even break is the narrowest allowance that still fits in the same number
 * of lines, found by bisection over the width and re-using the greedy wrapper
 * rather than a second breaking algorithm that could disagree with it. Same
 * words, same order, same line count — so it cannot introduce an overflow or
 * an extra line, which is what makes it safe to apply to every caption.
 */
export function balancedLines(text: string, widthInCapsAllowed: number, widthScale = 1): string[] {
  const greedy = linesFor(text, widthInCapsAllowed, widthScale);
  if (greedy.length < 2) return greedy;

  // The widest single word is a hard floor: no allowance below it can produce
  // this many lines, and bisecting past it would loop.
  const longestWord = Math.max(
    ...text.split(/\s+/).filter(Boolean).map((word) => widthInCaps(word, widthScale)),
  );

  /*
    Except when that word is wider than the line it has to sit on — a URL, a
    hashtag, a German compound. Then the floor is above the ceiling, every
    midpoint of the bisection is *wider* than the allowance, and the block it
    settles on is the one that fits that wider width: drawn past both edges of
    the frame, with nothing raised anywhere. The wrapper breaks such a word
    now, so no allowance is unreachable and the floor is only an optimisation;
    holding it under the allowance is what keeps it from becoming a licence to
    overflow.
  */
  let low = Math.min(longestWord, widthInCapsAllowed);
  let high = widthInCapsAllowed;
  let best = greedy;
  // Twenty halvings takes the interval to a millionth of its width, which is
  // far below one glyph. A fixed count rather than a convergence test, because
  // a loop that decides when to stop is a loop that can decide not to.
  for (let step = 0; step < 20; step += 1) {
    const middle = (low + high) / 2;
    const attempt = linesFor(text, middle, widthScale);
    if (attempt.length <= greedy.length) {
      best = attempt;
      high = middle;
    } else {
      low = middle;
    }
  }
  return best;
}

/** How wide this string draws, in cap heights. */
export function widthInCaps(text: string, widthScale = 1): number {
  let total = 0;
  for (const ch of text) {
    // Bidi isolates and other formatting characters draw nothing. They are in
    // the string because the renderer puts them there, and counting them would
    // break a line early for characters with no ink.
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x2068 || cp === 0x2069 || (cp >= 0x200b && cp <= 0x200f)) continue;
    total += ADVANCE.get(ch) ?? fallbackAdvance(cp);
  }
  /*
    And the face's own width.

    The table above is one face per script — Montserrat Black and Cairo Black,
    the two it was measured from. Anton and Bebas Neue run at 0.6 of
    Montserrat's width per unit of height and Archivo Black at 1.05, so a
    single table with no scale wraps a condensed caption a third early (nothing
    fails; the words move to another line) or runs a wide one past the
    platform's safe area (nothing fails; the last word sits under the
    username). Rounded up in the catalogue, because those two errors do not
    cost the same.
  */
  return total * widthScale;
}

/**
 * Average advance width as a multiple of **cap height**, not of the nominal
 * size — because that is the number the two faces agree on.
 *
 * Measured off rendered frames: DejaVu Sans runs 0.79 of its cap for
 * mixed-case English and 0.92 for upper-case; Montserrat Black runs 0.78 and
 * 0.92. That near-identity is what makes the font swap safe. Sizing by cap
 * height makes Montserrat's nominal size 20% larger, and its glyphs are
 * correspondingly narrower, so the two cancel and every line breaks in the
 * same place it did before. Had the ratio been expressed against nominal size
 * instead, the swap would have moved every line break in the product.
 *
 * It is still an estimate — libass rewraps what does not fit — which is why
 * cues also have a hard character ceiling.
 */
const ADVANCE_PER_CAP = 0.85;

/** Captions taller than this fraction of the frame stop being captions. */
const MAX_CAPTION_BAND = 0.25;

/**
 * Ink above and below the baseline on one line, as a fraction of nominal size.
 * Measured: DejaVu 0.85, Montserrat Black 0.75. The larger is used, so the
 * estimate falls outward — the direction every error in this file falls.
 */
const CAP_PLUS_DESCENDER = 0.85;

/** The outline width `ffmpeg.ts` puts in every caption style row. */
const OUTLINE_PX = 5;

/**
 * The height a caption block of this many lines actually occupies.
 *
 * `Fontsize` in ASS *is* the line step — measured, at three lines, in both
 * faces: the baselines land exactly one nominal size apart. So a block is
 * (lines − 1) steps, plus one line's worth of ink, plus the outline on both
 * edges.
 *
 * What was here before was `lines * fontSize * 1.25`, and the 1.25 was doing
 * two jobs badly: it stood in for the step *and* for the ink, and it
 * over-counted a three-line block by about 28%. Nothing failed — a caption
 * that would have fitted was simply refused a third line and truncated with an
 * ellipsis, on the shapes where the band is tightest. The words were thrown
 * away by an estimate, which is the same bug this file was written to fix,
 * one layer up.
 */
export function captionBlockHeight(layout: CaptionLayout, lines: number): number {
  return (lines - 1) * layout.fontSize + CAP_PLUS_DESCENDER * layout.fontSize + OUTLINE_PX * 2;
}

/** The nominal ASS size that draws this layout's cap height in a given face. */
export function nominalSizeFor(face: CaptionFace, layout: CaptionLayout): number {
  return Math.round(layout.capHeight / face.capRatio);
}

export function captionLayout(
  frame: { width: number; height: number },
  platform: Platform | null | undefined,
): CaptionLayout {
  const safe = safeAreaFor(platform);
  const capHeight = Math.min(frame.width, frame.height) * CAP_FRACTION_OF_SHORT_SIDE;
  const fontSize = Math.round(capHeight / DEFAULT_FACES.latin.capRatio);

  // Both margins take the rail's width so the block stays centred in the frame
  // rather than centred in the space left over, which would read as crooked.
  // Ceil, not round: rounding down by half a pixel puts the caption back inside
  // the band we just reserved, and every error here should fall outward.
  const sideMargin = Math.ceil(frame.width * Math.max(safe.side, safe.rail));
  const usableWidth = Math.max(frame.width * 0.3, frame.width - sideMargin * 2);

  // Sit the caption just above the platform's furniture, plus a small breath so
  // it does not appear to rest on it.
  const marginV = Math.ceil(frame.height * safe.bottom + capHeight * 0.54);

  const maxCharsPerLine = Math.max(8, Math.floor(usableWidth / (capHeight * ADVANCE_PER_CAP)));

  const band = frame.height * MAX_CAPTION_BAND;
  const fits = (lines: number) =>
    captionBlockHeight({ fontSize } as CaptionLayout, lines) <= band;
  let maxLines = 1;
  while (maxLines < 3 && fits(maxLines + 1)) maxLines += 1;

  return {
    fontSize,
    capHeight,
    marginL: sideMargin,
    marginR: sideMargin,
    marginV,
    alignment: 2,
    usableWidth: Math.round(usableWidth),
    maxCharsPerLine,
    maxLines,
  };
}

/**
 * True when a caption box of this height would collide with the platform's
 * furniture. Used by the quality harness: a layout that passes its own maths
 * but fails this has a bug in the maths.
 */
export function collidesWithFurniture(
  layout: CaptionLayout,
  frame: { width: number; height: number },
  platform: Platform | null | undefined,
  lines: number,
): boolean {
  const safe = safeAreaFor(platform);
  const boxHeight = captionBlockHeight(layout, lines);
  const boxBottom = layout.marginV;
  const boxTop = boxBottom + boxHeight;

  const bottomForbidden = frame.height * safe.bottom;
  const topForbidden = frame.height * safe.top;

  if (boxBottom < bottomForbidden) return true;
  if (frame.height - boxTop < topForbidden) return true;
  if (layout.marginL < frame.width * safe.side) return true;
  return false;
}
