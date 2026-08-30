/**
 * The microphone button, and the sheet that opens when you press it.
 *
 * The whole design rests on one decision: **speech fills the same box typing
 * fills.** It does not send, it does not talk to the planner, it does not get
 * its own endpoint. What you say becomes text in the chat input, and from there
 * every behaviour the product already has applies unchanged — the planner, the
 * refusals, the language detection, the rate limit, the "I can't do that yet"
 * list. A second path into the renderer would be a second set of all of those,
 * drifting from the first.
 *
 * It also means you can fix what it misheard before sending, which matters more
 * than it sounds: a recogniser that is right nine times out of ten and
 * unstoppable is worse than one that is right nine times out of ten and hands
 * you the pen.
 */
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Mic, X, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { VoiceOrb } from "./orb";
import { useVoiceInput, voiceErrorMessage } from "./use-voice-input";

export function VoiceInput({
  onText,
  disabled = false,
  arabic = false,
}: {
  /** Given what was heard, so the caller can put it where typing goes. */
  onText: (text: string) => void;
  disabled?: boolean;
  /** Which language to listen for, and to apologise in. */
  arabic?: boolean;
}) {
  const voice = useVoiceInput({
    lang: arabic ? "ar-SA" : "en-US",
    onFinal: onText,
  });

  // Escape closes it. A full-screen listening state with no way out but the
  // mouse is a trap on a laptop.
  useEffect(() => {
    if (!voice.listening) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") voice.stop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [voice]);

  // Nothing at all rather than a button that cannot work. Firefox has no
  // SpeechRecognition, and a dead microphone icon is a worse answer than a
  // chat box that simply expects typing.
  if (!voice.supported) return null;

  return (
    <>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        onClick={voice.listening ? voice.stop : voice.start}
        disabled={disabled}
        aria-label={voice.listening ? "Stop listening" : "Describe your edit out loud"}
        aria-pressed={voice.listening}
        className="absolute right-12 top-1 h-10 w-10 rounded-full text-muted-foreground hover:text-foreground"
        data-testid="button-voice"
      >
        <Mic className={`w-4 h-4 ${voice.listening ? "text-secondary" : ""}`} />
      </Button>

      {/*
        Through a portal to <body>, and this is not tidiness.
        `position: fixed` is positioned against the viewport only while no
        ancestor establishes a containing block — and `transform`, `filter` and
        `backdrop-filter` all do. This sheet lives inside the chat panel, which
        is glass, so `inset-0` resolved against that panel instead: measured, the
        overlay began two thirds of the way down the screen and left the editor
        visible above it. It looked like a z-index problem and was not one.
      */}
      {voice.listening &&
        createPortal(
        <div
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 px-6 bg-black/75 backdrop-blur-md"
          role="dialog"
          aria-modal="true"
          aria-label="Listening"
          data-testid="voice-sheet"
        >
          <VoiceOrb level={voice.level} listening={voice.listening} className="w-56 h-56 sm:w-72 sm:h-72" />

          {/* What it has heard so far, as it hears it. A listening state with no
              transcript is a black box: you find out whether it understood you
              only after it has stopped. */}
          <p
            dir="auto"
            className="max-w-md text-center text-lg text-white/90 min-h-[3.5rem]"
            data-testid="voice-transcript"
          >
            {voice.transcript ||
              (arabic ? "تكلّم، وأنا أسمع…" : "Go ahead, I'm listening…")}
          </p>

          {voice.error && (
            <p className="max-w-md text-center text-sm text-red-300" data-testid="voice-error">
              {voiceErrorMessage(voice.error, arabic)}
            </p>
          )}

          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={voice.stop}
              className="rounded-full px-6"
              data-testid="button-voice-cancel"
            >
              <X className="w-4 h-4 mr-2" />
              {arabic ? "إلغاء" : "Cancel"}
            </Button>
            <Button
              type="button"
              onClick={voice.stop}
              className="rounded-full px-6 bg-secondary text-secondary-foreground"
              data-testid="button-voice-done"
            >
              <Check className="w-4 h-4 mr-2" />
              {arabic ? "تمّ" : "Done"}
            </Button>
          </div>
          <p className="text-xs text-white/45">
            {arabic ? "يمكنك تعديل النصّ قبل الإرسال." : "You can edit the text before sending."}
          </p>
        </div>,
          document.body,
        )}
    </>
  );
}
