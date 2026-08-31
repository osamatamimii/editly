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
import type { EditOperation, GradeLook, Platform, TransitionStyle } from "@workspace/api-zod";

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
  { platform: "youtube", patterns: /\byoutube\b|\byt\b|\blandscape\b|\bwidescreen\b|16:9|أفقي|عريض/i },
  { platform: "reels", patterns: /\binstagram|insta\b/i },
];

/** What the frame will actually be, said the way a person would say it. */
function shapeLabel(platform: Platform): string {
  if (platform === "youtube") return "16:9";
  if (platform === "square") return "1:1";
  return "9:16";
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
  { look: "mono", patterns: /\bblack ?(and|&) ?white\b|\bb\s?&\s?w\b|\bmonochrome|\bgrayscale|\bgreyscale|أبيض وأسود|ابيض واسود|بالأبيض والأسود/i },
  { look: "cinematic", patterns: /\bcinematic|\bfilm ?look|\bmovie ?look|\bteal ?(and|&) ?orange|سينمائ/i },
  { look: "warm", patterns: /\bwarm(er)?\b|\bgolden\b|\bsunny\b|دافئ|دافي|حار/i },
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
      /\bpunch(y|ier)\b|\bpunch\b(?!\s*(in|into|it|here|at|on|up)\b)|\bmake it pop\b|\bmore contrast\b|\bvivid\b|\bvibrant\b|أوضح|أقوى ألوان|ألوان أقوى/i,
  },
];

/**
 * Asking for a music bed.
 *
 * Bare "beat" is deliberately *not* here. "cut it to the beat" is a request to
 * sync the picture to a rhythm, which we do not do — matching it would lay a
 * bed nobody asked for and then, in the same reply, admit we cannot do the
 * thing they actually asked for. Only "a beat under it" reads as a bed, so
 * only that shape matches. The Arabic covers موسيقى / أغنية / خلفية موسيقية.
 */
const MUSIC_WORDS =
  /\bmusic|music ?bed|sound ?track|\bsong\b|\bbeat under\b|\btrack under\b|موسيق|أغنية|اغنية|خلفية موسيقية|صوت خلفي/i;

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
const EMOJI_WORDS = /\bemoji|\bemojis\b|إيموجي|ايموجي|رموز تعبيرية|ستيكر|sticker/i;

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

