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
import type { EditOperation, GradeLook, MusicMood, Platform, TransitionStyle } from "@workspace/api-zod";
import { MUSIC_MOOD_NAMES } from "@workspace/api-zod";
import { interstitialCard } from "./scenes";

/**
 * One thing to say, in both languages.
 *
 * Not an English string with a translation table beside it: a note that can
 * exist without its Arabic is a note that will ship without its Arabic, and
 * the reply will quietly fall back to English on exactly the sentence nobody
 * checked. Both halves are required by the type, so the compiler asks the
 * question at the moment the note is written, which is the only moment anyone
 * knows the answer.
 */
export interface Phrase {
  en: string;
  ar: string;
}

/** Written as `say(en, ar)` at every call site, to keep them on one line. */
const say = (en: string, ar: string): Phrase => ({ en, ar });

/**
 * Which language to answer in.
 *
 * Any Arabic letter anywhere in the ask. Somebody who typed «اقصّ الصمت make
 * it vertical» reads Arabic, and a mixed sentence answered in English is the
 * same failure as a pure one. There is no setting for this and there should
 * not be: the person already told us, by typing.
 */
export type Language = "en" | "ar";
export const languageOf = (text: string): Language =>
  /[\u0600-\u06ff\u0750-\u077f]/.test(text) ? "ar" : "en";

export interface ParsedIntent {
  operations: EditOperation[];
  /** What we understood and will do, phrased for the user. */
  willDo: Phrase[];
  /** Things they asked for that we recognise but cannot do yet. */
  cannotYet: Phrase[];
  /** The language they asked in, which is the language of the reply. */
  language: Language;
  /**
   * Which subjects the sentence itself decided.
   *
   * Not the same as which operations came out. "no captions on this one"
   * produces no caption operation and is a decision *about* captions — and
   * anything that fills in a person's usual settings has to be able to tell
   * those two apart, or the one sentence where somebody says no gets captions
   * anyway. See `lib/habits.ts`.
   *
   * A subject is spoken if the words are about it, whichever way they went.
   */
  spoke: SpokenSubjects;
  /**
   * The subjects this sentence said no to.
   *
   * A subset of `spoke`, and a different question from it: `spoke` is true
   * whichever way the sentence went, and this is true only for the no. Read by
   * the reply, so that a sentence which is nothing but a refusal is answered
   * with the refusal rather than with "I did not catch that".
   */
  declined: Array<keyof SpokenSubjects>;
}

/**
 * The subjects a sentence can decide, and the one place they are listed.
 *
 * This shape was written out three times — here, in `direct.ts` and in
 * `habits.ts` — and the parser is the only one of the three that fills it in.
 * That is not a tidiness complaint: it is exactly why a subject could be added
 * to the parser and never reach the two layers that exist to be silenced by it.
 * `music` was added and threaded through by hand; `coverage` and `sfx` were
 * not, and both auto-direction rules went on overriding people who had said no
 * for as long as that was true. Named once, adding a subject is a type error
 * everywhere it has to be handled.
 *
 * A subject is spoken if the words are about it, **whichever way they went**.
 * A refusal is a decision.
 */
export interface SpokenSubjects {
  platform: boolean;
  captions: boolean;
  silence: boolean;
  music: boolean;
  /** Changing shot size or angle: `alternateFraming`, and any b-roll with it. */
  coverage: boolean;
  /** The quiet whooshes under the cuts: `soundEffects`. */
  sfx: boolean;
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
  { platform: "tiktok", patterns: /\btiktok|tik tok\b|تيك ?توك/i },
  { platform: "reels", patterns: /\breels?\b|ريلز/i },
  { platform: "shorts", patterns: /\bshorts?\b|شورتس/i },
  { platform: "square", patterns: /\bsquare\b|1:1|\bfeed post\b|\blinkedin\b|مربع/i },
  // «عرضي» and «بالعرض» are how anybody actually says widescreen out loud;
  // «عريض» alone is the word a specification uses. Both, because a customer
  // who typed the ordinary one got no shape at all and no note saying why.
  { platform: "youtube", patterns: /\byoutube\b|\byt\b|\blandscape\b|\bwidescreen\b|16:9|افقي|عريض|عرضي|بالعرض/i },
  { platform: "reels", patterns: /\binstagram|insta\b/i },
];

/** The aspect ratio, for the places that want the numbers. */
function shapeLabel(platform: Platform): string {
  if (platform === "youtube") return "16:9";
  if (platform === "square") return "1:1";
  return "9:16";
}

/**
 * The same thing, for somebody who has never edited a video.
 *
 * "9:16" is a ratio, and a ratio is a thing you learn from editing software.
 * Asked what he wants to see before a render starts, Osama said: first it
 * tells you what it is going to do, **in words somebody who has never made an
 * edit would understand**. «أعيد تأطيره 9:16» fails that twice over, once on
 * «تأطير» and once on the numbers.
 *
 * The ratio has not gone anywhere: it is still what the render uses and still
 * what `shapeLabel` returns for the places that report it. This is only what
 * the sentence says.
 */
/**
 * A platform, spelled the way its own logo spells it.
 *
 * `op.platform` is a lowercase key -- `tiktok`, `youtube` -- and it was being
 * interpolated straight into the sentence, so the most-read line in the
 * product read «أخلّيه عمودي لـtiktok»: an English word in lowercase, glued to
 * an Arabic preposition. Four words further on, the same reply says it will
 * write captions "because most people watch with the sound off". One of those
 * two sentences was written for a person and the other was not.
 *
 * Arabic gets the Arabic spelling, which is what the platforms use themselves
 * in Arabic. `square` is not a platform at all, so it is named by what it is
 * for rather than by a brand.
 *
 * And the preposition is plain «ل», not «لـ». The connector was there because
 * what followed was Latin script and had to be held off from the letter; an
 * Arabic word attaches to it the ordinary way, so «لتيك توك» is what anybody
 * would write and «لـتيك توك» is a seam showing.
 */
const PLATFORM_NAMES: Record<string, { en: string; ar: string }> = {
  tiktok: { en: "TikTok", ar: "تيك توك" },
  reels: { en: "Reels", ar: "ريلز" },
  shorts: { en: "Shorts", ar: "شورتس" },
  youtube: { en: "YouTube", ar: "يوتيوب" },
  square: { en: "a feed post", ar: "منشور بالفيد" },
};

export function platformInWords(platform: string, lang: Language): string {
  return PLATFORM_NAMES[platform]?.[lang] ?? platform;
}

export function shapeInWords(platform: Platform): { en: string; ar: string } {
  if (platform === "youtube") return { en: "wide", ar: "عريض" };
  if (platform === "square") return { en: "square", ar: "مربّع" };
  return { en: "vertical", ar: "عمودي" };
}

/**
 * The named looks, in the words people use for them.
 *
 * Order matters: the list is walked top to bottom and the first hit wins, so
 * the specific sits above the general. "black and white and cinematic" is a
 * sentence somebody will write, and mono is the half that is unambiguous.
 *
 * "cinematic" is the one word here that means nothing precise — it is a mood,
 * not a measurement — so it maps to the teal-and-orange split, which is what
 * the word has come to mean in practice whatever it used to mean.
 */
const LOOK_WORDS: Array<{ look: GradeLook; patterns: RegExp }> = [
  { look: "mono", patterns: /\bblack ?(and|&) ?white\b|\bb\s?&\s?w\b|\bmonochrome|\bgrayscale|\bgreyscale|ابيض واسود|ابيض واسود|بالابيض والاسود/i },
  { look: "cinematic", patterns: /\bcinematic|\bfilm ?look|\bmovie ?look|\bteal ?(and|&) ?orange|سينمائ/i },
  { look: "warm", patterns: /\bwarm(er)?\b|\bwarm it up\b|\bgolden\b|\bsunny\b|دافئ|دافي|دفي|الوان دافيه|حار/i },
  { look: "cool", patterns: /\bcool(er)?\b|\bcold(er)?\b|\bblue ?tone|بارد/i },
  /*
   * `punch` the colour look, and not `punch in` the zoom.
   *
   * `\bpunch\b` matched both, so "punch in at 0:12" asked for a zoom and
   * silently also regraded the whole video. Nobody reported it because the
   * reply lists what it will do and both lines were true — it was doing two
   * things and had been asked for one. The negative lookahead is the fix:
   * "punchy" and "punchier" are unambiguous, and bare "punch" only counts when
   * it is not the verb followed by in/into/it/here.
   */
  {
    look: "punch",
    patterns:
      /\bpunch(y|ier)\b|\bpunch\b(?!\s*(in|into|it|here|at|on|up)\b)|\bmake (?:it|the colou?rs?) pop\b|\bcolou?rs? pop\b|\bmore contrast\b|\bvivid\b|\bvibrant\b|\bsaturated?\b|اوضح|اقوي الوان|الوان اقوي|لون اقوي/i,
  },
];

/**
 * Asking for a music bed.
 *
 * Bare "beat" is deliberately *not* here. "cut it to the beat" is a request to
 * sync the picture to a rhythm, which we do not do — matching it would lay a
 * bed nobody asked for and then, in the same reply, admit we cannot do the
 * thing they actually asked for. Only "a beat under it" reads as a bed, so
 * only that shape matches. The Arabic covers موسيقى / اغنيه / خلفية موسيقية.
 */
const MUSIC_WORDS =
  /\bmusic|music ?bed|sound ?track|\bsong\b|\bbeat under\b|\btrack under\b|موسيق|اغنيه|اغنيه|خلفيه موسيقيه|صوت خلفي/i;

/**
 * Naming a genre is asking for music.
 *
 * «حط بيت تراب» and "add a boom bap beat" are how people who actually make
 * short-form ads ask — they name the beat, not the category it belongs to —
 * and neither sentence contains the word *music* in either language, so both
 * were read as asking for nothing at all. The mood table underneath already
 * knew what trap and boom bap were; the door above it did not.
 *
 * Each of these is a genre and only a genre. The bare word «تراب» is not here,
 * because on its own it is soil, and the bare English "beat" is not here
 * either: "cut to the beat" is a request about the picture, and putting it in
 * this list would lay a bed under every sentence that asked for the cuts to
 * land — a bed nobody mentioned, which is the one failure this whole feature
 * is arranged to avoid.
 */
const MUSIC_GENRE_WORDS =
  /\btrap beat\b|\b808s?\b|\bboom ?bap\b|\blo-?fi\b|\bchill ?hop\b|\bsynth ?wave\b|\b(?:hip ?hop|rap|drill) beat\b|بيت تراب|ايقاع تراب|ايقاع تراب|بيت هيب ?هوب|بيت راب|لو ?فاي|لوفاي/i;

/**
 * Is this sentence about music at all?
 *
 * One function rather than three copies of `MUSIC_WORDS.test(text)`, because
 * the genre words have to reach every place that asks the question and not
 * only the place that lays the bed. There are three, and each one is a
 * different way to get it wrong: the branch that adds the bed; `spoke.music`,
 * which stops a later layer from adding a second one; and `asksForPunches`,
 * where an energy adjective belongs to the music rather than to the picture.
 * «حط بيت تراب حماسي» is a request for one bed and no zooms, and it is only
 * that in all three.
 */
function asksAboutMusic(text: string): boolean {
  return MUSIC_WORDS.test(text) || MUSIC_GENRE_WORDS.test(text);
}

/**
 * Declining a music bed — the same phrases as `MUSIC_WORDS` contain the word,
 * so without this a person saying "no music", "remove the music" or «بدون
 * موسيقى» matched `MUSIC_WORDS` and was *given* a bed, or, on a project with no
 * track, offered one they had just refused. Read the refusal, or every extra
 * phrasing accepted for the request is another refusal swallowed.
 */
/**
 * A complaint about music that is already there, which is neither request.
 *
 * "The music is too loud" is not "add music" and it is not "no music". It was
 * matching the first: the word was found, the sentence was not read, and
 * somebody who wrote in to say the bed was drowning them got a second bed laid
 * under the first. That is the worst reading of the three, because it is the
 * opposite of what they asked and it is the answer they were complaining
 * about, doubled.
 *
 * What we can actually do is narrow and worth saying plainly. Music already
 * inside the recording shares one track with the voice; there is no separate
 * thing to turn down. Levelling for the voice is real help and it is not what
 * they asked for, so it is offered as what we can do rather than announced as
 * what they wanted.
 */
const MUSIC_TOO_LOUD_WORDS =
  /(?:music|soundtrack|song|beat|backing track)[^.!?]{0,24}\b(?:too loud|so loud|very loud|is loud|louder than|drowning|drowns|overpowering|covering|too much)\b|\b(?:turn|bring|take|lower|reduce)\s+(?:the\s+)?(?:music|soundtrack|song|beat)\s*(?:down|lower)?\b|\b(?:lower|reduce|quieten)\s+(?:the\s+)?(?:music|soundtrack|song|beat)\b|(?:موسيق|اغنيه|اغنيه)[^.!؟?]{0,24}(?:عاليه|عالي|مرتفعه|مغطيه|بتغطي|كتير)|(?:نزل|نزل|خفف|خفف|قلل|قلل|واطي|وطي)\s*(?:صوت\s*)?(?:ال)?(?:موسيق|اغنيه|اغنيه)/i;

const NO_MUSIC_WORDS =
  /\bno (?:music|soundtrack|song|backing track)|without (?:music|a soundtrack|a song)|\bdon'?t (?:add|put|want|use) (?:any )?(?:music|a soundtrack|a song)|(?:remove|take out|get rid of|kill|drop|no) (?:the )?music|بدون موسيق|بلا موسيق|من غير موسيق|من دون موسيق|لا موسيق|لا (?:تحط|تضع|تضيف|تريد) (?:موسيق|اغنيه|اغنيه)|شيل (?:ال)?موسيق|احذف (?:ال)?موسيق|بدون اغنيه|بدون اغنيه|بلا اغنيه|\bno (?:trap|lo-?fi|boom ?bap|synth ?wave|808s?)\b|\bno beat\b|\bwithout a beat\b|بدون بيت|بلا بيت/i;

/**
 * Which mood a bed is asked for in.
 *
 * Read *inside* the music branch and nowhere else, which is what makes words
 * this loose safe: «هادئة» on its own is not a request for anything, and a
 * sentence that already asked for music and then said "calm" is describing the
 * music. The same arrangement `SFX_QUIET_WORDS` has, for the same reason.
 *
 * No `\b` on the Arabic alternatives. A word boundary in JavaScript is defined
 * against `\w`, which is ASCII, so it matches nothing beside an Arabic letter
 * and quietly makes the pattern dead — the trap that once made «ومضة»
 * invisible to the transition matcher.
 *
 * Order matters where two could match: "dark cinematic" is cinematic, because
 * the named genre is the stronger statement.
 */
const MUSIC_MOODS: { mood: MusicMood; patterns: RegExp }[] = [
  /*
    The named genres come first, because a genre is a stronger statement than
    a feeling: "dark trap" is trap, and "upbeat lo-fi" is lo-fi. A person who
    types the name of a genre has told us more than one who types an adjective.
  */
  {
    mood: "trap",
    patterns: /\btrap\b|\b808s?\b|\bdrill\b|تراب|ثماني ?مئه|ايقاع تراب/i,
  },
  {
    mood: "lofi",
    patterns: /\blo-?fi\b|\bchill ?hop\b|\bstudy beats?\b|لو ?فاي|لوفاي/i,
  },
  {
    mood: "boombap",
    patterns: /\bboom ?bap\b|\bhip ?hop\b|\brap beat\b|\bold ?school\b|هيب ?هوب|راب|بوم ?باب/i,
  },
  {
    mood: "retro",
    patterns: /\bretro\b|\bsynth ?wave\b|\b80s\b|\beighties\b|\bvapor ?wave\b|\bneon\b|ريترو|ثمانينات|ثمانيني|سينث/i,
  },
  {
    mood: "corporate",
    patterns: /\bcorporate\b|\bclean\b|\bprofessional\b|\bbusiness\b|\bexplainer\b|\bproduct video\b|كوربوريت|احترافيه|احترافي|رسميه|نظيفه|شركات/i,
  },
  {
    mood: "epic",
    patterns: /\bepic\b|\btrailer\b|\bheroic\b|\bmassive\b|\bgrand\b|ملحمي|ملحميه|بطوليه|تريلر|ضخمه/i,
  },
  {
    mood: "cinematic",
    /*
      "epic" and "trailer" used to land here. They have their own mood now —
      brighter, faster and with the drums forward — and leaving them in both
      lists would mean whichever entry came first silently won.
    */
    patterns: /\bcinematic\b|\bdramatic\b|\borchestral\b|\bfilm ?score\b|سينمائي|سينمائيه|دراميه|اوركسترا/i,
  },
  {
    mood: "upbeat",
    patterns: /\bupbeat\b|\benergetic\b|\bhype\b|\bexciting\b|\bdriving\b|\bpunchy\b|\bfast\b|حماسي|حماسيه|نشيطه|نشيط|سريعه|قويه|طاقه/i,
  },
  {
    mood: "dark",
    patterns: /\bdark\b|\btense\b|\bmoody\b|\bsuspense\b|\bserious\b|مظلمه|غامضه|متوتره|متوتره|جاده|جاده|مشوقه/i,
  },
  {
    mood: "playful",
    patterns: /\bplayful\b|\bfun\b|\bcute\b|\bquirky\b|\bcheerful\b|\bhappy\b|مرحه|مرح|لطيفه|بهيجه|مبهجه|ظريفه/i,
  },
  {
    /*
      "lo-fi" and "chill hop" used to be listed here as well, from when warm
      was the closest thing we had to that genre. They belong to `lofi` now,
      and `lofi` is read first, so the copies here never matched anything —
      the same quiet duplication the note above `cinematic` is about.
    */
    mood: "warm",
    patterns: /\bwarm\b|\bcozy\b|\bcosy\b|\bsmooth\b|\bsoulful\b|\btender\b|دافئه|دافئ|ناعمه|ناعم|حنونه/i,
  },
  {
    mood: "calm",
    patterns: /\bcalm\b|\bquiet\b|\bsoft\b|\bgentle\b|\bchill\b|\brelax\w*|\bmellow\b|\bambient\b|هادئه|هادئ|هادي|هاديه|رايقه|خفيفه|خفيف/i,
  },
];

/**
 * The mood a sentence asked for, and the one it gets when it did not say.
 *
 * Calm is the default and it is not a coin toss: a bed sits under somebody
 * talking at eighteen decibels below them, and of the six this is the one that
 * is hardest to be wrong about. A person who wanted something louder will say
 * so on the next message; a person who got something loud under a quiet piece
 * to camera has had their video damaged by a guess.
 */
export function musicMoodFrom(text: string): MusicMood {
  return MUSIC_MOODS.find((entry) => entry.patterns.test(text))?.mood ?? "calm";
}

/**
 * Asking for a beat *cut*, which we do not do.
 *
 * Separated from MUSIC_WORDS so that "add music" lays a bed and "cut to the
 * beat" still gets an honest no — and so that "add music and cut to the beat"
 * gets both answers instead of the friendlier one.
 */
/**
 * Asking for emojis, and the emojis themselves.
 *
 * Two patterns rather than one, because the difference between them is the
 * whole feature. This product does not write copy nobody asked for — the
 * animated title refuses to invent words for the same reason — and choosing
 * somebody's emojis for them is writing copy. So the ask alone gets a refusal
 * that names the fix, and the emojis they typed get placed.
 *
 * And typing an emoji is *not* on its own an ask. «اقصّ الصمت 🙏» is a person
 * being polite; burning a praying-hands sticker into their video because of it
 * would be the product reading punctuation as an instruction.
 */
const EMOJI_WORDS = /\bemoji|\bemojis\b|ايموجي|ايموجي|رموز تعبيريه|ستيكر|sticker/i;

/**
 * One run of emoji, keeping a sequence together: the joiner, the variation
 * selector and the skin-tone modifiers all belong to the glyph before them, and
 * splitting them turns one picture into two broken ones.
 *
 * Deliberately not `\p{Extended_Pictographic}`, which also matches ©, ® and ™ —
 * three characters that turn up in the text of somebody asking about their
 * rights, not asking for a sticker.
 */
const EMOJI_BASE = "[\\u{1F000}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{2B00}-\\u{2BFF}]";
const EMOJI_TAIL = "[\\u{FE0F}\\u{1F3FB}-\\u{1F3FF}]*";
const EMOJI_RUN = new RegExp(
  // One *picture*: a base, its modifiers, and any joined parts. Matching whole
  // runs instead would make "🔥😂🎉🚀💯" a single match and the cap below
  // meaningless, which is exactly how it first shipped.
  `${EMOJI_BASE}${EMOJI_TAIL}(?:\\u{200D}${EMOJI_BASE}${EMOJI_TAIL})*`,
  "gu",
);

