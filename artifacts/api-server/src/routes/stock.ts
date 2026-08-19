/**
 * Searching the stock library, and getting one file out of it.
 *
 * The download is a proxy rather than a redirect, for two reasons that both
 * come down to the browser. A redirect would put a pexels.com URL in front of
 * an ad blocker, and a `fetch` of a third-party host would depend on their
 * CORS headers, which are not ours to promise. Streaming through here makes it
 * a same-origin request that behaves like every other one in the app.
 *
 * It is a *stream*, not a buffer: a 40MB clip read into memory on a serverless
 * function is how you turn a feature into an out-of-memory kill.
 */
import { Router, type IRouter } from "express";
import { Readable } from "node:stream";
import { stockConfigured, searchStock, resolveStockFile, resolveStockPreview } from "../lib/stock";
import { rateLimit, LIMITS } from "../lib/rate-limit";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/** Enough to fill a grid, few enough that one search is one upstream call. */
const RESULTS_PER_PAGE = 24;

/**
 * A ceiling on what we will pass through.
 *
 * `pickVideoFile` already prefers ≤1080p, so this is not the normal path; it
 * is the guard for the day Pexels returns something unexpected. Without it a
 * single request could stream unbounded bytes through the function.
 */
const MAX_FILE_BYTES = 200 * 1024 * 1024;

const NOT_CONFIGURED =
  "The stock library is not switched on for this deployment yet. Adding a Pexels key turns it on.";

router.get("/stock/search", rateLimit(LIMITS.write), async (req, res): Promise<void> => {
  if (!stockConfigured) {
    // 503 rather than 404 or an empty list: "we have not set this up" and
    // "there are no photos of cats" are different answers, and a silent empty
    // grid sends the customer looking for a bug in their search terms.
    res.status(503).json({ error: NOT_CONFIGURED });
    return;
  }

  const query = String(req.query["q"] ?? "").trim();
  const kind = req.query["kind"] === "video" ? "video" : "image";
  if (query.length < 2 || query.length > 100) {
    res.status(400).json({ error: "Search for something between two and a hundred characters." });
    return;
  }

  try {
    const items = await searchStock(query, kind, RESULTS_PER_PAGE);
    res.json({ items });
  } catch (error) {
    logger.warn({ err: String(error) }, "stock search failed");
    res.status(502).json({ error: error instanceof Error ? error.message : "Stock search failed." });
  }
});

/**
 * Everything the download route does, for the small rendition instead.
 *
 * Kept as its own path rather than a query parameter on the download so that
 * "what is streamed" is decided by the URL and not by something a caller can
 * flip — and so a preview can be cached for an hour while a download is not
 * cached at all.
 */
async function streamStock(
  req: import("express").Request,
  res: import("express").Response,
  resolve: (id: string) => Promise<{
    url: URL;
    contentType: string;
    kind: "image" | "video";
    label: string;
    width: number;
    height: number;
    durationSeconds: number | null;
  }>,
  cacheControl: string,
): Promise<void> {
  if (!stockConfigured) {
    res.status(503).json({ error: NOT_CONFIGURED });
    return;
  }

  let resolved;
  try {
    // The id is parsed before anything is fetched, so a malformed one costs a
    // regex rather than a round trip.
    resolved = await resolve(String(req.params["id"]));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unknown stock item." });
    return;
  }

  let upstream: Response;
  try {
    upstream = await fetch(resolved.url, { signal: AbortSignal.timeout(60_000) });
  } catch (error) {
    logger.warn({ err: String(error) }, "stock fetch failed");
    res.status(502).json({ error: "Could not fetch that file from the stock library." });
    return;
  }

  if (!upstream.ok || !upstream.body) {
    res.status(502).json({ error: "The stock library refused that file." });
    return;
  }

  const declared = Number(upstream.headers.get("content-length") ?? 0);
  if (declared > MAX_FILE_BYTES) {
    res.status(413).json({ error: "That file is larger than we will pass through." });
    return;
  }

  res.setHeader("Content-Type", resolved.contentType);
  res.setHeader("Cache-Control", cacheControl);
  // Everything the caller needs to register the asset afterwards, without a
  // second round trip and without the caller inventing any of it.
  res.setHeader("X-Stock-Kind", resolved.kind);
  res.setHeader("X-Stock-Label", encodeURIComponent(resolved.label));
  res.setHeader("X-Stock-Width", String(resolved.width));
  res.setHeader("X-Stock-Height", String(resolved.height));
  res.setHeader("X-Stock-Duration", resolved.durationSeconds === null ? "" : String(resolved.durationSeconds));
  // Browsers only see headers they are told they may see.
  res.setHeader(
    "Access-Control-Expose-Headers",
    "X-Stock-Kind, X-Stock-Label, X-Stock-Width, X-Stock-Height, X-Stock-Duration",
  );
  if (declared > 0) res.setHeader("Content-Length", String(declared));

  // A declared length can lie, so the cap is also enforced on the way through.
  let seen = 0;
  const source = Readable.fromWeb(upstream.body as never);
  source.on("data", (chunk: Buffer) => {
    seen += chunk.length;
    if (seen > MAX_FILE_BYTES) source.destroy(new Error("stock file exceeded the cap"));
  });
  source.on("error", (error) => {
    logger.warn({ err: String(error) }, "stock stream aborted");
    if (!res.headersSent) res.status(502).end();
    else res.destroy();
  });
  source.pipe(res);
}

/**
 * The clip somebody is looking at before they decide.
 *
 * Same origin as everything else: no dependency on a third party's CORS or
 * uptime, and nothing for a blocker to remove. Cached for an hour, because a
 * preview someone scrolls back to should not be fetched twice.
 *
 * It does not make an undecodable clip decodable — a browser without H.264
 * plays neither the provider's copy nor ours, and the panel says so rather than
 * spinning.
 */
router.get("/stock/preview/:id", rateLimit(LIMITS.write), async (req, res): Promise<void> => {
  await streamStock(req, res, resolveStockPreview, "private, max-age=3600");
});

router.get("/stock/file/:id", rateLimit(LIMITS.write), async (req, res): Promise<void> => {
  await streamStock(req, res, resolveStockFile, "private, max-age=300");
});

export default router;