const BEAT_SYNC_WORDS = /\b(cut|sync|edit|time)\w* (it |them |the (cuts?|clips?) )?to (the )?(beat|music|rhythm|drop)\b|على الإيقاع|مع الإيقاع/i;

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
      "grade the colour to a look I do not have yet. Name warm, cool, cinematic, black and white or punchy, or upload a video whose colour you want matched",
      "أدرّج اللون إلى لوك لا أملكه بعد، سمّ warm أو cool أو cinematic أو الأبيض والأسود أو punch، أو ارفع فيديو تريد مطابقة لونه",
    ),
  },
  {
    /*
      Asking for it to be posted.

      The scheduling is built — accounts, captions per platform, a time, a
      publisher that will not send the same post twice — and not one platform
      has approved this app to post on somebody's behalf yet. So a sentence
      that asks for it got silence: no operation, and nothing in the reply.

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
      /\b(post|publish|upload|share)\b[^.!?]{0,30}\b(instagram|insta|reels?|tiktok|facebook|snapchat|twitter|on x)\b|\bschedule (it|this|them|the (post|clip|video))\b|\b(post|publish) (it|this|them) (for me|later|at|on|tomorrow|tonight)\b|(?:انشر|جدول)/i,
    label: say(
      "post it to your accounts yet. The scheduling is built — pick the accounts, write the caption once, choose the time — and every platform has to approve this app before it will let one post for you. None has yet, so nothing can go out on your behalf",
      "أنشرها على حساباتك بعد. الجدولة مبنيّة — تختار الحسابات وتكتب الكابشن مرّة وتحدّد الوقت — لكن كل منصّة يجب أن تعتمد هذا التطبيق قبل أن تسمح له بالنشر نيابةً عنك، ولم تعتمده أيٌّ منها بعد",
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
  kind: "video" | "image" | "audio";
  label: string | null;
}

const BROLL_WORDS =
  /\bb-?roll|cut ?away|cutaway|footage|insert (a |the )?(clip|shot)\b|بي ?رول|لقطات مساندة|لقطة مساندة|مقاطع مساندة|لقطات إضافية/i;
const OVERLAY_WORDS =
  /\blogo|overlay|screenshot|graphic|show (the |my )?(image|picture|photo)\b|الشعار|شعاري|لوجو|صورة فوق|لقطة شاشة|سكرين ?شوت/i;

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
const KINETIC_WORDS =
  /\bkinetic\b|\bword[- ]by[- ]word\b|\bone (word )?at a time\b|\bwords? (pop|land|drop)\w* in\b|كلمة كلمة|كلمة بكلمة|كلمة تلو/i;

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
  /\bsilence|silent|quiet|pause|dead air|um+s?\b|\bfiller|tighten|trim|short|fast|snapp|pace|boring|drag|صمت|سكتات|سكوت|وقفات|فراغات|اختصر|قصّر|قصر الفيديو|سرّع/i;

const VERTICAL_WORDS = /\bvertical|9:16|portrait|full ?screen\b|عمودي|عامودي|طولي/i;

/**
 * Captions, in both languages this product is asked in.
 *
 * The Arabic here is the whole reason this round exists: captions are the most
 * asked-for edit there is, and until now `add captions` worked and «ضيف ترجمة»
 * produced *nothing* — the reply fell through to "I'm not sure what to change
 * from that". The product could do the thing and could not be asked for it.
 */
const CAPTION_WORDS =
  /\bcaption|subtitle|sub ?titles?|text on screen|on-?screen text\b|ترجمة|ترجمه|سبتايتل|كتابة على الشاشة|نص على الشاشة|مكتوب على الشاشة/i;

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
const TRANSLATE_WORDS = /\btranslat(?:e|ed|ing|ion)\b|\bdubb?(?:ed|ing)?\b|ترجم(?![ةه])|مترجم|دبلجة/i;

const KARAOKE_WORDS =
  /\bkaraoke|word by word|word-by-word|highlight|كلمة كلمة|كلمة بكلمة|كلمة ورا كلمة|كاريوكي|تظليل/i;
const YELLOW_WORDS = /\byellow|gold\b|أصفر|اصفر|ذهبي/i;

/**
 * Asking for the strongest stretch, in the ways people actually ask.
 *
 * "highlight" alone is deliberately not enough — KARAOKE_WORDS above already
 * reads it as a caption style ("highlight each word"), so the highlight *cut*
 * needs the shape of a request for a piece of the clip: "the best part",
 * "strongest 30 seconds", "a highlight reel", "just the good bit".
 */
const HIGHLIGHT_WORDS =
  /\b(best|strongest|good|top|most interesting) ?\d* ?(part|parts|bit|bits|moment|moments|section|seconds?|secs?|s\b)|highlight reel|the highlight\b|أفضل جزء|أقوى جزء|أهم جزء|أحسن جزء|أفضل لقطة|أقوى لقطة|أفضل لحظة|أقوى لحظة|أهم لحظة|مقتطف|الزبدة|زبدة الفيديو/i;
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
  return text.replace(/[\u0660-\u0669\u06f0-\u06f9]/g, (d) => {
    const code = d.codePointAt(0)!;
    return String(code - (code >= 0x06f0 ? 0x06f0 : 0x0660));
  });
}

