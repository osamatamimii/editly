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
import { VoiceOrb } from "./orb";
import { useVoiceInput, voiceErrorMessage } from "./use-voice-input";

export function VoiceInput({
  onTranscript,
  onError,
  existing = "",
  disabled = false,
  arabic = false,
}: {
  /** Every update while speaking, so the input fills as the words arrive. */
  onTranscript: (text: string, final: boolean) => void;
  /** So the caller can put the reason where the person is already looking. */
  onError?: (message: string | null) => void;
  /** Whatever is already in the box, so speaking adds rather than replaces. */
  existing?: string;
  disabled?: boolean;
  arabic?: boolean;
}) {
  const voice = useVoiceInput({ lang: arabic ? "ar-SA" : "en-US" });

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
      aria-label={arabic ? (voice.listening ? "أوقف الاستماع" : "تكلّم بدل الكتابة") : voice.listening ? "Stop listening" : "Speak instead of typing"}
      aria-pressed={voice.listening}
      title={arabic ? "تكلّم بدل الكتابة" : "Speak instead of typing"}
      className={`absolute right-12 top-1 h-10 w-10 rounded-full flex items-center justify-center
        transition-transform duration-200 disabled:opacity-40 disabled:pointer-events-none
        ${voice.listening ? "" : "hover:scale-105"}`}
      data-testid="button-voice"
    >
      {/* The same orb at both sizes, growing out of the button while it is
          listening rather than a sheet opening over the editor. It overflows
          the button on purpose — `absolute` here means the growth costs no
          layout, so the chat bar does not jump when you start speaking. */}
      <span
        className={`absolute pointer-events-none transition-all duration-300 ease-out
          ${voice.listening ? "w-20 h-20" : "w-9 h-9"}`}
      >
        <VoiceOrb level={voice.level} listening={voice.listening} className="w-full h-full" />
      </span>
      <span className="sr-only" data-testid="voice-transcript">
        {voice.transcript}
      </span>
    </button>
  );
}