/**
 * The emojis somebody actually typed, at most three: a wall of them is noise.
 *
 * Joined with a space rather than run together, and the space is doing work
 * rather than styling: the `word` title style animates whitespace-separated
 * pieces one at a time, so three spaced emojis pop onto the frame in sequence
 * and three crammed ones arrive as a single lump. The renderer decides what a
 * piece is; this decides that these are three things and not one.
 */
export function emojiIn(text: string): string {
  return (text.match(EMOJI_RUN) ?? []).slice(0, 3).join(" ");
}

/**
 * Asking for a sound layer, and asking for it to be left alone.
 *
 * The two are written here together on purpose. A generous pattern with no
 * refusal beside it is exactly how «no captions» came to add captions: the ask
 * matched a substring of the refusal and the product did the opposite of what
 * was typed, confidently. Every pattern added to this file from here gets its
 * negative in the same commit, and this pair is checked in both directions by
 * the suite.
 *
 * `\b` is left off every Arabic alternative. A word boundary in JavaScript is
 * defined against `\w`, which is ASCII, so `\bمؤثرات\b` matches nothing at
 * all — the trap that once made «ومضة» invisible to the transition matcher. A
 * bare alternation is correct anyway: «مؤثرات» is inside «بالمؤثرات».
 *
 * Both spellings of «مؤثّرات», with the shadda and without, because nobody
 * types the shadda and the product cannot be a spelling test.
 */
const SFX_WORDS =
  /\bsound ?effects?\b|\bsfx\b|\bwhoosh(?:es)?\b|\bswoosh(?:es)?\b|\brisers?\b|\bimpact sounds?\b|\btransition sounds?\b|مؤثرات|موثرات|اصوات انتقال|صوت علي القص/i;

const NO_SFX_WORDS =
  /\bno sound ?effects?\b|\bno sfx\b|\bwithout (?:any )?sound ?effects?\b|\bno whoosh(?:es)?\b|\bdon'?t add (?:any )?sound ?effects?\b|بدون مؤثرات|بدون مؤثرات|بلا مؤثرات|بلا مؤثرات|من غير مؤثرات|لا مؤثرات|لا مؤثرات/i;

/**
 * Which set, and only when they said so.
 *
 * Read *inside* the sound-effects branch and nowhere else, which is what makes
 * words this loose safe: «خفيفة» on its own is not a request for anything, and
 * a sentence that already asked for effects and then said "subtle" is asking
 * about the effects.
 */
const SFX_QUIET_WORDS = /\bsubtle\b|\bminimal\b|\bgentle\b|\bquiet(?:er)?\b|\blight touch\b|خفيفه|خفيف|بسيطه|هادئه|اهدي|اخف/i;
const SFX_PUNCHY_WORDS = /\bpunchy\b|\baggressive\b|\bhard[- ]hitting\b|\bheavy\b|قويه|عنيفه|ثقيله/i;
/**
 * Asking for the video to be *made* rather than edited.
 *
 * Every other pattern in this file is about changing a recording. This one is
 * for the person who has no recording — a shop with product photographs and no
 * camera — and it is the only request in the product where the answer is a
 * video that did not exist a minute ago.
 *
 * Written with its refusal beside it in the same commit, which is this file's
 * rule: a generous pattern with no negative is how «no captions» came to add
 * captions. And no `\b` on the Arabic, because a word boundary in JavaScript is
 * defined against `\w` and matches nothing next to an Arabic letter.
 */
const REEL_WORDS =
  /\bvideo (?:from|out of) (?:my |the |these )?(?:photos?|images?|pictures?|product (?:photos?|images?))\b|\b(?:photo|image|slideshow|product) video\b|\b(?:make|create|build) (?:an? )?(?:ad|reel|video|clip) (?:from|out of) (?:my |the |these )?(?:photos?|images?|pictures?)\b|\bturn (?:my |the |these )?(?:photos?|images?|pictures?) into (?:an? )?(?:video|ad|reel)\b|فيديو من الصور|فيديو من صور|فيديو من صوري|من صور المنتج|حول الصور|حول الصور|اعمل فيديو من|سوي فيديو من|سوي فيديو من/i;

const NO_REEL_WORDS =
  /\bwithout (?:my |the )?(?:photos?|images?|pictures?)\b|\bno slideshow\b|\bdon'?t use (?:my |the )?(?:photos?|images?|pictures?)\b|بدون الصور|بدون صور|بلا صور|لا تستخدم الصور/i;

const BEAT_SYNC_WORDS = /\b(cut|sync|edit|time)\w* (it |them |the (cuts?|clips?) )?(?:to|on|with) (the )?(beat|music|rhythm|drop)\b|علي الايقاع|مع الايقاع|علي ايقاع/i;

/**
 * Asked-for things that are real product ideas but have no operation yet.
 *
 * This list has to be pruned as things get built, or it starts lying in the
 * other direction — a product that says "I can't do transitions" the week
 * after transitions shipped is as dishonest as one that promises what it
 * cannot do. Two entries were narrowed for exactly that reason:
 *
 * - Transitions: gone from this list entirely. The fade at the ends, the
 *   dissolve between the cuts, and the shaped joins — wipes, slides, a white
 *   flash — are all built, so there is nothing left here to admit.
 * - Colour: matching a reference video's colour exists, so the reply points
 *   at it rather than refusing the whole subject.
 * - Music: narrowed to beat-*syncing*. Laying a bed under an edit is built;
 *   cutting the picture in time with one is not, and saying "I can't add
 *   music" to someone who just got music would be the same lie in reverse.
 */