const RANGE_MMSS = new RegExp(String.raw`(\d{1,3}):([0-5]\d)\s*${TO}\s*(\d{1,3}):([0-5]\d)`, "i");
const RANGE_MINUTES = new RegExp(
  String.raw`(?:minute|\u0627\u0644\u062f\u0642\u064a\u0642\u0629|\u062f\u0642\u064a\u0642\u0629)\s*(\d{1,3})\s*${TO}\s*(?:minute|\u0627\u0644\u062f\u0642\u064a\u0642\u0629|\u062f\u0642\u064a\u0642\u0629)?\s*(\d{1,3})`,
  "i",
);
const RANGE_SECONDS = new RegExp(
  String.raw`(?:from|\u0645\u0646)\s*(?:second|\u0627\u0644\u062b\u0627\u0646\u064a\u0629)?\s*(\d{1,4})\s*(?:seconds?|secs?|s\b)?\s*${TO}\s*(\d{1,4})\s*(?:seconds?|secs?|s\b|\u062b\u0627\u0646\u064a\u0629|\u062b\u0648\u0627\u0646\u064a)`,
  "i",
);
// The \b sits inside the alternation, not in front of it. Outside, it is a
// boundary test against an Arabic letter, which is never a word character, so
// it never matches — «أول ٤٠ ثانية» found nothing while "the first 40 seconds"
// worked. That is the third time this exact mistake has been made in this file.
const RANGE_FIRST = /(?:\bfirst|\bopening|أول|اول)\s*(\d{1,4})\s*(?:seconds?|secs?|s\b|ثانية|ثواني)/i;
const RANGE_FIRST_MINUTES = /(?:\bfirst|\bopening|أول|اول)\s*(\d{1,3})?\s*(?:minutes?|دقيقة|دقائق)/i;

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
      `أفعل شيئًا عند ${when.join("، ")} وحدها بعد، فكلّ شيء عدا التقريب يسري على الفيديو كلّه، قل لي ماذا أفعل هناك وسأخبرك إن كنت أستطيع`,
    ),
  ];
}

