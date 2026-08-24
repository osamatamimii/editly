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
  /** Point size for the ASS style, in the frame's own coordinate space. */
  fontSize: number;
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
 * Caption size is a fraction of frame *width*, not a constant.
 *
 * 6.5% of the width is 70 px on a 1080-wide frame, which is the size short-form
 * captions have converged on — big enough to read at arm's length on a phone,
 * small enough that three or four words still fit on a line. Fixing the number
 * instead of the fraction means the same caption is unreadable on a 720p export
 * and absurd on a 4K one.
 */
const FONT_FRACTION_OF_WIDTH = 0.065;

/**
 * Characters per em for a bold sans face. DejaVu Sans Bold averages close to
 * this across mixed-case English; it is an estimate, and the line-break logic
 * treats it as one, which is why cues also have a hard character ceiling.
 */
const AVERAGE_GLYPH_WIDTH = 0.55;

/** Captions taller than this fraction of the frame stop being captions. */
const MAX_CAPTION_BAND = 0.25;

export function captionLayout(
  frame: { width: number; height: number },
  platform: Platform | null | undefined,
): CaptionLayout {
  const safe = safeAreaFor(platform);
  const fontSize = Math.round(frame.width * FONT_FRACTION_OF_WIDTH);

  // Both margins take the rail's width so the block stays centred in the frame
  // rather than centred in the space left over, which would read as crooked.
  // Ceil, not round: rounding down by half a pixel puts the caption back inside
  // the band we just reserved, and every error here should fall outward.
  const sideMargin = Math.ceil(frame.width * Math.max(safe.side, safe.rail));
  const usableWidth = Math.max(frame.width * 0.3, frame.width - sideMargin * 2);

  // Sit the caption just above the platform's furniture, plus a small breath so
  // it does not appear to rest on it.
  const marginV = Math.ceil(frame.height * safe.bottom + fontSize * 0.35);

  const maxCharsPerLine = Math.max(8, Math.floor(usableWidth / (fontSize * AVERAGE_GLYPH_WIDTH)));

  // Line height with the outline is roughly 1.25 em.
  const lineHeight = fontSize * 1.25;
  const maxLines = Math.max(1, Math.min(3, Math.floor((frame.height * MAX_CAPTION_BAND) / lineHeight)));

  return {
    fontSize,
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
  const boxHeight = lines * layout.fontSize * 1.25;
  const boxBottom = layout.marginV;
  const boxTop = boxBottom + boxHeight;

  const bottomForbidden = frame.height * safe.bottom;
  const topForbidden = frame.height * safe.top;

  if (boxBottom < bottomForbidden) return true;
  if (frame.height - boxTop < topForbidden) return true;
  if (layout.marginL < frame.width * safe.side) return true;
  return false;
}
