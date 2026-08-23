/**
 * Turns what someone typed into an edit plan the worker can actually execute.
 *
 * This is not AI, and it does not pretend to be. It is a keyword matcher over
 * the operations that exist — which is exactly what the old version was, except
 * that one replied "I'll throw in some dynamic zooms" to a system with no zoom
 * operation, and then rendered nothing at all.
 *
 * The important property here is that the reply is derived from the plan, so it
 * cannot promise something the plan does not contain. When phase 4 puts a real
 * model behind this, the model's job is to emit one of these plans; everything
 * downstream stays as it is.
 */
import type { EditOperation, Platform } from "@workspace/api-zod";

export interface ParsedIntent {
  operations: EditOperation[];
  /** What we understood and will do, phrased for the user. */
  willDo: string[];
  /** Things they asked for that we recognise but cannot do yet. */
  cannotYet: string[];
}

const PLATFORM_WORDS: Array<{ platform: Platform; patterns: RegExp }> = [
  { platform: "tiktok", patterns: /\btiktok|tik tok\b/i },
  { platform: "reels", patterns: /\breels?|instagram|insta\b/i },
  { platform: "shorts", patterns: /\bshorts?|youtube|yt\b/i },
];

/** Asked-for things that are real product ideas but have no operation yet. */
const NOT_YET: Array<{ patterns: RegExp; label: string }> = [
  { patterns: /\bemoji/i, label: "add emojis" },
  { patterns: /\bmusic|beat|sound ?track\b/i, label: "add music or sync to a beat" },
  { patterns: /\bcolou?r|grade|cinematic|filter\b/i, label: "colour grade" },
  { patterns: /\bhook|first (two|2|three|3) seconds\b/i, label: "build a hook from the opening" },
  { patterns: /\btransition/i, label: "add transitions" },
];

/**
 * B-roll is not in that list any more, and the reason is worth stating.
 *
 * The operations for it exist, but only a model was ever able to choose them,
 * because choosing one means naming a file. And there is no model on a
 * deployment with no OpenAI key — which is this one — so everything built for
 * the library was unreachable from a sentence, and the honest reply "I can't
 * cut in B-roll yet" was describing a limitation of the *planner*, not of the
 * product.
 *
 * So the matcher reads the library too. It does not guess at a file's contents:
 * it places what is there, says exactly where it put it, and leaves correcting
 * that to the person, which is a conversation they can have. Nothing here is
 * cleverer than that, deliberately.
 */
export interface LibraryFile {
  id: string;
  kind: "video" | "image" | "audio";
  label: string | null;
}

const BROLL_WORDS = /\bb-?roll|cut ?away|cutaway|footage|insert (a |the )?(clip|shot)\b/i;
const OVERLAY_WORDS = /\blogo|overlay|screenshot|graphic|show (the |my )?(image|picture|photo)\b/i;

/**
 * Where cutaways go when nobody said.
 *
 * Not at zero — the opening is where a speaker establishes who they are, and
 * covering it is the one place a cutaway is always wrong. After that, spaced
 * far enough apart that two do not read as one.
 */
const CUTAWAY_SECONDS = [5, 15, 25];
const CUTAWAY_DURATION = 3;

/** A phrase in quotes is the one case where the words are unambiguously theirs. */
const QUOTED = /["“”']([^"“”']{1,120})["“”']/;

const SILENCE_WORDS =
  /\bsilence|silent|quiet|pause|dead air|um+s?\b|\bfiller|tighten|trim|short|fast|snapp|pace|boring|drag/i;

const VERTICAL_WORDS = /\bvertical|9:16|portrait|full ?screen\b/i;

const CAPTION_WORDS = /\bcaption|subtitle|sub ?titles?|text on screen|on-?screen text\b/i;
const KARAOKE_WORDS = /\bkaraoke|word by word|word-by-word|highlight/i;
const YELLOW_WORDS = /\byellow|gold\b/i;

/**
 * Asking for the strongest stretch, in the ways people actually ask.
 *
 * "highlight" alone is deliberately not enough — KARAOKE_WORDS above already
 * reads it as a caption style ("highlight each word"), so the highlight *cut*
 * needs the shape of a request for a piece of the clip: "the best part",
 * "strongest 30 seconds", "a highlight reel", "just the good bit".
 */
