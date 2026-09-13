/**
 * The prompt box on the front page, which is the first thing a stranger does.
 *
 * What stood here were two buttons: "Start editing free" and "See how it
 * works". A button asks somebody to commit before they have seen anything; a
 * box asks them to say what they want, which is both easier and the thing this
 * product is actually for. Lovable and Webild both open this way and it is the
 * pattern Osama asked for — with one difference that decides the whole design.
 *
 * **They generate from a sentence. We edit a video somebody already has.**
 * "Build me a site for a coffee shop" is a complete request. "Cut the silences
 * and caption it" is not: there is nothing to cut. So this box asks for both,
 * and the file is *chosen* here rather than sent — not one byte leaves until
 * there is an account and a project for it to belong to.
 *
 * ## What happens when they press send
 *
 * Nothing is created and nothing is uploaded. The sentence goes into the URL
 * and the file into memory, and the person is taken to sign up. The first-run
 * screen on the other side already knows how to take both: it has accepted
 * `?ask=` since the feature scroller was built, and it stashes a file for the
 * editor exactly as the dashboard does. So this adds a door, not a pipeline.
 *
 * ## What happens if the file does not survive
 *
 * It survives today: sign-up is email and password with confirmation off, the
 * session comes back in place, and every route is client-side, so the module
 * holding the handle is never re-evaluated. A hard reload or a provider
 * redirect would lose it — and then the sentence, which travels in the URL,
 * still arrives, and the first-run screen asks for the file it was always
 * going to ask for with the request already written in the box. The failure
 * mode is the product's own normal path, one click longer.
 */
import { useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { ArrowUp, Paperclip, X } from "lucide-react";
import { ACCEPTED_VIDEO_ACCEPT, videoRejection } from "@/lib/start-from-video";
import { whyNotAVideo } from "@/lib/video-storage";
import { formatBytes } from "@workspace/api-zod/bytes";
import { stashLandingFile } from "@/lib/pending-upload";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/lib/language";
import { LANDING } from "@/lib/landing-copy";
import { SUGGESTIONS } from "@/lib/first-run";
import { useTypedPlaceholder } from "@/lib/typed-placeholder";

export function LandingComposer({ signedIn }: { signedIn: boolean }) {
  const { t, language } = useLanguage();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const picker = useRef<HTMLInputElement | null>(null);
  const [sentence, setSentence] = useState("");
  const [file, setFile] = useState<File | null>(null);

  /*
    The box writes its own examples, and they are the checked ones.

    A single placeholder teaches one thing, and the claim this page makes is
    that a sentence is the interface — so it shows four of them being written
    in the box somebody is about to type into.

    `SUGGESTIONS` rather than copy invented here, and that is the whole design:
    every one of those sentences is run through the real keyword parser by
    `onboarding-test`, in both languages, on every build. An example written
    for the front page is a promise nothing checks, and the failure it makes is
    the worst this product has — the first thing a new person asks for coming
    back refused, in the words the home page put in their mouth.

    It stops the moment there is anything in the box: the placeholder is not
    drawn then, and a timer running for somebody who is busy typing is work
    nobody asked for.
  */
  const examples = useMemo(
    () => SUGGESTIONS.map((suggestion) => suggestion.sentence[language === "ar" ? "ar" : "en"]),
    [language],
  );
  const placeholder = useTypedPlaceholder(examples, sentence.length === 0);

  /*
    The same door as everywhere else.

    `videoRejection` is what the dashboard, the clip screen and the editor all
    ask, and the reason it is shared is written where it lives: three
    hand-written lists at three doors is how one of them came to refuse the
    mkv the server accepts. This is a fourth door and it asks the same
    question rather than growing a fourth list.

    No plan is known here — nobody has signed in — so there is no per-plan
    ceiling to check against. That is checked on the other side, by the upload
    door, against the plan the account actually has. Refusing a file here on a
    ceiling we would have to guess would be turning a stranger away on a number
    we invented.
  */
  const choose = (picked: File | null) => {
    if (!picked) return;
    /*
      No ceiling passed, and that is the deliberate half.

      `videoRejection` takes one because every other door knows the plan it is
      standing in front of. This one does not: nobody has signed in. Passing a
      guess would turn a stranger away on a number we invented, and the upload
      door checks the real one against the real plan before a byte moves. So
      only the question this door can honestly answer is asked — is this a
      video at all — and the file most often refused here is an iPhone photo,
      whose owner `whyNotAVideo` tells what to do instead.
    */
    if (videoRejection(picked, { ceilingBytes: null }) === "type") {
      toast({ title: t(LANDING.hero.composerNotVideo), description: whyNotAVideo(picked), variant: "destructive" });
      return;
    }
    setFile(picked);
  };

  const send = () => {
    const said = sentence.trim();
    // Either half is enough to be worth carrying. Somebody who typed a
    // sentence and has no file to hand is told what to do on the next screen;
    // somebody who dropped a file and typed nothing is shown the suggestions
    // there. Both is the whole request, and it is the common case.
    if (!said && !file) {
      picker.current?.click();
      return;
    }
    stashLandingFile(file);
    const next = said ? `/onboarding?ask=${encodeURIComponent(said)}` : "/onboarding";
    setLocation(signedIn ? next : `/login?mode=signup&next=${encodeURIComponent(next)}`);
  };

  return (
    <div
      className="w-full max-w-2xl animate-fade-up"
      style={{ animationDelay: "440ms" }}
      data-testid="landing-composer"
    >
      <div className="rounded-3xl bg-surface-1 border border-hairline backdrop-blur-md p-3 shadow-[0_1px_2px_rgba(8,4,24,0.10),0_24px_60px_-28px_rgba(8,4,24,0.55)]">
        <label htmlFor="landing-ask" className="sr-only">
          {t(LANDING.hero.composerLabel)}
        </label>
        <textarea
          id="landing-ask"
          data-testid="input-landing-ask"
          value={sentence}
          onChange={(event) => setSentence(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends, shift-enter breaks the line. A box this shape is
            // read as a chat box, and a chat box that needs a button pressed
            // is the one thing people notice about it.
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
          rows={2}
          placeholder={placeholder}
          className="w-full resize-none bg-transparent px-3 pt-2 pb-1 text-base md:text-lg text-foreground placeholder:text-muted-foreground/70 focus:outline-none text-start"
        />

        {file ? (
          /* The file, named. A picker that says "1 file selected" is a picker
             somebody has to open again to find out what they picked. */
          <div
            data-testid="landing-file"
            className="mx-2 mb-2 inline-flex max-w-full items-center gap-2 rounded-full bg-surface-2 ps-3 pe-1.5 py-1 text-sm"
          >
            <span className="truncate text-foreground/90">{file.name}</span>
            <span className="shrink-0 text-muted-foreground tabular-nums">{formatBytes(file.size)}</span>
            <button
              type="button"
              onClick={() => setFile(null)}
              aria-label={t(LANDING.hero.composerRemoveFile)}
              className="shrink-0 grid place-items-center w-6 h-6 rounded-full hover:bg-surface-1 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : null}

        <div className="flex items-center gap-2 px-1">
          <input
            ref={picker}
            type="file"
            accept={ACCEPTED_VIDEO_ACCEPT}
            className="hidden"
            data-testid="input-landing-file"
            onChange={(event) => {
              choose(event.target.files?.[0] ?? null);
              // Cleared so picking the same file twice still fires a change.
              event.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => picker.current?.click()}
            data-testid="button-landing-attach"
            className="inline-flex items-center gap-2 h-10 ps-3 pe-4 rounded-full bg-surface-2 hover:bg-surface-1 border border-hairline-faint text-sm font-medium transition-colors"
          >
            <Paperclip className="w-4 h-4" />
            {t(LANDING.hero.composerAttach)}
          </button>

          <span className="flex-1" />

          <button
            type="button"
            onClick={send}
            data-testid="button-landing-send"
            aria-label={t(LANDING.hero.composerSend)}
            className="glow-btn btn-gradient-cta grid place-items-center w-11 h-11 rounded-full text-white"
          >
            <ArrowUp className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/*
        The line under the box — "free, no card; your file does not leave this
        device until you have an account" — is gone at Osama's instruction.

        It answered the two questions somebody has with a finger over a file
        picker on a site they met a minute ago. Both answers are still true and
        neither is now written anywhere on this page. Worth knowing rather than
        worth arguing: the fear it addressed does not disappear with the
        sentence.
      */}
    </div>
  );
}
