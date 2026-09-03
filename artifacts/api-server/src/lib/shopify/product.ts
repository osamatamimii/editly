/**
 * A product, read as material for an advertisement.
 *
 * Pure: it takes what the Admin API returned and decides what an ad out of it
 * would be made of. No network, no database, no clock — so every rule below is
 * checked against a payload written by hand, which is the only way to test the
 * shapes that matter and are rare in one shop's catalogue.
 *
 * The judgement it makes is small and worth stating: **a product page is
 * already an edit.** The merchant chose which photograph comes first, and it is
 * the one their customers see. Reordering by resolution or by "which looks most
 * like a hero shot" would be this file overruling the only person who has seen
 * the product, and it is the commonest way these tools produce something the
 * merchant does not recognise.
 */

/**
 * How many photographs are worth downloading.
 *
 * The reel keeps twelve at a fifteen-second target and drops the rest, so
 * fetching forty would be forty downloads to use twelve of them — paid for in
 * a request the merchant is waiting on. Bounded here rather than at the reel,
 * where the arithmetic would already have been spent.
 */
export const MAX_IMAGES = 12;

/**
 * The only hosts this server will fetch a product image from.
 *
 * The URLs come from Shopify's own API, which is the argument for trusting
 * them and not the argument for skipping this check: the next line of code
 * downloads whatever they say, from a server that sits inside our
 * infrastructure and holds our credentials. A media URL is a value in a JSON
 * response, and a value in a JSON response is not a promise about where it
 * points.
 */
const ALLOWED_HOSTS = [".shopify.com", ".shopifycdn.com"];

export function isAllowedMediaUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  return ALLOWED_HOSTS.some((suffix) => url.hostname.endsWith(suffix));
}

/**
 * The width to ask the CDN for.
 *
 * Shopify's CDN resizes on request, so this is the difference between fetching
 * a twelve-megapixel original and fetching what the reel will actually use.
 * 1600 is above the tallest frame the product renders (1080x1920 cropped from
 * a 2x working image is 2160 wide at the extreme, and a still that needs more
 * than 1600 is one `fitFor` is about to pad rather than enlarge).
 */
const REQUEST_WIDTH = 1600;

function boundedUrl(raw: string): string {
  const url = new URL(raw);
  url.searchParams.set("width", String(REQUEST_WIDTH));
  return url.toString();
}

export interface ProductImage {
  url: string;
  width: number;
  height: number;
  alt: string | null;
}

export interface ProductAd {
  title: string;
  images: ProductImage[];
  /** "24.00 USD", or null when the product has no price to show. */
  price: string | null;
  /**
   * Videos the product has and this does not use yet.
   *
   * Counted rather than ignored, because "your product has a video and we made
   * a slideshow out of your photos instead" is a thing the merchant must be
   * told. A supplier's clip is usually the best asset on the page.
   */
  videos: number;
  /** Media that is neither: 3D models, embedded YouTube. Also counted. */
  otherMedia: number;
}

/** Everything this reads out of the Admin API's `product` node. */
export function readProduct(node: unknown): ProductAd | null {
  if (!node || typeof node !== "object") return null;
  const product = node as Record<string, unknown>;
  const title = typeof product["title"] === "string" ? product["title"].trim() : "";
  const media = (product["media"] as { nodes?: unknown[] } | undefined)?.nodes ?? [];

  const images: ProductImage[] = [];
  let videos = 0;
  let otherMedia = 0;

  for (const entry of Array.isArray(media) ? media : []) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const kind = item["mediaContentType"];

    if (kind === "IMAGE") {
      const image = item["image"] as Record<string, unknown> | undefined;
      const url = image?.["url"];
      // A media row whose file is still processing has no URL yet, and that is
      // a normal state rather than an error: Shopify transcodes and the row
      // appears first. Skipped silently — it is not missing, it is early.
      if (!isAllowedMediaUrl(url)) continue;
      if (images.length >= MAX_IMAGES) continue;
      images.push({
        url: boundedUrl(url),
        width: typeof image?.["width"] === "number" ? image["width"] : 0,
        height: typeof image?.["height"] === "number" ? image["height"] : 0,
        alt: typeof item["alt"] === "string" && item["alt"].trim() ? item["alt"].trim() : null,
      });
      continue;
    }

    if (kind === "VIDEO") videos += 1;
    else otherMedia += 1;
  }

  if (images.length === 0) return null;

  return { title: title || "Your product", images, price: priceOf(product), videos, otherMedia };
}

function priceOf(product: Record<string, unknown>): string | null {
  const range = product["priceRangeV2"] as Record<string, unknown> | undefined;
  const min = range?.["minVariantPrice"] as Record<string, unknown> | undefined;
  const amount = min?.["amount"];
  const currency = min?.["currencyCode"];
  if (typeof amount !== "string" && typeof amount !== "number") return null;
  const asNumber = Number(amount);
  if (!Number.isFinite(asNumber) || asNumber <= 0) return null;
  return typeof currency === "string" && currency ? `${asNumber.toFixed(2)} ${currency}` : asNumber.toFixed(2);
}