const HIGHLIGHT_WORDS =
  /\b(best|strongest|good|top|most interesting) ?\d* ?(part|parts|bit|bits|moment|moments|section|seconds?|secs?|s\b)|highlight reel|the highlight\b|أفضل جزء|أقوى جزء|أفضل لقطة|أقوى لقطة|مقتطف|الزبدة|زبدة الفيديو/i;
/** "best 45 seconds", "the top 20s" — the number they said, not our default. */
const HIGHLIGHT_SECONDS = /\b(\d{1,3}) ?(?:seconds?|secs?|s\b|ثانية|ثواني)/i;

const PUNCH_WORDS = /\bzoom|punch|emphasi[sz]|energetic|energy|dynamic|hype\b/i;
const PUSH_WORDS = /\bslow (push|zoom)|ken burns|drift|subtle move|cinematic move\b/i;
const LOUDNESS_WORDS = /\bloud|volume|quiet|audio level|sound level|normali[sz]/i;

export function planFromText(
  text: string,
  options: { defaultPlatform?: Platform | null; assets?: LibraryFile[] } = {},
): ParsedIntent {
  const operations: EditOperation[] = [];
  const willDo: string[] = [];
  const cannotYet: string[] = [];

  const wantsSilenceCut = SILENCE_WORDS.test(text);
  const platform = PLATFORM_WORDS.find((p) => p.patterns.test(text))?.platform ?? null;
  const wantsVertical = platform !== null || VERTICAL_WORDS.test(text);

  if (wantsSilenceCut) {
    operations.push({ type: "removeSilence", thresholdDb: -32, minSilenceMs: 500, paddingMs: 80 });
    willDo.push("cut out the silences and dead air");
  }

  // The person asks for a length; where those seconds live is the worker's
  // judgement, made from the transcript. The plan carries only the length.
  if (HIGHLIGHT_WORDS.test(text)) {
    const asked = HIGHLIGHT_SECONDS.exec(text);
    const targetSeconds = Math.min(120, Math.max(5, asked ? Number(asked[1]) : 30));
    operations.push({ type: "extractHighlight", targetSeconds });
    willDo.push(`pull the strongest ${targetSeconds} seconds into its own cut`);
  }

  if (wantsVertical) {
    const target = platform ?? options.defaultPlatform ?? "tiktok";
    operations.push({ type: "formatForPlatform", platform: target });
    willDo.push(`reframe it to 9:16 for ${target}`);
  }

  // The words are in the video, not in this sentence, so the plan asks for
  // captions and the worker fills them in once it has heard the clip. If no
  // recogniser is configured there, the render comes back saying so.
  if (CAPTION_WORDS.test(text)) {
    operations.push({
      type: "autoCaptions",
      style: KARAOKE_WORDS.test(text) ? "karaoke-box" : YELLOW_WORDS.test(text) ? "bold-yellow" : "bold-white",
      animation: KARAOKE_WORDS.test(text) ? "karaoke" : "pop",
      dropFillers: true,
    });
    willDo.push("caption it from what is actually said");
  }

  // An empty `at` means "you choose": the worker puts the punches where the
  // speaker leaned on a word, which it can only know after transcribing.
  if (PUNCH_WORDS.test(text)) {
    operations.push({ type: "zoomPunch", at: [], amount: 0.13, holdMs: 1000 });
    willDo.push("punch in where you lean on a word");
  } else if (PUSH_WORDS.test(text)) {
    operations.push({ type: "kenBurns", to: 1.08 });
    willDo.push("add a slow push so the frame is not static");
  }

  if (LOUDNESS_WORDS.test(text)) {
    operations.push({ type: "normalizeLoudness", targetLufs: -14 });
    willDo.push("level the audio to what these platforms expect");
  }

  // ── The project's own files ────────────────────────────────────────────────
  const library = options.assets ?? [];
  const clips = library.filter((a) => a.kind === "video");
  const stills = library.filter((a) => a.kind === "image");

  if (BROLL_WORDS.test(text)) {
    if (clips.length === 0) {
      cannotYet.push("cut in B-roll, because this project has no clips to cut to yet");
    } else {
      clips.slice(0, CUTAWAY_SECONDS.length).forEach((clip, index) => {
        const at = CUTAWAY_SECONDS[index]!;
        operations.push({
          type: "insertBRoll",
          assetId: clip.id,
          at,
          durationSeconds: CUTAWAY_DURATION,
          fit: "cover",
          keepSourceAudio: true,
        });
        willDo.push(`cut away to ${describeFile(clip)} at ${at}s`);
      });
    }
  }

  if (OVERLAY_WORDS.test(text)) {
    if (stills.length === 0) {
      cannotYet.push("put an image over the frame, because this project has no images yet");
    } else {
      const still = stills[0]!;
      operations.push({
        type: "overlayImage",
        assetId: still.id,
        at: 1,
        durationSeconds: 4,
        // A logo lives in a corner. Anywhere else covers the speaker's face,
        // which is the one thing the frame is for.
        position: "top-right",
        scale: 0.25,
        opacity: 1,
      });
      willDo.push(`hold ${describeFile(still)} in the corner from 1s`);
    }
  }

  // A title needs words, and the only words we can be certain are theirs are
  // the ones they put in quotes. Anything else would be us writing their copy.
  const quoted = QUOTED.exec(text);
  if (quoted) {
    const words = quoted[1]!.trim();
    if (words.length > 0) {
      operations.push({
        type: "motionTitle",
        text: words.slice(0, 120),
        at: 0.5,
        durationSeconds: 2.5,
        style: "card",
        position: "center",
      });
      willDo.push(`bring in the words "${words}" near the start`);
    }
  } else if (/\btitle|\btext on screen\b/i.test(text) && !CAPTION_WORDS.test(text)) {
    cannotYet.push('animate a title, because I do not know the words — put them in quotes and I will');
  }

  for (const { patterns, label } of NOT_YET) {
    if (patterns.test(text)) cannotYet.push(label);
  }

  return { operations, willDo, cannotYet };
}

