/**
 * The picture a project has before it has a picture.
 *
 * A project card shows a poster once one exists. Before that — a fresh
 * project, a clip the browser will not decode, a poster that failed to fetch —
 * the card was a black rectangle with a grey camera icon in the middle of it,
 * three across, and a library of them is the least appealing screen in the
 * product. It is also the screen somebody sees most often.
 *
 * So a project without a poster gets art of its own instead of an absence.
 *
 * Two rules make this worth having rather than decoration:
 *
 * **It belongs to the project.** The hue comes from the project's id, so a
 * given project looks the same on every device, on every visit, forever, and
 * you learn to find it by colour in a grid the way you find a book by its
 * spine. A random gradient would be prettier once and useless.
 *
 * **It costs nothing.** Layered CSS gradients, no canvas, no image, no
 * network. Twelve of these on a dashboard add no bytes and no frames — which
 * matters, because the thing they replace was chosen partly for being cheap.
 */

/**
 * A hue from an id.
 *
 * FNV-1a rather than a sum of char codes: consecutive uuids differ in one
 * character, and a sum maps them to adjacent hues — a dashboard of projects
 * made the same afternoon would come out as six shades of the same orange.
 */
function hueOf(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 360;
}

/**
 * How far the second and third stops travel around the wheel.
 *
 * Also from the seed, so the art varies in more than hue — every card being
 * the same gradient in a different colour is a pattern you notice by the
 * fourth one.
 */
function spreadOf(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = seed.length - 1; i >= 0; i--) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return 28 + (hash % 46);
}

export function ProjectArt({ seed, className = "" }: { seed: string; className?: string }) {
  const hue = hueOf(seed);
  const spread = spreadOf(seed);
  const h2 = (hue + spread) % 360;
  const h3 = (hue + spread * 2) % 360;

  return (
    <div
      className={`absolute inset-0 ${className}`}
      aria-hidden="true"
      data-testid="project-art"
      style={{
        backgroundColor: `hsl(${hue} 78% 56%)`,
        backgroundImage: [
          // The folds. Concentric rings of white at a very low alpha, off
          // centre, which is what turns a flat gradient into something that
          // looks like a surface catching light.
          `repeating-radial-gradient(circle at 18% 112%, rgba(255,255,255,0.16) 0 6%, rgba(255,255,255,0) 6% 13%)`,
          // A second set, rotated by being anchored elsewhere, so the folds
          // cross rather than ring.
          `repeating-radial-gradient(circle at 96% -18%, rgba(0,0,0,0.10) 0 7%, rgba(0,0,0,0) 7% 15%)`,
          // The colour itself, three stops across the diagonal.
          `linear-gradient(135deg, hsl(${hue} 82% 62%) 0%, hsl(${h2} 84% 55%) 48%, hsl(${h3} 76% 58%) 100%)`,
        ].join(", "),
      }}
    />
  );
}
