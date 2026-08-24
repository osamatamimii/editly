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

/**
 * Order is priority: the first pattern that matches wins.
 *
 * "shorts" is tested before plain "youtube" on purpose — "youtube shorts" is a
 * vertical frame and "youtube" on its own is not, and until widescreen existed
 * both fell into the same bucket. Instagram is last for the same reason:
 * "instagram feed" is a square, "instagram" alone is a reel.
 */
const PLATFORM_WORDS: Array<{ platform: Platform; patterns: RegExp }> = [
  { platform: "tiktok", patterns: /\btiktok|tik tok\b/i },
  { platform: "reels", patterns: /\breels?\b/i },
  { platform: "shorts", patterns: /\bshorts?\b/i },
  { platform: "square", patterns: /\bsquare\b|1:1|\bfeed post\b|\blinkedin\b|مربع/i },
  { platform: "youtube", patterns: /\byoutube\b|\byt\b|\blandscape\b|\bwidescreen\b|16:9|أفقي|عريض/i },
  { platform: "reels", patterns: /\binstagram|insta\b/i },
];

/** What the frame will actually be, said the way a person would say it. */
function shapeLabel(platform: Platform): string {
  if (platform === "youtube") return "16:9";
  if (platform === "square") return "1:1";
  return "9:16";
}

/** Asked-for things that are real product ideas but have no operation yet. */
/**
 * Asked-for things that are real product ideas but have no operation yet.
 *
 * This list has to be pruned as things get built, or it starts lying in the
 * other direction — a product that says "I can't do transitions" the week
 * after transitions shipped is as dishonest as one that promises what it
 * cannot do. Two entries were narrowed for exactly that reason:
 *
 * - Transitions: a fade at the ends exists now, so only the *between-cuts*
 *   kind is still missing, and only that is claimed.
 * - Colour: matching a reference video's colour exists, so the reply points
 *   at it rather than refusing the whole subject.
 */
