/**
 * The clips a render cut from this project's video.
 *
 * Each is its own artifact — its own stretch of the source, its own file —
 * so each row gets its own player, signed the same way everything else this
 * person owns is signed: by their own session, in the browser. The panel
 * renders nothing at all until clips exist, because an empty "Clips" box on
 * every project would be a promise-shaped piece of furniture.
 */
import { Scissors, Download } from "lucide-react";
import { useListClips, getListClipsQueryKey, type Clip } from "@workspace/api-client-react";
import { usePlayableVideo, signedVideoUrl } from "@/lib/video-storage";

export { getListClipsQueryKey };

function clock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function ClipRow({ clip }: { clip: Clip }) {
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
        <button
          onClick={() => void download()}
          title="Open this clip in a new tab to save it"
          className="flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors"
          data-testid={`clip-download-${clip.idx}`}
        >
          <Download className="w-3.5 h-3.5" />
        </button>
      </div>
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
  if (!clips || clips.length === 0) return null;

  // Newest set only. The endpoint returns newest-first sets in source order
  // within each set, so the first row's jobId names the set to show — older
  // sets' files still exist, but a panel of every set ever made is an
  // archive, not an editor.
  const latestJob = clips[0].jobId;
  const latest = clips.filter((c) => c.jobId === latestJob);

  return (
    <div className="rounded-xl glass-panel border border-hairline flex flex-col gap-2 px-4 py-4 mt-3" data-testid="panel-clips">
      <div className="flex items-center gap-2">
        <Scissors className="w-4 h-4 text-secondary flex-shrink-0" />
        <span className="text-sm font-medium text-muted-foreground">
          Your clips ({latest.length})
        </span>
      </div>
      {latest.map((clip) => (
        <ClipRow key={clip.id} clip={clip} />
      ))}
    </div>
  );
}
