/**
 * Every clip, across every project.
 *
 * The clips panel inside a project answers "what came out of this take". This
 * answers the other question, which is the one somebody who records a weekly
 * show actually has: **what have I got to post.** Their clips live in eleven
 * projects, and the output of the thing they use this product for was
 * scattered across the screens they used to make it.
 *
 * So: one wall, newest first, each clip named by what is said in it and
 * carrying the recording it came out of. Play it here, take it, or open the
 * project it belongs to and keep editing.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import { Scissors, Download, SquareArrowOutUpRight, Loader2 } from "lucide-react";
import { BackButton } from "@/components/back-button";
import { LoadFailed } from "@/components/load-failed";
import { ProjectArt } from "@/components/project-art";
import { apiJson } from "@/lib/api-fetch";
import { usePlayableVideo, signedVideoUrl } from "@/lib/video-storage";

interface LibraryClip {
  id: string;
  projectId: string;
  projectTitle: string;
  title: string | null;
  note: string | null;
  startSeconds: number;
  endSeconds: number;
  outputSeconds: number | null;
  outputPath: string | null;
  thumbnailPath: string | null;
  createdAt: string;
}

function clock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function ClipCard({ clip }: { clip: LibraryClip }) {
  const { url } = usePlayableVideo(clip.outputPath);
  const [taking, setTaking] = useState(false);

  const take = async () => {
    if (!clip.outputPath) return;
    setTaking(true);
    try {
      // Signed here rather than held in state: a URL minted when the page
      // loaded has expired by the time somebody scrolls to the bottom of a
      // long library and presses it.
      const signed = await signedVideoUrl(clip.outputPath);
      if (!signed) return;
      const link = document.createElement("a");
      link.href = signed;
      link.download = `${(clip.title ?? "clip").replace(/\s+/g, "-").toLowerCase()}.mp4`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } finally {
      setTaking(false);
    }
  };

  return (
    <div
      className="rounded-2xl glass-panel border border-hairline-faint overflow-hidden flex flex-col p-2"
      data-testid={`clip-card-${clip.id}`}
    >
      <div className="force-dark relative w-full aspect-[9/16] rounded-xl overflow-hidden bg-background">
        {url ? (
          <video
            src={`${url}#t=${Math.max(0.1, (clip.outputSeconds ?? 4) * 0.25)}`}
            preload="metadata"
            muted
            playsInline
            controls
            className="absolute inset-0 w-full h-full object-cover"
          />
        ) : (
          /* The same generated art the project cards use, so a clip whose file
             is still arriving is a picture rather than a hole. */
          <ProjectArt seed={clip.id} />
        )}
        <div className="absolute bottom-2 right-2 px-2 py-0.5 rounded-full bg-black/70 text-white text-[11px] font-medium backdrop-blur-md">
          {clock(clip.outputSeconds ?? clip.endSeconds - clip.startSeconds)}
        </div>
      </div>

      <div className="px-2 pt-3 pb-1 flex-1">
        <div dir="auto" className="text-sm font-semibold leading-snug line-clamp-2">
          {clip.title ?? "Untitled clip"}
        </div>
        {/* Which recording this came out of. A wall of clips titled by what was
            said in them, with no way to tell which take each belongs to, is a
            pile rather than a library. */}
        <Link
          href={`/project/${clip.projectId}`}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-1 mt-1"
        >
          <span dir="auto" className="truncate max-w-[14rem]">{clip.projectTitle}</span>
          <SquareArrowOutUpRight className="w-3 h-3 flex-shrink-0" />
        </Link>
      </div>

      <div className="px-2 pb-2 flex items-center gap-2">
        <button
          type="button"
          onClick={take}
          disabled={!clip.outputPath || taking}
          className="aura-chip no-default-hover-elevate flex-1 rounded-full min-h-11 md:min-h-9 text-xs font-medium inline-flex items-center justify-center gap-2 disabled:opacity-40"
          data-testid={`button-take-clip-${clip.id}`}
        >
          {taking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
          Save
        </button>
      </div>
    </div>
  );
}

export default function ClipsPage() {
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [clips, setClips] = useState<LibraryClip[]>([]);

  const load = useCallback(async () => {
    setState("loading");
    const { ok, body } = await apiJson<{ clips?: LibraryClip[] }>("/api/clips");
    // A failed read must not render as an empty library. "You have no clips"
    // is a claim about somebody's work, and making it from a network error is
    // the failure this codebase keeps finding.
    if (!ok) {
      setState("failed");
      return;
    }
    setClips(body.clips ?? []);
    setState("ready");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="w-full max-w-7xl mx-auto px-6 py-12">
      <BackButton fallback="/dashboard" label="Dashboard" className="mb-6 -ml-4" />
      <h1 className="text-3xl font-bold tracking-tight mb-2">Clips</h1>
      <p className="text-muted-foreground text-sm mb-8">
        Every clip cut out of every recording, newest first. Play one, save it, or open the take it
        came from.
      </p>

      {state === "loading" ? (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="rounded-2xl glass-panel border border-hairline-faint p-2">
              <div className="w-full aspect-[9/16] rounded-xl bg-surface-1 animate-pulse" />
              <div className="h-4 bg-surface-1 rounded mt-3 animate-pulse" />
            </div>
          ))}
        </div>
      ) : state === "failed" ? (
        <LoadFailed what="your clips" onRetry={load} testId="clips-failed" />
      ) : clips.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center glass-panel rounded-2xl border-hairline-faint border-dashed">
          <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-4 border border-primary/20">
            <Scissors className="w-8 h-8 text-primary" />
          </div>
          <h2 className="text-xl font-bold mb-2">Nothing cut yet</h2>
          <p className="text-muted-foreground max-w-md">
            Open a long recording and ask for clips, or press <strong>Three clips</strong> in the
            looks row. Each moment comes back as its own post, titled by what is said in it.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4" data-testid="clips-grid">
          {clips.map((clip) => (
            <ClipCard key={clip.id} clip={clip} />
          ))}
        </div>
      )}
    </div>
  );
}
