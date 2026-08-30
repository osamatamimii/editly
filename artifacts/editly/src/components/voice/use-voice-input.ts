/**
 * Listening, as a hook: speech to text, and how loud you are while you say it.
 *
 * Two separate things happen here and they come from two different APIs, which
 * is worth saying because it is the reason the orb is honest. `SpeechRecognition`
 * gives the words; the Web Audio API gives the loudness. If the orb were driven
 * by the recogniser it would only move when a phrase landed, half a second late.
 * Driven by the analyser it moves with the sound itself, so what you see is what
 * the microphone is hearing.
 *
 * **This runs in the browser, and the browser is not always able.** Chrome, Edge
 * and Safari have `SpeechRecognition` (Safari and older Chrome under
 * `webkitSpeechRecognition`); Firefox does not. So it is feature-detected and
 * `supported` is returned, rather than a button that does nothing being shown to
 * a third of the internet. The upgrade — recording the audio and transcribing it
 * with the same Deepgram and ElevenLabs pair the renderer already uses, which
 * would work everywhere and is better at Arabic — needs those keys on the API
 * rather than only on the worker, so it is a deliberate next step and not a
 * silent gap.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** What the browser calls it, whichever browser this is. */
type RecognitionCtor = new () => SpeechRecognitionLike;

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<
    ArrayLike<{ transcript: string }> & { isFinal: boolean }
  >;
}

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export type VoiceError =
  | "not-allowed"
  | "no-speech"
  | "audio-capture"
  | "network"
  | "unknown";

/**
 * What went wrong, in words somebody can act on.
 *
 * The browser hands back a short machine string. Putting that on the screen is
 * the same mistake the render notes stopped making: `not-allowed` is not a
 * sentence, and the person reading it has to guess that it means their own
 * browser is holding the microphone back.
 */
export function voiceErrorMessage(error: VoiceError, arabic: boolean): string {
  switch (error) {
    case "not-allowed":
      return arabic
        ? "المتصفّح لم يسمح بالوصول إلى الميكروفون. اسمح له من شريط العنوان وحاول ثانية."
        : "Your browser is holding the microphone back. Allow it from the address bar and try again.";
    case "no-speech":
      return arabic ? "لم أسمع شيئًا. جرّب مرّة أخرى." : "I didn't hear anything. Try again.";
    case "audio-capture":
      return arabic
        ? "لا أجد ميكروفونًا على هذا الجهاز."
        : "I can't find a microphone on this device.";
    case "network":
      return arabic
        ? "التعرّف على الكلام يحتاج اتصالًا، والاتصال انقطع."
        : "Speech recognition needs a connection, and it dropped.";
    default:
      return arabic ? "تعذّر الاستماع هذه المرّة." : "That didn't work this time.";
  }
}

export interface VoiceInput {
  /** Whether this browser can do it at all. */
  supported: boolean;
  listening: boolean;
  /** Microphone loudness, 0 to 1, updated every frame while listening. */
  level: number;
  /** What has been heard so far, including the part not yet settled. */
  transcript: string;
  error: VoiceError | null;
  start: () => void;
  stop: () => void;
}

export function useVoiceInput({
  lang = "en-US",
  onFinal,
}: {
  lang?: string;
  /** Called once, when listening ends, with everything that was heard. */
  onFinal?: (text: string) => void;
} = {}): VoiceInput {
  const [supported] = useState(() => recognitionCtor() !== null);
  const [listening, setListening] = useState(false);
  const [level, setLevel] = useState(0);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState<VoiceError | null>(null);

  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const audio = useRef<{ ctx: AudioContext; stream: MediaStream; raf: number } | null>(null);
  const finalText = useRef("");
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  /** Everything this hook holds open, closed in one place. */
  const teardown = useCallback(() => {
    const a = audio.current;
    if (a) {
      cancelAnimationFrame(a.raf);
      // The track has to be stopped explicitly. Without this the browser keeps
      // showing the recording indicator after the orb has gone, which is its
      // own kind of lie.
      a.stream.getTracks().forEach((t) => t.stop());
      void a.ctx.close().catch(() => {});
      audio.current = null;
    }
    setLevel(0);
  }, []);

  useEffect(() => teardown, [teardown]);

  const stop = useCallback(() => {
    recognition.current?.stop();
    recognition.current = null;
    teardown();
    setListening(false);
    const text = finalText.current.trim();
    if (text) onFinalRef.current?.(text);
  }, [teardown]);

  const start = useCallback(() => {
    const Ctor = recognitionCtor();
    if (!Ctor || recognition.current) return;

    setError(null);
    setTranscript("");
    finalText.current = "";

    const rec = new Ctor();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0]?.transcript ?? "";
        if (result.isFinal) finalText.current += text;
        else interim += text;
      }
      setTranscript((finalText.current + interim).trimStart());
    };
    rec.onerror = (event) => {
      const known: VoiceError[] = ["not-allowed", "no-speech", "audio-capture", "network"];
      setError(known.includes(event.error as VoiceError) ? (event.error as VoiceError) : "unknown");
    };
    rec.onend = () => {
      // Ending is the recogniser's decision as often as ours, so the state that
      // says "listening" follows it rather than the button.
      recognition.current = null;
      teardown();
      setListening(false);
    };

    recognition.current = rec;
    setListening(true);
    try {
      rec.start();
    } catch {
      recognition.current = null;
      setListening(false);
      setError("unknown");
      return;
    }

    // The loudness, from the microphone directly. Asked for separately from the
    // recogniser on purpose: this is what the orb moves on, and it has to be
    // live rather than arriving with the words.
    void navigator.mediaDevices
      ?.getUserMedia({ audio: true })
      .then((stream) => {
        if (!recognition.current) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const Ctx =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctx) return;
        const ctx = new Ctx();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.75;
        source.connect(analyser);
        const buffer = new Uint8Array(analyser.frequencyBinCount);

        const tick = () => {
          analyser.getByteTimeDomainData(buffer);
          // RMS around the centre, which is amplitude rather than brightness.
          let sum = 0;
          for (let i = 0; i < buffer.length; i++) {
            const v = (buffer[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / buffer.length);
          // A speaking voice sits well below full scale, so the useful range is
          // stretched: without this the orb barely moves at a normal volume.
          setLevel(Math.min(1, rms * 4.5));
          if (audio.current) audio.current.raf = requestAnimationFrame(tick);
        };
        audio.current = { ctx, stream, raf: requestAnimationFrame(tick) };
      })
      .catch(() => {
        // The recogniser has its own permission prompt and its own error path;
        // failing to get a second stream costs the animation, not the words.
      });
  }, [lang, teardown]);

  return { supported, listening, level, transcript, error, start, stop };
}