export function parseMoments(asked: string): number[] {
  const text = withAsciiDigits(asked);
  const found = new Set<number>();
  // `at 1:05` / `عند 1:05`, and the bare-seconds form with its unit spelled,
  // which is what distinguishes it from any other number in the sentence.
  const AT = String.raw`(?:\bat|\bon|عند|في)`;
  const SECOND_NOUN = String.raw`(?:the\s+)?(?:second|الثانية|ثانية)`;
  const MOMENT = new RegExp(
    // "at 1:05", «عند 1:05» — a clock, which is unambiguous.
    String.raw`${AT}\s*(?:${SECOND_NOUN}\s*)?(\d{1,3}):([0-5]\d)` +
      // ...or a count of seconds with its unit said, in either order, which is
      // what tells it apart from every other number in the sentence:
      // "at second 45", "at 45 seconds", «عند الثانية 45».
      String.raw`|${AT}\s*${SECOND_NOUN}\s*(\d{1,4})\b` +
      String.raw`|${AT}\s*(\d{1,4})\s*(?:seconds?|secs?|s\b|ثانية|ثواني)`,
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
 * `قرّب` is here and bare `قرب` is not, and the difference is the shadda.
 *
 * The list had the noun (تقريب) and the loanword (زوم) but not the imperative,
 * which is the word somebody actually types: «قرّب الصورة» is how you ask for
 * this in Arabic and it matched nothing. Bare `قرب` stays out because it is
 * also the preposition in «بالقرب من», and a matcher that punches in whenever
 * somebody says "near" is worse than one that misses a spelling.
 */
const PUNCH_WORDS =
  /\bzoom|punch|emphasi[sz]|energetic|energy|dynamic|hype\b|زوم|تقريب|قرّب|قرِّب|حماس|طاقة|حيوية/i;
const PUSH_WORDS =
  /\bslow (push|zoom)|ken burns|drift|subtle move|cinematic move\b|زوم بطيء|تقريب بطيء|حركة بطيئة|حركة سينمائية|كين بيرنز/i;
/**
 * "level the audio" was not in here, and that is the phrase this file's own
 * reply uses: "I'll level the audio to what these platforms expect". The
 * product said the words and could not hear them. Only "audio level" matched,
 * which is the same two words in the order nobody says them in.
 */
const LOUDNESS_WORDS =
  /\bloud|volume|quiet|audio level|sound level|normali[sz]|\blevel(l?ing)? (the |my )?(audio|sound|volume)\b|مستوى الصوت|اضبط الصوت|وحّد الصوت|عدّل الصوت|عدل الصوت|ظبط الصوت|ارفع الصوت|الصوت واطي|الصوت منخفض|الصوت عالي/i;
// "fade" alone is enough — every reading of it in an edit request means the
// ends ("fade it in", "fade to black", "soft ending"). Arabic: تلاشي/تلاشى.
// A hook is the one edit everyone names the same way. "Cold open" is the film
// term; "start with the best bit" is what people actually type.
const HOOK_WORDS =
  /\bhook\b|\bcold open\b|start (?:it )?with the (?:best|strongest)|open (?:it )?(?:on|with) the (?:best|strongest)|\bهوك\b|ابدأ بالأقوى|ابدأ بأقوى|ابدأ بأفضل|ابدأ بأهم|افتح بأقوى/i;

/**
 * The shaped joins, and the words people use for them.
 *
 * Ordered longest-intent-first so "wipe left" is not eaten by the bare "wipe".
 * The direction words are checked next to the style word rather than anywhere
 * in the sentence, because "slide it left" and "cut the left third and slide
 * between the shots" are different requests and only one of them is about the
 * transition.
 */
/** The nine shaped styles as the reply says them. */
const STYLE_IN_WORDS: Record<Exclude<TransitionStyle, "dissolve">, string> = {
  wipeLeft: "wipe to the left",
  wipeRight: "wipe to the right",
  wipeUp: "wipe upward",
  wipeDown: "wipe downward",
  slideLeft: "slide to the left",
  slideRight: "slide to the right",
  slideUp: "slide upward",
  slideDown: "slide downward",
  flash: "flash of white",
};

/** The same nine, as the reply says them in Arabic. */
const STYLE_IN_WORDS_AR: Record<Exclude<TransitionStyle, "dissolve">, string> = {
  wipeLeft: "مسحة إلى اليسار",
  wipeRight: "مسحة إلى اليمين",
  wipeUp: "مسحة إلى الأعلى",
  wipeDown: "مسحة إلى الأسفل",
  slideLeft: "انزلاقة إلى اليسار",
  slideRight: "انزلاقة إلى اليمين",
  slideUp: "انزلاقة إلى الأعلى",
  slideDown: "انزلاقة إلى الأسفل",
  flash: "ومضة بيضاء",
};

const TRANSITION_STYLES: Array<{ patterns: RegExp; style: TransitionStyle }> = [
  { patterns: /\bwipe\s*(?:to\s*the\s*)?right|مسح(?:ة)?\s*لليمين/i, style: "wipeRight" },
  { patterns: /\bwipe\s*(?:to\s*the\s*)?up|\bwipe\s*upward/i, style: "wipeUp" },
  { patterns: /\bwipe\s*(?:to\s*the\s*)?down|\bwipe\s*downward/i, style: "wipeDown" },
  { patterns: /\bwipe|مسح(?:ة)?/i, style: "wipeLeft" },
  { patterns: /\bslide\s*(?:to\s*the\s*)?right|\bpush\s*right|انزلاق\s*لليمين/i, style: "slideRight" },
  { patterns: /\bslide\s*(?:to\s*the\s*)?up|\bpush\s*up/i, style: "slideUp" },
  { patterns: /\bslide\s*(?:to\s*the\s*)?down|\bpush\s*down/i, style: "slideDown" },
  { patterns: /\bslide|\bpush\b|\bswipe|whip ?pan|انزلاق/i, style: "slideLeft" },
  { patterns: /\bflash\b|white flash|ومضة|فلاش/i, style: "flash" },
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

/** Which shaped join a sentence asks for, if any. */
function transitionStyleFrom(text: string): TransitionStyle | null {
  if (!JOIN_CONTEXT.test(text)) return null;
  return TRANSITION_STYLES.find((entry) => entry.patterns.test(text))?.style ?? null;
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
  /\bcross ?-?fade|\bdissolve|\bblend (?:between|the cuts)|smooth(?:er)? (?:the )?(?:cuts|joins|transitions?)|(?:cuts|joins|transitions?) smooth(?:er)?|less jump(?:y|ing)|between (?:the )?(?:cuts|clips)|تلاش(?:ي|ٍ) بين|مزج|انتقال ناعم|بين القصات|بين القطعات|ذوّب|ذوب بين|تذويب|بين المقاطع/i;

const FADE_WORDS = /\bfade|fade[- ]?(?:in|out)|to black|soft (?:opening|ending|start|end)|تلاشي|تلاشى/i;

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

  const wantsSilenceCut = SILENCE_WORDS.test(text);
  const platform = PLATFORM_WORDS.find((p) => p.patterns.test(text))?.platform ?? null;
  const wantsVertical = platform !== null || VERTICAL_WORDS.test(text);

  if (wantsSilenceCut) {
    operations.push({ type: "removeSilence", thresholdDb: -32, minSilenceMs: 500, paddingMs: 80 });
    willDo.push(say("cut out the silences and dead air", "أقصّ الصمت والفراغات"));
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

  // The person asks for a length; where those seconds live is the worker's
  // judgement, made from the transcript. The plan carries only the length.
  if (!clipsAsk && HIGHLIGHT_WORDS.test(text)) {
    const asked = HIGHLIGHT_SECONDS.exec(text);
    const targetSeconds = Math.min(120, Math.max(5, asked ? Number(asked[1]) : 30));
    operations.push({ type: "extractHighlight", targetSeconds });
    willDo.push(say(`pull the strongest ${targetSeconds} seconds into its own cut`, `أستخرج أقوى ${targetSeconds} ثانية في مقطع مستقلّ`));
  }

  // The stretch they named, kept exactly. The mirror of the highlight: there
  // the worker chooses the moments, here the person already has.
  const range = clipsAsk ? null : parseRange(text);
  if (range) {
    operations.push({ type: "extractRange", ...range });
    willDo.push(
      say(
        `keep just ${clockOf(range.startSeconds)}\u2013${clockOf(range.endSeconds)}, the stretch you named`,
        `أبقي ${clockOf(range.startSeconds)}\u2013${clockOf(range.endSeconds)} وحدها، المدى الذي سمّيته`,
      ),
    );
  }

  if (wantsVertical) {
    const target = platform ?? options.defaultPlatform ?? "tiktok";
    operations.push({ type: "formatForPlatform", platform: target });
    willDo.push(say(`reframe it to ${shapeLabel(target)} for ${target}`, `أعيد تأطيره ${shapeLabel(target)} لـ${target}`));
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

  if (CAPTION_WORDS.test(text) && !wantsTranslation) {
    operations.push({
      type: "autoCaptions",
      style: KARAOKE_WORDS.test(text) ? "karaoke-box" : YELLOW_WORDS.test(text) ? "bold-yellow" : "bold-white",
      animation: KARAOKE_WORDS.test(text) ? "karaoke" : "pop",
      dropFillers: true,
    });
    willDo.push(say("caption it from what is actually said", "أكتب الترجمة من الكلام المنطوق نفسه"));
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
    willDo.push(say("add a slow push so the frame is not static", "أضيف حركة بطيئة كي لا تبقى الصورة ثابتة"));
  } else if (PUNCH_WORDS.test(text)) {
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
        : say("punch in where you lean on a word", "أقرّب الصورة عند الكلمات التي تشدّد عليها"),
    );
  }

  if (LOUDNESS_WORDS.test(text)) {
    // `voice` is decided at the end, once the whole sentence has been read —
    // see the note above the loop below.
    operations.push({ type: "normalizeLoudness", targetLufs: -14, voice: false });
    willDo.push(say("level the audio to what these platforms expect", "أضبط مستوى الصوت على ما تتوقّعه هذه المنصّات"));
  }

  // A bare "add transitions" used to be refused outright. The fade at the ends
  // is a transition and it is built, so the ask now produces it — and the
  // narrower "between the cuts" entry above still says what is missing, so
  // nobody is told they got something they did not.
  if (HOOK_WORDS.test(text)) {
    operations.push({ type: "coldOpen", seconds: 4 });
    willDo.push(say("open on the strongest moment, then play the rest from the top", "أفتح على أقوى لحظة، ثم يُعرض الباقي من البداية"));
  }

  // Two different transitions, asked for in overlapping words. "Transitions"
  // with nothing else said means both — the ends and the joins — because that
  // is what the word means to someone who has never seen this menu, and both
  // now exist. Naming one gets exactly the one named.
  const wantsAnyTransition = /\btransitions?\b|\bانتقال|انتقالات/i.test(text);
  const shapedStyle = transitionStyleFrom(text);
  const wantsDissolve = DISSOLVE_WORDS.test(text);
  if (FADE_WORDS.test(text) || wantsAnyTransition) {
    operations.push({ type: "fade", durationMs: 500 });
    willDo.push(say("open it from black and close it to black", "أفتحه من السواد وأُغلقه إليه"));
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
    operations.push({ type: "transition", style, durationMs: 250 });
    willDo.push(
      style === "dissolve"
        ? say("dissolve between the cuts instead of jumping", "أذوّب بين القصّات بدل القفز بينها")
        : say(
            `join the cuts with a ${STYLE_IN_WORDS[style]} instead of jumping`,
            `أصل القصّات بـ${STYLE_IN_WORDS_AR[style]} بدل القفز بينها`,
          ),
    );
  }

  // ── The project's own files ────────────────────────────────────────────────
  const library = options.assets ?? [];
  const clips = library.filter((a) => a.kind === "video");
  const stills = library.filter((a) => a.kind === "image");

  if (BROLL_WORDS.test(text)) {
    if (clips.length === 0) {
      cannotYet.push(say("cut in B-roll yet, because this project has no clips to cut to", "أضيف لقطات مساندة بعد، لأن المشروع لا يحوي مقاطع أقطع إليها"));
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
        willDo.push(say(`cut away to ${describeFile(clip)} at ${at}s`, `أقطع إلى ${describeFile(clip)} عند الثانية ${at}`));
      });
    }
  }

  // A named look. Before the library block, because it needs no file of theirs.
  const look = LOOK_WORDS.find((entry) => entry.patterns.test(text))?.look;
  if (look) {
    operations.push({ type: "grade", saturation: 1, look });
    willDo.push(
      look === "mono"
        ? say("take the colour out", "أنزع اللون")
        : look === "punch"
          ? say("push the contrast and the colour", "أرفع التباين واللون")
          : say(`grade it ${look}`, `أدرّجه ${look}`),
    );
  }

  const tracks = library.filter((a) => a.kind === "audio");

  // Music is the person's own file or it is nothing. We ship no catalogue and
  // will not: a track we handed out would be a licence we bought on their
  // behalf. So the honest reply when the library is empty names the fix rather
  // than the limitation — upload the track and it goes under.
  if (MUSIC_WORDS.test(text)) {
    if (tracks.length === 0) {
      cannotYet.push(
        say(
          "add music yet, because this project has no audio file. Upload the track you have the rights to and I will lay it under the whole edit",
          "أضيف موسيقى بعد، لأن المشروع لا يحوي ملفًّا صوتيًّا، ارفع المقطوعة التي تملك حقوقها وأضعها تحت التعديل كلّه",
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
          "cut to the beat yet, because this project has no music to cut to. Upload the track and the punches will land on it",
          "أقصّ على الإيقاع بعد، لأن المشروع لا يحوي موسيقى أقصّ عليها، ارفع المقطوعة وستقع التقريبات عليها",
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
          "land the punches on the beat of that track rather than on your voice",
          "أُوقع التقريبات على إيقاع تلك المقطوعة بدل صوتك",
        ),
      );
    }
  }

  if (OVERLAY_WORDS.test(text)) {
    if (stills.length === 0) {
      cannotYet.push(say("put an image over the frame yet, because this project has no images", "أضع صورة فوق الكادر بعد، لأن المشروع لا يحوي صورًا"));
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
      const kinetic = KINETIC_WORDS.test(asked);
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
  } else if (/\btitle|\btext on screen\b/i.test(text) && !CAPTION_WORDS.test(text)) {
    cannotYet.push(
      say(
        "animate a title yet, because I do not know the words. Put them in quotes and I will",
        "أحرّك عنوانًا بعد، لأنني لا أعرف كلماته، ضعها بين علامتَي اقتباس وسأفعل",
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
          "أختار لك الإيموجي، اكتب التي تريدها في رسالتك وسأضعها",
        ),
      );
    }
  }


  for (const { patterns, label } of NOT_YET) {
    if (patterns.test(text)) cannotYet.push(label);
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
  const hasBed = operations.some((op) => op.type === "addMusic");
  for (const operation of operations) {
    if (operation.type === "normalizeLoudness") operation.voice = !hasBed;
  }

  return { operations, willDo, cannotYet, language: languageOf(asked) };
}

/** Seconds as m:ss, because "80s" is a number and "1:20" is a moment. */
function clockOf(seconds: number): string {
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
  const lang = intent.language;

  if (!context.hasVideo) return EMPTY_PROJECT[lang];

  const parts: string[] = [];
  const listed = (phrases: Phrase[]): string =>
    joinNaturally(phrases.map((p) => p[lang]), lang);

  if (intent.willDo.length > 0) {
    const doing = listed(intent.willDo);
    if (context.render?.started) {
      parts.push(
        lang === "ar"
          ? `تمام، س${doing}. التصيير يعمل الآن؛ سيظهر هنا لحظة انتهائه.`
          : `On it. I'll ${doing}. It's rendering now; you'll see it here the moment it's done.`,
      );
    } else if (context.render && !context.render.started) {
      // The reason comes from the server in English. It is left as it is
      // rather than guessed at: half a sentence in each language reads worse
      // than one, and inventing an Arabic reason we did not write would be
      // putting words in the product's mouth about why it refused.
      parts.push(
        lang === "ar"
          ? `كنت س${doing}، لكن لا أستطيع البدء الآن: ${context.render.because}`
          : `I'd ${doing}. But I can't start it right now: ${context.render.because}`,
      );
    } else {
      parts.push(
        lang === "ar"
          ? `تمام، س${doing}. اضغط Generate Edit وأبدأ.`
          : `Right. I'll ${doing}. Hit Generate Edit and I'll start.`,
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
        ? `لا أستطيع أن ${missing}، فأترك ${plural ? "تلك الأمور" : "ذلك"} خارج التعديل بدل أن أدّعي.`
        : `I can't ${missing}, so I'll leave ${plural ? "those" : "that"} out rather than pretend.`,
    );
  }

  if (parts.length === 0) return NOTHING_UNDERSTOOD[lang];

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
    "ارفع فيديو أوّلًا وأبدأ العمل، أستطيع أن أستخرج أقوى 30 ثانية، وأبقي مدًى تسمّيه بالضبط (من 1:20 إلى 2:10)، وأقسّمه إلى مقاطع منفصلة، وأقصّ الصمت، وأكتب الترجمة من كلامك نفسه، وأعيد التأطير لتيك توك أو ريلز أو شورتس، أو 16:9 ليوتيوب، أو مربّعًا للفيد، وأضيف حركة، وأضع موسيقاك تحته، وأدرّجه warm أو cool أو cinematic أو أبيض وأسود، وأفتحه من السواد وأُغلقه إليه، وأضبط مستوى الصوت.",
};

const NOTHING_UNDERSTOOD: Record<Language, string> = {
  en:
    "I'm not sure what to change from that. Right now I can pull out the best 30 seconds of a clip, " +
    "keep exactly a stretch you name (from 1:20 to 2:10), cut it into separate clips, cut the silences, caption it, reframe it to 9:16 or 16:9 or square, " +
    "add punch-in zooms or a slow push, lay a track you've uploaded under the whole thing, fade it in and out, and level the audio. Try something like " +
    '"give me the strongest 30 seconds, captioned, vertical for TikTok".',
  ar:
    "لست متأكّدًا ما الذي أغيّره من ذلك. أستطيع الآن أن أستخرج أفضل 30 ثانية من المقطع، " +
    "وأبقي مدًى تسمّيه بالضبط (من 1:20 إلى 2:10)، وأقسّمه إلى مقاطع منفصلة، وأقصّ الصمت، وأكتب الترجمة، وأعيد التأطير إلى 9:16 أو 16:9 أو مربّع، " +
    "وأقرّب الصورة عند التشديد أو أضيف حركة بطيئة، وأضع مقطوعة رفعتَها تحت التعديل كلّه، وأفتحه من السواد وأُغلقه إليه، وأضبط مستوى الصوت، جرّب مثلًا " +
    "«أعطني أقوى 30 ثانية، مع ترجمة، عمودية للتيك توك».",
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
