/**
 * Stock footage and photography, searched from inside the project.
 *
 * The bytes come through our own API rather than from the provider's CDN, and
 * that is not indirection for its own sake: a `fetch` of a third-party host
 * depends on their CORS headers, which are not ours to promise, and a
 * third-party domain is exactly what an ad blocker removes without telling
 * anyone. Same-origin, it behaves like every other request in the app.
 *
 * What lands in the project is an ordinary asset. There is no "stock" kind and
 * nothing downstream knows where a file came from — a clip added here is cut
 * in as b-roll by the same operation as a clip the customer filmed.
 */
import { useEffect, useRef, useState } from "react";
import { Loader2, Search, ImageIcon, Film, X, Plus } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { uploadProjectAsset } from "@/lib/video-storage";
import { playbackVerdict, PREVIEW_CEILING_MS, PLAYBACK_POLL_MS } from "@/lib/playability";

export interface StockItem {
  id: string;
  kind: "image" | "video";
  label: string;
  previewUrl: string;
  /** A bigger still, for the preview. */
  viewUrl: string;
  /** Whether there is something to play. The bytes come from our own route. */
  playable: boolean;
  width: number;
  height: number;
  durationSeconds: number | null;
  credit: string;
  creditUrl: string;
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** A name for the object in storage. The server's label is the human one. */
function fileNameFor(id: string, contentType: string): string {
  const extension = contentType.includes("mp4")
    ? "mp4"
    : contentType.includes("png")
      ? "png"
      : contentType.includes("webp")
        ? "webp"
        : contentType.startsWith("video/")
          ? "mp4"
          : "jpg";
  return `${id.replace(":", "-")}.${extension}`;
}

export function StockSearch({
  projectId,
  userId,
  onAdded,
}: {
  projectId: string;
  userId: string;
  onAdded: () => void | Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"image" | "video">("video");
  const [items, setItems] = useState<StockItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  /**
   * The one being looked at.
   *
   * Clicking a tile used to add it. That is the wrong default for a grid of
   * near-identical thumbnails: a poster frame says almost nothing about how a
   * clip moves, and adding is a download, an upload and a row — expensive to
   * undo for something you only wanted to see. So a click opens it, and adding
   * is a separate, deliberate press.
   */
  const [previewing, setPreviewing] = useState<StockItem | null>(null);
  /**
   * The playable clip, fetched through our API and held as an object URL.
   *
   * A `<video>` cannot carry an Authorization header, so the bytes are fetched
   * and handed to the element rather than pointed at. That is also why this is
   * the *small* rendition: the whole thing arrives before the first frame
   * plays, and the poster covers the wait.
   */
  const [clipUrl, setClipUrl] = useState<string | null>(null);
  const [clipLoading, setClipLoading] = useState(false);
  /**
   * Whether the clip we fetched will actually decode here.
   *
   * Not every browser can play H.264 — the editor already says so about
   * people's own uploads, in those words — and a decoder that cannot is not
   * loud about it: the element sits at readyState 0, networkState "loading",
   * with no error to read, from a *local* blob. So the same verdict the editor
   * uses is applied here, on a much shorter clock, and the poster frame takes
   * over when it gives up.
   */
  const [clipVerdict, setClipVerdict] = useState<"pending" | "playable" | "failed">("pending");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Distinct from an error: nothing is broken, the key is simply not set. */
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  useEffect(() => {
    if (!previewing || !previewing.playable) {
      setClipUrl(null);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    setClipLoading(true);
    setClipVerdict("pending");
    void (async () => {
      try {
        const res = await fetch(`/api/stock/preview/${encodeURIComponent(previewing.id)}`, {
          headers: await authHeaders(),
        });
        if (!res.ok) throw new Error("preview unavailable");
        const blob = await res.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setClipUrl(objectUrl);
      } catch {
        // The poster frame is still there, and it is a preview — a failure
        // here must not become an error message about someone's project.
        if (!cancelled) setClipUrl(null);
      } finally {
        if (!cancelled) setClipLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      // Revoked on the way out: a grid someone browses for a minute would
      // otherwise hold every clip they glanced at in memory.
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [previewing]);

  useEffect(() => {
    if (!clipUrl) return;
    const startedAt = Date.now();
    const tick = (): void => {
      const el = videoRef.current;
      setClipVerdict(
        playbackVerdict(
          el ? { readyState: el.readyState, networkState: el.networkState, error: el.error } : null,
          Date.now() - startedAt,
          PREVIEW_CEILING_MS,
        ),
      );
    };
    tick();
    const timer = window.setInterval(tick, PLAYBACK_POLL_MS);
    return () => window.clearInterval(timer);
  }, [clipUrl]);

  async function search(): Promise<void> {
    const q = query.trim();
    if (q.length < 2) return;
    setSearching(true);
    setError(null);
    try {
      const res = await fetch(`/api/stock/search?q=${encodeURIComponent(q)}&kind=${kind}`, {
        headers: await authHeaders(),
      });
      const body = (await res.json().catch(() => ({}))) as { items?: StockItem[]; error?: string };
      if (res.status === 503) {
        setUnavailable(body.error ?? "The stock library is not switched on yet.");
        setItems([]);
        return;
      }
      if (!res.ok) throw new Error(body.error ?? "That search did not work.");
      setUnavailable(null);
      setPreviewing(null);
      setItems(body.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That search did not work.");
    } finally {
      setSearching(false);
      setSearched(true);
    }
  }

  async function add(item: StockItem): Promise<void> {
    setAdding(item.id);
    setError(null);
    try {
      const res = await fetch(`/api/stock/file/${encodeURIComponent(item.id)}`, {
        headers: await authHeaders(),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not fetch that file.");
      }
      const blob = await res.blob();
      const contentType = res.headers.get("content-type") ?? blob.type;
      // The label carries the credit the provider asks us to keep, and it comes
      // from the server rather than from this component, so it is the same
      // string whatever added it.
      const label = decodeURIComponent(res.headers.get("x-stock-label") ?? item.label);
      // The dimensions of the file that arrived, not of the original the search
      // result described. Pexels lists a 6000px original and serves a 1880px
      // copy; recording the number we did not download is a library describing
      // files it does not hold.
      const servedWidth = Number(res.headers.get("x-stock-width")) || item.width;
      const servedHeight = Number(res.headers.get("x-stock-height")) || item.height;
      const servedDuration = Number(res.headers.get("x-stock-duration")) || item.durationSeconds;
      const file = new File([blob], fileNameFor(item.id, contentType), { type: contentType });

      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("Your session expired. Sign in again.");

      const { path, kind: storedKind } = await uploadProjectAsset({
        file,
        userId,
        projectId,
        accessToken: token,
      });
      const registered = await fetch(`/api/projects/${projectId}/assets`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await authHeaders()) },
        body: JSON.stringify({
          path,
          kind: storedKind,
          label,
          bytes: file.size,
          ...(servedWidth ? { width: servedWidth } : {}),
          ...(servedHeight ? { height: servedHeight } : {}),
          ...(servedDuration ? { durationSeconds: servedDuration } : {}),
        }),
      });
      if (!registered.ok) {
        const body = (await registered.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not add that to the project.");
      }
      await onAdded();
      setPreviewing(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add that to the project.");
    } finally {
      setAdding(null);
    }
  }

  return (
    <div className="mt-4 border-t border-hairline-faint pt-4" data-testid="stock-search">
      <div className="text-sm font-medium">Or find something</div>
      <div className="text-xs text-muted-foreground">
        Free stock clips and photos, added to this project like any other file.
      </div>

      <div className="mt-3 flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void search();
            }}
            placeholder="city at night, coffee, desk…"
            data-testid="input-stock-query"
            className="w-full h-11 md:h-auto rounded-lg border border-hairline bg-surface-1 pl-8 pr-3 md:py-2 text-base md:text-xs outline-none focus:border-primary/40"
          />
        </div>
        <div className="flex rounded-lg border border-hairline overflow-hidden">
          {(["video", "image"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              data-testid={`button-stock-${k}`}
              className={`px-2.5 min-h-11 md:min-h-0 md:py-2 flex items-center justify-center text-xs transition-colors ${
                kind === k ? "bg-primary/15 text-primary" : "bg-surface-1 text-muted-foreground"
              }`}
              aria-pressed={kind === k}
            >
              {k === "video" ? <Film className="w-3.5 h-3.5" /> : <ImageIcon className="w-3.5 h-3.5" />}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => void search()}
          disabled={searching || query.trim().length < 2}
          data-testid="button-stock-search"
          className="rounded-lg border border-hairline bg-surface-1 px-3 min-h-11 md:min-h-0 md:py-2 text-xs font-medium transition-all hover:border-primary/40 disabled:opacity-50"
        >
          {searching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Search"}
        </button>
      </div>

      {unavailable && (
        <div
          className="mt-3 rounded-lg border border-hairline bg-surface-1 px-3 py-2 text-xs text-muted-foreground"
          data-testid="stock-unavailable"
        >
          {unavailable}
        </div>
      )}

      {error && (
        <div
          className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs"
          role="alert"
        >
          {error}
        </div>
      )}

      {previewing && (
        <div
          className="mt-3 rounded-xl border border-hairline bg-surface-1 p-3"
          data-testid="stock-preview"
        >
          <div className="relative w-full overflow-hidden rounded-lg bg-black">
            {previewing.kind === "video" && clipUrl && clipVerdict !== "failed" ? (
              // Muted and looping on purpose: this is a silent judgement about
              // movement, and a grid that starts shouting is a grid people close.
              <video
                key={previewing.id}
                ref={videoRef}
                src={clipUrl}
                poster={previewing.previewUrl}
                controls
                autoPlay
                muted
                loop
                playsInline
                data-testid="stock-preview-video"
                className="w-full max-h-64 object-contain"
              />
            ) : (
              <img
                key={previewing.id}
                src={previewing.viewUrl || previewing.previewUrl}
                data-loading={previewing.kind === "video" && clipLoading ? "true" : undefined}
                alt={previewing.label}
                data-testid="stock-preview-image"
                className="w-full max-h-64 object-contain"
              />
            )}
            {previewing.kind === "video" && clipVerdict === "failed" && (
              <span
                className="absolute inset-x-0 bottom-0 bg-black/70 px-2 py-1.5 text-[10px] text-white"
                data-testid="stock-preview-unplayable"
              >
                This clip will not play in this browser — some codecs just cannot be
                previewed here. It will still cut into your video normally.
              </span>
            )}
            {previewing.kind === "video" && clipLoading && (
              <span
                className="absolute inset-0 flex items-center justify-center bg-black/40"
                data-testid="stock-preview-loading"
              >
                <Loader2 className="w-5 h-5 animate-spin text-white" />
              </span>
            )}
          </div>

          <div className="mt-2 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs truncate" title={previewing.label}>
                {previewing.label}
              </div>
              <div className="text-[10px] text-muted-foreground">
                {/* Pexels asks that the photographer be credited, so they are
                    named here as well as in the file once it is added. */}
                <a
                  href={previewing.creditUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline"
                >
                  {previewing.credit}
                </a>{" "}
                · Pexels
                {previewing.durationSeconds !== null
                  ? ` · ${Math.round(previewing.durationSeconds)}s`
                  : ""}
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                type="button"
                onClick={() => setPreviewing(null)}
                data-testid="button-stock-close-preview"
                aria-label="Close the preview"
                className="rounded-lg border border-hairline bg-surface-2 p-2 text-muted-foreground hover:text-foreground transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => void add(previewing)}
                disabled={adding !== null}
                data-testid="button-stock-add"
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-white transition-all hover:bg-primary/90 disabled:opacity-50"
              >
                {adding === previewing.id ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Plus className="w-3.5 h-3.5" />
                )}
                {adding === previewing.id ? "Adding…" : "Add to this project"}
              </button>
            </div>
          </div>
        </div>
      )}

      {items.length > 0 && (
        <ul className="mt-3 grid grid-cols-3 sm:grid-cols-4 gap-2">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => setPreviewing(item)}
                disabled={adding !== null}
                data-testid={`stock-item-${item.id}`}
                title={`${item.label} — ${item.credit}`}
                className={`group relative block w-full aspect-video overflow-hidden rounded-lg border bg-surface-2 disabled:opacity-60 ${
                  previewing?.id === item.id ? "border-primary ring-1 ring-primary" : "border-hairline"
                }`}
              >
                <img
                  src={item.previewUrl}
                  alt={item.label}
                  loading="lazy"
                  className="w-full h-full object-cover transition-transform group-hover:scale-105"
                />
                {adding === item.id && (
                  <span className="absolute inset-0 flex items-center justify-center bg-black/50">
                    <Loader2 className="w-4 h-4 animate-spin text-white" />
                  </span>
                )}
                {item.durationSeconds !== null && (
                  <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1 text-[10px] text-white">
                    {Math.round(item.durationSeconds)}s
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {searched && !searching && !unavailable && !error && items.length === 0 && (
        <div className="mt-3 text-xs text-muted-foreground">
          Nothing came back for that. Try a plainer word — stock libraries index objects and places
          better than they index moods.
        </div>
      )}
    </div>
  );
}
