/**
 * Stock footage and photography, from Pexels.
 *
 * Two rules shape this file, and both are about not trusting a URL.
 *
 * **The client never names a file.** It names an *id*, and we ask Pexels what
 * that id resolves to. The alternative — accepting a URL from the browser and
 * fetching it — is a server-side request forgery: our process sits inside the
 * deployment's network and would happily fetch a cloud metadata endpoint, an
 * internal service, or a redirect chain that ends at one. An id cannot express
 * any of that.
 *
 * **And even Pexels' answer is checked.** `assertAllowedHost` runs on the URL
 * that came back, because "the third party said so" is not a security
 * boundary; a compromised or misconfigured upstream that returned an internal
 * address would otherwise be obeyed.
 *
 * The key lives only here. It is never sent to the browser, and the browser
 * never talks to Pexels — which also means no dependency on a third party's
 * CORS headers, and no way for an ad blocker to break the feature by blocking
 * a domain it has never heard of.
 */
import { logger } from "./logger";

const API_KEY = process.env["PEXELS_API_KEY"]?.trim();

export const stockConfigured = Boolean(API_KEY);

/**
 * Where bytes are allowed to come from.
 *
 * Pexels serves media from a handful of hosts. An exact-suffix match on the
 * registrable domain, not `includes`, because `pexels.com.attacker.net` passes
 * a substring test and is not Pexels.
 */
const ALLOWED_HOSTS = ["pexels.com", "images.pexels.com", "videos.pexels.com", "player.vimeo.com"];

export function assertAllowedHost(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("The stock provider returned something that is not a URL.");
  }
  if (url.protocol !== "https:") {
    throw new Error("Stock media must be served over HTTPS.");
  }
  const host = url.hostname.toLowerCase();
  const ok = ALLOWED_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  if (!ok) {
    throw new Error("The stock provider pointed somewhere we do not fetch from.");
  }
  return url;
}

export interface StockItem {
  /** "photo:123" or "video:456". Namespaced because the two id spaces overlap. */
  id: string;
  kind: "image" | "video";
  /** Shown under the thumbnail, and kept as the asset's label. */
  label: string;
  /** A small image, safe to put in a grid. Videos get their poster frame. */
  previewUrl: string;
  /**
   * A bigger still, for looking at one properly before committing to it.
   *
   * These two are provider URLs rather than proxied, unlike the download. The
   * download is proxied because it is the file that ends up in someone's
   * project and its size is ours to control; a preview is a thumbnail on a
   * public CDN, and pushing megabytes of "maybe" through a serverless function
   * so that a person can glance at a clip is a cost with nothing on the other
   * side of it.
   */
  viewUrl: string;
  /**
   * Whether there is something to play. The bytes come from our own preview
   * route, never from a URL in this object — see `resolveStockPreview`.
   */
  playable: boolean;
  width: number;
  height: number;
  durationSeconds: number | null;
  /** Pexels asks that the photographer be credited. So we carry it. */
  credit: string;
  creditUrl: string;
}

/** Ids are ours, not theirs: "photo:123". Parsing one is also validating it. */
export function parseStockId(id: string): { kind: "photo" | "video"; numericId: string } {
  const match = /^(photo|video):([0-9]{1,15})$/.exec(id);
  if (!match) throw new Error("That is not a stock id.");
  return { kind: match[1] as "photo" | "video", numericId: match[2]! };
}

