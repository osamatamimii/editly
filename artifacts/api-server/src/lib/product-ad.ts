/**
 * The advertisement a merchant gets without saying anything.
 *
 * Not a Shopify concept, which is why it does not live in the Shopify folder.
 * A product ad is footage, photographs, a name and a price, and where those
 * came from — a store's catalogue, or a person dragging files onto a page — is
 * the caller's business and not this file's. The section in the app and the
 * embedded app in Shopify's admin are the same screen with two doors, and this
 * is the part they both end at.
 *
 * **Footage first, and that is the correction this file exists in.** The first
 * version of it built a slideshow out of product photographs, because that is
 * what a Shopify catalogue hands you. It is not what a dropshipper has and it
 * is not what a dropshipping advertisement is: they have supplier clips, and
 * clips of somebody holding the thing, and the photographs are what covers the
 * gaps. So when there is footage the footage is the advertisement and the
 * photographs are cutaways over it — and only when there is none at all does
 * this fall back to building a video out of the stills, which is still the
 * right answer for the many catalogue products that have no video.
 */
import type { EditOperation, Platform } from "@workspace/api-zod";

/** What an advertisement says, however it was gathered. */
export interface ProductAdCopy {
  title: string;
  /** As the merchant would write it: "34.00 USD", "99 ر.س". Never invented. */
  price: string | null;
}

/** What an advertisement is made of, in the order the merchant arranged it. */
export interface ProductAdMaterial {
  /**
   * The clips, in upload order. The first is the source; the rest are cut in
   * over it, which is what a second angle is.
   */
  clipIds: readonly string[];
  /** The photographs, in upload order. Cutaways, never the spine. */
  photoIds: readonly string[];
  /**
   * How long the first clip runs, when anybody knows.
   *
   * Null is common and is not a failure: it is what an upload that never got
   * measured looks like. Everything below that depends on it is skipped rather
   * than guessed, because a cut placed at a second that does not exist is a
   * cut placed at zero.
   */
  sourceSeconds: number | null;
}

/** The opening beat, left alone. A cutaway over the hook is an ad nobody watches. */
export const HOOK_SECONDS = 1.2;
/** How long one cutaway holds. Long enough to read, short enough to be a cut. */
export const CUTAWAY_SECONDS = 1.5;
/** And the most of the running time they may take between them. */
export const CUTAWAY_SHARE = 0.4;
/**
 * How much longer than the ad the footage must be before it is cut down.
 *
 * A twenty second clip asked to be a fifteen second ad does not need a
 * highlight chosen out of it; the ends will do. Past this it does, and asking
 * for one on material that did not need it is how a good five seconds gets
 * thrown away.
 */
export const WORTH_CUTTING = 1.4;

/**
 * Where the cutaways land.
 *
 * Spread across the running time rather than stacked at the front, with the
 * hook and the closing beat kept clear: the last stretch is where the price
 * card goes, and a photograph under it is two things asking to be read at once.
 */
export function cutawayPlacements(
  count: number,
  runningSeconds: number,
): { at: number; durationSeconds: number }[] {
  if (count <= 0 || runningSeconds <= 0) return [];

  const tail = CUTAWAY_SECONDS + 0.5;
  const runway = runningSeconds - HOOK_SECONDS - tail;
  if (runway < CUTAWAY_SECONDS) return [];

  // Never more than the share allows, and never more than were offered.
  const room = Math.floor((runningSeconds * CUTAWAY_SHARE) / CUTAWAY_SECONDS);
  const keep = Math.max(0, Math.min(count, room, Math.floor(runway / CUTAWAY_SECONDS)));
  if (keep === 0) return [];

  // Evenly across the runway, each one starting at the top of its own slot, so
  // two cutaways can never overlap however the arithmetic lands.
  const slot = runway / keep;
  return Array.from({ length: keep }, (_, i) => ({
    at: Math.round((HOOK_SECONDS + i * slot) * 100) / 100,
    durationSeconds: CUTAWAY_SECONDS,
  }));
}

