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
import { useState } from "react";
import { Loader2, Search, ImageIcon, Film } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { uploadProjectAsset } from "@/lib/video-storage";

export interface StockItem {
  id: string;
  kind: "image" | "video";
  label: string;
  previewUrl: string;
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
  const [error, setError] = useState<string | null>(null);
  /** Distinct from an error: nothing is broken, the key is simply not set. */
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

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
            className="w-full rounded-lg border border-hairline bg-surface-1 pl-8 pr-3 py-2 text-xs outline-none focus:border-primary/40"
          />
        </div>
        <div className="flex rounded-lg border border-hairline overflow-hidden">
          {(["video", "image"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              data-testid={`button-stock-${k}`}
              className={`px-2.5 py-2 text-xs transition-colors ${
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
          className="rounded-lg border border-hairline bg-surface-1 px-3 py-2 text-xs font-medium transition-all hover:border-primary/40 disabled:opacity-50"
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

      {items.length > 0 && (
        <ul className="mt-3 grid grid-cols-3 sm:grid-cols-4 gap-2">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => void add(item)}
                disabled={adding !== null}
                data-testid={`stock-item-${item.id}`}
                title={`${item.label} — ${item.credit}`}
                className="group relative block w-full aspect-video overflow-hidden rounded-lg border border-hairline bg-surface-2 disabled:opacity-60"
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