async function pexels(path: string): Promise<any> {
  if (!API_KEY) throw new Error("Stock search is not configured.");
  const response = await fetch(`https://api.pexels.com${path}`, {
    headers: { Authorization: API_KEY },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 429) {
    throw new Error("The stock library is rate limiting us. Try again in a minute.");
  }
  if (!response.ok) {
    logger.warn({ status: response.status, path }, "pexels request failed");
    throw new Error("The stock library did not answer.");
  }
  return await response.json();
}

function photoToItem(photo: any): StockItem {
  return {
    id: `photo:${photo.id}`,
    kind: "image",
    label: String(photo.alt || "Photo").slice(0, 120),
    previewUrl: String(photo.src?.medium ?? photo.src?.small ?? ""),
    viewUrl: String(photo.src?.large ?? photo.src?.medium ?? ""),
    playable: false,
    width: Number(photo.width) || 0,
    height: Number(photo.height) || 0,
    durationSeconds: null,
    credit: String(photo.photographer ?? "Pexels"),
    creditUrl: String(photo.photographer_url ?? "https://www.pexels.com"),
  };
}

/** The smallest playable rendition, for deciding rather than for keeping. */
function smallestPlayable(files: any[]): { url: string; contentType: string } | null {
  const mp4s = (files ?? []).filter((f) => String(f.file_type ?? "").includes("mp4") && f.link);
  if (mp4s.length === 0) return null;
  const smallest = mp4s.reduce((a, b) =>
    (Number(b.height) || Infinity) < (Number(a.height) || Infinity) ? b : a,
  );
  return { url: String(smallest.link), contentType: String(smallest.file_type ?? "video/mp4") };
}

function videoToItem(video: any): StockItem {
  return {
    id: `video:${video.id}`,
    kind: "video",
    label: String(video.user?.name ? `Clip by ${video.user.name}` : "Clip").slice(0, 120),
    previewUrl: String(video.image ?? ""),
    viewUrl: String(video.image ?? ""),
    playable: smallestPlayable(video.video_files) !== null,
    width: Number(video.width) || 0,
    height: Number(video.height) || 0,
    durationSeconds: Number(video.duration) || null,
    credit: String(video.user?.name ?? "Pexels"),
    creditUrl: String(video.user?.url ?? "https://www.pexels.com"),
  };
}

export async function searchStock(
  query: string,
  kind: "image" | "video",
  perPage: number,
): Promise<StockItem[]> {
  const q = encodeURIComponent(query);
  if (kind === "image") {
    const data = await pexels(`/v1/search?query=${q}&per_page=${perPage}`);
    return (data.photos ?? []).map(photoToItem).filter((i: StockItem) => i.previewUrl);
  }
  const data = await pexels(`/videos/search?query=${q}&per_page=${perPage}`);
  return (data.videos ?? []).map(videoToItem).filter((i: StockItem) => i.previewUrl);
}

/**
 * Which rendition to actually download.
 *
 * Not the biggest one available. A 4K stock clip is hundreds of megabytes and
 * every frame of it is thrown away by a 1080p timeline — it would cost the
 * customer upload time, cost us storage, and slow the render down for no
 * visible difference. So: the largest file that is still at or under 1080p,
 * and only then the smallest thing available as a fallback.
 */
function pickVideoFile(files: any[]): {
  url: string;
  contentType: string;
  width: number;
  height: number;
} {
  const mp4s = files.filter((f) => String(f.file_type ?? "").includes("mp4") && f.link);
  const usable = mp4s.length > 0 ? mp4s : files.filter((f) => f.link);
  if (usable.length === 0) throw new Error("That clip has no downloadable file.");
  const withinBudget = usable.filter((f) => (Number(f.height) || 0) <= 1080);
  const pool = withinBudget.length > 0 ? withinBudget : usable;
  const best = pool.reduce((a, b) => ((Number(b.height) || 0) > (Number(a.height) || 0) ? b : a));
  return {
    url: String(best.link),
    contentType: String(best.file_type ?? "video/mp4"),
    // The rendition's own size, not the parent clip's. They differ — a 4K entry
    // lists 3840x2160 while the file we actually download is 1920x1080 — and
    // recording the number we did not fetch is how a library ends up describing
    // files it does not hold.
    width: Number(best.width) || 0,
    height: Number(best.height) || 0,
  };
}

/**
 * The size of the image we actually download.
 *
 * Pexels reports the original's dimensions on the search result — often 6000px
 * wide — while `large2x` is a resized copy whose real size is spelled out in
 * its own query string. Recording 6000 for a file that is 1880 wide is a small
 * lie that becomes a real one the moment anything scales against it.
 */
function sizeFromSrcUrl(url: string, fallbackWidth: number, fallbackHeight: number): {
  width: number;
  height: number;
} {
  try {
    const params = new URL(url).searchParams;
    const width = Number(params.get("w"));
    const height = Number(params.get("h"));
    if (width > 0 && height > 0) return { width, height };
    // Only the width is given: keep the original's aspect ratio.
    if (width > 0 && fallbackWidth > 0 && fallbackHeight > 0) {
      return { width, height: Math.round((width * fallbackHeight) / fallbackWidth) };
    }
  } catch {
    // Not a URL we can read. Fall through to what the listing said.
  }
  return { width: fallbackWidth, height: fallbackHeight };
}

export interface ResolvedStockFile {
  url: URL;
  contentType: string;
  kind: "image" | "video";
  /** What the asset should be called once it is in the project. */
  label: string;
  width: number;
  height: number;
  durationSeconds: number | null;
}

/**
 * The clip to play while somebody is deciding — through us, like everything else.
 *
 * This began as a direct `videos.pexels.com` URL on the theory that a preview is
 * only a thumbnail. It is not: on the first browser we tried it in, the request
 * was black-holed. No error, no `onerror`, `readyState` stuck at 0 and a video
 * element that simply never started — the same silent failure the checkout
 * widget had, from the same cause, a third-party domain a blocker had never
 * heard of. Still images from `images.pexels.com` loaded fine in that same
 * browser, which is exactly what makes the failure so hard to guess at from the
 * code.
 *
 * So the rule that already governs the download governs this too: if it has to
 * work, it comes from our origin. It is still the *smallest* rendition — a
 * decision does not need 1080p — so the cost of the guarantee is a few hundred
 * kilobytes.
 */
export async function resolveStockPreview(id: string): Promise<ResolvedStockFile> {
  const { kind, numericId } = parseStockId(id);

  if (kind === "photo") {
    const photo = await pexels(`/v1/photos/${numericId}`);
    const item = photoToItem(photo);
    const url = String(photo.src?.large ?? photo.src?.medium ?? "");
    const size = sizeFromSrcUrl(url, item.width, item.height);
    return {
      url: assertAllowedHost(url),
      contentType: "image/jpeg",
      kind: "image",
      label: item.label,
      width: size.width,
      height: size.height,
      durationSeconds: null,
    };
  }

  const video = await pexels(`/videos/videos/${numericId}`);
  const item = videoToItem(video);
  const smallest = smallestPlayable(video.video_files);
  if (!smallest) throw new Error("That clip has nothing small enough to preview.");
  return {
    url: assertAllowedHost(smallest.url),
    contentType: smallest.contentType,
    kind: "video",
    label: item.label,
    width: 0,
    height: 0,
    durationSeconds: item.durationSeconds,
  };
}

export async function resolveStockFile(id: string): Promise<ResolvedStockFile> {
  const { kind, numericId } = parseStockId(id);

  if (kind === "photo") {
    const photo = await pexels(`/v1/photos/${numericId}`);
    const item = photoToItem(photo);
    // `large2x` is roughly 1880px wide — more than any 1080p composition needs
    // and small enough to upload over a phone connection.
    const url = String(photo.src?.large2x ?? photo.src?.large ?? photo.src?.original ?? "");
    const size = sizeFromSrcUrl(url, item.width, item.height);
    return {
      url: assertAllowedHost(url),
      contentType: "image/jpeg",
      kind: "image",
      label: `${item.label} — ${item.credit} / Pexels`.slice(0, 160),
      width: size.width,
      height: size.height,
      durationSeconds: null,
    };
  }

  const video = await pexels(`/videos/videos/${numericId}`);
  const item = videoToItem(video);
  const file = pickVideoFile(video.video_files ?? []);
  return {
    url: assertAllowedHost(file.url),
    contentType: file.contentType,
    kind: "video",
    label: `${item.label} — Pexels`.slice(0, 160),
    width: file.width || item.width,
    height: file.height || item.height,
    durationSeconds: item.durationSeconds,
  };
}