const NOT_YET: Array<{ patterns: RegExp; label: Phrase }> = [
  {
    // Narrowed twice now. Reference matching removed the whole subject from
    // this list; the named looks removed most of what was left. What survives
    // is a colour ask that names no look we have and no reference to match —
    // "grade it like Wes Anderson", "make the reds deeper" — where the honest
    // answer is still that we cannot.
    patterns: /\bcolou?r ?(grade|grading)\b|\bgrade it like\b|\bLUT\b/i,
    label: say(
      "give it a look I do not have yet. Say warm, cool, cinematic, black and white or punchy, or send a video whose colour you want copied",
      "أعطيه لون ما بعرفه بعد. قلّي warm أو cool أو cinematic أو أبيض وأسود أو punch، أو ارفع فيديو بدك ألوانه متل ألوانه",
    ),
  },
  {
    /*
      Asking for it to be posted.

      The scheduling is built: accounts, captions per platform, a time, and a
      publisher that will not send the same post twice. So is the sending, now,
      for four destinations. What is missing is that every platform reviews an
      app before it will let one post on somebody's behalf, and not one of those
      reviews has finished. So a sentence that asks for it got silence: no
      operation, and nothing in the reply.

      The label below has to keep saying which of those two walls it is, and
      `refusal-test` holds it to that against `CAN_SEND` in the publisher: a
      product that owns four working uploaders and tells somebody it cannot
      send is describing itself as smaller than it is, which is the same lie as
      promising what it cannot do, and much harder to notice.

      Silence is the worst of the three answers available. A refusal at least
      says the product heard you; silence looks like it worked.

      Narrow on purpose. "post" alone is in "post-production" and "share" is in
      half of everything, so a platform has to be named beside a posting verb,
      or the sentence has to say "schedule" outright.

      And no `\b` on the Arabic. A word boundary in JavaScript is defined
      against `\w`, which is ASCII, so `\bانشر\b` matches nothing at all —
      the same trap that once made «ومضة» invisible to the transition matcher.
      A bare alternation is correct here anyway: «انشرها» and «انشره» both
      contain «انشر».
    */
    patterns:
      /\b(post|publish|upload|share)\b[^.!?]{0,30}\b(instagram|insta|reels?|tiktok|facebook|snapchat|twitter|youtube|shorts?|on x)\b|\bschedule (it|this|them|the (post|clip|video))\b|\b(post|publish) (it|this|them) (for me|later|at|on|tomorrow|tonight)\b|(?:انشر|جدول)/i,
    label: say(
      "post it to your accounts yet, and what is missing is approval rather than code. The scheduling is built, and so is the sending: YouTube, TikTok, Instagram Reels, Facebook Pages and X each have a working uploader here. Every one of those platforms reviews an app before it will let it post on somebody's behalf, and none of those reviews has finished",
      "أنشرها على حساباتك بعد، والناقص اعتماد لا كود. الجدولة مبنيّة والإرسال كذلك: ليوتيوب وتيك توك وريلز إنستغرام وصفحات فيسبوك و‏X رافعٌ يعمل هنا. وكل واحدة من هذه المنصّات تراجع التطبيق قبل أن تسمح له بالنشر نيابةً عن أحد، ولم تنتهِ أيّ مراجعة منها بعد",
    ),
  },
  {
    /*
      Playing it faster, which is a real edit and one this product does not do.

      It was answered with silence -- "I did not catch what you want changed"
      -- which is the worst of the three answers, because the person asked for
      something perfectly ordinary in perfectly ordinary words and was told
      they had not made sense. A refusal at least says we heard them.

      The near thing we *do* do is named, because it is what most people asking
      this actually want: a talk that drags is fixed by cutting the pauses far
      better than by playing the whole thing at 1.2x.

      Narrow on purpose. "fast" is in `SILENCE_WORDS` already and means
      "tighten it"; only an explicit speed-up belongs here. «سرّع» is in that
      list for the same reason and is deliberately not repeated here.
    */
    /*
      Only an explicit playback rate. "Speed it up" is not here, in either
      language, and that is a decision rather than an omission: «سرّع» has
      meant "tighten it" in `SILENCE_WORDS` since the beginning, a talk that
      drags is fixed far better by cutting the pauses than by playing it at
      1.2x, and the reply says which of the two it did. What is left here is
      the ask no tighten can stand in for -- a rate, a time lapse, slow motion.

      The two halves had drifted apart before this comment existed: English
      "speed it up" was refused while Arabic «سرّعه» was tightened, so the same
      request got opposite answers depending on which language it was typed in.
    */
    patterns:
      /\b(?:play|run) it (?:faster|slower|at \d)|\b\d(?:\.\d)?x speed\b|\btime ?lapse\b|\bslow ?(?:mo|motion)\b|\bslow it down\b|\bhalf speed\b|\bdouble speed\b|بسرعه مضاعفه|ضعف السرعه|سرعه \d|تصوير مسرع|سلو ?موشن|تصوير بطيء|بطئه|بطئه/i,
    label: say(
      "play it faster or slower yet. What I can do is take out the pauses and the ums, which is usually what makes a recording feel slow",
      "أشغّله أسرع أو أبطأ بعد. اللي بقدر عليه إني أشيل السكتات و«آآ» و«يعني»، وهي عادةً اللي بتخلّي التسجيل حاسس بطيء",
    ),
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
  kind: "video" | "image" | "audio" | "lut";
  label: string | null;
}

const BROLL_WORDS =
  /\bb[ -]?roll|cut ?away|cutaway|footage|insert (a |the )?(clip|shot)\b|\b(?:add|use|put|show) (?:some |my |the )?clips?\b|بي ?رول|لقطات مسانده|لقطه مسانده|مقاطع مسانده|لقطات اضافيه|مقاطع من ملفاتي|من مقاطعي/i;
const OVERLAY_WORDS =
  /\blogo|overlay|screenshot|graphic|show (the |my )?(image|picture|photo)\b|الشعار|شعاري|لوجو|اللوغو|لوغو|اللوقو|صوره فوق|لقطه شاشه|سكرين ?شوت/i;

/**
 * A card between sections, which is the reference's signature move.
 *
 * r04 cuts to a light card with an icon and a name between every one of its
 * five sections, and it is what makes a talking head read as a produced
 * explainer rather than a recording. The study ranked it highest for visual
 * effect against effort, and it is now expressible — so this is the sentence
 * that reaches it.
 *
 * Deliberately not matched by "title" or "card" alone. Both are ordinary words
 * about text, and `motionTitle` is the right answer to either; this is about
 * *cutting away* to a full-frame plate, which people describe as a section, a
 * chapter, or a break.
 */
const SECTION_CARD_WORDS =
  /\bsection card|chapter card|title card|interstitial|section break|divider card\b|بطاقه قسم|بطاقه فاصله|فاصل بين الاقسام|كرت قسم|بطاقه تعريفيه|بطاقه تعريفيه/i;

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

/**
 * The opening or the ending, named as a thing rather than as a length.
 *
 * "Cut the intro", "trim the end", «احذف المقدمة». Perfectly clear and
 * unanswerable: an intro is however long the person decided it was, and
 * nothing on this side has heard the recording.
 */
const ENDS_ASK =
  /\b(?:cut|remove|drop|trim|skip|lose|get rid of)\b[^.!?]{0,16}\b(?:the )?(?:intro|introduction|outro|ending|the end|beginning|opening)\b|(?:احذف|اقطع|شيل|الغي|قص)\s*(?:ال)?(?:مقدمه|نهايه|بدايه|خاتمه)/i;

/** Keeping somebody centred by following them, which is not built. */
const FOLLOW_SUBJECT_ASK =
  /\b(?:follow|track|centre|center|keep)\b[^.!?]{0,16}\b(?:my|the|his|her)?\s*(?:face|head|subject|me)\b|\bcent(?:re|er) me\b|\bkeep me in frame\b|(?:تابع|لاحق|تتبع)\s*(?:وجهي|الوجه)|خليني بالنص/i;

/** A progress bar, which is not built either. */
const PROGRESS_BAR_ASK = /\bprogress bar\b|\bprogress ?bar\b|\bcountdown bar\b|شريط تقدم|شريط الوقت/i;

/**
 * Asking for the words to arrive one at a time.
 *
 * The style exists and the model can choose it; this is the matcher learning
 * the same word, which is the direction the two-heads rule allows — the cheap
 * head may know less than the paid one, never more. It matters because the
 * matcher is what answers when the model times out, and "the words came in as
 * a slab today" is not a difference anybody would report as a bug.
 *
 * «كلمة كلمة» and «كلمة بكلمة» are how this is asked for in Arabic, and
 * neither has a `\b` in front of it: a word boundary before an Arabic letter
 * never matches, which is the trap this file has now fallen into three times.
 */
/**
 * Captions that emphasise, as distinct from captions that wipe.
 *
 * Two animations now do something word by word and they are not the same
 * thing: `karaoke` wipes a fill across each word as it is said, and `kinetic`
 * reveals each word and then draws the one the speaker leaned on larger and in
 * the accent colour. Somebody who says "word by word" means the wipe — that is
 * what the phrase has meant in this product since it shipped — so this pattern
 * deliberately does **not** claim it, and karaoke is tested first.
 *
 * What it claims is the vocabulary the wipe never had: emphasis, and movement.
 *
 * `\bkinetic\b` also lives in `KINETIC_WORDS`, which chooses the *title* style
 * — and that is not a collision, because this one is only ever read inside the
 * caption branch. A sentence has to be about captions before it gets here.
 */
const KINETIC_CAPTION_WORDS =
  /\bkinetic\b|\banimated (?:captions?|subtitles?)\b|\bcaptions? that (?:pop|move|bounce)\b|\bemphasi[sz]\w*|\bstress(?:ed|es)? (?:the )?word|\bmake the (?:captions?|words) (?:pop|move)\b|كابشن متحرك|كابشنز متحركه|كتابه متحركه|ترجمه متحركه|تشديد|شدد الكلمات|ابرز الكلمه|ابرز الكلمه|كلمه بارزه/i;

const KINETIC_WORDS =
  /\bkinetic\b|\bword[- ]by[- ]word\b|\bone (word )?at a time\b|\bwords? (pop|land|drop)\w* in\b|كلمه كلمه|كلمه بكلمه|كلمه تلو/i;

/**
 * The Arabic half was missing entirely, and this is the most-asked-for edit in
 * the product. Everything else here reads Arabic — the highlight, the hook,
 * the transitions, the looks, the music — but "اقصّ الصمت" produced *no
 * operations at all*, which means the reply fell through to "I'm not sure what
 * to change from that". Found by rendering the sentences a person would type
 * rather than the ones the checks already had.
 *
 * No `\b` on the Arabic alternatives: word boundaries are defined against
 * ASCII word characters, so `\b` before an Arabic letter never matches. That
 * has bitten this file once before.
 */
const SILENCE_WORDS =
  // The English half has had "short" and "boring" since the beginning; the
  // Arabic half had neither, so «بدي اياه اقصر» and «شيل الملل» -- the two
  // commonest ways to ask for this -- reached nothing at all.
  // "speed it up" is here rather than on the refusal list, and only in that
  // shape: a bare "speed" is in "2x speed", which is a rate and is refused.
  /\bsilence|silent|quiet|pause|dead air|tighten|trim|short|fast|snapp|pace|boring|drag|\bspeed (?:it|this|the video) ?up\b|صمت|سكتات|سكوت|وقفات|فراغات|اختصر|قصر|قصر الفيديو|اقصر|اقصر|قصره|قصره|الملل|الممل|الممله|ممل|سرع|سرعه|سرعها|سرععه/i;

/**
 * The hesitations and the false starts, which are not silence.
 *
 * `um+s?` and `filler` used to live in `SILENCE_WORDS`, and they were in the
 * wrong list: an "um" is *loud*, so cutting the silences has never removed one.
 * Somebody who wrote "cut the ums" got the silences cut and every hesitation
 * left in — the request answered by doing a different thing, which is the
 * shape of failure this file keeps finding.
 *
 * They are separate patterns rather than one because the two asks are
 * different sentences. "Cut the ums" is precise and gets exactly that;
 * "tighten it up" is a person asking for the whole treatment, and that is
 * silences *and* hesitations, which is why the generic word stayed above.
 */
// `آآ` carries no ASCII word boundary before it — `\bآآ` matched *nothing*,
// because `\b` needs a word character on the ASCII side and Arabic is not one,
// so "شيل الآآآ" ("cut the aaah") produced no result at all. It is the fourth
// time this exact trap — an ASCII `\b` in front of an Arabic run — has been
// found and fixed in this file. The run of two-or-more madda-alef is what an
// elongated hesitation looks like written down, and it does not appear inside
// ordinary words, so no anchor is needed.
const HESITATION_WORDS =
  /\bum+s?\b|\buh+s?\b|\bfiller|hesitat|stumbl|stutter|false start|\bmumbl|اا|ترددات|التردد|تلعثم|يتلعثم|كلمات? الحشو|بدايات? مكرره|بدايات? مكرره|يعيد الجمله|كرر الجمله/i;

/**
 * Refusals, in the same file as the thing they refuse.
 *
 * A generous request pattern with no matching refusal pattern is how "no
 * captions" once added captions and "keep the silence" cut it. The pattern was
 * written the same day as the request it negates so it cannot be forgotten
 * separately.
 */
/**
 * "Tidy this up", said without naming a part of it.
 *
 * Deliberately narrow. These are the words for the whole treatment, and every
 * one of them already appears in `SILENCE_WORDS` — which is the point: a
 * sentence that reaches both patterns gets both operations, and a sentence
 * that names only one of them gets only that one.
 */
const WHOLE_TREATMENT_WORDS = /\btighten|snapp|\bmake it tight|شده|اشده|اشده|رتبه|نظفه|نظفه/i;

const NO_TIGHTEN_WORDS =
  /\bkeep the (?:ums?|uhs?|hesitations?|stumbles?)|don'?t (?:cut|remove) (?:the )?(?:ums?|uhs?|hesitations?)|\bleave the (?:ums?|hesitations?)|خلي الترددات|خلي الترددات|لا تشيل الترددات|بدون حذف الترددات/i;

/**
 * Somebody asking for an edit without naming one.
 *
 * "Make this good." "Edit it." "Do your thing." «سوّه حلو». Until `direct.ts`
 * existed these produced nothing at all and were answered politely, which is
 * the single most damning thing about the old planner: the most natural way to
 * ask for the product is the one sentence it could not hear.
 *
 * It is also the gate on the direction, and that is why the pattern is narrow
 * rather than generous. The direction builds a whole edit and the edit starts a
 * render, so a matcher that fires on "hello" spends somebody's minutes on a
 * message that was not a request. Something has to be *asked for*: a verb about
 * this video, or a judgement about how it should come out.
 *
 * And no `\b` on the Arabic: word boundaries in JavaScript are defined against
 * `\w`, which is ASCII, so `\bعدّله\b` matches nothing. The trap that once made
 * «ومضة» invisible to the transition matcher.
 */
const EDIT_THIS_WORDS =
  /\b(?:edit|tidy|polish|fix|work on|do your thing)\b|\bclean (?:it |this )?up\b|\bsort (?:it |this )?out\b|\bmake (?:it|this) (?:look |seem |feel )?(?:good|better|nice|punchy|watchable|professional|polished|pro|sharp|clean|proper)\b|\bmake (?:it|this) look like\b|\blike a (?:real|proper|professional)\b|\bgo ahead\b|\bwhatever you think\b|\byou decide\b|عدله|عدله|عدلي|رتبه|رتبه|نظفه|نظفه|سوه|سوه|اعمل اللازم|اعملها|اعمله|شوف الافضل|زي ما تشوف|خليه? ?(?:يطلع )?(?:حلو|احترافي|منيح|مرتب|مرتب)|خليه? ?(?:يطلع )?(?:حلو|احترافي|منيح|مرتب|مرتب)|زي فيديوهات|زي الفيديوهات|مثل فيديوهات|بدي(?: اياه| ياه)? (?:احلي|اجمل|افضل|احسن)|خليه اجمل|اشتغل عليه/i;

/**
 * Whether this sentence is asking for an edit at all.
 *
 * Exported for the same reason `saysOnlyThis` is: one place decides what a
 * phrase means, and the direction is downstream of that decision rather than
 * holding a second copy of it.
 */
export function asksForAnEdit(text: string): boolean {
  // Folded, like everything else matched here. The patterns in this file are
  // written in the folded alphabet, so a caller handing us raw text -- which
  // every caller does -- would otherwise miss «عدّله» for its shadda alone.
  return EDIT_THIS_WORDS.test(withAsciiDigits(text));
}

/**
 * "Only", and everything it is spelt as.
 *
 * The one sentence that has to switch the direction off. `direct.ts` builds a
 * whole edit without being asked, and the person's words amend it — which is
 * right almost always and exactly wrong when they say *only*. Somebody who
 * types "just cut the silences, nothing else" and receives captions, punch-ins
 * and a fade has been ignored, and it does not stop being that because the
 * extra work was good.
 *
 * Narrow on purpose. "just" is in "I just want" and "just now", so it counts
 * only when it sits beside a verb the plan can act on, or when the sentence
 * closes the door outright ("nothing else", «وبس»). A pattern that is generous
 * here turns the product's own judgement off on sentences that never asked it
 * to, which is the failure in the other direction and much harder to see.
 *
 * And no `\b` on the Arabic: a word boundary in JavaScript is defined against
 * `\w`, which is ASCII, so `\bفقط\b` matches nothing at all. The same trap
 * that once made «ومضة» invisible to the transition matcher.
 */
/*
  «بس» at the end of a sentence is the commonest way to say "only" in this
  dialect, and it was the one spelling missing.

  «وبس», «و بس» and «بس هيك» were all here; a sentence that simply ended in it
  was not, so «ظبطلي الصوت بس» -- fix the audio, only that -- came back with a
  ten-operation edit. Being overruled on the sentence where somebody was most
  explicit is the failure this whole flag exists to prevent, and this was the
  most natural way to trigger it.

  At the start it is ambiguous and the ambiguity is resolved by what follows:
  «بس شيل السكتات» is "just remove the silences" and «بس أنا بدي...» is "but I
  want...". A pronoun after it makes it the conjunction, and nothing else does,
  so that is the whole rule. Erring toward "only" everywhere else is
  deliberate: a smaller edit than somebody wanted is a worse edit, and being
  overruled on the sentence where they were explicit is a worse product.
*/
const ONLY_WORDS =
  /\bonly\b|\bnothing else\b|\band nothing more\b|\bjust (?:cut|remove|trim|add|put|do|fix|sort|level|the)\b|\bthat'?s all\b|\bdon'?t do anything else\b|فقط لا غير|لا شيء غير|ولا شي غير|وبس|و بس|^بس (?!انا|انا|احنا|احنا|نحن|هو|هي|هم|انت|انت|انتي|انتي)|\bبس هيك|\sبس\s*[.!؟?]*\s*$|لا تعمل شي غير|لا تضيف شي/i;

/**
 * Whether this sentence is the whole plan.
 *
 * Exported because the direction has to read it and it belongs beside the
 * pattern rather than beside the consumer, for the reason every other matcher
 * in this file is here: one place decides what a phrase means.
 */
export function saysOnlyThis(text: string): boolean {
  return ONLY_WORDS.test(withAsciiDigits(text));
}

const VERTICAL_WORDS = /\bvertical|9:16|portrait|full ?screen\b|عمودي|عامودي|طولي/i;

/*
  The three patterns below exist only so that a *refusal* can be recognised.

  Nothing acts on them: saying "no captions" produces no operation, which is
  already what happens. What they do is mark the subject as spoken, so that
  what somebody usually asks for is not added to the one video where they said
  not to. A person who is contradicted on the sentence where they were most
  explicit does not conclude the product knows them.

  Kept beside the patterns they negate rather than in a block of their own,
  because a negation that drifts away from the thing it negates is a negation
  that stops covering it.
*/
const HORIZONTAL_WORDS = /\bhorizontal|16:9|landscape|widescreen\b|افقي|افقي|عريض/i;
/*
  Saying it and taking it back, which are the same instruction.

  This covered "no captions" and «بدون ترجمة» — the ways somebody says it
  *before* there are any. It did not cover the ways somebody says it after:
  "remove the captions", "drop the captions", «شيل الترجمة». Those name the
  thing, so the caption pattern below matched them, and the plan came back with
  captions in it. The product's answer to «شيل الترجمة» was to add captions.

  Nobody reported it because of where it happens. The first message on a
  project asks *for* things; a removal is almost always a correction, the third
  or fourth sentence in a conversation, and by then the person is looking at a
  video rather than re-reading a reply.

  Both shapes now, and the verb has to be next to the noun: "remove the music
  and caption it" is one of each, and a removal that reached across the whole
  sentence would eat the half that was a request.
*/
const NO_CAPTION_WORDS =
  /\bno (?:captions?|subtitles?)|without (?:captions?|subtitles?)|\bdon'?t caption|\b(?:remove|drop|delete|take out|get rid of)\s+(?:the\s+)?(?:captions?|subtitles?)\b|بدون (?:ترجمه|ترجمه|كابشن|كتابه)|بلا (?:ترجمه|كابشن)|من غير (?:ترجمه|كابشن)|لا ترجمه|ما بدي (?:ترجمه|كابشن)|(?:شيل|احذف|الغي|الغي|امسح|شيلي)\s*(?:ال)?(?:ترجمه|ترجمه|كابشن|كتابه)/i;
const NO_SILENCE_WORDS =
  /\bkeep the (?:silence|pauses)|don'?t cut (?:the )?(?:silence|pauses)|\bno (?:silence )?cut(?:ting)?\b|خلي الصمت|خلي الصمت|لا تقص الصمت|بدون قص/i;

/**
 * Captions, in both languages this product is asked in.
 *
 * The Arabic here is the whole reason this round exists: captions are the most
 * asked-for edit there is, and until now `add captions` worked and «ضيف ترجمة»
 * produced *nothing* — the reply fell through to "I'm not sure what to change
 * from that". The product could do the thing and could not be asked for it.
 *
 * «كابشن» arrived late and is the same bug one word further in. It is the word
 * the product's own interface uses — the panel is «شكل الكابشن», the position
 * patterns below have always read «كابشن فوق» — and it was missing from the
 * pattern that decides whether captions were asked for at all. So «ضيف كابشن»
 * matched a position rule and never reached it: the most natural way to ask,
 * in the product's own vocabulary, produced nothing.
 */
const CAPTION_WORDS =
  /\bcaption|subtitle|sub ?titles?|text on screen|on-?screen text\b|ترجمه|ترجمه|سبتايتل|كابشن|كتابه علي الشاشه|نص علي الشاشه|مكتوب علي الشاشه/i;

/**
 * The one word that is two different requests.
 *
 * «ترجمة» is what an Arabic speaker calls captions — and «ترجم» is the verb for
 * translating into another language, which we do not do. They share four
 * letters, so the caption pattern above matches both, and without this the
 * product would answer «ترجم الفيديو للإنجليزي» with same-language captions and
 * call it done. That is the exact failure this file exists to prevent: doing
 * something nobody asked for and reporting it as the thing they did.
 *
 * The lookahead is what separates them: «ترجم» only counts when it is *not*
 * followed by the ta marbuta of «ترجمة». In English the verbs are unambiguous.
 */
const TRANSLATE_WORDS = /\btranslat(?:e|ed|ing|ion)\b|\bdubb?(?:ed|ing)?\b|ترجم(?![هه])|مترجم|دبلجه/i;

const KARAOKE_WORDS =
  /\bkaraoke|word by word|word-by-word|highlight|كلمه كلمه|كلمه بكلمه|كلمه ورا كلمه|كاريوكي|تظليل/i;
const YELLOW_WORDS = /\byellow|gold\b|اصفر|اصفر|ذهبي/i;

/**
 * The named looks, asked for by name — in both languages, because a style a
 * person cannot reach from an Arabic sentence does not exist for half the
 * product. Checked before the older colour words: somebody who says
 * «هرموزي» has said something more specific than "yellow".
 */
const CAPTION_STYLE_WORDS: Array<[RegExp, "hormozi" | "beast" | "pill" | "neon" | "clean" | "bubble" | "karaoke-light" | "creator" | "glow" | "label"]> = [
  [/hormozi|هرموزي|هورموزي/i, "hormozi"],
  [/\bbeast\b|بيست|مستر بيست/i, "beast"],
  [/خلف الكلمه|صندوق الكلمه|word pill|pill caption|box behind/i, "pill"],
  [/\bneon\b|نيون|متوهج/i, "neon"],
  /*
     The cold look, and it sits *after* neon on purpose.

     The two are one letter apart in Arabic: neon already answers to «متوهج»,
     and «توهج» is inside it. Put this row first and every «متوهج» in the
     product would have quietly become the light look instead of the loud one
     — a rule broken by a substring, which `\b` cannot help with here because
     a word boundary in JavaScript is defined against ASCII and Arabic has
     none. Ordering is the fix that needs no lookbehind: «متوهج» is claimed
     above, so anything reaching this line meant the quiet one.
  */
  [/\bglow\b|\bhalo\b|توهج|توهج|هاله|كابشن ناعم|كابشن خفيف/i, "glow"],
  [/\bminimal\b|\bclean caption|كابشن هادئ|كابشن بسيط/i, "clean"],
  [/\bbubble\b|فقاع/i, "bubble"],
  [/white box|bright box|صندوق ابيض|شريط ابيض/i, "karaoke-light"],
  [/\bcreator\b|كرييتور|كرياتور|زي المشاهير/i, "creator"],
  /* The grey translucent bar. «شريط أبيض» above stays the white one: most
     specific first only works when the two bars do not share their words. */
  [/gr[ae]y (?:bar|box)|شريط رمادي|خلفيه رماديه|خلفيه شفافه|خلفيه للكابشن|caption background/i, "label"],
];
/** The big-keyword lockup, asked for the way people describe it. */
const FOCUS_WORDS = /الكلمه الكبيره|كلمه بارزه|كلمه كبيره|big keyword|keyword caption|one word big|focus caption/i;
/*
  The rise, and it is asked for **before** the lockup it is a version of.

  Every sentence that reaches `rise` also reaches `FOCUS_WORDS` — «كلمة بارزة
  صاعدة» contains «كلمة بارزة», "rising keyword" contains "keyword" — so a row
  after it could never win. The wipe/kinetic pair above is ordered for the same
  reason and says so; `\b` is no help here because it is defined on ASCII and
  does nothing against Arabic.

  «من تحت» on its own is deliberately not in here. It is how half the people
  who want the caption at the *bottom* say it — «حط الكابشن من تحت» — and a row
  that took it would answer a question about position with an answer about
  motion, and put the caption back in the middle while it did.
*/
const RISE_WORDS = /صاعد|تصعد|يطلع من تحت|تطلع من تحت|rising|rise up|float up|lift up/i;
/** Where the caption sits, said the way people say it. */
const CAPTION_TOP_WORDS = /كابشن فوق|الكابشن فوق|فوق الشاشه|اعلي الشاشه|اعلي الشاشه|captions? (?:at|on) top|top of the screen/i;
const CAPTION_MIDDLE_WORDS = /وسط الشاشه|منتصف الشاشه|نص الشاشه|middle of the screen|center(?:ed)? captions?|captions? in the (?:centre|center|middle)/i;
/*
  And the bottom, which needed no words for as long as it was the default.

  It is not the default any more — `DEFAULT_CAPTION_LOOK` puts a caption where
  short-form has put it for years — so "at the bottom" has to be a thing a
  person can ask for. A default that cannot be asked back is a preference the
  product took away rather than a choice it made for you.
*/
const CAPTION_BOTTOM_WORDS =
  /كابشن تحت|الكابشن تحت|اسفل الشاشه|اسفل الشاشه|تحت الشاشه|captions? (?:at|on|near) the bottom|bottom of the screen|lower third/i;
/** The three sizes, in the words that mean them. */
/*
  Nobody calls them captions when they want them bigger.

  They call them the text, or the writing, or the font -- «كبّر الخط» is the
  commonest sentence in this whole area and it reached nothing, in either
  language, because every pattern here named the thing by our word for it.
*/
const CAPTION_BIG_WORDS =
  /كابشن كبير|الكابشن كبير|(?:كبر|كبر|زود|زود)\s*(?:حجم\s*)?(?:ال)?(?:كابشن|خط|خط|كتابه|ترجمه|ترجمه|نص)|(?:الخط|الكتابه|الترجمه|الكابشن)\s*(?:صغير|صغيره)|big captions?|large captions?|bigger captions?|\bmake the (?:text|writing|words|font|captions?|subtitles?) bigger\b|\bbigger (?:text|font|words|subtitles?)\b|\b(?:text|font|captions?|subtitles?) (?:is |are )?too small\b/i;
const CAPTION_SMALL_WORDS = /كابشن صغير|الكابشن صغير|صغر الكابشن|صغر الكابشن|small(?:er)? captions?/i;
/**
 * The fast-cut rhythm, asked for as a rhythm.
 *
 * Deliberately none of KARAOKE_WORDS' phrases: «كلمة كلمة» has meant the wipe
 * since the wipe shipped, and pace is a different axis — a person can want
 * a karaoke wipe at a leisurely pace or a hard-swap caption twice a second.
 */
const CAPTION_QUICK_WORDS =
  /fast captions?|quick captions?|rapid captions?|snappy captions?|punchy captions?|short chunks|كابشن سريع|الكابشن سريع|كابشن متسارع|كابشن قصير سريع|ايقاع سريع للكابشن|ايقاع سريع للكابشن/i;

/*
  The other half of the same axis, for the same reason as the bottom above.

  Quick is the default now, so the slower grouping — whole phrases, a cue that
  sits for a couple of seconds — is the one that has to be sayable. Somebody
  captioning a lecture or an interview wants sentences, not three words twice a
  second, and until these words existed there was no way to say so.
*/
const CAPTION_CALM_WORDS =
  /slow(?:er)? captions?|calm captions?|steady captions?|normal captions?|full sentences?|whole sentences?|كابشن هادئ|كابشن بطيء|الكابشن بطيء|ايقاع هادئ|ايقاع هادئ|جمل كامله|جمله كامله/i;

/**
 * Asking for the strongest stretch, in the ways people actually ask.
 *
 * "highlight" alone is deliberately not enough — KARAOKE_WORDS above already
 * reads it as a caption style ("highlight each word"), so the highlight *cut*
 * needs the shape of a request for a piece of the clip: "the best part",
 * "strongest 30 seconds", "a highlight reel", "just the good bit".
 */
const HIGHLIGHT_WORDS =
  /\b(best|strongest|good|top|most interesting) ?\d* ?(part|parts|bit|bits|moment|moments|section|seconds?|secs?|s\b)|highlight reel|the highlight\b|افضل جزء|اقوي جزء|اهم جزء|احسن جزء|افضل لقطه|اقوي لقطه|افضل لحظه|اقوي لحظه|اهم لحظه|(?:افضل|اقوي|اهم|احسن)\s*\d{1,3}\s*(?:ثانيه|ثواني|دقيقه|دقايق|دقائق)|(?:اعطيني|اعطني|طلعلي|طلع لي|بدي)\s*(?:افضل|اقوي|اهم|احسن)|مقتطف|الزبده|زبده الفيديو/i;
/**
 * A target length, which is the same request said the other way round.
 *
 * "Give me the strongest 30 seconds" was heard and "make it 60 seconds" was
 * not, and they are one request: a length, with the choice of which seconds
 * left to us. Somebody cutting for a feed thinks in the limit they are cutting
 * to, so this is the more natural of the two and it was the one that reached
 * nothing.
 *
 * A unit is required, with one exception that earns itself: "make it 60
 * instead" is the commonest correction of a length there is, and the word
 * `instead` is what makes the bare number safe. It says the sentence is
 * changing something already decided, and the only number already decided in
 * this product is a length.
 *
 * Even then, not under ten. A bare number that small is a count of clips
 * ("give me 3 instead"), and nobody asks for a nine-second video.
 *
 * Everywhere else a unit is required, because a bare number is a moment, a
 * count of clips, a year -- this file has four patterns that read one.
 *
 * And no `\b` after «بدل». A word boundary in JavaScript is defined against
 * `\w`, which is ASCII, so it can never match beside an Arabic letter: the
 * Arabic half of this pattern was written with one and matched nothing at all
 * while the English half worked. Seventh time in this file.
 */
const TARGET_LENGTH =
  /\b(?:make|keep|cut|get|bring) (?:it|this|the video) (?:(?:down|in) )?(?:to )?(?:about |around |roughly |under )?(\d{1,4})\s*(?:seconds?|secs?|s\b|minutes?|mins?)\b|\b(?:in|under|within) (?:about |around )?(\d{1,4})\s*(?:seconds?|secs?|minutes?|mins?)\b|\b(?:make|keep|cut) (?:it|this) (?:to )?(\d{2,4})\s*(?:instead|rather)\b|(?:خليها|خليها|خليه|خليه)\s*(\d{2,4})\s*(?:بدل|احسن|احسن)|(?:خليه|خليه|خليها|خليها|اعمله|بدي(?:ه|ه ياه| اياه)?)\s*(?:حوالي\s*|تقريبا\s*)?(\d{1,4})?\s*(دقيقه|دقيقتين|دقائق|ثانيه|ثواني)/i;

/**
 * "best 45 seconds", "the top 20s" — the number they said, not our default.
 *
 * The Arabic side of the pattern above needed the number form adding, and it
 * is the one worth naming: «اقوى 30 ثانية» is the highlight request, and every
 * Arabic spelling of it wanted a noun after the adjective -- «أقوى جزء»,
 * «أقوى لقطة». So the way anybody actually asks, with the length in it,
 * reached nothing.
 *
 * Which made the product recommend a sentence it could not read: «أعطني أقوى
 * 30 ثانية مع ترجمة، عمودية لتيك توك» is the example in `NOTHING_UNDERSTOOD`,
 * offered to somebody we had just failed to understand.
 */
const HIGHLIGHT_SECONDS = /\b(\d{1,3}) ?(?:seconds?|secs?|s\b|ثانيه|ثواني)/i;

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
const TO = "(?:to|until|till|thru|through|[-\u2013\u2192]|\u0627\u0644\u064a|\u0627\u0644\u064a|\u062d\u062a\u064a|\u0644\u063a\u0627\u064a\u0647)";
/**
 * The digits an Arabic keyboard types by default.
 *
 * Every number pattern in this file is written against 0-9, and an Arabic
 * layout produces ٠-٩ (and ۰-۹ on a Persian one). They are the same numbers to
 * a reader and different characters to a regex, so «من ١:٢٠ إلى ٢:١٠» matched
 * nothing at all — as did every clip count, every "first N seconds", every
 * length someone named.
 *
 * Normalising once here fixes all of them together, which is the point: the
 * alternative is remembering to write two digit classes in every future
 * pattern, and that is a thing nobody remembers twice.
 *
 * Only the digits are touched. The words are matched as typed, and anything
 * echoed back to the person — a title they put in quotes — is read from what
 * they actually wrote, not from this.
 */
export function withAsciiDigits(text: string): string {
  return plainArabic(
    text.replace(/[\u0660-\u0669\u06f0-\u06f9]/g, (d) => {
      const code = d.codePointAt(0)!;
      return String(code - (code >= 0x06f0 ? 0x06f0 : 0x0660));
    }),
  );
}

/**
 * Arabic as people actually type it, which is not how a dictionary spells it.
 *
 * Nobody reaches for the hamza key on a phone. «أقوى» is typed «اقوى», «أفضل»
 * is «افضل», «إيقاع» is «ايقاع» -- and a third of the Arabic patterns in this
 * file were written with the hamza, so a third of what this product can do was
 * unreachable for anybody typing at normal speed.
 *
 * The one that makes it plain: «أعطني أقوى 30 ثانية مع ترجمة، عمودية لتيك
 * توك» is the example sentence this file *offers* when it cannot read
 * something, and «اعطيني اقوى 30 ثانية» -- the same request, typed the way a
 * person types -- reached nothing at all. The product was recommending a
 * sentence it could only understand in one spelling.
 *
 * Both sides are folded, which is what makes this safe: the patterns in this
 * file are written in the folded alphabet too, so nothing becomes ambiguous,
 * only more reachable. The folds are the standard ones and each is a pair of
 * characters ordinary typing treats as the same letter:
 *
 *   أ إ آ ٱ → ا     the hamza carriers, the big one
 *   ى → ي           alef maqsura, which many keyboards do not distinguish
 *   ة → ه           taa marbuta, the commonest typo in the language
 *   ـ                tatweel, a decoration that means nothing
 *   the harakat      short vowels, written by almost nobody
 *
 * Only what is *matched* is folded. Anything echoed back -- a title somebody
 * put in quotes -- is read from what they actually wrote, exactly as it was
 * before the digits were normalised here for the same reason.
 */
export function plainArabic(text: string): string {
  return text
    .replace(/[\u0623\u0625\u0622\u0671]/g, "\u0627")
    .replace(/\u0649/g, "\u064a")
    .replace(/\u0629/g, "\u0647")
    .replace(/[\u0640\u064b-\u0652\u0670]/g, "");
}

const RANGE_MMSS = new RegExp(String.raw`(\d{1,3}):([0-5]\d)\s*${TO}\s*(\d{1,3}):([0-5]\d)`, "i");
const RANGE_MINUTES = new RegExp(
  String.raw`(?:minute|\u0627\u0644\u062f\u0642\u064a\u0642\u0647|\u062f\u0642\u064a\u0642\u0647)\s*(\d{1,3})\s*${TO}\s*(?:minute|\u0627\u0644\u062f\u0642\u064a\u0642\u0647|\u062f\u0642\u064a\u0642\u0647)?\s*(\d{1,3})`,
  "i",
);
const RANGE_SECONDS = new RegExp(
  String.raw`(?:from|\u0645\u0646)\s*(?:second|\u0627\u0644\u062b\u0627\u0646\u064a\u0647)?\s*(\d{1,4})\s*(?:seconds?|secs?|s\b)?\s*${TO}\s*(\d{1,4})\s*(?:seconds?|secs?|s\b|\u062b\u0627\u0646\u064a\u0647|\u062b\u0648\u0627\u0646\u064a)`,
  "i",
);
// The \b sits inside the alternation, not in front of it. Outside, it is a
// boundary test against an Arabic letter, which is never a word character, so
// it never matches — «أول ٤٠ ثانية» found nothing while "the first 40 seconds"
// worked. That is the third time this exact mistake has been made in this file.
const RANGE_FIRST = /(?:\bfirst|\bopening|اول|اول)\s*(\d{1,4})\s*(?:seconds?|secs?|s\b|ثانيه|ثواني)/i;
const RANGE_FIRST_MINUTES = /(?:\bfirst|\bopening|اول|اول)\s*(\d{1,3})?\s*(?:minutes?|دقيقه|دقائق)/i;

/**
 * "Cut the first ten seconds" means lose them, not keep them.
 *
 * Both halves of that sentence were being read and only one was being acted
 * on: `RANGE_FIRST` found the ten seconds and the branch kept exactly the
 * stretch the person had just asked to be rid of. A sixty-minute talk came
 * back ten seconds long, rendered, charged for, and announced as done.
 *
 * It is the same shape as the caption inversion -- a phrase whose object was
 * read and whose verb was not -- and it is worse here, because the caption
 * version left the video intact.
 *
 * Bare "the first ten seconds" with no verb still means keep: that is how
 * somebody names a stretch. Only these words turn it around, and «اقطع» is in
 * both lists for the reason English "cut" is: in this position it means lose
 * them, and the keep reading ("cut to the first ten seconds") carries its own
 * preposition, which is tested first.
 */
const CUT_TO_THE_FIRST = /\bcut (?:to|down to) the\b|\bjust\b|\bonly\b|\bkeep\b|خلي بس|خلي بس|بس اول|بس اول|احتفظ/i;
const DROP_THE_FIRST =
  /\b(?:cut|remove|drop|skip|trim|delete|lose|chop|take off|get rid of)\b|اقطع|اقطع|اقص|احذف|احذف|شيل|الغي|الغي|امسح|قص/i;

/**
 * Every single moment the sentence names, in seconds.
 *
 * A range says "keep this part"; a moment says "here, do this" — and until now
 * nothing in this product could say the second one. The renderer has taken
 * explicit punch times since it was written (`zoomPunch.at` is a list of
 * seconds), and both heads always sent `at: []`, which means "you choose". So
 * the capability existed, was tested, and was unreachable: there was no way for
 * a person to point at 0:12.
 *
 * Deliberately narrow about what counts. "at 0:12" and «عند 0:12» are somebody
 * pointing; a bare "12" in a sentence is a number, and reading it as a timecode
 * would turn "make it 12 seconds long" into a punch at the twelfth second. The
 * marker word is required.
 *
 * Ranges are left alone: `parseRange` runs on the same text and a moment inside
 * "from 1:20 to 2:10" is that range's own edge, not a third instruction.
 */

/**
 * The other things a sentence can ask for, so a moment can be seen to belong to
 * one of them rather than to the zoom.
 *
 * Not every operation word in this file, only the ones somebody plausibly
 * writes beside a timecode. A moment next to "make it vertical" competes for
 * nothing, because that applies to the whole video either way.
 */
const RIVAL_WORDS = new RegExp(
  [
    SILENCE_WORDS.source,
    CAPTION_WORDS.source,
    BROLL_WORDS.source,
    OVERLAY_WORDS.source,
    KINETIC_WORDS.source,
    HIGHLIGHT_WORDS.source,
    String.raw`\bcut\b|\btrim\b|\bremove\b|\bdelete\b|اقصص|اقص|احذف|شيل`,
  ].join("|"),
  "i",
);

/**
 * The moments that belong to `wanted` rather than to something else in the
 * same message.
 *
 * Nearest instruction word wins, measured in characters, either side. Two
 * shapes have to work and they put the words in opposite orders:
 *
 *   "zoom at 1:05 and at 2:30"       - verb first, two moments, one instruction
 *   "At 0:12 cut. At 0:40 zoom in."  - moment first, two instructions
 *
 * The first version scanned the whole message and put every second on the
 * single zoomPunch, so a mark asking to cut at 0:12 invented a punch there. The
 * second split on sentence ends *and* on "and", which fixed that and broke the
 * other one: "and at 2:30" is a clause with no verb in it, so its moment was
 * dropped and the person silently got one punch instead of two.
 *
 * Distance to the nearest instruction word is what both shapes have in common,
 * and it needs no guess about where a clause ends.
 */
export function momentsFor(asked: string, wanted: RegExp): number[] {
  const text = withAsciiDigits(asked);
  const anchors: Array<{ at: number; mine: boolean }> = [];
  for (const [pattern, mine] of [
    [wanted, true],
    [RIVAL_WORDS, false],
  ] as const) {
    const scan = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    for (const m of text.matchAll(scan)) anchors.push({ at: m.index ?? 0, mine });
  }
  if (!anchors.some((a) => a.mine)) return [];

  const found = new Set<number>();
  for (const second of parseMoments(text)) {
    const where = positionOfMoment(text, second);
    if (where < 0) continue;
    let nearest = anchors[0];
    for (const anchor of anchors) {
      if (Math.abs(anchor.at - where) < Math.abs(nearest.at - where)) nearest = anchor;
    }
    if (nearest.mine) found.add(second);
  }
  return [...found].sort((a, b) => a - b);
}

/** Where in the text a given second was written, or -1. */
function positionOfMoment(text: string, second: number): number {
  const clock = `${Math.floor(second / 60)}:${String(second % 60).padStart(2, "0")}`;
  const asClock = text.indexOf(clock);
  if (asClock >= 0) return asClock;
  const bare = new RegExp(String.raw`\b${second}\b`).exec(text);
  return bare?.index ?? -1;
}

/**
 * The moments a sentence named that nothing in the plan picked up.
 *
 * Exported because both heads owe this sentence. Someone stopping on a second
 * and typing "cut this bit" got silence: no operation, and nothing in the reply
 * about the moment either — which is worse than a refusal, because a refusal at
 * least says the product heard you and cannot help yet, and silence looks
 * exactly like success.
 *
 * The only thing that consumes a moment today is the zoom punch; everything
 * else applies to the whole video. When that changes for an operation, it
 * records what it used and this list shortens on its own, with no second place
 * to remember to edit.
 */
export function momentsNotHonoured(asked: string, operations: EditOperation[]): Phrase[] {
  const named = parseMoments(asked);
  if (named.length === 0) return [];
  const used = new Set(operations.flatMap((op) => (op.type === "zoomPunch" ? op.at : [])));
  const ignored = named.filter((second) => !used.has(second));
  if (ignored.length === 0) return [];
  const when = ignored.map(clockOf);
  return [
    say(
      `do something only at ${when.join(", ")} yet. Everything except a zoom punch applies to the whole video, so tell me what to do there and I will say if I can`,
      `أعمل إشي عند ${when.join("، ")} لحالها بعد، كل إشي غير التقريب بينطبق على الفيديو كلّه، قلّي شو أعمل هناك وبقلّك إذا بقدر`,
    ),
  ];
}

export function parseMoments(asked: string): number[] {
  const text = withAsciiDigits(asked);
  const found = new Set<number>();
  // `at 1:05` / `عند 1:05`, and the bare-seconds form with its unit spelled,
  // which is what distinguishes it from any other number in the sentence.
  const AT = String.raw`(?:\bat|\bon|عند|في)`;
  const SECOND_NOUN = String.raw`(?:the\s+)?(?:second|الثانيه|ثانيه)`;
  const MOMENT = new RegExp(
    // "at 1:05", «عند 1:05» — a clock, which is unambiguous.
    String.raw`${AT}\s*(?:${SECOND_NOUN}\s*)?(\d{1,3}):([0-5]\d)` +
      // ...or a count of seconds with its unit said, in either order, which is
      // what tells it apart from every other number in the sentence:
      // "at second 45", "at 45 seconds", «عند الثانية 45».
      String.raw`|${AT}\s*${SECOND_NOUN}\s*(\d{1,4})\b` +
      String.raw`|${AT}\s*(\d{1,4})\s*(?:seconds?|secs?|s\b|ثانيه|ثواني)`,
    "gi",
  );
  for (const m of text.matchAll(MOMENT)) {
    const seconds =
      m[1] !== undefined ? Number(m[1]) * 60 + Number(m[2]) : Number(m[3] ?? m[4]);
    if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 6 * 3600) found.add(seconds);
  }
  return [...found].sort((a, b) => a - b);
}