/**
 * The advertisement, as operations.
 *
 * Short and fixed on purpose. This is the plan a merchant gets when they have
 * said nothing at all, and the first version of a thing chosen for somebody
 * should be the one they can most easily correct: every operation here is one
 * they can name in a sentence afterwards. A twelve-operation plan built from
 * guesses is impressive once and unarguable with.
 *
 * Whatever they *did* say is merged over this by the caller, through
 * `withDirection`, and wins. So this is the floor, not the ceiling.
 */
export function planForProductAd(
  ad: ProductAdCopy,
  material: ProductAdMaterial,
  options: { platform: Platform; targetSeconds: number },
): EditOperation[] {
  const seconds = options.targetSeconds;
  const operations: EditOperation[] = [];
  const hasFootage = material.clipIds.length > 0;

  if (!hasFootage) {
    /*
      No footage at all, so the photographs have to *be* the video.

      This is the catalogue case, not the dropshipper's: most Shopify products
      carry images and no clip, and a slideshow with movement in it is better
      than telling that merchant we have nothing for them. It is the weaker
      advertisement of the two, and the section in the app says so by refusing
      to build one from photographs alone.
    */
    operations.push({
      type: "stillsReel",
      assetIds: [...material.photoIds],
      targetSeconds: seconds,
      motion: 0.12,
    });
  } else if (
    material.sourceSeconds !== null &&
    material.sourceSeconds > seconds * WORTH_CUTTING
  ) {
    /*
      Long footage, cut down to the length that was asked for.

      A supplier clip is two minutes of a product rotating on a white table.
      Posting it is the commonest way one of these ads dies, and trimming the
      ends is not the same as choosing the good part. `extractHighlight` picks
      the stretch; where there is no transcript to pick it from, the worker says
      so in the notes rather than pretending it chose.
    */
    operations.push({ type: "extractHighlight", targetSeconds: Math.max(5, Math.round(seconds)) });
  }

  operations.push({ type: "formatForPlatform", platform: options.platform });

  /*
    Everything that is not the spine, cut in over it.

    The second and later clips first, then the photographs: another angle of
    the product beats a still of it, and if there is only room for two cutaways
    they should be the two moving ones. All of them are `insertBRoll` with the
    source audio kept, which is what a cutaway is — the picture changes and
    whatever is being said carries on underneath.
  */
  if (hasFootage) {
    const spare = [...material.clipIds.slice(1), ...material.photoIds];
    const running = Math.min(seconds, material.sourceSeconds ?? seconds);
    const places = cutawayPlacements(spare.length, running);
    for (const [index, place] of places.entries()) {
      operations.push({
        type: "insertBRoll",
        assetId: spare[index]!,
        at: place.at,
        durationSeconds: place.durationSeconds,
        // Filling the frame. A product shot letterboxed inside a vertical ad
        // is a picture of a picture.
        fit: "cover",
        keepSourceAudio: true,
      });
    }
  }

  operations.push({
    // Their words. A generated headline is the one thing in this plan that
    // could be wrong about the product itself, and a merchant who reads a
    // sentence they did not write about their own product stops trusting the
    // rest of the video.
    type: "motionTitle",
    text: ad.title.slice(0, 120),
    at: 0.3,
    durationSeconds: 2.5,
    style: "card",
    position: "center",
  });

  if (ad.price) {
    operations.push({
      type: "motionTitle",
      text: ad.price,
      // Held to the last stretch, and clamped so a short ad does not put the
      // price card up before the title has left the screen.
      at: Math.max(3.2, seconds - 3.5),
      durationSeconds: 2.5,
      style: "lower-third",
      position: "bottom",
    });
  }

  // Out of black and back into it. The one operation here that is purely a
  // finish: a hard first frame reads as a video that started already playing.
  operations.push({ type: "fade", durationMs: 400 });

  return operations;
}
