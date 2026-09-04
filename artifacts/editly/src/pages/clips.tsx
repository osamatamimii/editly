/**
 * Taking short posts out of a long recording. That is the whole of this
 * section, and saying so is most of what this file is now for.
 *
 * It used to be a wall: every clip from every project, newest first. That was
 * a useful shelf and it was read as something it is not. A section called
 * "clips", reached from a screen full of podcasts, showing nothing but
 * outputs, is read as *where podcasts are edited* — and this is not that. An
 * episode is edited in its own project like anything else. This screen does
 * one job on one kind of input: point it at a recording, get posts back.
 *
 * Two changes make the screen mean that rather than merely say it.
 *
 * **It carries the action.** A section that only displays results is an
 * archive whatever its heading claims, so the recordings a person could cut
 * from are at the top of it, and choosing one writes the request into that
 * project's editor. Written, not sent: the same rule the first-run screen
 * follows, because a sentence that fires on arrival is a sentence nobody read,
 * and the second time they will want to type their own.
 *
 * **It is filed by recording.** "What came out of this episode" is the
 * question somebody who publishes weekly is actually asking, and a flat wall
 * cannot answer it. The per-tile line naming the project is gone with the
 * grouping: it existed because a wall of clips with no way to tell which take
 * each belongs to is a pile, and a heading answers that better than a
 * repeated label under every tile.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { Scissors, Download, SquareArrowOutUpRight, Loader2, Mic, UploadCloud } from "lucide-react";
import {
  useListProjects,
  useCreateProject,
  useGetSubscription,
  getListProjectsQueryKey,
  getGetDashboardStatsQueryKey,
  getGetSubscriptionQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { stashPendingMessage, stashPendingUpload, titleFromFilename } from "@/lib/pending-upload";
import { videoRejection } from "@/lib/start-from-video";
import { useToast } from "@/hooks/use-toast";
import { CLIPS_REQUEST } from "@/lib/first-run";
import { clippableRecordings, shelvesFrom } from "@/lib/clip-shelves";
import { BackButton } from "@/components/back-button";
import { LoadFailed } from "@/components/load-failed";
import { ProjectArt } from "@/components/project-art";
import { apiJson } from "@/lib/api-fetch";
import { usePlayableVideo, downloadableVideoUrl, ACCEPTED_VIDEO_ACCEPT, servedCeiling, formatBytes } from "@/lib/video-storage";
import { useLanguage } from "@/lib/language";
import { phrase } from "@/lib/landing-copy";
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
  const { toast } = useToast();
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
      if (!signed) {
        // Silent before: the spinner stopped, no file arrived, and nothing was
        // said. A control that visibly does nothing is one somebody presses
        // three times and then stops trusting.
        //
        // The pair is written here rather than in `lib/copy/clips.ts` because
        // it is the only sentence this card says; `phrase` is the same shape
        // that file uses, so it can move there whenever the card grows a
        // second one.
        toast({
          title: t(phrase("تعذّر جلب هذا المقطع", "Could not fetch that clip")),
          description: t(phrase("المقطع ما زال هنا. جرّب بعد قليل.", "It is still here. Try again in a moment.")),
          variant: "destructive",
        });
        return;
      }
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
        {/*
          The recording this came out of used to be named here, on every tile.

          It existed because a flat wall of clips titled by what is said in them
          is a pile: nothing said which take each belonged to. The clips are
          filed under their recording now, so the heading answers that once for
          a whole shelf instead of repeating it under every card, and the space
          goes back to the thing the tile is about.
        */}
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

/**
 * The door: add an episode, and the request for clips is waiting in the editor
 * when it opens.
 *
 * This is the part that makes the section mean what its heading says. A screen
 * that lists recordings you already have answers "which of these", and the
 * question somebody arrives with is "where do I put my episode". So the file
 * comes first and the list of what is already here comes second.
 *
 * The upload itself belongs to the editor, which owns the pipeline — progress,
 * poster capture, dimension probing. What happens here is the two things that
 * have to happen *before* it: the row is created, and the sentence is written.
 */