/** The stretch the sentence names, or null when it names none. */
export function parseRange(asked: string): { startSeconds: number; endSeconds: number } | null {
  const text = withAsciiDigits(asked);
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
  /*
    Which way round the opening stretch is meant. `dropsTheOpening` is asked
    once and used by both branches below, because "cut the first minute" and
    "cut the first sixty seconds" are the same sentence.

    The keep reading is tested first: "cut to the first ten seconds" contains
    the word that would otherwise drop them.

    `endSeconds` is the day-long ceiling the schema allows, because what is
    meant is "to the end" and the render clamps it to the file's real length.
  */
  const dropsTheOpening = !CUT_TO_THE_FIRST.test(text) && DROP_THE_FIRST.test(text);
  const TO_THE_END = 86400;

  const firstSeconds = RANGE_FIRST.exec(text);
  if (firstSeconds) {
    const n = Number(firstSeconds[1]);
    if (dropsTheOpening) return { startSeconds: n, endSeconds: TO_THE_END };
    if (n >= 5) return { startSeconds: 0, endSeconds: n };
    return null;
  }
  const firstMinutes = RANGE_FIRST_MINUTES.exec(text);
  if (firstMinutes) {
    const n = firstMinutes[1] ? Number(firstMinutes[1]) : 1;
    if (n >= 1 && n <= 180) {
      return dropsTheOpening
        ? { startSeconds: n * 60, endSeconds: TO_THE_END }
        : { startSeconds: 0, endSeconds: n * 60 };
    }
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
/**
 * How many, and the shapes people ask in.
 *
 * The trailing \b was the same mistake as above and it cost more, because this
 * one *did not fail loudly*: «قسّمها إلى ٥ مقاطع» still matched CLIPS_INTO, so
 * the split happened — with the count silently falling back to three. The
 * person asked for five, got three, and was told it was done.
 *
 * "into 6 pieces" missed for a different reason: the noun had to follow "into"
 * immediately, so a number or an adjective in between ("into separate clips",
 * the phrase this file's own reply advertises) broke it.
 */
const CLIPS_COUNT =
  /(?<!\d)(\d{1,2})\s*(?:clips?|shorts|pieces|segments|\u0645\u0642\u0627\u0637\u0639|\u0642\u0635\u0627\u0635\u0627\u062a|\u0623\u062c\u0632\u0627\u0621|\u0627\u062c\u0632\u0627\u0621|\u0643\u0644\u064a\u0628\u0627\u062a)/i;
const CLIPS_INTO =
  /\b(?:into|in ?to)\s+(?:\d{1,2}\s+)?(?:\w+\s+){0,2}(?:clips?|shorts|pieces|segments)\b|\u0642\u0633\u0651?\u0645\u0647?[^.]*(?:\u0645\u0642\u0627\u0637\u0639|\u0642\u0635\u0627\u0635\u0627\u062a|\u0623\u062c\u0632\u0627\u0621|\u0627\u062c\u0632\u0627\u0621|\u0643\u0644\u064a\u0628\u0627\u062a)/i;

/** The clips ask, or null. Count clamps to [2, 6]; length reuses the seconds pattern. */
export function parseClips(typed: string): { count: number; targetSeconds: number } | null {
  const text = withAsciiDigits(typed);
  const counted = CLIPS_COUNT.exec(text);
  const into = CLIPS_INTO.test(text);
  if (!counted && !into) return null;
  const count = Math.min(6, Math.max(2, counted ? Number(counted[1]) : 3));
  const asked = HIGHLIGHT_SECONDS.exec(text);
  const targetSeconds = Math.min(120, Math.max(5, asked ? Number(asked[1]) : 30));
  return { count, targetSeconds };
}

/*
 * `قرب` is here now, bare, and the edge is what keeps it honest.
 *
 * It used to be spelled `قرّب` with the shadda, and the shadda was doing real
 * work: it is what separates the imperative "zoom in" from «بالقرب من», which
 * means "near", and a matcher that punches in whenever somebody says "near" is
 * worse than one that misses a spelling.
 *
 * Then the matching started folding Arabic the way people type it -- no
 * shadda, no hamza -- because a third of this file was unreachable without it.
 * That fold takes the shadda away, so the distinction had to be made a
 * different way or lost.
 *
 * `arWord` is the different way, and it is the better one: «بالقرب» carries
 * «قرب» with an Arabic letter in front of it, so the edge refuses it, while
 * «قرب الصورة» has nothing in front and matches. The spelling nobody types is
 * reachable and the preposition still is not.
 */
/*
  «طاقة» needs an edge, because «بطاقة» contains it.

  `\b` is no help here: JavaScript's word character is `[A-Za-z0-9_]`, so a
  boundary placed against an Arabic letter is not the boundary anybody means.
  Left bare, «طاقة» (energy) matches inside «بطاقة» (card) — so an Arabic
  speaker asking for a section card got zoom punches they never mentioned, and
  an English speaker asking for the same card did not. `bilingual-test` found
  it the day a pair for `drawLayers` was finally written, which is what that
  file is for.

  The guard is a lookaround on the Arabic block itself. Only the words that can
  sit inside another word carry it; «زوم» and «قرّب» are left alone rather than
  wrapped for symmetry, because a guard on a word that does not need one is a
  guard nobody can tell is load-bearing.
*/
const AR = "\u0600-\u06FF";
const arWord = (word: string): string => `(?<![${AR}])${word}(?![${AR}])`;

const PUNCH_WORDS = new RegExp(
  `\\bzoom|punch|emphasi[sz]|energetic|energy|dynamic|hype\\b|زوم|تقريب|` +
    [`حماس`, `طاقه`, `حيويه`, `قرب`].map(arWord).join("|"),
  "i",
);

/**
 * The half of `PUNCH_WORDS` that names the move rather than a feeling.
 *
 * "zoom", "punch in", «تقريب», «قرّب» are requests about the *picture* and mean
 * nothing else. The rest — energetic, energy, dynamic, hype, «حماس», «طاقة»,
 * «حيوية» — are adjectives, and an adjective attaches to whatever noun is
 * nearest.
 *
 * Which is how «ضيف موسيقى حماسية» came to add zoom punches. The sentence asks
 * for *music* that is energetic; «حماسية» matched the punch list; the person
 * got their bed and four zoom punches they never mentioned. English was
 * unaffected, because "upbeat" is not in the list — so this was also a
 * bilingual asymmetry, and the Arabic half was the one that got the surprise.
 *
 * The rule below is the smallest one that fixes it without making the matcher
 * timid: an adjective alone does not ask for punches when the sentence is
 * asking for music. Say "zoom" and you get zooms, music or no music.
 */
/*
  The same word and the same edge as `PUNCH_WORDS`, for the same reason.

  This was spelled «قرّب» until Arabic started being folded the way people type
  it, and the shadda was the only thing keeping it out of «بالقرب من», which
  means "near". Folded and left bare, it punched in on any sentence that said
  something was near something. `arWord` is what replaces the shadda: an
  Arabic letter in front of «قرب» refuses the match, and nothing in front
  allows it.
*/
const PUNCH_MOVE_WORDS = new RegExp(
  `\\bzoom|punch|emphasi[sz]\\b|زوم|تقريب|` + [`قرب`].map(arWord).join("|"),
  "i",
);

/** Whether this sentence is really asking for punch-ins. */
function asksForPunches(text: string): boolean {
  if (PUNCH_MOVE_WORDS.test(text)) return true;
  // Only an energy adjective is left. It belongs to the music if music is what
  // the sentence is about.
  return PUNCH_WORDS.test(text) && !asksAboutMusic(text);
}
const PUSH_WORDS =
  /\bslow (push|zoom)|ken burns|drift|subtle move|cinematic move\b|زوم بطيء|تقريب بطيء|حركه بطيئه|حركه سينمائيه|كين بيرنز/i;

/**
 * Asking for coverage, which is what people call it when they do not know the
 * word.
 *
 * Almost nobody types "alternate the framing". They type "make it look like two
 * cameras", or "cut between wide and close", or «زي ما في كاميرتين» — the
 * *effect*, described from the viewer's seat. So the vocabulary here is the
 * effect's, and the operation's own name is not even in it.
 *
 * Deliberately not matching a bare "angle" or «زاوية». One angle is what this
 * has; a person who says "shoot it from another angle" is asking for footage we
 * do not have, and answering that with a crop is the product doing a different
 * thing and reporting it as the thing asked for.
 */
const COVERAGE_WORDS =
  /\btwo (?:cameras?|angles?|shot sizes?)\b|\bsecond camera\b|\bmulti-?cam\b|\bcoverage\b|\bwide and (?:close|tight)\b|\b(?:close|tight) and wide\b|\bdifferent shot sizes?\b|\bvary the (?:framing|shots?|shot sizes?)\b|\bchange up the framing\b|كاميرتين|كاميرا ثانيه|كاميرتان|حجمين|حجمان|قريبه وبعيده|بعيده وقريبه|نوع الكادر|نوع الكادر|تنويع الكادر|تغيير حجم اللقطه/i;

/*
  The refusal, written the same minute as the request it negates.

  This file's own history is the argument: "no captions" added captions and
  "keep the silence" cut it, both because a generous request pattern shipped
  without one of these beside it. The framing is the sentence people are most
  likely to be firm about — somebody who composed a shot and wants it left alone
  says so — so a request pattern here without its negation would be the same
  failure a third time.
*/
const NO_COVERAGE_WORDS =
  /\bkeep the (?:framing|frame|shot|composition)\b|\bsame framing\b|\bdon'?t (?:change|touch|move) the (?:framing|frame|shot size|composition)\b|\bone (?:angle|shot size)\b|\bno (?:reframing|zoom(?:ing)?)\b|خلي (?:الكادر|التاطير)|خلي (?:الكادر|التاطير)|لا تغير (?:الكادر|التاطير|حجم اللقطه)|لا تغير (?:الكادر|التاطير|حجم اللقطه)|بدون تغيير (?:الكادر|التاطير)|زاويه واحده|حجم واحد/i;
/**
 * "level the audio" was not in here, and that is the phrase this file's own
 * reply uses: "I'll level the audio to what these platforms expect". The
 * product said the words and could not hear them. Only "audio level" matched,
 * which is the same two words in the order nobody says them in.
 */
/**
 * Somebody naming the room rather than the level.
 *
 * A separate list from the loudness one, and separate because the two asks
 * arrive in different words and want different work: "the audio is quiet" is a
 * level, "there is a fan in the background" is a room. They produce the same
 * operation because the operation is where both live, but a sentence that
 * names noise must reach it even when it says nothing about volume.
 */
const NOISE_WORDS =
  // The Arabic used to need «في» in front of «ضجة», so «شيل الضجة» -- the
  // commonest way to ask for this -- reached nothing. The bare noun is here
  // now, with and without the article and with and without the shadda.
  /\b(?:noise|noisy|hiss|hissing|hum|humming|buzz|buzzing|denoise)\b|\b(?:room|background|ambient) tone\b|\bclean (?:up )?(?:the |my )?(?:audio|sound)\b|ضجيج|ضوضاء|شوشره|صوت المروحه|صوت الغرفه|ضجه|ضجه|نظف الصوت|نظف الصوت/i;

const LOUDNESS_WORDS =
  /\bloud|volume|quiet|audio level|sound level|normali[sz]|\blevel(l?ing)? (the |my )?(audio|sound|volume)\b|\bfix (?:the |my )?(?:audio|sound)\b|\bsort (?:out )?(?:the |my )?(?:audio|sound)\b|مستوي الصوت|اضبط الصوت|وحد الصوت|عدل الصوت|عدل الصوت|ظبط(?:لي|له|هولي)? ?(?:ال)?صوت|ظبط(?:لي|له|هولي)? ?(?:ال)?صوت|صلح الصوت|صلح الصوت|ارفع الصوت|الصوت واطي|الصوت منخفض|الصوت عالي|صوتي اعلي|صوتي واطي|صوتي منخفض|علي صوتي/i;
// "fade" alone is enough — every reading of it in an edit request means the
// ends ("fade it in", "fade to black", "soft ending"). Arabic: تلاشي/تلاشى.
// A hook is the one edit everyone names the same way. "Cold open" is the film
// term; "start with the best bit" is what people actually type.
const HOOK_WORDS =
  /\bhook\b|\bcold open\b|start (?:it )?with the (?:best|strongest)|\bbest (?:bit|part) first\b|\bput the best (?:bit|part) first\b|open (?:it )?(?:on|with) the (?:best|strongest)|هوك|ابدا بالاقوي|ابدا باقوي|ابدا بافضل|ابدا باهم|افتح باقوي|حط الاحلي بالاول|حط الاقوي بالاول|الاحلي بالاول|الاقوي بالاول/i;

/**
 * The shaped joins, and the words people use for them.
 *
 * Ordered longest-intent-first so "wipe left" is not eaten by the bare "wipe".
 * The direction words are checked next to the style word rather than anywhere
 * in the sentence, because "slide it left" and "cut the left third and slide
 * between the shots" are different requests and only one of them is about the
 * transition.
 */
/** The shaped styles as the reply says them. */
const STYLE_IN_WORDS: Record<Exclude<TransitionStyle, "dissolve">, string> = {
  wipeLeft: "wipe to the left",
  wipeRight: "wipe to the right",
  wipeUp: "wipe upward",
  wipeDown: "wipe downward",
  slideLeft: "slide to the left",
  slideRight: "slide to the right",
  slideUp: "slide upward",
  slideDown: "slide downward",
  softWipeLeft: "soft-edged wipe to the left",
  softWipeRight: "soft-edged wipe to the right",
  softWipeUp: "soft-edged wipe upward",
  softWipeDown: "soft-edged wipe downward",
  flash: "flash of white",
  flashBlack: "blink to black",
  flashGrey: "pass through grey",
  whipPan: "whip pan",
  zoomBlur: "zoom through a blur",
  glitch: "glitch at the seams",
};

/** The same, as the reply says them in Arabic. */
const STYLE_IN_WORDS_AR: Record<Exclude<TransitionStyle, "dissolve">, string> = {
  wipeLeft: "مسحة إلى اليسار",
  wipeRight: "مسحة إلى اليمين",
  wipeUp: "مسحة إلى الأعلى",
  wipeDown: "مسحة إلى الأسفل",
  slideLeft: "انزلاقة إلى اليسار",
  slideRight: "انزلاقة إلى اليمين",
  slideUp: "انزلاقة إلى الأعلى",
  slideDown: "انزلاقة إلى الأسفل",
  softWipeLeft: "مسحة بحافّة ناعمة إلى اليسار",
  softWipeRight: "مسحة بحافّة ناعمة إلى اليمين",
  softWipeUp: "مسحة بحافّة ناعمة إلى الأعلى",
  softWipeDown: "مسحة بحافّة ناعمة إلى الأسفل",
  flash: "ومضة بيضاء",
  flashBlack: "إطفاءة إلى السواد",
  flashGrey: "مرورة عبر الرمادي",
  whipPan: "سحبة سريعة",
  zoomBlur: "تقريب بضبابية سريعة",
  glitch: "جليتش عند الوصلات",
};

const TRANSITION_STYLES: Array<{ patterns: RegExp; style: TransitionStyle }> = [
  /*
    The montage three first, because their words are the specific ones.
    "whip pan" used to fall through to slideLeft — a plain slide is what a
    person who says whip pan explicitly did not ask for, and the day the
    real whip shipped, the mapping moved with it.
  */
  { patterns: /whip\s*-?pan|\bwhip\b|سحبه|سحبه سريعه/i, style: "whipPan" },
  { patterns: /zoom\s*-?blur|zoom transition|انتقال زوم|زوم بلور|تقريب سريع بين/i, style: "zoomBlur" },
  { patterns: /\bglitch|جليتش|غليتش|قليتش/i, style: "glitch" },
  /*
    The wipes, soft by default.

    A wipe's edge is the whole of how it reads, and ffmpeg's hard one is a line
    crossing the frame with nothing either side of it: the 2009 slideshow. The
    feathered version is what a person drawing a wipe on a storyboard means, so
    the bare word gets it and the hard edge is reachable by saying so.

    This changes what a *sentence* produces and not what a *plan* produces: a
    stored plan carries the style it was written with, and `wipeLeft` still
    renders the hard wipe it always did. See `HARD_EDGE` below.
  */
  { patterns: /\bwipe\s*(?:to\s*the\s*)?right|مسح(?:ه)?\s*لليمين/i, style: "softWipeRight" },
  { patterns: /\bwipe\s*(?:to\s*the\s*)?up|\bwipe\s*upward/i, style: "softWipeUp" },
  { patterns: /\bwipe\s*(?:to\s*the\s*)?down|\bwipe\s*downward/i, style: "softWipeDown" },
  { patterns: /\bwipe|مسح(?:ه)?/i, style: "softWipeLeft" },
  { patterns: /\bslide\s*(?:to\s*the\s*)?right|\bpush\s*right|انزلاق\s*لليمين/i, style: "slideRight" },
  { patterns: /\bslide\s*(?:to\s*the\s*)?up|\bpush\s*up/i, style: "slideUp" },
  { patterns: /\bslide\s*(?:to\s*the\s*)?down|\bpush\s*down/i, style: "slideDown" },
  { patterns: /\bslide|\bpush\b|\bswipe|انزلاق/i, style: "slideLeft" },
  /*
    The coloured joins, and the colour first.

    "Flash to black" and "flash" are the same word with opposite meanings — one
    is a full stop between two sections, the other is energy inside one — so the
    named colour is checked before the bare word, the way every other pair in
    this list is ordered. A bare flash stays white, which is what the word means
    when nobody says otherwise.
  */
  { patterns: /\b(?:flash|blink|cut)\s*(?:to|through)?\s*black\b|\bblack flash\b|ومضه\s*(?:الي\s*)?(?:سوداء|السواد)|فلاش اسود/i, style: "flashBlack" },
  { patterns: /\b(?:flash|fade)\s*(?:to|through)?\s*gr[ae]y(?:s)?\b|ومضه\s*رماديه|عبر الرمادي/i, style: "flashGrey" },
  { patterns: /\bflash\b|white flash|ومضه|فلاش/i, style: "flash" },
];

/**
 * Whether the sentence is talking about the joins at all.
 *
 * Required before any of the patterns above counts, because every one of those
 * words has an ordinary meaning in a sentence about video: "make a slideshow
 * of my photos" is not a request for a slide transition, and it matched one
 * until this existed. A shaped join is a statement *about the cuts*, so the
 * sentence has to mention them — which every real way of asking already does.
 *
 * Written as a separate condition rather than folded into each pattern so
 * there is one place to read the rule, instead of nine places to forget it.
 */
const JOIN_CONTEXT =
  /\bbetween\b|\btransitions?\b|\bcuts?\b|\bshots?\b|\bclips?\b|\bjoins?\b|بين|انتقال|القصات|القطعات|اللقطات/i;

/**
 * "Hard" said about a wipe, which is the only thing it can be said about.
 *
 * One qualifier and a table of four rather than eight more patterns in the
 * list above, because "hard" is not a different join, it is the same join with
 * the edge undone. Eight patterns would also have to be ordered against the
 * direction words all over again, which is the kind of list that is right the
 * day it is written and wrong the first time anybody adds to it.
 */
const HARD_EDGE = /\bhard[- ]?edged?\b|\bhard wipe\b|\bsharp wipe\b|مسح(?:ه)?\s*حاد?ه?|حاف?ه\s*حاد?ه?/i;

/** Each soft wipe's hard original. Nothing else has two edges to choose from. */
const HARD_WIPE: Partial<Record<TransitionStyle, TransitionStyle>> = {
  softWipeLeft: "wipeLeft",
  softWipeRight: "wipeRight",
  softWipeUp: "wipeUp",
  softWipeDown: "wipeDown",
};

/** Which shaped join a sentence asks for, if any. */
function transitionStyleFrom(text: string): TransitionStyle | null {
  if (!JOIN_CONTEXT.test(text)) return null;
  const style = TRANSITION_STYLES.find((entry) => entry.patterns.test(text))?.style ?? null;
  if (style && HARD_EDGE.test(text)) return HARD_WIPE[style] ?? style;
  return style;
}

/**
 * The join, not the ends.
 *
 * Kept apart from FADE_WORDS on purpose even though "fade" appears in both
 * vocabularies: "fade to black" and "crossfade" are opposite ends of the same
 * word, and a sentence containing "cross fade" must not also trip the ends.
 * The English side therefore requires the *compound*, never bare "fade".
 */
const DISSOLVE_WORDS =
  /\bcross ?-?fade|\bdissolve|\bblend (?:between|the cuts)|smooth(?:er)? (?:the )?(?:cuts|joins|transitions?)|(?:cuts|joins|transitions?) smooth(?:er)?|less jump(?:y|ing)|between (?:the )?(?:cuts|clips)|تلاش(?:ي|) بين|مزج|انتقال ناعم|بين القصات|بين القطعات|ذوب|ذوب بين|تذويب|بين المقاطع/i;

const FADE_WORDS = /\bfade|fade[- ]?(?:in|out)|to black|soft (?:opening|ending|start|end)|تلاشي|تلاشي/i;

/**
 * The cutaway's own edge, which is not the joins.
 *
 * A cutaway is a second picture over one that keeps running, so "dissolve into
 * the b-roll" is a different request from "dissolve between the cuts". Until
 * this existed the first was heard as the second: a dissolve went onto every
 * seam in the timeline and the cutaway carried on popping, which is the exact
 * opposite of what was asked for.
 */
const SOFT_CUTAWAY =
  /\b(?:dissolve|fade|blend|ease|cross ?-?fade)\s+(?:in\s*)?(?:to|into)?\s*(?:the\s*)?(?:b-?roll|cutaways?)\b|\b(?:b-?roll|cutaways?)\s+(?:should\s+)?(?:dissolve|fade)|(?:ذوب|ذوب|تلاشي?|مزج)\s*(?:عند|الي|في)?\s*(?:اللقطات|لقطات|اللقطه)\s*(?:المسانده|المسانده)?/i;

/**
 * Whether the sentence named the *timeline's* cuts, rather than the cutaway.
 *
 * Read only to settle the one ambiguity the two vocabularies share: "dissolve
 * into the b-roll" contains the word dissolve, and the bare word is enough on
 * its own to ask for a transition between every scene. A sentence that names
 * the cutaway edge and says nothing about the cuts has not asked for one.
 */
const CUTS_NAMED = /\bcuts?\b|\bjoins?\b|\bshots?\b|\btransitions?\b|بين|القص|القطعات|انتقال/i;

export function planFromText(
  asked: string,
  options: { defaultPlatform?: Platform | null; assets?: LibraryFile[] } = {},
): ParsedIntent {
  // Matched against normalised digits; `asked` stays exactly as typed, and is
  // what the quoted-title read below uses, because those are their words.
  const text = withAsciiDigits(asked);
  const operations: EditOperation[] = [];
  const willDo: Phrase[] = [];
  const cannotYet: Phrase[] = [];

  /*
    A refusal contains the word it refuses, and until now that was the whole
    behaviour: "keep the silence" contains "silence" and produced a silence
    cut; "no captions on this one" contains "captions" and produced captions.
    The product did the opposite of what those sentences asked, reported it as
    done, and rendered it.

    It went unnoticed because both patterns were written to be generous — the
    right instinct for the ways people ask for a thing, and exactly wrong for
    the ways they decline it. Generosity about a request has to be paired with
    a reading of the refusal, or the more phrasings you accept the more
    refusals you swallow.
  */
  const refusesCaptions = NO_CAPTION_WORDS.test(text);
  const refusesSilenceCut = NO_SILENCE_WORDS.test(text);

  const wantsSilenceCut = SILENCE_WORDS.test(text) && !refusesSilenceCut;
  const platform = PLATFORM_WORDS.find((p) => p.patterns.test(text))?.platform ?? null;
  const wantsVertical = platform !== null || VERTICAL_WORDS.test(text);

  /*
    What the sentence is *about*, as opposed to what it asked for.

    A refusal is a decision. "no captions" mentions captions, produces no
    caption operation, and must stop anything from adding one on the strength
    of what this person usually does — which is the difference between a
    product that knows you and one that ignores you. So the test is the
    subject's own vocabulary plus its negations, not the operation list.
  */
  const spoke = {
    platform: platform !== null || VERTICAL_WORDS.test(text) || HORIZONTAL_WORDS.test(text),
    captions: CAPTION_WORDS.test(text) || TRANSLATE_WORDS.test(text) || refusesCaptions,
    silence: SILENCE_WORDS.test(text) || refusesSilenceCut,
    // Music, request or refusal alike. The restructure planner lays a bed on its
    // own when a track is present, and without this a person who said "no music"
    // — having named the subject, and been given no bed here — still had one
    // added there, because "not requested" and "refused" looked the same to it.
    // A complaint about the bed is a decision about music too: whatever else
    // happens to this sentence, nothing downstream should add one.
    music: asksAboutMusic(text) || NO_MUSIC_WORDS.test(text) || MUSIC_TOO_LOUD_WORDS.test(text),
    /*
     * Coverage and effects, request or refusal alike, and both were missing.
     *
     * `direct.ts` adds `alternateFraming` to anything over a minute with cuts
     * in it, and quiet `soundEffects` to any vertical with cuts. Neither could
     * see a refusal, because neither was told: "don't change the framing" and
     * "no sound effects" both parse here, both correctly produce no operation,
     * and both were then overruled by the layer that fills in what the sentence
     * did not mention. The framing is the thing people are most firm about —
     * somebody who composed a shot and wants it left alone says so once and
     * expects that to hold.
     */
    coverage: COVERAGE_WORDS.test(text) || NO_COVERAGE_WORDS.test(text),
    sfx: SFX_WORDS.test(text) || NO_SFX_WORDS.test(text),
  };

  /*
    The subjects this sentence said no to, as opposed to said something about.

    `spoke` cannot answer this: it is true for "add captions" and for "no
    captions" alike, which is exactly what it is for. But a sentence that is
    *only* a refusal produced no operation, no phrase, and therefore the reply
    that says we did not catch it -- so "no captions please" and «بلا ترجمة»,
    which are about as clear as a sentence gets, were answered as gibberish.

    A refusal is honoured either way; what was missing was saying so. On a
    project with a render already made it is honoured by absence, which is
    fine because the list names everything else. On the first message of a
    project there is nothing to list, and silence reads as not having heard.
  */
  const declined: Array<keyof SpokenSubjects> = [];
  if (refusesCaptions) declined.push("captions");
  if (refusesSilenceCut) declined.push("silence");
  if (NO_MUSIC_WORDS.test(text)) declined.push("music");
  if (NO_COVERAGE_WORDS.test(text)) declined.push("coverage");
  if (NO_SFX_WORDS.test(text)) declined.push("sfx");

  /*
    Three sentences, three answers.

    "Cut the ums" names the hesitations, and gets exactly those. "Tighten it
    up" is a person asking for the whole treatment, which is the pauses *and*
    the hesitations, because that is what the phrase means to the person saying
    it. And "cut the silences" is as precise as the first one — so it gets the
    silences and nothing else.

    That last case is the one worth writing down. Deriving this from
    `wantsSilenceCut` would have made every silence request also start deleting
    speech, on the reasoning that they are both tidying. They are not: a pause
    removed is time, and a word removed is what somebody said.
  */
  const refusesTighten = NO_TIGHTEN_WORDS.test(text);
  const namedHesitations = HESITATION_WORDS.test(text) && !refusesTighten;
  const wantsWholeTreatment = WHOLE_TREATMENT_WORDS.test(text) && !refusesTighten;
  const wantsTighten = namedHesitations || wantsWholeTreatment;

  if (wantsSilenceCut) {
    operations.push({ type: "removeSilence", thresholdDb: -32, minSilenceMs: 500, paddingMs: 80 });
    willDo.push(say("take out the silent bits", "أشيل السكتات"));
  }

  if (wantsTighten) {
    operations.push({ type: "tighten", fillers: true, repeats: true });
    willDo.push(
      say("take out the ums and the sentences that start twice", "أشيل «آآ» و«يعني» والجمل اللي بتبلّش مرتين"),
    );
  }

  // Several pieces, each its own output. Checked before the highlight and the
  // range: "the best 3 clips" is a clips ask, and the worker would drop a
  // stray highlight riding along anyway — better not to promise one.
  const clipsAsk = parseClips(text);
  if (clipsAsk) {
    operations.push({ type: "extractClips", ...clipsAsk });
    willDo.push(
      say(
        `cut it into ${clipsAsk.count} separate clips of about ${clipsAsk.targetSeconds} seconds each`,
        `أقسّمه إلى ${clipsAsk.count} مقاطع منفصلة، كلٌّ منها نحو ${clipsAsk.targetSeconds} ثانية`,
      ),
    );
  }

  /*
    A named target length, read as the highlight it is.

    "Make it 60 seconds" and "give me the strongest 60 seconds" ask for the
    same file. Only the second was heard, and the first is how anybody cutting
    to a platform's limit actually says it.

    Taken before the highlight branch so that a sentence carrying both a target
    and the word "best" does not produce two, and guarded on there being no
    explicit range: "keep it to 1:20 to 2:10" already named its seconds.
  */
  const targetLength = clipsAsk ? null : TARGET_LENGTH.exec(text);
  const targetSeconds = (() => {
    if (!targetLength) return null;
    // One number across six spellings; only one group ever fills.
    const n = Number(
      targetLength[1] ?? targetLength[2] ?? targetLength[3] ?? targetLength[4] ?? targetLength[5] ?? "",
    );
    const arabicUnit = targetLength[6];
    // «خليه دقيقة» has no digit and means one of whatever it named.
    const count = Number.isFinite(n) && n > 0 ? n : arabicUnit ? 1 : NaN;
    if (!Number.isFinite(count)) return null;
    const inMinutes = arabicUnit
      ? /دقيق/.test(arabicUnit)
      : /\b(?:minutes?|mins?)\b/i.test(targetLength[0]);
    const seconds = inMinutes ? count * 60 : count;
    // Under five seconds is not a video and over three hours is not a target.
    return seconds >= 5 && seconds <= 3 * 3600 ? Math.round(seconds) : null;
  })();

  if (targetSeconds !== null && !HIGHLIGHT_WORDS.test(text) && !parseRange(text)) {
    operations.push({ type: "extractHighlight", targetSeconds });
    willDo.push(
      say(
        `pick the strongest ${targetSeconds} seconds, since that is the length you asked for`,
        `أختار أقوى ${targetSeconds} ثانية، لأن هاد الطول اللي طلبته`,
      ),
    );
  }

  // The person asks for a length; where those seconds live is the worker's
  // judgement, made from the transcript. The plan carries only the length.
  if (!clipsAsk && HIGHLIGHT_WORDS.test(text)) {
    const asked = HIGHLIGHT_SECONDS.exec(text);
    /*
      No ceiling, for the reason written beside the model's copy of this in
      `planner.ts`: `chooseHighlight` has none, and 120 only ever turned "the
      best ten minutes" into two.
    */
    const targetSeconds = Math.max(5, asked ? Number(asked[1]) : 30);
    operations.push({ type: "extractHighlight", targetSeconds });
    willDo.push(say(`take the strongest ${targetSeconds} seconds and make them a video on their own`, `آخد أقوى ${targetSeconds} ثانية وأعملها فيديو لحاله`));
  }

  // The stretch they named, kept exactly. The mirror of the highlight: there
  // the worker chooses the moments, here the person already has.
  const range = clipsAsk ? null : parseRange(text);
  if (range) {
    operations.push({ type: "extractRange", ...range });
    /*
      Two sentences, because there are two requests.

      "Keep from 1:20 to 2:10" names a stretch to hold on to. "Cut the first
      ten seconds" names a stretch to lose, and the rest of the recording is
      what comes back -- there is no second number to read out, because the end
      is wherever the recording ends. Reading the first sentence over the
      second is what made the inversion invisible: the plan dropped the whole
      video and the reply said "the part you asked for".
    */
    const dropsOpening = range.startSeconds > 0 && range.endSeconds >= 86400;
    willDo.push(
      dropsOpening
        ? say(
            `drop the first ${clockOf(range.startSeconds)} and keep the rest`,
            `أشيل أول ${clockOf(range.startSeconds)} وأبقي الباقي`,
          )
        : say(
            `keep only what is between ${clockOf(range.startSeconds)} and ${clockOf(range.endSeconds)}, the part you asked for`,
            `أبقي بس اللي بين ${clockOf(range.startSeconds)} و${clockOf(range.endSeconds)}، الجزء اللي طلبته`,
          ),
    );
  }

  if (wantsVertical) {
    const target = platform ?? options.defaultPlatform ?? "tiktok";
    operations.push({ type: "formatForPlatform", platform: target });
    const shaped = shapeInWords(target);
    willDo.push(
      say(
        `make it ${shaped.en} for ${platformInWords(target, "en")}`,
        `أخلّيه ${shaped.ar} ل${platformInWords(target, "ar")}`,
      ),
    );
  }

  // The words are in the video, not in this sentence, so the plan asks for
  // captions and the worker fills them in once it has heard the clip. If no
  // recogniser is configured there, the render comes back saying so.
  // Translation is refused before captions are added, not after, and the
  // captions are *not* added anyway. Someone who asked for English subtitles on
  // an Arabic video and got Arabic ones has been handed the wrong file and told
  // it is the right one — which is worse than being told no.
  const wantsTranslation = TRANSLATE_WORDS.test(text);
  if (wantsTranslation) {
    cannotYet.push(
      say(
        "put it into another language yet. Captions come out in whatever language is spoken",
        "أنقله إلى لغة أخرى بعد، الترجمة تخرج باللغة المنطوقة نفسها",
      ),
    );
  }

  /*
    Saying something about how the captions should look is asking for captions.

    Nobody calls them captions when they want them bigger. They say "make the
    text bigger", «كبّر الخط», "put the words at the top" -- and every gate
    here named the thing by our word for it, so the commonest sentence in this
    whole area reached nothing at all. The person was told we did not catch it,
    having asked for something the product does.

    The look patterns are the gate's second half rather than a new list,
    because a second list is how the gate and the branch start disagreeing
    about what a sentence meant.
  */
  const saysHowCaptionsLook =
    CAPTION_BIG_WORDS.test(text) ||
    CAPTION_SMALL_WORDS.test(text) ||
    CAPTION_TOP_WORDS.test(text) ||
    CAPTION_MIDDLE_WORDS.test(text) ||
    CAPTION_BOTTOM_WORDS.test(text) ||
    KARAOKE_WORDS.test(text) ||
    CAPTION_STYLE_WORDS.some(([words]) => words.test(text));

  if ((CAPTION_WORDS.test(text) || saysHowCaptionsLook) && !wantsTranslation && !refusesCaptions) {
    /*
      Only what the sentence actually said.

      Every one of these used to end in a fallback — `?? "bold-white"`,
      `: "bottom"`, `: "m"`, `: "pop"`, `: "normal"` — and that is where the
      product's default was really decided: not in the schema, not in a named
      constant, but in the last branch of five ternaries in a keyword matcher.
      A person who typed "add captions" got the same object as a person who
      typed "white captions at the bottom", and nothing downstream could tell
      them apart.

      Now a field is written only when a word chose it, and everything else is
      left off for `DEFAULT_CAPTION_LOOK` to answer at the last moment — which
      is what lets the picker style an unstyled plan, the habits apply what
      somebody always does, and the default itself change without rewriting
      this file.
    */
    const style =
      CAPTION_STYLE_WORDS.find(([words]) => words.test(text))?.[1] ??
      (KARAOKE_WORDS.test(text) ? "karaoke-box" : YELLOW_WORDS.test(text) ? "bold-yellow" : undefined);
    const position = CAPTION_TOP_WORDS.test(text)
      ? "top"
      : CAPTION_MIDDLE_WORDS.test(text)
        ? "middle"
        : CAPTION_BOTTOM_WORDS.test(text)
          ? "bottom"
          : undefined;
    const size = CAPTION_BIG_WORDS.test(text) ? "l" : CAPTION_SMALL_WORDS.test(text) ? "s" : undefined;
    /*
      Karaoke first, and the order is the decision.

      "Word by word" reaches both patterns, and it has meant the wipe since
      the wipe shipped. A new animation that quietly took an established
      phrase would change what an existing sentence produces — which is the
      shape of regression this file keeps finding — so `kinetic` only answers
      the words the wipe never claimed.

      The last branch is `undefined` rather than "pop": a sentence that says
      nothing about movement leaves the style to bring its own, which is the
      whole point of every row in the catalogue carrying a `defaultAnimation`
      that nothing read for as long as this line said "pop".
    */
    const animation = RISE_WORDS.test(text)
      ? "rise"
      : FOCUS_WORDS.test(text)
        ? "focus"
        : KARAOKE_WORDS.test(text)
          ? "karaoke"
          : KINETIC_CAPTION_WORDS.test(text)
            ? "kinetic"
            : CAPTION_QUICK_WORDS.test(text)
              ? // The reference fast-cut look, asked for in words: at two swaps
                // a second any entrance animation reads as flicker, so quick
                // pace asked for on its own brings the hard swap with it. Not
                // applied to the *default* quick pace, which gets the style's
                // own animation — `creator` was built with focus and measured
                // with it.
                "none"
              : undefined;
    const pace = CAPTION_QUICK_WORDS.test(text) ? "quick" : CAPTION_CALM_WORDS.test(text) ? "normal" : undefined;

    operations.push({
      type: "autoCaptions",
      ...(style ? { style } : {}),
      ...(position ? { position } : {}),
      ...(size ? { size } : {}),
      ...(animation ? { animation } : {}),
      ...(pace ? { pace } : {}),
      dropFillers: true,
    });
    willDo.push(
      KINETIC_CAPTION_WORDS.test(text) && !KARAOKE_WORDS.test(text)
        ? say(
            "caption it from what is actually said, with each word arriving as it is spoken and the word you lean on drawn larger",
            "أكتب الترجمة من الكلام المنطوق نفسه، كل كلمة بتوصل وقت ما تنقال، والكلمة اللي بتشدّد عليها بترسمها أكبر",
          )
        : say("write what you say on the screen", "أكتب الكلام اللي بتحكيه عالصورة"),
    );
  }

  // An empty `at` means "you choose": the worker puts the punches where the
  // speaker leaned on a word, which it can only know after transcribing.
  // The slow push is read first, and the order is the whole point: PUSH_WORDS
  // has always named "slow zoom" explicitly, and PUNCH_WORDS' bare \bzoom ate
  // it every time — so the one phrase that unambiguously means *gentle* was the
  // one that produced hits. The author's intent was written down; the order
  // defeated it. Most specific first, and it survives.
  if (PUSH_WORDS.test(text)) {
    operations.push({ type: "kenBurns", to: 1.08 });
    willDo.push(say("move the picture slowly so it is not standing still", "أحرّك الصورة شوي بهدوء حتى ما تضلّ واقفة"));
  } else if (asksForPunches(text)) {
    // Where they pointed, if they pointed anywhere. An empty list still means
    // "you choose", and the worker still puts them on the emphasis — so a
    // sentence with no moment in it behaves exactly as it always has.
    const moments = momentsFor(text, PUNCH_WORDS);
    operations.push({ type: "zoomPunch", at: moments, amount: 0.13, holdMs: 1000, on: "emphasis" });
    willDo.push(
      moments.length > 0
        ? say(
            `punch in at ${moments.map(clockOf).join(", ")}`,
            `أقرّب الصورة عند ${moments.map(clockOf).join("، ")}`,
          )
        : say("punch in where you lean on a word", "أقرّب الصورة عند الكلمات اللي بتشدّد عليها"),
    );
  }

  /*
    Coverage is read after the two zooms and independently of them, because it
    is not one of them. A slow push and a punch both move the frame *within* a
    shot; this changes the frame *between* shots and never moves it. Someone who
    asks for both should get both, and the renderer's own ceiling keeps the
    compound zoom inside the pixels the crop reserved.
  */
  if (COVERAGE_WORDS.test(text) && !NO_COVERAGE_WORDS.test(text)) {
    operations.push({ type: "alternateFraming", amount: 0.15 });
    willDo.push(
      say(
        "switch between a wide shot and a close one, so it looks like two cameras instead of one",
        "أبدّل بين لقطة واسعة ولقطة قريبة، فبتبيّن كأنه في كاميرتين مش وحدة",
      ),
    );
  }

  const namedNoise = NOISE_WORDS.test(text);
  if (LOUDNESS_WORDS.test(text) || namedNoise) {
    // `voice` is decided at the end, once the whole sentence has been read —
    // see the note above the loop below. `denoise` is asked for either way and
    // costs nothing when there is nothing to remove: the renderer measures the
    // room in the pauses and leaves a quiet one alone.
    operations.push({ type: "normalizeLoudness", targetLufs: -14, voice: false, denoise: true });
    willDo.push(
      namedNoise
        ? say(
            "even out the sound and take the room noise from under your voice",
            "أظبّط الصوت وأشيل ضجّة الغرفة من تحت صوتك",
          )
        : say("even out the sound to what these apps expect", "أظبّط الصوت متل ما بدها هالتطبيقات"),
    );
  }

  // A bare "add transitions" used to be refused outright. The fade at the ends
  // is a transition and it is built, so the ask now produces it — and the
  // narrower "between the cuts" entry above still says what is missing, so
  // nobody is told they got something they did not.
  if (HOOK_WORDS.test(text)) {
    operations.push({ type: "coldOpen", seconds: 4 });
    willDo.push(say("start with the strongest moment, then carry on from the beginning", "أبلّش بأقوى لحظة، وبعدها بيكمّل من أوله"));
  }

  // Two different transitions, asked for in overlapping words. "Transitions"
  // with nothing else said means both — the ends and the joins — because that
  // is what the word means to someone who has never seen this menu, and both
  // now exist. Naming one gets exactly the one named.
  /*
    The word for it, and the trap it fell into.

    This read `/\btransitions?\b|\bانتقال|انتقالات/i`, and the `\b` in front of
    the Arabic could never match. A boundary sits between a word character and a
    non-word one; every Arabic letter is a non-word character to a JavaScript
    regular expression, so `\bانتقال` can only fire where a Latin letter or a
    digit is touching the alif. «حط انتقال بين القصّات» has a space there, so the
    singular Arabic word for a transition produced nothing at all — the plural
    worked, because the `انتقالات` alternative beside it carries no `\b`. The
    same trap is documented in four other places in this file; this is the
    fifth, and it was sitting on the feature's own name.

    Bare stems and no suffixes, because Arabic prefixes and suffixes attach to
    the word: «انتقال» is inside «الانتقال», «انتقالات» and «الانتقالات», and
    matching the stem catches all four without four alternatives to keep in
    step. Writing `انتقالات?` instead would have been a third bug in one line —
    that is «انتقالا» with an optional «ت», which is not a word.

    The transliterations are here because that is what people actually type.
    The request that led to this change was written «الترانزشنز», which this
    product did not understand at all.
  */
  const wantsAnyTransition = /\btransitions?\b|انتقال|ترانز[يی]?شن/i.test(text);
  const shapedStyle = transitionStyleFrom(text);
  /*
    A cutaway edge is not a join, and the bare word "dissolve" belongs to
    whichever of the two the sentence actually named. "Dissolve into the
    b-roll" asked for one thing; reading it as both puts a dissolve on every
    seam in the timeline that nobody asked for.
  */
  const softCutaway = SOFT_CUTAWAY.test(text);
  const wantsDissolve = DISSOLVE_WORDS.test(text) && !(softCutaway && !CUTS_NAMED.test(text));
  /*
    Where they want them, when they said.

    The renderer puts a transition where the recording jumps and leaves every
    tidying cut hard, which is what somebody who typed "add transitions" meant
    and is not what somebody who typed "a transition between every cut" meant.
    The second is a real ask — a montage, a slideshow, a flash on the beat —
    and it is narrow on purpose: "every", "each" or "all" has to be next to the
    word for a cut, because "add transitions to all of it" is the first sentence
    again with an emphasis on it.

    No `\b` before the Arabic, which does not work in front of an Arabic letter:
    `\b` is a boundary between a word character and a non-word one, and every
    Arabic letter is a non-word character to a JavaScript regular expression, so
    `\bكل` can only ever match where a Latin letter touches it. The trap is
    documented in four other places in this file and this is the fifth.
  */
  const EVERY_CUT_WORDS =
    /\b(?:every|each|all)\s+(?:single\s+)?(?:cut|cuts|join|joins|seam|seams|clip|clips|shot|shots)\b|(?:كل|بين كل)\s*(?:قص?ه|قص?ات|وصله|وصلات|مقطع|مقاطع|لقطه|لقطات)/i;
  const everyCut = EVERY_CUT_WORDS.test(text);
  /*
    The ends, and only when the ends are what was meant.

    A bare "transitions" means both halves of the word — the fade at the ends
    and the join between the cuts — because that is what it means to somebody
    who has never seen this menu, and both exist. But «انتقال ناعم بين
    المقاطع» and "a soft transition between the cuts" have already said which
    half, and adding a fade to black on top of that is answering the vaguer
    reading of a sentence that was not vague.

    The same rule is applied to the style ten lines down, and this is where it
    should always have started: a named shape wins over the general ask.
  */
  const namedTheJoins = wantsDissolve || shapedStyle !== null;
  if (FADE_WORDS.test(text) || (wantsAnyTransition && !namedTheJoins)) {
    operations.push({ type: "fade", durationMs: 500 });
    willDo.push(say("start it from a black screen and end on one", "أخلّيه يبلّش من شاشة سودا ويخلص عليها"));
  }
  // A named shape wins over the general ask: somebody who said "wipe" asked
  // for a wipe, and giving them the default because they also said the word
  // "transitions" would be answering the vaguer half of their sentence.
  if (shapedStyle || wantsDissolve || wantsAnyTransition) {
    const style = shapedStyle ?? "dissolve";
    // This briefly refused to run alongside a cold open, because a reordered
    // cut list deadlocked the renderer's audio crossfade. The renderer now
    // seeks each piece on its own input instead of branching one decode, so
    // the pair works and the promise is good again. The note is left here
    // because the two features still interact, and the next person to touch
    // either one should know that they do.
    operations.push({
      type: "transition",
      style,
      durationMs: 250,
      where: everyCut ? "everyCut" : "scenes",
    });
    /*
      And the reply says which, because the difference is visible in the file.

      Somebody told "dissolve between the cuts" who then watches a thirty-cut
      edit with four dissolves in it has been misled by the sentence rather than
      by the render. The narrower promise is also the more impressive one: it
      says the product looked at the cuts instead of treating them all alike.
    */
    const named = style === "dissolve" ? null : STYLE_IN_WORDS[style];
    const namedAr = style === "dissolve" ? null : STYLE_IN_WORDS_AR[style];
    willDo.push(
      everyCut
        ? named
          ? say(
              `make every change of scene a ${named} instead of a jump`,
              `أخلّي كل تغيير مشهد ${namedAr} بدل ما ينطّ`,
            )
          : say("let every scene fade into the next instead of jumping", "أخلّي كل مشهد يذوب بالتاني بدل ما ينطّ")
        : named
          ? say(
              `use a ${named} only where the recording jumps, not at every change of scene`,
              `أحطّ ${namedAr} بس وين التسجيل بينطّ، مش عند كل تغيير مشهد`,
            )
          : say(
              "fade only where the recording jumps, not at every change of scene",
              "أخلّيه يذوب بس وين التسجيل بينطّ، مش عند كل تغيير مشهد",
            ),
    );
  }

  // ── The project's own files ────────────────────────────────────────────────
  const library = options.assets ?? [];
  const clips = library.filter((a) => a.kind === "video");
  const stills = library.filter((a) => a.kind === "image");

  if (BROLL_WORDS.test(text)) {
    if (clips.length === 0) {
      cannotYet.push(say("show other clips over your talking yet, because this project has no clips to show", "أورّي مقاطع تانية فوق كلامك بعد، لأن المشروع ما فيه مقاطع أورّيها"));
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
          edge: softCutaway ? "dissolve" : "cut",
        });
        willDo.push(
          softCutaway
            ? say(
                `fade into ${describeFile(clip)} at ${at}s`,
                `أذوب على ${describeFile(clip)} عند الثانية ${at}`,
              )
            : say(`cut away to ${describeFile(clip)} at ${at}s`, `أقطع إلى ${describeFile(clip)} عند الثانية ${at}`),
        );
      });
    }
  }

  // A named look. Before the library block, because it needs no file of theirs.
  const look = LOOK_WORDS.find((entry) => entry.patterns.test(text))?.look;
  if (look) {
    operations.push({ type: "grade", saturation: 1, look });
    willDo.push(
      look === "mono"
        ? say("make it black and white", "أخلّيه أبيض وأسود")
        : look === "punch"
          ? say("make the colours stronger and clearer", "أخلّي الألوان أقوى وأوضح")
          : say(`give it a ${look} look`, `أعطيه لون ${look}`),
    );
  }

  const tracks = library.filter((a) => a.kind === "audio");

  /*
    Their file first, and a bed we make when they have none.

    The refusal that used to live here was right for as long as the only
    possible source was a catalogue: a track we hand out is a licence we bought
    on somebody's behalf. It stopped being right when the bed could be
    *generated* — audio made to our own account is ours to give away, and the
    person who asked for music and owns none is no longer told to go and find
    some.

    Their own upload still wins wherever it exists, and that is not politeness:
    they chose that track, and a piece of music somebody picked beats one a
    mood name produced every time.
  */
  /*
    A complaint about a bed that is already there gets the truth, not a bed.
    See MUSIC_TOO_LOUD_WORDS. Placed before the request branch so the word
    "music" cannot reach it, and it sets `spoke.music` through the same door
    the refusal does, so no later layer lays one either.
  */
  if (MUSIC_TOO_LOUD_WORDS.test(text)) {
    cannotYet.push(
      say(
        "turn down music that is already in the recording, because it shares one track with your voice",
        "أنزّل موسيقى هي أصلًا جوّا التسجيل، لأنها ع نفس المسار مع صوتك",
      ),
    );
    if (!operations.some((op) => op.type === "normalizeLoudness")) {
      operations.push({ type: "normalizeLoudness", targetLufs: -14, voice: true, denoise: true });
      willDo.push(
        say(
          "even out the sound so your voice sits on top of it",
          "أظبّط الصوت لحتى صوتك يطلع فوقها",
        ),
      );
    }
  } else if (asksAboutMusic(text) && !NO_MUSIC_WORDS.test(text)) {
    if (tracks.length === 0) {
      const mood = musicMoodFrom(text);
      operations.push({
        type: "addMusic",
        mood,
        gainDb: -18,
        duck: true,
        fadeSeconds: 1.5,
        fromSeconds: 0,
        loop: true,
      });
      willDo.push(
        say(
          `put ${MUSIC_MOOD_NAMES[mood].en} music under the whole video, dropping down while you talk`,
          `أحطّ موسيقى ${MUSIC_MOOD_NAMES[mood].ar} تحت الفيديو كلّه، بتنخفض لمّا تحكي`,
        ),
      );
    } else {
      const track = tracks[0]!;
      operations.push({
        type: "addMusic",
        assetId: track.id,
        gainDb: -18,
        duck: true,
        fadeSeconds: 1.5,
        fromSeconds: 0,
        loop: true,
      });
      willDo.push(say(`lay ${describeFile(track)} under the whole edit, ducking under your voice`, `أضع ${describeFile(track)} تحت التعديل كلّه، تنخفض تحت صوتك`));
    }
  }

  /**
   * Cutting to the beat.
   *
   * This sat on the "cannot yet" list next to emojis for the whole life of the
   * product, and it is one of the three or four edits short-form video is
   * actually made of. What it needs is a *reading of the music*, which the
   * worker can now do — see beats.ts, and note that it answers "no beat here"
   * far more often than it answers with a grid.
   *
   * It is placed in this section rather than with the other motion asks for one
   * reason: this is where the library is known. An edit with no bed has no beat
   * to land on, and the honest reply names the fix — the same shape as music,
   * b-roll and overlays above.
   */
  if (BEAT_SYNC_WORDS.test(text)) {
    if (tracks.length === 0) {
      cannotYet.push(
        say(
          "follow the beat yet, because this project has no music to follow. Send the track and the zooms will land on it",
          "أمشي على الإيقاع بعد، لأن المشروع ما فيه موسيقى أمشي عليها. ارفع المقطوعة ورح يصير التقريب على ضرباتها",
        ),
      );
    } else {
      const track = tracks[0]!;
      // Asking for the cuts to follow the music is also asking for the music.
      // Making them say both would be the product being pedantic about its own
      // internal shape.
      if (!operations.some((op) => op.type === "addMusic")) {
        operations.push({
          type: "addMusic",
          assetId: track.id,
          gainDb: -18,
          duck: true,
          fadeSeconds: 1.5,
          fromSeconds: 0,
          loop: true,
        });
        willDo.push(
          say(
            `lay ${describeFile(track)} under the whole edit, ducking under your voice`,
            `أضع ${describeFile(track)} تحت التعديل كلّه، تنخفض تحت صوتك`,
          ),
        );
      }
      // One punch operation, not two. Somebody who asks for punches *and* for
      // the beat is asking for one thing, and the beat is the more specific
      // answer — the same most-specific-wins rule that "slow zoom" taught this
      // file the hard way.
      const punchAt = operations.findIndex((op) => op.type === "zoomPunch");
      if (punchAt >= 0) {
        const existing = operations[punchAt] as Extract<EditOperation, { type: "zoomPunch" }>;
        operations[punchAt] = { ...existing, at: [], on: "beat" };
      } else {
        operations.push({ type: "zoomPunch", at: [], amount: 0.13, holdMs: 1000, on: "beat" });
      }
      willDo.push(
        say(
          "zoom in on the beat of that track instead of on your voice",
          "أقرّب الصورة مع ضربات هديك المقطوعة بدل صوتك",
        ),
      );
    }
  }

  /*
    The sound layer.

    Not conditional on the library, unlike the three blocks above it: the
    sixteen sounds ship inside the worker image and were written by us, so there
    is no file for anybody to be missing. That is the whole reason this is the
    one audio operation a brand-new project can ask for on its first sentence.

    The refusal is checked first and wins outright. "add captions but no sound
    effects" contains the ask *and* the refusal, and a matcher that reads them
    in the other order does the thing the sentence spent its last three words
    saying not to.
  */
  if (SFX_WORDS.test(text) && !NO_SFX_WORDS.test(text)) {
    const palette = SFX_PUNCHY_WORDS.test(text) ? "punchy" : SFX_QUIET_WORDS.test(text) ? "quiet" : "clean";
    operations.push({
      type: "soundEffects",
      gainDb: palette === "punchy" ? -10 : palette === "quiet" ? -15 : -12,
      palette,
      onCuts: true,
      onPunches: true,
      onOpen: true,
    });
    willDo.push(
      palette === "clean"
        ? say(
            "add sound effects where the scenes change and where it zooms in, and a sound that builds up before the first one",
            "أحطّ مؤثّرات صوت عند تغيير المشاهد ومع تقريب الصورة، وصوت بيعلى شوي شوي قبل أول وحدة",
          )
        : palette === "punchy"
          ? say(
              "add strong sound effects where the scenes change and where it zooms in",
              "أحطّ مؤثّرات صوت قوية عند تغيير المشاهد ومع تقريب الصورة",
            )
          : say(
              "add light sound effects where the scenes change, short ones that stay out of the way",
              "أحطّ مؤثّرات صوت خفيفة عند تغيير المشاهد، قصيرة ما بتزاحم الكلام",
            ),
    );
  }

  /*
    A video built from the photographs, rather than an edit of one.

    Placed here because this is where the library is known, like music and
    b-roll above it — and, like them, the honest answer with an empty library
    names the fix rather than the limitation. Somebody who asks for a video of
    their product and is told "I cannot" will leave; told "add the photos and I
    will build it", they add the photos.
  */
  if (REEL_WORDS.test(text) && !NO_REEL_WORDS.test(text)) {
    if (stills.length === 0) {
      cannotYet.push(
        say(
          "build a video from your photos yet, because this project has none. Add the product images and I will cut them into one",
          "أبني فيديو من صورك بعد، لأن هذا المشروع لا صور فيه، أضف صور المنتج وأقصّها في فيديو",
        ),
      );
    } else {
      const chosen = stills.slice(0, 20);
      operations.push({
        type: "stillsReel",
        // Their order. It is a decision somebody already made about which
        // photograph should open, and nothing here knows better than they did.
        assetIds: chosen.map((a) => a.id),
        targetSeconds: 15,
        motion: 0.12,
      });
      willDo.push(
        say(
          `build the video out of ${chosen.length} of your photos`,
          `أبني الفيديو من ${chosen.length} من صورك`,
        ),
      );
    }
  }

  /*
    A section card, built as layers.

    `drawLayers` carries a composition rather than naming a look, so the card
    is data — six layers with numbers measured off r04 — and the same operation
    will later carry whatever a model reading a reference emits. This keyword
    is the first door into it and deliberately a narrow one.

    The name is the person's own words or nothing. There is no place here to
    invent a section title for somebody, and a card carrying copy they never
    wrote is the failure this codebase is most careful about.
  */
  if (SECTION_CARD_WORDS.test(text)) {
    const named = text.match(/["\u201c\u201d\u00ab\u00bb]([^"\u201c\u201d\u00ab\u00bb]{1,60})["\u201c\u201d\u00ab\u00bb]/)?.[1]?.trim();
    if (!named) {
      cannotYet.push(
        say(
          'put a full-screen title in yet, because you did not say what it should say. Put the words in quotes, like "Setup"',
          'أحطّ شاشة فيها عنوان بعد، لأنك ما قلت شو مكتوب عليها. حطّ الكلمات بين علامتين اقتباس، متل "الإعداد"',
        ),
      );
    } else {
      operations.push({
        type: "drawLayers",
        /*
          A square icon is a different fraction of the width than of the
          height, and which shape this renders to is decided later in this same
          function. 9:16 is the shape this product exports by default and the
          one every reference uses, so it is what the card is built for.
        */
        layers: interstitialCard({ name: named, at: 1, durationSeconds: 2, aspect: 9 / 16 }),
      });
    }
  }

  if (OVERLAY_WORDS.test(text)) {
    if (stills.length === 0) {
      cannotYet.push(say("put a picture on top of the video yet, because this project has no pictures", "أحطّ صورة فوق الفيديو بعد، لأن المشروع ما فيه صور"));
    } else {
      const still = stills[0]!;
      operations.push({
        type: "overlayImage",
        assetId: still.id,
        // Fits inside its area rather than filling and cropping it: an image
        // somebody asked to lay over the frame is usually a logo or a
        // screenshot, and cropping the edges off either destroys the point.
        fit: "contain",
        at: 1,
        durationSeconds: 4,
        // A logo lives in a corner. Anywhere else covers the speaker's face,
        // which is the one thing the frame is for.
        position: "top-right",
        scale: 0.25,
        opacity: 1,
      });
      willDo.push(say(`hold ${describeFile(still)} in the corner from 1s`, `أثبّت ${describeFile(still)} في الزاوية من الثانية الأولى`));
    }
  }

  // A title needs words, and the only words we can be certain are theirs are
  // the ones they put in quotes. Anything else would be us writing their copy.
  const quoted = QUOTED.exec(asked);
  if (quoted) {
    const words = quoted[1]!.trim();
    if (words.length > 0) {
      // Kinetic when they asked for it, a card otherwise. The two look
      // genuinely different on the frame — a card is one statement held, a
      // kinetic line arrives a word at a time — so the reply says which.
      /*
        `text`, not `asked`. The quoted title above is read from `asked`
        because those are their words and go on the screen exactly as typed;
        every *match* in this file is made against `text`, which is folded --
        digits normalised, hamza and the short vowels taken off. Testing a
        folded pattern against unfolded input is a match that cannot happen,
        and this was the one line in the file still doing it: «كلمة كلمة» chose
        a held card instead of words arriving one at a time.
      */
      const kinetic = KINETIC_WORDS.test(text);
      operations.push({
        type: "motionTitle",
        text: words.slice(0, 120),
        at: 0.5,
        durationSeconds: 2.5,
        style: kinetic ? "word" : "card",
        position: "center",
      });
      willDo.push(
        kinetic
          ? say(`land the words "${words}" one at a time near the start`, `أُنزل كلمات "${words}" واحدةً واحدة قرب البداية`)
          : say(`bring in the words "${words}" near the start`, `أُدخل عبارة "${words}" قرب البداية`),
      );
    }
    /*
      The same request, in the words people use for it.

      "Add my name at the bottom" and «حط اسمي تحت» are asking for a title and
      were reaching nothing, because this only looked for the word "title".
      Deliberately still not a bare "caption": those are the *spoken* words,
      which the product reads off the recording and does not need to be told.
    */
  } else if (
    /\btitle|\btext on screen\b|\b(?:add|put|show|write)\b[^.!?]{0,20}\b(?:my name|a name|a lower.?third|a label)\b|(?:حط|ضيف|اكتب)\s*(?:اسمي|عنوان|العنوان|لقب)/i.test(text) &&
    !CAPTION_WORDS.test(text) &&
    /*
      And not when the section card above has already said it.

      "Put a title card at the start" reaches both, and both say the same
      thing: we will put any words on screen, in quotes, and cannot invent
      them. Somebody reading their own refusal twice in one reply concludes
      the product is confused rather than careful.
    */
    !cannotYet.some((p) => /what it should say|شو مكتوب عليها/.test(p.en + p.ar))
  ) {
    cannotYet.push(
      say(
        "animate a title yet, because I do not know the words. Put them in quotes and I will",
        "أحرّك عنوان بعد، لأني ما بعرف كلماته، حطّها بين علامتين اقتباس وبعملها",
      ),
    );
  }

  /**
   * Emojis — the last thing on the "cannot yet" list but one.
   *
   * They are read from `asked`, not from the normalised text, for the same
   * reason a quoted title is: what goes back onto the person's video has to be
   * exactly the characters they typed.
   */
  if (EMOJI_WORDS.test(text)) {
    const emojis = emojiIn(asked);
    if (emojis) {
      operations.push({
        type: "motionTitle",
        text: emojis,
        at: 0.5,
        durationSeconds: 2,
        style: "word",
        // Over the top of the frame rather than the middle of it: a sticker
        // sits beside what is happening, and the middle is where the face is.
        position: "top",
      });
      willDo.push(say(`put ${emojis} on the opening`, `أضع ${emojis} على البداية`));
    } else {
      cannotYet.push(
        say(
          "pick emojis for you. Type the ones you want in your message and I will put them on",
          "أختارلك الإيموجي، اكتب اللي بدك ياه برسالتك وبحطّه",
        ),
      );
    }
  }


  for (const { patterns, label } of NOT_YET) {
    if (patterns.test(text)) cannotYet.push(label);
  }

  /*
    Three asks that need one more thing from the person, not a refusal.

    Each was answered with "I did not catch what you want changed", which is
    the reply for a sentence nobody could read. These were read perfectly: they
    are requests for something this product does, missing one fact it cannot
    invent. Saying which fact turns a dead end into a next message.
  */

  /*
    The opening or the ending, with nobody having said how long it is.

    "Cut the intro" is a clear request and an unanswerable one: an intro is
    however long the person decided it was, and nothing here has heard the
    recording. `extractRange` takes seconds, so seconds are what this needs,
    and saying so is more use than a refusal.

    Not fired when the sentence already named a length, because then it is the
    request `parseRange` just answered.
  */
  const wantsEndsTrimmed = ENDS_ASK.test(text) && !parseRange(text) && !operations.some((op) => op.type === "extractRange");
  if (wantsEndsTrimmed) {
    cannotYet.push(
      say(
        "tell where your intro ends by myself. Say how long it runs, like: cut the first 15 seconds, and I will take exactly that",
        "أعرف لحالي وين بتخلص المقدمة. قلّي قدّيش طولها، متلًا: اقطع أول 15 ثانية، وبشيلها بالظبط",
      ),
    );
  }

  /*
    And the two that are simply not built, said plainly rather than swallowed.
  */
  if (FOLLOW_SUBJECT_ASK.test(text)) {
    cannotYet.push(
      say(
        "keep you centred by following your face yet. What I can do is cut between a wide shot and a close one, which is how a second camera would cover it",
        "أضلّ ملاحق وجهك ليضلّ بالنص بعد. اللي بقدر عليه إني أبدّل بين لقطة واسعة ولقطة قريبة، متل ما كانت كاميرا تانية تصوّر",
      ),
    );
  }
  if (PROGRESS_BAR_ASK.test(text)) {
    cannotYet.push(
      say(
        "draw a bar showing how much is left yet",
        "أرسم شريط بيورّي قدّيش ضلّ من الفيديو بعد",
      ),
    );
  }

  /*
   * A moment nobody picked up.
   *
   * Someone stopping on a second and typing "cut this bit" got silence: no
   * operation, and nothing in the reply about the moment either. That is worse
   * than a refusal — a refusal at least tells you the product heard you and
   * cannot help yet, and this told you nothing at all while looking like it had
   * worked.
   *
   * The only thing that consumes a moment today is the zoom punch. Everything
   * else in this product applies to the whole video, so a moment named next to
   * a caption, a cut or a look was heard and could not be honoured, and the
   * person is owed that sentence. When the answer becomes "yes" for one of
   * them, that operation records what it used and this list shortens on its
   * own.
   */
  cannotYet.push(...momentsNotHonoured(asked, operations));

  /*
    Whether the levelling should also take out what sits below a voice.

    Decided here rather than where the operation is pushed, because the branch
    that lays a music bed runs *after* that one — and this is the one question
    the answer depends on. Below 80Hz there is room tone and no speech, so on a
    talking clip the filter is free; under a track it is the bottom octave of a
    kick drum, which is the part somebody chose that track for.

    A sentence that asked for music gets the plain levelling. Everything else
    is somebody talking, which is what this product is for.
  */
  levelAgainstTheBed(operations);

  return { operations, willDo, cannotYet, language: languageOf(asked), spoke, declined };
}

