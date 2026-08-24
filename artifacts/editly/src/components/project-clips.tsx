/**
 * The clips a render cut from this project's video.
 *
 * Each is its own artifact — its own stretch of the source, its own file —
 * so each row gets its own player, signed the same way everything else this
 * person owns is signed: by their own session, in the browser. The panel
 * renders nothing at all until clips exist, because an empty "Clips" box on
 * every project would be a promise-shaped piece of furniture.
 *
 * The newest set leads; earlier sets fold away behind a count rather than
 * disappearing — their files still exist and still belong to the person, but
 * a panel of every set ever made is an archive, not an editor.
 */
import { useState } from "react";
import { Scissors, Download, Trash2, ChevronDown, ChevronRight, SquareArrowOutUpRight } from "lucide-react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useListClips, getListClipsQueryKey, type Clip } from "@workspace/api-client-react";
import { usePlayableVideo, signedVideoUrl } from "@/lib/video-storage";
import { supabase } from "@/lib/supabase";

export { getListClipsQueryKey };

function clock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function ClipRow({
  clip,
  onDelete,
  onOpen,
  opening,
}: {
  clip: Clip;
  onDelete: (clip: Clip) => void;
  onOpen: (clip: Clip) => void;
  opening: boolean;
}) {
  // The preview.webm mirror is tried first, exactly as the main player does —
  // a browser that cannot decode H.264 should not lose the clips too.
  const { url, previewUrl } = usePlayableVideo(clip.outputPath);

  async function download(): Promise<void> {
    const signed = await signedVideoUrl(clip.outputPath);
    if (signed) window.open(signed, "_blank");
  }

  return (
    <div
      className="rounded-xl border border-hairline bg-surface-1 p-2"
      data-testid={`clip-row-${clip.idx}`}
    >
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="text-xs font-medium truncate min-w-0">
          Clip {clip.idx} · {clock(clip.startSeconds)}–{clock(clip.endSeconds)}
          {clip.outputSeconds != null ? ` · ${clip.outputSeconds.toFixed(0)}s` : ""}
        </span>
        <span className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={() => void download()}
            title="Open this clip in a new tab to save it"
            className="text-muted-foreground hover:text-foreground transition-colors"
            data-testid={`clip-download-${clip.idx}`}
          >
            <Download className="w-3.5 h-3.5" />
          </button>
          {/* A clip is a video, so it can be edited like one — this makes a
              project of its own from a copy of it, and opens it. */}
          <button
            onClick={() => onOpen(clip)}
            disabled={opening}
            title="Open this clip as its own project"
            className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
            data-testid={`clip-open-${clip.idx}`}
          >
            <SquareArrowOutUpRight className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => onDelete(clip)}
            title="Delete this clip"
            className="text-muted-foreground hover:text-destructive transition-colors"
            data-testid={`clip-delete-${clip.idx}`}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </span>
      </div>
      {/* The speaker's own words, never invented copy — absent when nothing
          was heard, rather than filled with something nobody said. */}
      {clip.title && (
        <p className="text-[11px] leading-snug italic mb-1.5 truncate">“{clip.title}”</p>
      )}
      {(previewUrl || url) && (
        <video
          controls
          preload="metadata"
          playsInline
          className="w-full rounded-lg bg-black/40 max-h-48"
          data-testid={`clip-video-${clip.idx}`}
        >
          {previewUrl && <source src={previewUrl} type="video/webm" />}
          {url && <source src={url} type="video/mp4" />}
        </video>
      )}
      {clip.note && (
        <p className="text-[11px] leading-snug text-muted-foreground mt-1">{clip.note}</p>
      )}
    </div>
  );
}

export function ProjectClips({ projectId }: { projectId: string }) {
  const { data: clips } = useListClips(projectId);
  const queryClient = useQueryClient();
  const [showEarlier, setShowEarlier] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [, navigate] = useLocation();

  if (!clips || clips.length === 0) return null;

  // Newest set first: the endpoint returns newest-first sets in source order
  // within each set, so the first row's jobId names the set that leads.
  const latestJob = clips[0].jobId;
  const latest = clips.filter((c) => c.jobId === latestJob);
  const earlier = clips.filter((c) => c.jobId !== latestJob);

  async function remove(clip: Clip): Promise<void> {
    // The row goes first server-side, so a failure can only mean "still
    // there" — refetching is the honest recovery either way.
    await fetch(`/api/projects/${projectId}/clips/${clip.id}`, {
      method: "DELETE",
      headers: await authHeaders(),
    }).catch(() => {});
    queryClient.invalidateQueries({ queryKey: getListClipsQueryKey(projectId) });
  }

  async function open(clip: Clip): Promise<void> {
    // The server copies the bytes and answers with the new project; landing
    // on it is the whole point, so nothing is navigated until it exists.
    setOpening(clip.id);
    try {
      const res = await fetch(`/api/projects/${projectId}/clips/${clip.id}/open`, {
        method: "POST",
        headers: await authHeaders(),
      });
      if (!res.ok) return;
      const project = (await res.json()) as { id: string };
      navigate(`/projects/${project.id}`);
    } catch {
      // Nothing was created on a failure — the row is taken back server-side.
    } finally {
      setOpening(null);
    }
  }

  return (
    <div className="rounded-xl glass-panel border border-hairline flex flex-col gap-2 px-4 py-4 mt-3" data-testid="panel-clips">
      <div className="flex items-center gap-2">
        <Scissors className="w-4 h-4 text-secondary flex-shrink-0" />
        <span className="text-sm font-medium text-muted-foreground">
          Your clips ({latest.length})
        </span>
      </div>
      {latest.map((clip) => (
        <ClipRow
          key={clip.id}
          clip={clip}
          onDelete={(c) => void remove(c)}
          onOpen={(c) => void open(c)}
          opening={opening === clip.id}
        />
      ))}
      {earlier.length > 0 && (
        <>
          <button
            onClick={() => setShowEarlier((v) => !v)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            data-testid="button-earlier-clips"
          >
            {showEarlier ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            Earlier sets ({earlier.length})
          </button>
          {showEarlier &&
            earlier.map((clip) => (
              <ClipRow
                key={clip.id}
                clip={clip}
                onDelete={(c) => void remove(c)}
                onOpen={(c) => void open(c)}
                opening={opening === clip.id}
              />
            ))}
        </>
      )}
    </div>
  );
}