/** A file by its own name where it has one, and by its kind where it does not. */
function describeFile(file: LibraryFile): string {
  const label = (file.label ?? "").trim();
  if (!label) return file.kind === "image" ? "your image" : "your clip";
  return `"${label.slice(0, 60)}"`;
}

/**
 * The assistant's reply. Written from the parsed plan so it can only claim what
 * the worker will really do — and says plainly when it cannot do something.
 */
export function replyFor(
  intent: ParsedIntent,
  context: {
    hasVideo: boolean;
    /**
     * What happened when the server tried to start the render for this
     * message. "started" is the promise of the product — one prompt, and the
     * work begins; the person is told it is running, not told which button to
     * press next. "blocked" carries the refusal in words (a render already
     * going, the month's minutes spent). Absent means nothing was attempted —
     * no operations, or no video — and the reply reads as before.
     */
    render?: { started: true } | { started: false; because: string };
  },
): string {
  if (!context.hasVideo) {
    return "Upload a video first and I'll get to work — I can cut the silences out, caption it from what you actually say, reframe it for TikTok, Reels or Shorts, add motion, and level the audio.";
  }

  const parts: string[] = [];

  if (intent.willDo.length > 0) {
    if (context.render?.started) {
      parts.push(`On it — I'll ${joinNaturally(intent.willDo)}. It's rendering now; you'll see it here the moment it's done.`);
    } else if (context.render && !context.render.started) {
      parts.push(`I'd ${joinNaturally(intent.willDo)} — but I can't start it right now: ${context.render.because}`);
    } else {
      parts.push(`Right — I'll ${joinNaturally(intent.willDo)}. Hit Generate Edit and I'll start.`);
    }
  }

  if (intent.cannotYet.length > 0) {
    parts.push(
      `I can't ${joinNaturally(intent.cannotYet)} yet, so I'll leave ${intent.cannotYet.length > 1 ? "those" : "that"} out rather than pretend.`,
    );
  }

  if (parts.length === 0) {
    return (
      "I'm not sure what to change from that. Right now I can cut the silences out of a clip, " +
      "caption it, reframe it to 9:16, add punch-in zooms or a slow push, and level the audio — try " +
      'something like "remove the dead air, caption it and make it vertical for TikTok".'
    );
  }

  return parts.join(" ");
}

function joinNaturally(items: string[]): string {
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}
