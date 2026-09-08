/**
 * Talking to the editor, in the chat bar, with nothing taken over.
 *
 * The first version opened a full-screen sheet: the editor dimmed, the orb sat
 * alone in the middle of it, and the words appeared under it and were handed
 * over at the end. That was not asked for and it was wrong in the way that
 * matters — talking to something should not mean leaving the thing you were
 * looking at. You lose the video, the timeline and the moment you had parked on,
 * which are the things you are talking *about*.
 *
 * So: **the orb is the button.** It sits in the chat bar at rest, small and
 * still. Press it and it stays exactly where it is and comes alive, and what
 * you say lands in the input as you say it — the same box the keyboard fills,
 * live, so you watch it arrive and can fix it without waiting for anything to
 * close.
 */
import { useEffect, useRef } from "react";
import { Languages } from "lucide-react";
import { VoiceOrb } from "./orb";
import { useVoiceInput, voiceErrorMessage } from "./use-voice-input";
import { SPEECH_TAGS, type SpeechLanguage } from "./speech-language";
import { useLanguage } from "@/lib/language";
import { VOICE } from "@/lib/copy/editor";

export function VoiceInput({
  onTranscript,
  onError,
  existing = "",
  disabled = false,
  language,
  onLanguageChange,
}: {
  /** Every update while speaking, so the input fills as the words arrive. */
  onTranscript: (text: string, final: boolean) => void;
  /** So the caller can put the reason where the person is already looking. */
  onError?: (message: string | null) => void;
  /** Whatever is already in the box, so speaking adds rather than replaces. */
  existing?: string;
  disabled?: boolean;
  /** Which language to listen for. See `speech-language.ts` for how it is chosen. */
  language: SpeechLanguage;
  /** So the person can correct the guess, which is the one thing that fixes
   *  the case where every guess is wrong: they are switching languages. */
  onLanguageChange: (language: SpeechLanguage) => void;
}) {
  /*
    Two different languages, kept apart.

    `language` is what the microphone listens for. `screenLanguage` is what the
    person reads, and it is what the labels below are written in: a person using
    an Arabic product who has the microphone set to English should be told, in
    Arabic, that it is listening in English.
  */
  const { t, screenLanguage } = useLanguage();
  const arabic = screenLanguage === "ar";
  const voice = useVoiceInput({ lang: SPEECH_TAGS[language] });

  // The text before this turn started, so a second dictation adds to the
  // sentence instead of replacing it.
  const before = useRef("");
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  useEffect(() => {
    if (!voice.listening) return;
    onTranscriptRef.current(
      before.current ? `${before.current} ${voice.transcript}` : voice.transcript,
      false,
    );
  }, [voice.transcript, voice.listening]);

  useEffect(() => {
    onError?.(voice.error ? voiceErrorMessage(voice.error, arabic) : null);
    // onError is a render-stable callback in practice; the reason is the value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice.error, arabic]);

  // Nothing at all rather than a button that cannot work: Firefox has no
  // SpeechRecognition, and a dead microphone is a worse answer than a chat box
  // that simply expects typing.
  if (!voice.supported) return null;

  return (
    <button
      type="button"
      onClick={(e) => {
        // Inside a <form>: without this the first press submits the message.
        e.preventDefault();
        if (voice.listening) {
          voice.stop();
          return;
        }
        // Whatever they had already typed stays: dictation adds a sentence, it
        // does not take the box over.
        before.current = existing.trim();
        void voice.start();
      }}
      disabled={disabled}
      aria-label={voice.listening ? t(VOICE.stopListening) : t(VOICE.speak)}
      aria-pressed={voice.listening}
      title={t(VOICE.speak)}
      /* `relative` rather than `absolute`: the orb used to be floated into the
         right-hand end of the chat input along with two other controls. It has
         its own place in the composer now — first thing on the first row, at
         the size it deserves — so it lays out like everything else. The growth
         while listening is still free, because the sphere inside is what is
         absolutely positioned, not the button. */
      className={`relative shrink-0 h-11 w-11 rounded-full flex items-center justify-center
        transition-transform duration-200 disabled:opacity-40 disabled:pointer-events-none
        ${voice.listening ? "" : "hover:scale-105"}`}
      data-testid="button-voice"
    >
      {/* The light the sphere sits in.

          At rest the orb is a nearly-black glass ball — that is the material,
          and it is correct — but on a pale composer a dark disc reads as a
          hole rather than as an object. A soft brand-coloured bloom under it,
          blurred and slightly off-centre so it reads as a light source above
          and to one side, gives the sphere something to be glass *against*. It
          brightens while listening, with everything else. */}
      <span
        aria-hidden="true"
        className={`absolute inset-0 rounded-full blur-[7px] pointer-events-none transition-opacity duration-300
          ${voice.listening ? "opacity-100" : "opacity-70"}`}
        style={{
          background:
            "radial-gradient(circle at 34% 28%, hsl(var(--secondary) / 0.65) 0%, hsl(var(--primary) / 0.42) 52%, transparent 74%)",
        }}
      />
      {/* The same orb at both sizes, growing out of the button while it is
          listening rather than a sheet opening over the editor. It overflows
          the button on purpose — `absolute` here means the growth costs no
          layout, so the chat bar does not jump when you start speaking. */}
      <span
        className={`absolute pointer-events-none transition-all duration-300 ease-out
          ${voice.listening ? "w-20 h-20" : "w-10 h-10"}`}
      >
        <VoiceOrb level={voice.level} listening={voice.listening} className="w-full h-full" />
      </span>
      <span className="sr-only" data-testid="voice-transcript">
        {voice.transcript}
      </span>
    </button>
  );
}

/**
 * The language the microphone is listening for, as a control.
 *
 * Every way of choosing this is an inference, and the one moment they are all
 * wrong is the moment somebody switches language — which is exactly when they
 * will be told the speech recognition is broken. Two characters next to the
 * button costs almost nothing and makes that unfixable case fixable.
 */
export function SpeechLanguageToggle({
  language,
  onChange,
  disabled = false,
}: {
  language: SpeechLanguage;
  onChange: (language: SpeechLanguage) => void;
  disabled?: boolean;
}) {
  const { t } = useLanguage();
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        onChange(language === "ar" ? "en" : "ar");
      }}
      disabled={disabled}
      aria-label={language === "ar" ? t(VOICE.switchToEnglish) : t(VOICE.switchToArabic)}
      title={language === "ar" ? t(VOICE.listeningArabic) : t(VOICE.listeningEnglish)}
      /* A chip on the composer's second row now, beside the other controls,
         rather than a two-character label floated over the input. */
      className="composer-chip"
      data-testid="button-voice-language"
    >
      <Languages className="w-3.5 h-3.5" aria-hidden="true" />
      {language === "ar" ? "ع" : "EN"}
    </button>
  );
}
