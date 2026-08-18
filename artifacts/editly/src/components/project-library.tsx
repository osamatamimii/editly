/**
 * The project's library: everything this edit can put on screen besides the one
 * video being cut.
 *
 * It talks to the API with plain fetch rather than through the generated client
 * because the generated client is produced from the OpenAPI spec, and a panel
 * that cannot ship until the spec is regenerated is a panel that does not ship.
 * The endpoints it calls are three, and they are stable.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Trash2, ImageIcon, Film, Music, Plus } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { uploadProjectAsset, formatBytes, assetKindOf, MAX_ASSET_BYTES } from "@/lib/video-storage";

export interface ProjectAsset {
  id: string;
  kind: "video" | "image" | "audio";
  label: string | null;
  bytes: number;
}

const ICON = { video: Film, image: ImageIcon, audio: Music } as const;

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function ProjectLibrary({ projectId, userId }: { projectId: string; userId: string }) {
  const [assets, setAssets] = useState<ProjectAsset[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Which file of how many, so a ten-file drop does not look frozen. */
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/projects/${projectId}/assets`, { headers: await authHeaders() });
    if (res.ok) setAssets((await res.json()) as ProjectAsset[]);
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function add(files: FileList): Promise<void> {
    setError(null);
    setBusy(true);
    const list = Array.from(files);
    setProgress({ done: 0, total: list.length });

    // Sequential on purpose. Ten parallel uploads from a phone share one uplink
    // and finish no sooner, but they do make the progress meaningless and make
    // a failure halfway impossible to describe.
    const failures: string[] = [];
    for (const [index, file] of list.entries()) {
      try {
        if (!assetKindOf(file)) throw new Error(`"${file.name}" is not a video, image or audio file.`);
        const { data } = await supabase.auth.getSession();
        const token = data.session?.access_token;
        if (!token) throw new Error("Your session expired. Sign in again.");

        const { path, kind } = await uploadProjectAsset({ file, userId, projectId, accessToken: token });
        const res = await fetch(`/api/projects/${projectId}/assets`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(await authHeaders()) },
          body: JSON.stringify({ path, kind, label: file.name, bytes: file.size }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Could not add "${file.name}".`);
        }
      } catch (e) {
        failures.push(e instanceof Error ? e.message : `Could not add "${file.name}".`);
      }
      setProgress({ done: index + 1, total: list.length });
    }

    // Whatever did land is shown, and whatever did not is named. A batch that
    // half-worked must not report as either success or failure.
    await refresh();
    setBusy(false);
    setProgress(null);
    if (failures.length > 0) setError(failures.join(" "));
  }

  async function remove(id: string): Promise<void> {
    await fetch(`/api/projects/${projectId}/assets/${id}`, { method: "DELETE", headers: await authHeaders() });
    await refresh();
  }

  return (
    <div className="rounded-xl glass-panel border border-hairline px-4 py-4" data-testid="project-library">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <div className="text-sm font-medium">Files in this project</div>
          <div className="text-xs text-muted-foreground">
            B-roll, screenshots, a logo, music — anything the edit can put on screen.
          </div>
        </div>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          data-testid="button-add-assets"
          className="inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-surface-1 px-3 py-2 text-xs font-medium transition-all hover:border-primary/40 disabled:opacity-50"
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
          {busy && progress ? `Adding ${progress.done}/${progress.total}…` : "Add files"}
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="video/*,image/*,audio/*"
          className="hidden"
          onChange={(e) => {
            const files = e.target.files;
            e.target.value = "";
            if (files && files.length > 0) void add(files);
          }}
        />
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs" role="alert">
          {error}
        </div>
      )}

      {assets.length === 0 ? (
        <div className="text-xs text-muted-foreground">
          Nothing yet. Files you add here can be cut in as b-roll or laid over the frame — up to{" "}
          {formatBytes(MAX_ASSET_BYTES)} each.
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {assets.map((asset) => {
            const Icon = ICON[asset.kind];
            return (
              <li
                key={asset.id}
                className="flex items-center gap-2.5 rounded-lg border border-hairline bg-surface-1 px-3 py-2"
                data-testid={`asset-${asset.id}`}
              >
                <Icon className="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground" />
                <span className="text-xs truncate flex-1" title={asset.label ?? asset.id}>
                  {asset.label ?? asset.id}
                </span>
                <span className="text-[10px] text-muted-foreground flex-shrink-0">{formatBytes(asset.bytes)}</span>
                <button
                  type="button"
                  onClick={() => void remove(asset.id)}
                  aria-label={`Remove ${asset.label ?? "this file"}`}
                  className="text-muted-foreground hover:text-destructive transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