/**
 * The voice curve is for a voice, and a bed is not one.
 *
 * `normalizeLoudness.voice` puts an 80 Hz high pass on the speech leg. With
 * music in the mix that filter used to reach the bed and strip its bottom
 * octave: the kick drum, which is the part somebody chose that track for. The
 * comment in `ffmpeg.ts` records the bug; this is the rule that stops the plan
 * ever asking for it.
 *
 * It ran at the end of the matcher only, and the matcher is one of three
 * places a plan is assembled. The direction sets `voice: hasSpeech` with no
 * knowledge of a bed, and its operations are merged in **after** this ran, so
 * "put my music under it" plus an auto-levelled render walked straight past
 * the guard. It is called once more from `start-render`, which is the one door
 * every render goes through, for the reason `render-policy` gives about rules
 * enforced at each door: a rule applied where somebody remembered is a rule
 * that eventually is not applied.
 *
 * Mutates in place, like the loop it replaced, because the operations are the
 * plan being built rather than a value being derived.
 */
export function levelAgainstTheBed(operations: EditOperation[]): void {
  const hasBed = operations.some((op) => op.type === "addMusic");
  for (const operation of operations) {
    if (operation.type === "normalizeLoudness") operation.voice = !hasBed;
  }
}

/** Seconds as m:ss, because "80s" is a number and "1:20" is a moment. */
export function clockOf(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** A file by its own name where it has one, and by its kind where it does not. */
function describeFile(file: LibraryFile): string {
  const label = (file.label ?? "").trim();
  if (!label) return file.kind === "image" ? "your image" : file.kind === "audio" ? "your track" : "your clip";
  return `"${label.slice(0, 60)}"`;
}

/**
 * The assistant's reply. Written from the parsed plan so it can only claim what
 * the worker will really do — and says plainly when it cannot do something.
 */
/**
 * The three shapes an Arabic noun takes after a number.
 *
 * A second copy of the worker's `countedAr` rather than a shared package, for
 * the reason the worker keeps its own `languageOf`: these are two deployments
 * that ship on different days, and this is a rule, not a library. English
 * needs two forms and switches on `n === 1`; Arabic needs three, and the
 * plural is used for **three to ten** with the singular returning from eleven
 * upward. `3 دقيقة` is the register of a machine translation.
 */
function countedAr(count: number, one: string, two: string, few: string): string {
  const n = Math.abs(Math.round(count));
  if (n === 1) return one;
  if (n === 2) return two;
  const tail = n % 100;
  return tail >= 3 && tail <= 10 ? `${n} ${few}` : `${n} ${one}`;
}

/**
 * Why the render did not start, written rather than translated.
 *
 * The refusal arrives from `render-policy` as an English sentence plus the
 * numbers it was built from. Until now the Arabic reply interpolated that
 * English sentence whole, and the comment beside it argued — honestly — that
 * half a sentence in each language reads better than an invented reason.
 *
 * That was true while the reason was only prose. It stopped being true when
 * the body started carrying `reason`: the sentence is now written here from
 * the same numbers the English one was written from, so nothing is guessed and
 * nothing is translated. A refusal this does not recognise still falls back to
 * the English, which is the honest answer for a sentence we have not written
 * yet, rather than a shrug that hides which refusal it was.
 */
export function becauseIn(lang: Language, body: Record<string, unknown>): string {
  const english = String(body["error"] ?? "the render could not be started.");
  if (lang !== "ar") return english;

  const n = (key: string): number => {
    const value = body[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };

  switch (body["reason"]) {
    case "suspended":
      return "هالحساب موقوف، فما بيبلّش تصيير جديد. ما انحذف إشي؛ مشاريعك وفيديوهاتك كلّها بمكانها.";
    case "alreadyRendering":
      return "في تصيير شغّال هلق على هالمشروع، وبضمّ هاد عليه أول ما يخلص.";
    case "noVideo":
      return "ارفع فيديو قبل التصيير.";
    /*
      Our defect, not theirs, and the Arabic says so the same way the English
      does: nothing started, nothing charged, and one thing to try. It does not
      name the schema, because a person reading this did nothing that a
      different sentence would have avoided.
    */
    case "planNotRunnable":
      return "في إشي بالتعديل طلع غلط من عنّا، فما بلّش إشي وما انصرفت ولا دقيقة. جرّب تطلبه بكلمات تانية، واحكيلنا إذا ضلّ يصير.";
    case "tooManyInFlight":
      return `عندك ${countedAr(n("jobsInFlight"), "تصيير واحد", "تصييران", "عمليات تصيير")} تعمل الآن. تعمل واحدة تلو الأخرى، فابدأ هذه حين تنتهي إحداها.`;
    case "minutesInFlight":
      return `دقايق هالشهر محجوزة بتصيير شغّال هلق: ${n("minutesInFlight")} من ${n("minutesIncluded")}. أول ما يخلص بترجعلك اللي ما انصرف منها.`;
    case "minutesExhausted":
      return `استُهلكت دقائق هذا الشهر: ${n("minutesUsed")} من ${n("minutesIncluded")}. تتجدّد مع بداية الشهر القادم، أو ارفع الباقة الآن.`;
    case "sourceExhausted":
      return (
        `ما رُفع هذا الشهر سبق ما نُشر منه بكثير: نحو ` +
        `${countedAr(Math.round(n("sourceMinutesUsed") / 60), "ساعة", "ساعتين", "ساعات")} من اللقطات قُرئت مقابل ` +
        `${countedAr(n("minutesUsed"), "دقيقة", "دقيقتين", "دقائق")} صُدّرت. انشر أكثر ممّا هو هنا، أو ارفع الباقة. ` +
        `وعلى الحالين يتصفّر هذا مع بداية الشهر القادم.`
      );
    case "uploadTooLong": {
      const suggested = body["suggestedPlan"];
      const room = typeof suggested === "string" ? ` باقة ${suggested} تأخذه.` : "";
      return `هذا الملفّ أطول ممّا تأخذه باقتك: ${countedAr(n("maxUploadMinutes"), "دقيقة", "دقيقتين", "دقائق")} هي الحدّ.${room}`;
    }
    case "wouldExceed":
      return `هذا الملفّ يحتاج نحو ${countedAr(n("projectedMinutes"), "دقيقة", "دقيقتين", "دقائق")} والباقي لك ${countedAr(n("minutesRemaining"), "دقيقة", "دقيقتين", "دقائق")}. قصّره، أو ارفع الباقة.`;
    default:
      return english;
  }
}

/**
 * How long a video has to be before "the whole thing" and "clips of it" stop
 * being the same product.
 *
 * Ten minutes, and the reason is the platforms rather than a feeling. A clip
 * that goes anywhere social is under ten minutes — that is the longest a
 * TikTok can be, and Reels and Shorts are far shorter — so a file under this
 * could plausibly be posted whole. Above it, "post it whole" means YouTube, a
 * podcast feed, a course page: a different deliverable from the same footage,
 * and there is no way to look at the file and know which one somebody wants.
 *
 * This product has been answering that question by itself, in the framing
 * rather than in the code: four of six first-run suggestions shorten the
 * video, and the two most-read sentences in the whole product both open with
 * "I can pull out the strongest 30 seconds". Nothing refuses a long edit;
 * nothing offers one either.
 */
export const LONG_SOURCE_SECONDS = 600;

/**
 * "Keep the whole thing" — the ask this product had no words for.
 *
 * Every other shape has a vocabulary here: clips, a highlight, a range. The
 * one intention with no phrase was the plainest one, so somebody who typed
 * «خليه كامل» or "keep the full length" was understood as having said nothing
 * about the shape at all.
 *
 * No `\b` in front of the Arabic, which cannot match there: a boundary sits
 * between a word character and a non-word one, and every Arabic letter is a
 * non-word character to a JavaScript regular expression. The trap is
 * documented five other times in this file.
 */
export const KEEP_WHOLE_WORDS =
  /\bkeep (it|the) (whole|full|entire)|\bthe whole (thing|video|episode)\b|\bfull[- ]length\b|\bdon'?t (cut it (down|up)|shorten|split)\b|\bone (long )?video\b|\bas (it is|is)\b|كامل|كاملا|كاملا|بالطول|نفس الطول|خلي الطول|ما تقصره|لا تقصره|ما تقسمه|لا تقسمه|فيديو واحد/i;

/**
 * The two answers, in the words somebody actually types back.
 *
 * A bare «مقاطع» or "clips" is what a person replies to a question that
 * offered those two words, and neither of them parses as a request on its own:
 * `parseClips` needs a count or a "cut it into", by design, because "add
 * transitions between the clips" is not an ask to split anything. So the reply
 * to a question has to be read as a reply rather than as a fresh sentence, and
 * that is what this is for — see `answeringShape` in `routes/messages.ts`.
 *
 * Deliberately narrow. This is only ever consulted when the previous thing in
 * the conversation was the question, so it does not have to survive being
 * pointed at arbitrary text.
 */
export function shapeAnswer(raw: string): "whole" | "clips" | null {
  const text = withAsciiDigits(raw);
  if (/\bclips?\b|\bshorts?\b|\bpieces\b|\bcut it up\b|مقاطع|قصاصات|كليبات|قطعه/i.test(text)) return "clips";
  if (KEEP_WHOLE_WORDS.test(text) || /\bwhole\b|\bfull\b|\bone video\b|كامل|طويل|بالطول/i.test(text)) return "whole";
  return null;
}

/**
 * The answer, written the way this file's own parser reads it.
 *
 * The person's reply is kept as their message; this is what gets planned,
 * appended to the request they made before the question. Putting a sentence
 * the matcher already understands through the matcher is the alternative to
 * teaching every parser about conversational context, and it is the smaller
 * of the two changes by a wide margin.
 */
export function shapeAnswerAsRequest(answer: "whole" | "clips", language: Language): string {
  if (answer === "clips") return language === "ar" ? "قسّمه إلى 3 مقاطع" : "cut it into 3 clips";
  return language === "ar" ? "خليه كامل بنفس الطول" : "keep the whole thing, full-length";
}

/** Operations that decide, by themselves, what shape the deliverable is. */
const SHAPE_DECIDING = new Set(["extractClips", "extractHighlight", "extractRange", "stillsReel"]);

/**
 * One video or several short ones — and whether the sentence said.
 *
 * The third answer is the one that matters. A plan of captions, levelling and
 * a grade is a perfectly good edit that says nothing at all about the shape of
 * what comes back, and on a forty-minute recording that is not a detail: the
 * person is either cleaning up an episode or harvesting posts out of it, and
 * those are different products.
 *
 * Read from the operations rather than from the words, because the operations
 * are what will actually run — a sentence the model read and a sentence the
 * keyword matcher read have to answer this the same way.
 */
export function deliverableShape(
  operations: readonly { type: string }[],
  text: string,
): "settled" | "unsaid" {
  if (operations.some((op) => SHAPE_DECIDING.has(op.type))) return "settled";
  if (KEEP_WHOLE_WORDS.test(withAsciiDigits(text))) return "settled";
  return "unsaid";
}

/**
 * The question, and the only one this product asks.
 *
 * Asked once per project and never again — see `messages.ts`. A product that
 * asks twice about the same thing is worse than one that guesses, because at
 * least the guess moves.
 *
 * It offers the two answers in the words they can type straight back, which is
 * the whole difference between a question and an interrogation.
 */
export const WHOLE_OR_CLIPS: Record<Language, string> = {
  en:
    "Before I start: this one is long. Do you want it back as one video, cleaned up and the same length, " +
    'or cut into short clips to post? Say "the whole thing" or "clips" and I will go.',
  ar:
    "قبل ما أبلّش: هاد فيديو طويل. بدك ياه فيديو واحد منظّف بنفس الطول، ولا مقاطع قصيرة تنشرها؟ " +
    "قلّي «كامل» أو «مقاطع» وبمشي.",
};

/**
 * The last sentence of the question, which is also how we know it was asked.
 *
 * The question carries the recording's real length, so no two projects get the
 * same string and "have we asked this before?" cannot be an equality test any
 * more. This clause is the part that never varies: it names the two words a
 * person can type back, it is the same in every project, and nobody types it
 * at us. `messages.ts` matches on it.
 *
 * Kept beside the sentence it ends, and asserted to be a suffix of it, because
 * a marker that drifts out of the text it marks turns the question into one
 * this product asks forever.
 */
export const SHAPE_ASKED: Record<Language, string> = {
  en: 'Say "the whole thing" or "clips" and I will go.',
  ar: "قلّي «كامل» أو «مقاطع» وبمشي.",
};

/**
 * How long the recording is, in the words somebody would use for it.
 *
 * Minutes, rounded, because a question that opens "this one runs 42 minutes"
 * is answerable and one that opens "this one is long" is an opinion. Under
 * ninety minutes it stays in minutes; past that hours are how anybody would
 * say it, and the remainder is dropped rather than read out as "1 hour and 37
 * minutes", which nobody needs in order to answer this question.
 */
function lengthInWords(seconds: number, lang: Language): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 90) {
    return lang === "ar"
      ? countedAr(minutes, "دقيقة", "دقيقتين", "دقائق")
      : `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const hours = Math.round(minutes / 60);
  return lang === "ar"
    ? countedAr(hours, "ساعة", "ساعتين", "ساعات")
    : `${hours} hour${hours === 1 ? "" : "s"}`;
}

/**
 * The question, with this recording's own numbers in it.
 *
 * Osama read the first version and said the options were not understandable.
 * The sentence was not vague about the *operations* -- it was vague about what
 * he would be holding afterwards, which is the only thing the answer turns on.
 * So each option now says what lands in his hands: one file of about this
 * length, or several short files ready to post.
 *
 * No clip count. The number of clips depends on what is said in the recording
 * and we do not know it yet; a figure invented to sound concrete is the kind
 * of sentence this product does not write.
 */
export function wholeOrClips(lang: Language, sourceSeconds: number | null): string {
  if (sourceSeconds === null || !Number.isFinite(sourceSeconds)) return WHOLE_OR_CLIPS[lang];
  const length = lengthInWords(sourceSeconds, lang);
  return lang === "ar"
    ? `قبل ما أبلّش: هاد التسجيل ${length}. بدك ترجعلك ملف واحد منظّف، بنفس الطول تقريبًا، ` +
      `ولا كم ملف قصير كل واحد أقل من دقيقة وجاهز تنشره؟ ${SHAPE_ASKED.ar}`
    : `Before I start: this recording runs ${length}. Do you want one file back, tidied up and about that ` +
      `long, or several short files, each under a minute and ready to post? ${SHAPE_ASKED.en}`;
}

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
    /**
     * The one question this product asks instead of answering.
     *
     * Set by `messages.ts` when the recording is long and nothing in the
     * sentence says whether the result should be one video or several. It
     * short-circuits everything below: no render was started, so a reply that
     * listed what it was about to do would be describing work that is not
     * happening.
     */
    ask?: "wholeOrClips";
    /**
     * Whether the sentence was read by the keyword matcher rather than by the
     * model, because the model was unreachable, slow, or answered with
     * something we could not run.
     *
     * Set by `messages.ts` from `intent.degraded`, which until now went to a
     * log and nowhere else.
     */
    simpleReading?: boolean;
    /**
     * How long the recording is, for the question to say so.
     *
     * Only read when `ask` is set. Null when the project has no measured
     * duration yet, and the question falls back to the sentence that says
     * "this one is long" instead of naming a number it does not have.
     */
    sourceSeconds?: number | null;
  },
): string {
  const lang = intent.language;

  if (!context.hasVideo) return EMPTY_PROJECT[lang];

  /*
    Asked, and nothing else said.

    Deliberately not "here is what I would do, and also which shape?" — the
    whole point of asking is that the answer changes the plan, so reciting the
    plan first is asking somebody to read a paragraph that may be about to be
    thrown away. One question, the two answers in it, nothing else.
  */
  if (context.ask === "wholeOrClips") return wholeOrClips(lang, context.sourceSeconds ?? null);

  const parts: string[] = [];
  const listed = (phrases: Phrase[]): string =>
    joinNaturally(phrases.map((p) => p[lang]), lang);

  if (intent.willDo.length > 0) {
    /*
      Two or more things, one per line.

      Asked what he wants to see before a render starts, Osama answered: first
      it tells you what it is about to do, so you can check it understood you.
      That is a *checking* sentence, and a run-on joined by «و» is the wrong
      shape for one: "cut the silences, and caption it, and make it vertical
      for tiktok, and level the audio" is read once, roughly, and nobody spots
      the clause that is wrong.

      A list is read down. Each line is one decision, and a wrong one is
      visible without re-reading the sentence. One item stays inline, because a
      bullet list of one is a list about nothing.
    */
    const items = intent.willDo.map((p) => p[lang]);
    const doing = listed(intent.willDo);
    const asList = items.length > 1;
    const opening = asList
      ? `${lang === "ar" ? "تمام، فهمت. رح:" : "Got it. Here is what I will do:"}\n${items
          .map((line) => `• ${line}`)
          .join("\n")}`
      : lang === "ar"
        ? `تمام، رح ${doing}.`
        : `Right. I'll ${doing}.`;
    // A blank line before the closing sentence, so the list reads as a list
    // and the thing that happens next is not mistaken for another item.
    const after = asList ? "\n\n" : " ";

    if (context.render?.started) {
      parts.push(
        opening +
          after +
          (lang === "ar"
            ? "التصيير شغّال هلق، وبيبيّن هون أول ما يخلص."
            : "It's rendering now; you'll see it here the moment it's done."),
      );
    } else if (context.render && !context.render.started) {
      // `because` arrives already in `lang` — see `becauseIn`, which writes the
      // Arabic from the refusal's own numbers rather than translating its
      // English. It used to be English interpolated into the Arabic frame.
      const wanted = asList
        ? `${lang === "ar" ? "كنت رح أعمل:" : "Here is what I was going to do:"}\n${items
            .map((line) => `• ${line}`)
            .join("\n")}`
        : lang === "ar"
          ? `كنت رح ${doing}.`
          : `I'd ${doing}.`;
      parts.push(
        wanted +
          after +
          (lang === "ar"
            ? `بس ما بقدر أبلّش هلق: ${context.render.because}`
            : `But I can't start it right now: ${context.render.because}`),
      );
    } else {
      parts.push(
        opening +
          after +
          (lang === "ar" ? "دوس Generate Edit وبمشي." : "Hit Generate Edit and I'll start."),
      );
    }
  }

  if (intent.cannotYet.length > 0) {
    // Each entry carries its own "yet", at the point in the phrase where it
    // belongs. It used to be appended here instead, which read fine for the
    // short labels it was written against and broke on every long one:
    // "I can't cut in B-roll, because this project has no clips to cut to yet
    // yet, so I'll leave that out". The product's most careful sentence — the
    // one where it admits a limit — was the one that came out mangled.
    const missing = listed(intent.cannotYet);
    const plural = intent.cannotYet.length > 1;
    parts.push(
      lang === "ar"
        ? `ما بقدر ${missing}، فبتركها برّا التعديل بدل ما أدّعي إني عملتها.`
        : `I can't ${missing}, so I'll leave ${plural ? "those" : "that"} out rather than pretend.`,
    );
  }

  /*
    A sentence that is nothing but a no is answered with the no.

    "No captions please" and «بلا ترجمة» produce no operation, which is right,
    and therefore produced no phrase, and therefore got the reply that says we
    did not catch it. Two of the clearest sentences anybody types were answered
    as gibberish, and the refusal was being honoured the whole time -- so this
    is a reply that was wrong about a product that was right, which is the kind
    that loses somebody's trust in both.

    Placed above the fallback rather than inside it, so a sentence that also
    asked for something keeps its list and this never appends to one: "captions
    but no music" is a plan, and a plan says what it will do.
  */
  if (parts.length === 0 && intent.declined.length > 0) {
    /*
      The "no" goes on each one, not once at the front. "No captions and music"
      says the opposite of the sentence it is answering about half of it, which
      on a reply whose whole job is to repeat a refusal back is the one mistake
      it cannot make.
    */
    const named = joinNaturally(
      intent.declined.map((subject) =>
        lang === "ar" ? `بلا ${DECLINED_SUBJECTS[subject].ar}` : `no ${DECLINED_SUBJECTS[subject].en}`,
      ),
      lang,
    );
    return lang === "ar"
      ? `تمام، ${named}. قلّي شو بدك أعمل وببلّش.`
      : `Right, ${named}. Tell me what you do want and I will start.`;
  }

  if (parts.length === 0) return NOTHING_UNDERSTOOD[lang];

  /*
    Said last, and only when there is a plan to doubt.

    When the model is unreachable, slow, or answers with something we cannot
    execute, the sentence is read by the keyword matcher instead. That is a
    worse reading and a working one, and until now it was recorded in a log
    nobody outside this building reads: the person got a shorter plan than
    their sentence deserved and no reason to suspect it.

    What is said is what they can act on -- the reading was the simple one,
    check the list, shorter words will land better -- and not which provider
    failed, which is telemetry wearing a sentence's clothes (`enrich.ts`
    learnt that one the expensive way, by leaking "gemini upload start 429"
    into somebody's chat).

    Not said when nothing was understood: `NOTHING_UNDERSTOOD` already asks for
    the sentence again, and following it with "and by the way I read it the
    simple way" is an excuse where a question belongs.
  */
  if (context.simpleReading) {
    parts.push(
      lang === "ar"
        ? "وبس تعرف: قريت جملتك بالطريقة البسيطة، كلمة كلمة. شوف القائمة إذا فيها اللي قصدته، وإذا في إشي ناقص قلهولي بكلمات أقصر وبمسكه."
        : "One thing: I read that the simple way, word by word. Check the list says what you meant, and if something is missing, tell me in shorter words and I will get it.",
    );
  }

  return parts.join(" ");
}

