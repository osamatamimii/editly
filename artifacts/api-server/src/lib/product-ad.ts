/**
 * The advertisement a merchant gets without saying anything.
 *
 * Not a Shopify concept, which is why it does not live in the Shopify folder.
 * A product ad is photographs, a name and a price, and where those three came
 * from — a store's catalogue, or a person dragging files onto a page — is the
 * caller's business and not this file's. The section in the app and the
 * embedded app in Shopify's admin are the same screen with two doors, and this
 * is the part they both end at.
 */
import type { EditOperation, Platform } from "@workspace/api-zod";

/** What an advertisement is made of, however it was gathered. */
export interface ProductAdCopy {
  title: string;
  /** As the merchant would write it: "34.00 USD", "99 ر.س". Never invented. */
  price: string | null;
}

/**
 * The advertisement, as operations.
 *
 * Short and fixed on purpose. This is the plan a merchant gets without saying
 * anything at all, and the first version of a thing chosen for somebody should
 * be the one they can most easily correct — every operation here is one they
 * can name in a sentence afterwards. A twelve-operation plan built from
 * guesses is impressive once and unarguable with.
 *
 * The reel is first because everything else is about the reel. The title opens
 * on the product's own name, which is text the merchant wrote; the price
 * closes, because a price at the end is the ad's ask and a price at the start
 * is a filter. Neither is invented — a product with no price gets no price
 * card rather than a made-up one.
 */
export function planForProductAd(
  ad: ProductAdCopy,
  assetIds: readonly string[],
  options: { platform: Platform; targetSeconds: number },
): EditOperation[] {
  const seconds = options.targetSeconds;
  const operations: EditOperation[] = [
    {
      type: "stillsReel",
      assetIds: [...assetIds],
      targetSeconds: seconds,
      motion: 0.12,
    },
    { type: "formatForPlatform", platform: options.platform },
    {
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
    },
  ];

  if (ad.price) {
    operations.push({
      type: "motionTitle",
      text: ad.price,
      // Held to the last stretch of the reel, and clamped so a short one does
      // not put the price card before the title has left the screen.
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
