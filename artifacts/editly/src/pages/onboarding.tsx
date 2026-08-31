/**
 * The first project, guided — not a tour.
 *
 * A tour explains a product. This makes one video, which is the only thing that
 * has ever convinced anybody of anything. Two questions on one screen, both
 * answerable in a gesture: which file, and what should happen to it.
 *
 * ## Why the sentence is placed and not sent
 *
 * The suggestion goes into the editor's box and stops there. Sending it on
 * arrival would produce a finished video and teach nothing — and the thing this
 * screen exists to teach is **that a sentence is the interface**. Somebody who
 * reads their own request sitting in the box, and presses send themselves,
 * knows what to type the second time. Somebody who watched it happen does not.
 *
 * ## Why it can always be skipped, and never twice
 *
 * A first-run screen that cannot be left is a wall in front of a product
 * somebody has already decided to try. Skipping is one click, it is remembered,
 * and the dashboard only sends anybody here at all when their account has **no
 * projects** — server truth, so making anything ends the first run for good,
 * on every device, whatever the browser remembered.
 */
import { useRef, useState } from "react";
import { useLocation } from "wouter";
import { Loader2, UploadCloud, Check } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateProject,
  useGetSubscription,
  getListProjectsQueryKey,
  getGetDashboardStatsQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { useToast } from "@/hooks/use-toast";
import { stashPendingUpload, stashPendingMessage, titleFromFilename } from "@/lib/pending-upload";
import {
  ACCEPTED_VIDEO_TYPES,
  formatBytes,
  uploadCeiling,
} from "@/lib/video-storage";
import {
  SUGGESTIONS,
  preferredLanguage,
  skipFirstRun,
  type FirstRunLanguage,
} from "@/lib/first-run";