/**
 * The two long sentences, which are the product describing itself.
 *
 * They are the most-read text here — one greets every empty project and the
 * other answers every sentence we could not parse — and until now an Arabic
 * speaker got both in English. Keeping them as data rather than inline
 * template literals is what makes it obvious when one language grows a
 * capability the other has not been told about.
 */
const EMPTY_PROJECT: Record<Language, string> = {
  en:
    "Upload a video first and I'll get to work. I can pull out the strongest 30 seconds, keep exactly a stretch you name (from 1:20 to 2:10), cut it into separate clips, cut the silences, caption it from what you actually say, reframe it for TikTok, Reels or Shorts (or 16:9 for YouTube, or square for a feed), add motion, lay your own music under it, grade it warm or cool or cinematic or black and white, fade it in and out, and level the audio.",
  ar:
    "ارفع فيديو وببلّش. بقدر أنظّفه وأخلّيه بنفس الطول، أو أطلّعلك أقوى 30 ثانية، أو أبقّي مدى بتسمّيه بالضبط (من 1:20 إلى 2:10)، أو أقسّمه مقاطع منفصلة. وبقصّ السكتات، وبكتب الترجمة من كلامك نفسه، وبعيد التأطير لتيك توك أو ريلز أو شورتس، أو 16:9 ليوتيوب، أو مربّع للفيد، وبضيف حركة، وبحطّ موسيقاك تحته، وبدرّجه warm أو cool أو cinematic أو أبيض وأسود، وبفتحه من السواد وبغلقه عليه، وبظبّط مستوى الصوت.",
};