function StartRow() {
  const { t, fmt, language } = useLanguage();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: projects } = useListProjects();
  const { data: subscription } = useGetSubscription();
  const createProject = useCreateProject();
  const [over, setOver] = useState(false);

  const recordings = useMemo(() => clippableRecordings(projects), [projects]);
  const said = language === "ar" ? "ar" : "en";

  /*
    Refused before the project row exists.

    The rule is `videoRejection`, shared with the dashboard, because both
    screens have to let the same files through; the words are this screen's,
    because somebody standing here is holding an episode and the dashboard's
    sentence is written for anything.
  */
  const addEpisode = async (file: File) => {
    /*
      The ceiling the server named, and nothing while it has not.

      `uploadCeiling` folds "not answered yet" into the build-time fallback —
      fifty megabytes, the free plan's order of magnitude — so a Pro customer
      dropping an episode before the subscription query returns was told it was
      too large. `videoRejection` treats null as "no ceiling to enforce yet".
    */
    const ceiling = servedCeiling(subscription);
    const rejection = videoRejection(file, { ceilingBytes: ceiling });
    if (rejection === "type") {
      toast({ title: t(CLIPS.badType), description: t(CLIPS.badTypeDetail), variant: "destructive" });
      return;
    }
    if (rejection === "size") {
      toast({
        title: t(CLIPS.tooLarge),
        // Only reachable when `ceiling` is a number: `videoRejection` never
        // answers "size" without one.
        description: fmt(CLIPS.tooLargeDetail, formatBytes(file.size), formatBytes(ceiling as number)),
        variant: "destructive",
      });
      return;
    }
    try {
      const project = await createProject.mutateAsync({ data: { title: titleFromFilename(file.name) } });
      queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetDashboardStatsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetSubscriptionQueryKey() });
      // Only after the row exists: a failed create must not leave a file
      // waiting for a project that was never made.
      stashPendingUpload(project.id, file);
      stashPendingMessage(project.id, CLIPS_REQUEST[said]);
      setLocation(`/project/${project.id}`);
    } catch {
      toast({ title: t(CLIPS.createFailed), description: t(CLIPS.tryLater), variant: "destructive" });
    }
  };

  /*
    Written into the editor, not sent.

    The same rule the first-run screen follows: somebody has to *see* what a
    request to this product looks like, and a sentence that fires on arrival is
    a sentence they never read. It is also why this is one click and not two —
    the second click is theirs, in the editor, on send.
  */
  const cutFrom = (projectId: string) => {
    stashPendingMessage(projectId, CLIPS_REQUEST[said]);
    setLocation(`/project/${projectId}`);
  };

  return (
    <div className="mb-10 space-y-4" data-testid="clips-start">
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const file = e.dataTransfer.files?.[0];
          if (file) void addEpisode(file);
        }}
        className={`block rounded-2xl border border-dashed p-6 text-center cursor-pointer transition-colors ${
          over ? "border-primary bg-primary/5" : "border-hairline glass-panel"
        }`}
        data-testid="clips-add-episode"
      >
        <div className="w-12 h-12 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto mb-3">
          <Mic className="w-6 h-6 text-primary" />
        </div>
        <div className="text-base font-semibold">{t(over ? CLIPS.addDrop : CLIPS.addTitle)}</div>
        <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">{t(CLIPS.addHint)}</p>
        <span className="aura-chip no-default-hover-elevate rounded-full min-h-11 md:min-h-9 px-4 text-xs font-medium inline-flex items-center gap-2 mt-4">
          {createProject.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UploadCloud className="w-3.5 h-3.5" />}
          {t(CLIPS.addButton)}
        </span>
        <input
          type="file"
          /* Extensions as well as types: browsers disagree about `.mkv`, so a
             list of media types alone does not offer the file OBS just wrote.
             See `ACCEPTED_VIDEO_ACCEPT`. */
          accept={ACCEPTED_VIDEO_ACCEPT}
          className="hidden"
          data-testid="clips-add-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Cleared so that choosing the same file twice fires again, which
            // is what somebody does after a refusal they have just fixed.
            e.target.value = "";
            if (file) void addEpisode(file);
          }}
        />
      </label>

      {/* And the shorter road for a show that is already here. Hidden when
          there is nothing to offer, rather than drawn empty. */}
      {recordings.length > 0 ? (
        <div className="rounded-2xl glass-panel border border-hairline-faint p-5">
          <div className="flex items-baseline gap-3 flex-wrap">
            <h2 className="text-sm font-semibold">{t(CLIPS.startTitle)}</h2>
            <span className="text-xs text-muted-foreground">{t(CLIPS.startHint)}</span>
          </div>
          <div className="flex flex-wrap gap-2 mt-4">
            {recordings.map((recording) => (
              <ClipFromButton key={recording.id} recording={recording} onPick={cutFrom} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ClipFromButton({
  recording,
  onPick,
}: {
  recording: { id: string; title: string; duration?: number | null };
  onPick: (projectId: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onPick(recording.id)}
      className="aura-chip no-default-hover-elevate rounded-full min-h-11 md:min-h-9 px-4 text-xs font-medium inline-flex items-center gap-2 max-w-full"
      data-testid={`button-cut-from-${recording.id}`}
    >
      <Scissors className="w-3.5 h-3.5 flex-shrink-0" />
      <span dir="auto" className="truncate min-w-0">{recording.title}</span>
      <span dir="ltr" className="text-muted-foreground flex-shrink-0">
        {clock(recording.duration ?? 0)}
      </span>
    </button>
  );
}

/** One recording's shelf. The order inside it is `shelvesFrom`'s, and its reasons are there. */
function RecordingShelf({ title, projectId, clips }: { title: string; projectId: string; clips: LibraryClip[] }) {
  const { t, fmt } = useLanguage();
  return (
    <section className="mb-10" data-testid={`clips-of-${projectId}`}>
      <div className="flex items-baseline gap-3 flex-wrap mb-4">
        <h2 dir="auto" className="text-lg font-semibold min-w-0 truncate max-w-full">{title}</h2>
        <span className="text-xs text-muted-foreground flex-shrink-0">{fmt(CLIPS.fromRecording, clips.length)}</span>
        <Link
          href={`/project/${projectId}`}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-1 flex-shrink-0"
        >
          {t(CLIPS.openRecording)}
          <SquareArrowOutUpRight className="w-3 h-3" />
        </Link>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4">
        {clips.map((clip) => (
          <ClipCard key={clip.id} clip={clip} />
        ))}
      </div>
    </section>
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

  /*
    One shelf per recording, in the order the recordings last produced
    something.

    Built from the clips themselves rather than from the project list, because
    the two can disagree: the library is capped, and a recording whose clips all
    fell outside the cap has no shelf here — which is correct, and a shelf built
    from projects would have drawn it empty and claimed the recording produced
    nothing.
  */
  const shelves = useMemo(() => shelvesFrom(clips), [clips]);

  return (
    <div className="w-full max-w-7xl mx-auto px-6 py-12">
      <BackButton fallback="/dashboard" label={t(COMMON.dashboard)} className="mb-6 -ms-4" />
      <h1 className="text-3xl font-bold tracking-tight mb-2">{t(CLIPS.title)}</h1>
      <p className="text-muted-foreground text-sm mb-8">{t(CLIPS.lead)}</p>

      {/*
        Above the results, and above the failure state too.

        A person who came here to cut clips and met a network error should still
        be able to do the thing the section is for. The wall below can fail; the
        door should not go with it.
      */}
      <StartRow />

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
          {/*
            Filed under the recording each came out of, newest recording first.

            `clips-grid` still wraps the lot because it is what says "the
            library drew, and it is not the empty state" — that question is
            about the screen, not about the shape inside it.
          */}
          <div data-testid="clips-grid">
            {shelves.map((shelf) => (
              <RecordingShelf
                key={shelf.projectId}
                projectId={shelf.projectId}
                title={shelf.title}
                clips={shelf.clips}
              />
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