const NOT_YET: Array<{ patterns: RegExp; label: string }> = [
  { patterns: /\bemoji/i, label: "add emojis" },
  { patterns: /\bmusic|beat|sound ?track\b/i, label: "add music or sync to a beat" },
  {
    patterns: /\bcolou?r|grade|cinematic|filter\b/i,
    label: "grade the colour on its own — but upload a video whose look you want and I will match it",
  },
  {
    // "fade" is deliberately absent: the fade is built. What is still missing
    // is the join between two cuts — a crossfade, a wipe, a slide.
    patterns: /\bcross ?fade|dissolve|\bwipe\b|\bslide\b|transition between|between (the )?(cuts|clips)/i,
    label: "put a transition between the cuts",
  },
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

/**
 * A stretch named by its moments, in the ways people actually name them.
 *
 * Four shapes, tried most-specific first: "1:20 to 2:10", "minute 2 to 3",
 * "from 40 to 90 seconds" (a seconds unit is required somewhere, so "from 3
 * to 5" about anything else does not become a cut), and "the first 40
 * seconds". The first-N form starts at five seconds on purpose: "the first
 * 3 seconds" belongs to hook-building, which is still on the not-yet list,
 * and claiming it as a cut would do something nobody asked for.
 */
const TO = "(?:to|until|till|thru|through|[-\u2013\u2192]|\u0625\u0644\u0649|\u0627\u0644\u0649|\u062d\u062a\u0649|\u0644\u063a\u0627\u064a\u0629)";
const RANGE_MMSS = new RegExp(String.raw`(\d{1,3}):([0-5]\d)\s*${TO}\s*(\d{1,3}):([0-5]\d)`, "i");
const RANGE_MINUTES = new RegExp(
  String.raw`(?:minute|\u0627\u0644\u062f\u0642\u064a\u0642\u0629|\u062f\u0642\u064a\u0642\u0629)\s*(\d{1,3})\s*${TO}\s*(?:minute|\u0627\u0644\u062f\u0642\u064a\u0642\u0629|\u062f\u0642\u064a\u0642\u0629)?\s*(\d{1,3})`,
  "i",
);
const RANGE_SECONDS = new RegExp(
  String.raw`(?:from|\u0645\u0646)\s*(?:second|\u0627\u0644\u062b\u0627\u0646\u064a\u0629)?\s*(\d{1,4})\s*(?:seconds?|secs?|s\b)?\s*${TO}\s*(\d{1,4})\s*(?:seconds?|secs?|s\b|\u062b\u0627\u0646\u064a\u0629|\u062b\u0648\u0627\u0646\u064a)`,
  "i",
);
const RANGE_FIRST = /\b(?:first|opening|أول|اول)\s*(\d{1,4})\s*(?:seconds?|secs?|s\b|ثانية|ثواني)/i;
const RANGE_FIRST_MINUTES = /\b(?:first|opening|أول|اول)\s*(\d{1,3})?\s*(?:minutes?|دقيقة|دقائق)/i;

/** The stretch the sentence names, or null when it names none. */
export function parseRange(text: string): { startSeconds: number; endSeconds: number } | null {
  const mmss = RANGE_MMSS.exec(text);
  if (mmss) {
    const start = Number(mmss[1]) * 60 + Number(mmss[2]);
    const end = Number(mmss[3]) * 60 + Number(mmss[4]);
    return end > start ? { startSeconds: start, endSeconds: end } : { startSeconds: end, endSeconds: start };
  }
  const minutes = RANGE_MINUTES.exec(text);
  if (minutes) {
    const a = Number(minutes[1]) * 60;
    const b = Number(minutes[2]) * 60;
    // "minute 2 to 3" reads as 2:00 to 3:00 — the marks, not the ordinals.
    return a < b ? { startSeconds: a, endSeconds: b } : { startSeconds: b, endSeconds: a };
  }
  const seconds = RANGE_SECONDS.exec(text);
  if (seconds) {
    const a = Number(seconds[1]);
    const b = Number(seconds[2]);
    if (a === b) return null;
    return a < b ? { startSeconds: a, endSeconds: b } : { startSeconds: b, endSeconds: a };
  }
  const firstSeconds = RANGE_FIRST.exec(text);
  if (firstSeconds) {
    const n = Number(firstSeconds[1]);
    if (n >= 5) return { startSeconds: 0, endSeconds: n };
    return null;
  }
  const firstMinutes = RANGE_FIRST_MINUTES.exec(text);
  if (firstMinutes) {
    const n = firstMinutes[1] ? Number(firstMinutes[1]) : 1;
    if (n >= 1 && n <= 180) return { startSeconds: 0, endSeconds: n * 60 };
  }
  return null;
}

/**
 * Asking for the video to be cut into pieces, each its own output.
 *
 * Deliberately narrow: a bare "clip" is how people refer to the video itself
 * ("this clip"), and B-roll requests say "insert a clip". So the ask must
 * carry either a number ("3 clips"), the into-shape ("split it into clips",
 * "into shorts"), or the Arabic verb for dividing. The model path catches the
 * phrasings this matcher will not.
 */
const CLIPS_COUNT = /\b(\d{1,2})\s*(?:clips?|shorts|\u0645\u0642\u0627\u0637\u0639|\u0642\u0635\u0627\u0635\u0627\u062a|\u0623\u062c\u0632\u0627\u0621)\b/i;
const CLIPS_INTO = /\b(?:into|in ?to)\s+(?:clips|shorts|pieces)\b|\u0642\u0633\u0651?\u0645\u0647?[^.]*(?:\u0645\u0642\u0627\u0637\u0639|\u0642\u0635\u0627\u0635\u0627\u062a|\u0623\u062c\u0632\u0627\u0621)/i;

/** The clips ask, or null. Count clamps to [2, 6]; length reuses the seconds pattern. */
export function parseClips(text: string): { count: number; targetSeconds: number } | null {
  const counted = CLIPS_COUNT.exec(text);
  const into = CLIPS_INTO.test(text);
  if (!counted && !into) return null;
  const count = Math.min(6, Math.max(2, counted ? Number(counted[1]) : 3));
  const asked = HIGHLIGHT_SECONDS.exec(text);
  const targetSeconds = Math.min(120, Math.max(5, asked ? Number(asked[1]) : 30));
  return { count, targetSeconds };
}

const PUNCH_WORDS = /\bzoom|punch|emphasi[sz]|energetic|energy|dynamic|hype\b/i;
const PUSH_WORDS = /\bslow (push|zoom)|ken burns|drift|subtle move|cinematic move\b/i;
const LOUDNESS_WORDS = /\bloud|volume|quiet|audio level|sound level|normali[sz]/i;
// "fade" alone is enough — every reading of it in an edit request means the
// ends ("fade it in", "fade to black", "soft ending"). Arabic: تلاشي/تلاشى.
// A hook is the one edit everyone names the same way. "Cold open" is the film
// term; "start with the best bit" is what people actually type.
const HOOK_WORDS =
  /\bhook\b|\bcold open\b|start (?:it )?with the (?:best|strongest)|open (?:it )?(?:on|with) the (?:best|strongest)|\bهوك\b|ابدأ بالأقوى|ابدأ بأقوى/i;

const FADE_WORDS = /\bfade|fade[- ]?(?:in|out)|to black|soft (?:opening|ending|start|end)|تلاشي|تلاشى/i;

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

  // Several pieces, each its own output. Checked before the highlight and the
  // range: "the best 3 clips" is a clips ask, and the worker would drop a
  // stray highlight riding along anyway — better not to promise one.
  const clipsAsk = parseClips(text);
  if (clipsAsk) {
    operations.push({ type: "extractClips", ...clipsAsk });
    willDo.push(
      `cut it into ${clipsAsk.count} separate clips of about ${clipsAsk.targetSeconds} seconds each`,
    );
  }

  // The person asks for a length; where those seconds live is the worker's
  // judgement, made from the transcript. The plan carries only the length.
  if (!clipsAsk && HIGHLIGHT_WORDS.test(text)) {
    const asked = HIGHLIGHT_SECONDS.exec(text);
    const targetSeconds = Math.min(120, Math.max(5, asked ? Number(asked[1]) : 30));
    operations.push({ type: "extractHighlight", targetSeconds });
    willDo.push(`pull the strongest ${targetSeconds} seconds into its own cut`);
  }

  // The stretch they named, kept exactly. The mirror of the highlight: there
  // the worker chooses the moments, here the person already has.
  const range = clipsAsk ? null : parseRange(text);
  if (range) {
    operations.push({ type: "extractRange", ...range });
    willDo.push(`keep just ${clockOf(range.startSeconds)}\u2013${clockOf(range.endSeconds)}, the stretch you named`);
  }

  if (wantsVertical) {
    const target = platform ?? options.defaultPlatform ?? "tiktok";
    operations.push({ type: "formatForPlatform", platform: target });
    willDo.push(`reframe it to ${shapeLabel(target)} for ${target}`);
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

  // A bare "add transitions" used to be refused outright. The fade at the ends
  // is a transition and it is built, so the ask now produces it — and the
  // narrower "between the cuts" entry above still says what is missing, so
  // nobody is told they got something they did not.
  if (HOOK_WORDS.test(text)) {
    operations.push({ type: "coldOpen", seconds: 4 });
    willDo.push("open on the strongest moment, then play the rest from the top");
  }

  if (FADE_WORDS.test(text) || /\btransitions?\b|\bانتقال|انتقالات/i.test(text)) {
    operations.push({ type: "fade", durationMs: 500 });
    willDo.push("open it from black and close it to black");
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

/** Seconds as m:ss, because "80s" is a number and "1:20" is a moment. */
function clockOf(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
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
    return "Upload a video first and I'll get to work — I can pull out the strongest 30 seconds, keep exactly a stretch you name (from 1:20 to 2:10), cut it into separate clips, cut the silences, caption it from what you actually say, reframe it for TikTok, Reels or Shorts - or 16:9 for YouTube, or square for a feed - add motion, fade it in and out, and level the audio.";
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
      "I'm not sure what to change from that. Right now I can pull out the best 30 seconds of a clip, " +
      "keep exactly a stretch you name (from 1:20 to 2:10), cut it into separate clips, cut the silences, caption it, reframe it to 9:16 or 16:9 or square, " +
      "add punch-in zooms or a slow push, fade it in and out, and level the audio — try something like " +
      '"give me the strongest 30 seconds, captioned, vertical for TikTok".'
    );
  }

  return parts.join(" ");
}

function joinNaturally(items: string[]): string {
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}