/**
 * And the one that answers a sentence we could not read.
 *
 * It used to recite the catalogue: sixty words naming every operation the
 * product has, ending in one example. That is the single moment in this
 * product where somebody most feels they are talking to a machine — they said
 * something in their own words, and a menu came back.
 *
 * Two examples instead of a list, and they are deliberately the two *shapes*
 * rather than two features: one that keeps the recording whole and one that
 * cuts a post out of it. Somebody who reads them learns the thing the
 * catalogue never taught, which is that both are possible. The full list still
 * exists, one message earlier, on an empty project where a list is the right
 * answer because they have nothing yet.
 *
 * Not "I am not sure": it did not understand, and saying so plainly is shorter
 * and less apologetic than hedging about it.
 */
/**
 * The subjects a person can say no to, in the words the no is said in.
 *
 * Nouns rather than phrases, because they are read after "no" / «بلا» and a
 * list of them has to join: "no captions or music" has to work as well as "no
 * captions". Deliberately the customer's word for each -- the framing one is
 * "cutting between shots", not `alternateFraming`, and nobody outside this
 * building has ever said "sfx".
 */
const DECLINED_SUBJECTS: Record<keyof SpokenSubjects, Record<Language, string>> = {
  captions: { en: "captions", ar: "ترجمة" },
  silence: { en: "cutting the silences", ar: "قصّ للسكتات" },
  music: { en: "music", ar: "موسيقى" },
  coverage: { en: "cutting between shots", ar: "تبديل بين اللقطات" },
  sfx: { en: "sound effects", ar: "مؤثّرات صوت" },
  platform: { en: "reframing", ar: "إعادة تأطير" },
};

const NOTHING_UNDERSTOOD: Record<Language, string> = {
  en:
    "I did not catch what you want changed. Tell me in your own words and I will say if I can, " +
    'or try something like "clean it up and caption it, keep the full length", ' +
    'or "give me the strongest 30 seconds, captioned, vertical for TikTok".',
  ar:
    "ما التقطت شو بدك أغيّر. قلّي بكلماتك وبقلّك إذا بقدر، " +
    "أو جرّب إشي متل «نظّفه وضيف ترجمة وخلّيه بنفس الطول»، " +
    "أو «أعطني أقوى 30 ثانية مع ترجمة، عمودية لتيك توك».",
};

/**
 * A list, joined the way the language joins lists.
 *
 * Arabic does not use the Oxford comma and does not put "and" only before the
 * last item — every item after the first takes a و, and the separator is the
 * Arabic comma ، not the Latin one. Joining an Arabic list with English
 * punctuation is the tell that a page was translated rather than written.
 */
function joinNaturally(items: string[], lang: Language = "en"): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (lang === "ar") return items.join("، و");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}
