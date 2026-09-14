/**
 * Compositions, written as layers.
 *
 * `drawLayers` carries a scene rather than naming a look, which is what makes
 * it able to draw things nobody wrote code for. That generality is the point
 * and it is also a problem for a keyword matcher: a regular expression cannot
 * invent a composition.
 *
 * So this file is the small bridge between the two. A sentence somebody
 * plausibly types — "put a card for each section" — becomes a named
 * composition here, and the composition is expressed in the same layer
 * language a model will one day emit directly. When that model arrives it
 * replaces this file's callers and not the language underneath it.
 *
 * ## Every number here was measured
 *
 * Off r04, frame by frame, because the first version of this card was built
 * from a written description and was wrong in five ways at once — name under
 * the icon rather than behind it, pill tucked against the icon, pill colours
 * inverted, shadow straight down, group centred. It looked fine and it looked
 * like a different product.
 *
 *   ground            RGB(236,236,236), sampled corner and centre
 *   ink               31.6%-64.0% of frame height, so the mass sits high
 *   coloured icon     23.2% of frame width, square, centred at 49.7% of height
 *   pill              33% of width, centred at 65.5%, RGB(164,164,164)
 *
 * The overlap — the icon covering the bottom quarter of the letters — is the
 * whole look: it is the difference between two layered objects and a list.
 */
import type { SceneLayer } from "@workspace/api-zod";

/** Ground, ink and pill, straight off the reference's frames. */
const GROUND = "#ECECEC";
const INK = "#111111";
const PILL = "#A4A4A4";

const ICON_SHARE = 0.232;
const ICON_FILLS_CASE = 0.9;
const CASE_CENTRE = 0.497;
const NAME_BASELINE = 0.46;
const PILL_CENTRE = 0.655;

/**
 * A colour for a card that has no logo.
 *
 * The reference's cards live off their icons. A grey letter on a white tile
 * has the right geometry and none of the life, so the placeholder takes a hue
 * from the name itself: same name, same colour, every render, with no table of
 * brands to maintain and no network call to make.
 *
 * Honestly a placeholder — it is not pretending to be anybody's logo — but a
 * *coloured object*, which is what the composition needs to read correctly.
 */
export function tintFor(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) % 360;
  return `hsl(${hash} 62% 58%)`;
}

export interface CardOptions {
  name: string;
  /** The line in the pill. Often what the speaker is saying right then. */
  note?: string;
  at: number;
  durationSeconds: number;
  /** The frame's shape, which decides how tall a square icon is. */
  aspect: number;
}

/**
 * The interstitial card, as the six layers it is made of.
 *
 * A hard cut in and out — no dissolve, which the reference never does and
 * which is the easiest single way to make this read as a slideshow. The icon
 * drops and settles; the name and the note fade up behind and below it, on a
 * stagger, so nothing arrives at once.
 */
export function interstitialCard(options: CardOptions): SceneLayer[] {
  const { name, note, at, durationSeconds: dur, aspect } = options;

  /*
    A square icon, expressed in two axes.

    `ICON_SHARE` is a fraction of the frame's *width*; the same square is a
    different fraction of its height, and `aspect` is what converts one to the
    other. Using one number for both gives a squashed icon on every shape but
    1:1 — and none of the shapes this product exports is 1:1.
  */
  const caseW = ICON_SHARE / ICON_FILLS_CASE;
  const caseH = caseW * aspect;
  const iconW = ICON_SHARE;
  const iconH = iconW * aspect;

  const gap = Math.min(0.11, (dur * 0.5) / 2);

  return [
    { box: { x: 0, y: 0, w: 1, h: 1 }, content: { kind: "fill", color: GROUND },
      at, durationSeconds: dur, enter: "fade", z: 0 },

    // Behind the icon, not above it. Source order decides nothing here — `z`
    // does — and this is the layer the icon has to paint over.
    { box: { x: 0.04, y: NAME_BASELINE - 0.1, w: 0.92, h: 0.11 },
      content: { kind: "text", runs: [{ text: name }], size: 0.072, color: INK, weight: 800 },
      at: at + gap, durationSeconds: Math.max(0.2, dur - gap), enter: "fade", z: 1 },

    // The white case, and the coloured tile inside it.
    { box: { x: 0.5 - caseW / 2, y: CASE_CENTRE - caseH / 2, w: caseW, h: caseH },
      content: { kind: "fill", color: "#ffffff" },
      at, durationSeconds: dur, enter: "drop", travel: 0.045, from: 0.86, radius: 0.235, shadow: 3, z: 2 },
    { box: { x: 0.5 - iconW / 2, y: CASE_CENTRE - iconH / 2, w: iconW, h: iconH },
      content: { kind: "fill", color: tintFor(name) },
      at, durationSeconds: dur, enter: "drop", travel: 0.045, from: 0.86, radius: 0.2, z: 3 },
    { box: { x: 0.5 - iconW / 2, y: CASE_CENTRE - iconH / 2, w: iconW, h: iconH },
      content: { kind: "text", runs: [{ text: [...name.trim()][0] ?? "" }], size: iconH * 0.5, color: "#ffffff", weight: 800 },
      at, durationSeconds: dur, enter: "drop", travel: 0.045, from: 0.86, z: 4 },

    ...(note
      ? [{
          box: { x: 0.25, y: PILL_CENTRE - 0.024, w: 0.5, h: 0.048 },
          content: {
            kind: "text" as const,
            runs: [{ text: note, background: PILL }],
            size: 0.021,
            color: "#ffffff",
            weight: 700,
          },
          at: at + gap * 2,
          durationSeconds: Math.max(0.2, dur - gap * 2),
          enter: "fade" as const,
          z: 5,
        }]
      : []),
  ];
}
