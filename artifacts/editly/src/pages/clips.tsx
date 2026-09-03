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
import { usePlayableVideo, downloadableVideoUrl } from "@/lib/video-storage";
import { useLanguage } from "@/lib/language";
import { CLIPS } from "@/lib/copy/clips";
import { COMMON, LOAD } from "@/lib/copy/common";

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
  const { t } = useLanguage();
  const { url, previewUrl } = usePlayableVideo(clip.outputPath);
  const [taking, setTaking] = useState(false);
  const [painted, setPainted] = useState(false);

  const take = async () => {
    if (!clip.outputPath) return;
    setTaking(true);
    try {
      // Signed here rather than held in state: a URL minted when the page
      // loaded has expired by the time somebody scrolls to the bottom of a
      // long library and presses it.
      //
      // And signed *for saving*: `<a download>` is ignored across origins, and
      // the file is on Supabase while the page is on ours. Without the name in
      // the signature the browser played the clip in a tab instead of keeping
      // it, which on a phone is a full-screen video and no way back to the
      // library.
      const filename = `${(clip.title ?? "clip").replace(/\s+/g, "-").toLowerCase()}.mp4`;
      const signed = await downloadableVideoUrl(clip.outputPath, filename);
      if (!signed) return;
      const link = document.createElement("a");
      link.href = signed;
      link.download = filename;
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
        {/*
          The art stays until the clip has really drawn a frame.

          It was `url ? <video> : <art>`, and that answers the wrong question. A
          signed URL means the file can be *fetched*; it says nothing about
          whether this browser can decode it. The master is H.264, and H.264
          decode is a licensed operating-system component — there is a browser
          on this project's own desk that holds an edited render at
          `readyState 0` forever, with no error, while `canPlayType` answers
          "probably". Every tile in this library was a black square there.

          So the VP9 mirror is offered first, the master second, and the art is
          drawn underneath a *transparent* player until `videoWidth` says a
          frame exists. `loadeddata`, not `loadedmetadata`: a browser with no
          decoder reads the header perfectly well and then draws nothing.
        */}
        {painted ? null : <ProjectArt seed={clip.id} />}
        {url || previewUrl ? (
          <video
            preload="metadata"
            muted
            playsInline
            controls
            onLoadedData={(e) => {
              if (e.currentTarget.videoWidth > 0) setPainted(true);
            }}
            className={`absolute inset-0 w-full h-full object-cover transition-opacity ${
              painted ? "opacity-100" : "opacity-0"
            }`}
          >
            {previewUrl ? <source src={previewUrl} type="video/webm" /> : null}
            {url ? (
              <source
                src={`${url}#t=${Math.max(0.1, (clip.outputSeconds ?? 4) * 0.25)}`}
                type="video/mp4"
              />
            ) : null}
          </video>
        ) : null}
        <div dir="ltr" className="absolute bottom-2 end-2 px-2 py-0.5 rounded-full bg-black/70 text-white text-[11px] font-medium backdrop-blur-md">
          {clock(clip.outputSeconds ?? clip.endSeconds - clip.startSeconds)}
        </div>
      </div>

      <div className="px-2 pt-3 pb-1 flex-1">
        <div dir="auto" className="text-sm font-semibold leading-snug line-clamp-2">
          {clip.title ?? t(CLIPS.untitled)}
        </div>
        {/* Which recording this came out of. A wall of clips titled by what was
            said in them, with no way to tell which take each belongs to, is a
            pile rather than a library. */}
        {/*
          `flex` with a `min-w-0` label, not a fixed `max-w`.

          It was `max-w-[14rem]`, which is wider than a tile in a two-column
          phone grid — so the title ran to the edge and stopped there, cut off
          with no ellipsis to say so, and the little "opens elsewhere" arrow was
          pushed off the card entirely. A flex child will not shrink below its
          content unless it is told it may.
        */}
        <Link
          href={`/project/${clip.projectId}`}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1 mt-1 max-w-full"
        >
          <span dir="auto" className="truncate min-w-0">{clip.projectTitle}</span>
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
          {t(CLIPS.save)}
        </button>
      </div>
    </div>
  );
}

export default function ClipsPage() {
  const { t, fmt } = useLanguage();
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [clips, setClips] = useState<LibraryClip[]>([]);
  const [total, setTotal] = useState(0);

  const load = useCallback(async () => {
    setState("loading");
    const { ok, body } = await apiJson<{ clips?: LibraryClip[]; total?: number }>("/api/clips");
    // A failed read must not render as an empty library. "You have no clips"
    // is a claim about somebody's work, and making it from a network error is
    // the failure this codebase keeps finding.
    if (!ok) {
      setState("failed");
      return;
    }
    setClips(body.clips ?? []);
    setTotal(body.total ?? body.clips?.length ?? 0);
    setState("ready");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="w-full max-w-7xl mx-auto px-6 py-12">
      <BackButton fallback="/dashboard" label={t(COMMON.dashboard)} className="mb-6 -ms-4" />
      <h1 className="text-3xl font-bold tracking-tight mb-2">{t(CLIPS.title)}</h1>
      <p className="text-muted-foreground text-sm mb-8">{t(CLIPS.lead)}</p>

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
        <LoadFailed what={LOAD.yourClips} onRetry={load} testId="clips-failed" />
      ) : clips.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center glass-panel rounded-2xl border-hairline-faint border-dashed">
          <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-4 border border-primary/20">
            <Scissors className="w-8 h-8 text-primary" />
          </div>
          <h2 className="text-xl font-bold mb-2">{t(CLIPS.emptyTitle)}</h2>
          <p className="text-muted-foreground max-w-md">
            {t(CLIPS.emptyLeadStart)}
            <strong>{t(CLIPS.emptyLeadAction)}</strong>
            {t(CLIPS.emptyLeadEnd)}
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4" data-testid="clips-grid">
            {clips.map((clip) => (
              <ClipCard key={clip.id} clip={clip} />
            ))}
          </div>
          {/* Where the list stops, said out loud.
              The cap is right — every tile signs a URL and draws a player, and
              nobody scrolls a thousand. What is not right is a library that
              quietly ends: somebody with three hundred clips saw the newest two
              hundred and nothing to say the rest were still there. */}
          {total > clips.length ? (
            <p className="text-sm text-muted-foreground mt-6" data-testid="clips-capped">
              {fmt(CLIPS.capped, clips.length, total)}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