export default function Onboarding() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createProject = useCreateProject();
  const { data: subscription } = useGetSubscription();

  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const [written, setWritten] = useState("");
  const [language, setLanguage] = useState<FirstRunLanguage>(() =>
    preferredLanguage(typeof navigator === "undefined" ? [] : [navigator.language, ...(navigator.languages ?? [])]),
  );

  const rtl = language === "ar";
  const say = (en: string, ar: string) => (rtl ? ar : en);

  /**
   * The same gatekeeping the dashboard and the editor apply, applied here too.
   *
   * Not because it is likely — the ceiling is generous — but because a file
   * rejected after the project row exists leaves an empty project named after
   * somebody's phone, and they have to go and delete it.
   */
  const accept = (picked: File) => {
    if (!ACCEPTED_VIDEO_TYPES.includes(picked.type) && !picked.name.match(/\.(mp4|mov|webm)$/i)) {
      toast({
        title: say("That file is not a video", "هذا الملفّ ليس فيديو"),
        description: say("Editly takes mp4, mov and webm.", "الصيغ المقبولة: mp4 وmov وwebm."),
        variant: "destructive",
      });
      return;
    }
    const ceiling = uploadCeiling(subscription);
    if (picked.size > ceiling) {
      toast({
        title: say("That file is too large", "هذا الملفّ أكبر من المسموح"),
        description: say(
          `It is ${formatBytes(picked.size)} and the limit is ${formatBytes(ceiling)} per video.`,
          `حجمه ${formatBytes(picked.size)} والحدّ ${formatBytes(ceiling)} لكل فيديو.`,
        ),
        variant: "destructive",
      });
      return;
    }
    setFile(picked);
  };

  const sentence = (() => {
    if (written.trim()) return written.trim();
    const pick = SUGGESTIONS.find((s) => s.id === chosen);
    return pick ? pick.sentence[language] : "";
  })();

  const start = async () => {
    try {
      const title = file ? titleFromFilename(file.name) : say("My first video", "أوّل فيديو");
      const project = await createProject.mutateAsync({ data: { title } });
      queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetDashboardStatsQueryKey() });
      // Only after the row exists: a failed create must never leave a file or a
      // sentence waiting for a project that was never made.
      if (file) stashPendingUpload(project.id, file);
      if (sentence) stashPendingMessage(project.id, sentence);
      /*
        Remembered on the way out, not on the way in.

        The dashboard stops sending anybody here the moment they have a project,
        so this is belt and braces — but the braces matter for the one case the
        project count cannot cover: a create that succeeds and a navigation that
        does not.
      */
      skipFirstRun();
      setLocation(`/project/${project.id}`);
    } catch (error: unknown) {
      const status = (error as { response?: { status?: number } })?.response?.status;
      toast({
        title: say("Could not start the project", "تعذّر بدء المشروع"),
        description:
          status === 429
            ? say(
                "This account has used its exported minutes for the month.",
                "استُهلكت دقائق التصدير لهذا الشهر على هذا الحساب.",
              )
            : say("Please try again in a moment.", "حاول مرّة أخرى بعد قليل."),
        variant: "destructive",
      });
    }
  };

  const skip = () => {
    skipFirstRun();
    setLocation("/dashboard");
  };

  return (
    <div className="min-h-screen px-4 sm:px-6 py-6 sm:py-10" dir={rtl ? "rtl" : "ltr"}>
      <div className="max-w-3xl mx-auto flex flex-col gap-8">
        <div className="flex items-center justify-between">
          <Logo className="h-7" />
          <div className="flex items-center gap-2">
            {/* The suggestions' language, not the product's. It answers in
                whichever language the sentence is written in. */}
            <div className="flex rounded-full border border-hairline p-0.5 text-xs" data-testid="first-run-language">
              {(["en", "ar"] as const).map((code) => (
                <button
                  key={code}
                  type="button"
                  onClick={() => setLanguage(code)}
                  className={`px-3 py-1 rounded-full transition-colors ${
                    language === code ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"
                  }`}
                  data-testid={`first-run-language-${code}`}
                >
                  {code === "en" ? "English" : "العربية"}
                </button>
              ))}
            </div>
            <ThemeToggle />
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <h1 className="text-2xl sm:text-3xl font-bold">
            {say("Let's make one video", "لنصنع فيديو واحدًا")}
          </h1>
          <p className="text-muted-foreground max-w-xl leading-relaxed">
            {say(
              "Editly edits from a sentence. Give it a raw take and say what you want, in your own words. Everything else on this screen is here once.",
              "يعدّل Editly انطلاقًا من جملة. أعطه لقطة خام وقل ما تريد بكلماتك. وكل ما على هذه الشاشة يظهر مرّة واحدة.",
            )}
          </p>
        </div>

        {/* ── The file ───────────────────────────────────────────────────── */}
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-muted-foreground">
            {say("1. Your footage", "١. لقطتك")}
          </h2>
          <div
            role="button"
            tabIndex={0}
            onClick={() => fileRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") fileRef.current?.click();
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              setDragging(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const dropped = e.dataTransfer.files?.[0];
              if (dropped) accept(dropped);
            }}
            className={`rounded-2xl border border-dashed px-6 py-10 text-center cursor-pointer transition-colors ${
              dragging ? "border-primary bg-primary/10" : "border-hairline hover:border-primary/50 hover:bg-primary/5"
            }`}
            data-testid="first-run-dropzone"
          >
            {file ? (
              <div className="flex flex-col items-center gap-2">
                <Check className="w-6 h-6 text-primary" />
                <div className="text-sm font-medium" data-testid="first-run-file">{file.name}</div>
                <div className="text-xs text-muted-foreground">
                  {formatBytes(file.size)} · {say("tap to choose a different one", "اضغط لاختيار ملفّ آخر")}
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2">
                <UploadCloud className="w-6 h-6 text-muted-foreground" />
                <div className="text-sm font-medium">
                  {say("Drop a video here", "أفلت فيديو هنا")}
                </div>
                <div className="text-xs text-muted-foreground">
                  {say("mp4, mov or webm. It uploads on the next screen.", "mp4 أو mov أو webm، ويُرفع في الشاشة التالية.")}
                </div>
              </div>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm"
              className="hidden"
              onChange={(e) => {
                const picked = e.target.files?.[0];
                // Allow picking the same file again after a rejection.
                e.target.value = "";
                if (picked) accept(picked);
              }}
              data-testid="first-run-file-input"
            />
          </div>
        </section>

        {/* ── The sentence ───────────────────────────────────────────────── */}
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-muted-foreground">
            {say("2. What should happen to it", "٢. ما الذي يحدث له")}
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {SUGGESTIONS.map((suggestion) => {
              const active = chosen === suggestion.id && !written.trim();
              return (
                <button
                  key={suggestion.id}
                  type="button"
                  onClick={() => {
                    setChosen(suggestion.id);
                    setWritten("");
                  }}
                  className={`text-start rounded-xl border px-4 py-3 transition-colors ${
                    active
                      ? "border-primary bg-primary/10"
                      : "border-hairline hover:border-primary/40 hover:bg-primary/5"
                  }`}
                  data-testid={`first-run-suggestion-${suggestion.id}`}
                >
                  <span className="block text-sm font-semibold">{suggestion.label[language]}</span>
                  <span className="block text-xs text-muted-foreground mt-1 leading-relaxed" dir="auto">
                    {suggestion.sentence[language]}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="flex flex-col gap-2 pt-1">
            <label htmlFor="first-run-own" className="text-xs text-muted-foreground">
              {say("Or say it your own way", "أو قلها بطريقتك")}
            </label>
            <Input
              id="first-run-own"
              dir="auto"
              value={written}
              onChange={(e) => setWritten(e.target.value)}
              placeholder={say("Cut the silences and caption it", "اقصص الصمت وضيف ترجمة")}
              className="bg-surface-1 border-hairline rounded-full h-11"
              data-testid="first-run-own"
            />
          </div>
        </section>

        {/* ── Out ────────────────────────────────────────────────────────── */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 pt-2 border-t border-hairline">
          <Button
            onClick={() => void start()}
            disabled={createProject.isPending}
            className="rounded-full"
            data-testid="first-run-start"
          >
            {createProject.isPending ? <Loader2 className="w-4 h-4 me-2 animate-spin" /> : null}
            {say("Start editing", "ابدأ التعديل")}
          </Button>
          <Button
            variant="ghost"
            onClick={skip}
            className="rounded-full text-muted-foreground"
            data-testid="first-run-skip"
          >
            {say("Skip, I'll look around", "تخطَّ، سأتصفّح بنفسي")}
          </Button>
          <p className="text-xs text-muted-foreground sm:ms-auto max-w-xs leading-relaxed">
            {file
              ? say(
                  "Your sentence goes into the box on the next screen. You send it.",
                  "جملتك توضع في الحقل بالشاشة التالية، وأنت من يرسلها.",
                )
              : say(
                  "You can start without a file and add one on the next screen.",
                  "يمكنك البدء بلا ملفّ وإضافته في الشاشة التالية.",
                )}
          </p>
        </div>
      </div>
    </div>
  );
}
