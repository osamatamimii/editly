/**
 * Understanding the material, which is the thing this product has never done.
 *
 * Twenty operations, a renderer that can execute all of them, two planners that
 * can be asked for any of them — and nothing anywhere that knows what the video
 * is *about*. "Give me the strongest thirty seconds" is answered in
 * `highlight.ts` by speech density with a hesitation penalty: a measurement of
 * how continuously somebody was talking. It is a good measurement and it is not
 * an answer to the question. The strongest thirty seconds of a talk is where
 * the point lands, and the point can land in a sentence delivered slowly with a
 * pause in the middle of it — which scores below a fast tangent every time.
 *
 * That is why the clips come out plausible and are never the right piece.
 *
 * This module is the missing step. It turns a transcript with timestamps into a
 * structure: where the parts of the material are, what the person asserted,
 * what they asked, which stretches are the reason anybody would watch, and
 * which single line the video should open on. It is stored with the project and
 * everything downstream reads it rather than re-deriving it.
 *
 * ## The rule that makes a model's answer usable
 *
 * A model reading a transcript is confident, cheap, fast, and wrong in a very
 * particular way: it invents times and it invents words. Asked about a
 * ninety-second clip it will place a chapter at 03:12; asked for what somebody
 * asserted it will produce a fluent sentence they never said. Neither throws.
 * Neither logs. Both parse. This is exactly the shape of failure this codebase
 * keeps finding in itself — the check that reads the filter string and passes a
 * feature that is not there — so the answer is treated the same way here:
 *
 *   **times are ours, quotes are theirs, and a quote that is not in the
 *   transcript does not exist.**
 *
 * Every timestamp the model returns is snapped onto a real boundary between
 * real words, or discarded. Every quote is looked up in what was actually said;
 * one that cannot be found is dropped and counted in a note. What survives is a
 * structure whose every element is anchored to a second of audio that exists
 * and a sentence that was spoken.
 *
 * ## And what happens with no model at all
 *
 * The deployment this runs on today has no Gemini key. So there is a second
 * path that reads structure out of the *shape* of the speech — chapter
 * boundaries at the longest pauses, questions from question marks and
 * interrogatives, peaks from where the speaking is densest. It is weaker and it
 * says so: `how` is `"structure"`, and the notes say the boundaries came from
 * the pauses rather than from a reading.
 *
 * It deliberately produces **no claims and no hook**. A claim is an assertion
 * attributed to a person and a hook is a judgement about what would hold a
 * stranger; a heuristic that guessed at either would be inventing the one kind
 * of content that must never be invented. Empty, honestly, beats plausible.
 */
import { createHash } from "node:crypto";
import type { StructureRead, StructureReader, Transcript } from "./providers/types";
import { speechBreaks, type SpokenWord } from "./timeline";
import { isFiller } from "./providers/fillers";
import { pick, sayIn, type Language, type NotePair, type Say } from "./say";

/** Bumped when the shape changes, so a stored reading from an older build is re-made rather than misread. */
export const COMPREHENSION_VERSION = 1;

export interface ComprehendedChapter {
  start: number;
  end: number;
  title: string;
}

export interface ComprehendedClaim {
  at: number;
  /** The speaker's own words. Verified to be in the transcript. */
  quote: string;
}

export interface ComprehendedQuestion {
  at: number;
  quote: string;
  /** Where the answer begins, when one follows. Null when nothing answers it. */
  answeredAt: number | null;
}

export interface ComprehendedPeak {
  start: number;
  end: number;
  /** Why this stretch holds attention, in the reader's words — not the speaker's. */
  why: string;
  /** 0..1. */
  strength: number;
}

export interface ComprehendedHook {
  at: number;
  quote: string;
}

export interface Comprehension {
  version: number;
  /** The source's length, so a stored reading can be recognised as being about a different file. */
  durationSeconds: number;
  language: string | null;
  /** `model` — read for meaning. `structure` — derived from the shape of the speech. */
  how: "model" | "structure";
  /** Which reader produced it, for the same reason a transcript names its source. */
  source: string | null;
  /** Of the words this was made from. The reuse key: same words, same reading. */
  digest: string;
  chapters: ComprehendedChapter[];
  claims: ComprehendedClaim[];
  questions: ComprehendedQuestion[];
  peaks: ComprehendedPeak[];
  hook: ComprehendedHook | null;
  /** What is worth knowing about how this was arrived at. Never empty when something was lost. */
  notes: string[];
}

/* ── The thresholds, all of them on the side of doing less ─────────────────── */

/**
 * The shortest thing that is allowed to be called a chapter.
 *
 * A model asked to divide a video will happily return a four-second "chapter",
 * and a chapter list where one entry is a sentence is not a table of contents —
 * it is the transcript with headings. Twelve seconds is short enough for a
 * ninety-second reel to have three of them and long enough that each is a part
 * rather than a line. Scaled down for a source too short to hold three.
 */
const MIN_CHAPTER_SECONDS = 12;

/** No table of contents anybody reads has more entries than this. */
const MAX_CHAPTERS = 24;

/** How far a boundary may be moved to land on a real pause. */
const CHAPTER_SNAP_SECONDS = 2.5;

/**
 * A gap this size at the start or the end is closed rather than left.
 *
 * A model that begins its first chapter at 1.4s and ends its last 2s before the
 * file does has not identified two pieces of unclassified material; it has
 * rounded. Anything larger is left as the hole it is, because a chapter list
 * that silently claims to cover a minute it never looked at is the lie this
 * file exists to refuse.
 */
const EDGE_TOLERANCE_SECONDS = 3;

/** Shorter than this is a moment, not a stretch, and cannot be cut to. */
const MIN_PEAK_SECONDS = 1.5;

/** More than this and "the peaks" is just "the video". */
const MAX_PEAKS = 12;

/**
 * How much transcript one reading is allowed to carry.
 *
 * The budget lives here rather than in the provider because it is a decision
 * about the *material*, not about an API: a source that does not fit is thinned
 * — adjacent lines merged, timestamps coarsened — so that the reading is still
 * of the whole video. The provider keeps a hard slice of its own as a backstop
 * against a caller that ignores this, which is the only honest place for a
 * second number: it is a guard, not a second opinion about the budget.
 */
export const TRANSCRIPT_BUDGET_CHARS = 180_000;

/**
 * How much of a quote has to be found before it counts as said.
 *
 * Not all of it, because a recogniser's word boundaries and a model's copy of
 * them disagree at the edges — a dropped "the", a contraction split in two, a
 * trailing clause the model tidied. Three quarters of the words, contiguous, in
 * order, is a sentence that was spoken. Half would let a paraphrase through,
 * and a paraphrase is the thing being screened for.
 */
const QUOTE_MATCH_RATIO = 0.75;

/** Below this many words, a partial match means nothing, so all of them must be there. */
const QUOTE_EXACT_BELOW = 4;

/* ── From a transcript to the two things everything else is built on ───────── */

/**
 * The words, on the source clock, in seconds.
 *
 * The same flattening `index.ts` already does for the cut, repeated here rather
 * than shared, because this module has to run in a test with no worker around
 * it and the conversion is four lines.
 */
export function wordsOf(transcript: Transcript): SpokenWord[] {
  return transcript.segments
    .flatMap((segment) => segment.words)
    .map((word) => ({
      start: word.startMs / 1000,
      end: word.endMs / 1000,
      filler: word.filler,
      text: word.text,
    }))
    .filter((word) => word.end > word.start)
    .sort((a, b) => a.start - b.start);
}

/**
 * A fingerprint of what was said, so a reading can be reused.
 *
 * Over the words and their times rather than over the file, because that is
 * what the reading is *of*. Two renders of the same source produce the same
 * transcript and must not pay for the same reading twice; a source that was
 * replaced produces different words and must not silently keep the old one's
 * chapters. The file's bytes would answer neither question — a re-encode of the
 * same recording is a different file and the same material.
 */
export function transcriptDigest(words: SpokenWord[]): string {
  const hash = createHash("sha256");
  for (const word of words) {
    hash.update(`${word.start.toFixed(3)}|${word.end.toFixed(3)}|${word.text ?? ""}\n`);
  }
  return hash.digest("hex").slice(0, 32);
}

/**
 * What one reading covers, and what it could not.
 *
 * `truncated` is the field that matters. A structure of the first forty minutes
 * of a two-hour talk, stored as the structure of the talk, is wrong in the way
 * nothing detects: it parses, it validates, and every chapter in it is real.
 * The only defence is for the step that cut it short to say so, in a note that
 * travels with the reading.
 */
export interface TranscriptForReading {
  text: string;
  /** The second the last line sent starts at. */
  coveredSeconds: number;
  /** True when the material did not fit and the tail was left out. */
  truncated: boolean;
}

/**
 * The transcript as the model reads it: one line per stretch of speech, each
 * prefixed with the second it starts at.
 *
 * Times on every line, and that is the point. A model handed a wall of prose
 * has no way to answer "where" except by guessing, and it will guess rather
 * than decline. Handing it the numbers does not make it accurate — the
 * reconciliation below still assumes it is not — but it converts the common
 * failure from invention into transcription error, which is the failure that
 * can be corrected.
 *
 * A source too long for one request is **thinned before it is cut**: adjacent
 * lines are merged, which costs the timestamps their resolution and keeps every
 * word. Only when the words alone still do not fit is the tail dropped, and
 * then it is dropped *loudly* — `truncated` is what the caller turns into a
 * note. Silence there would be the worst answer this module could give.
 */
export function transcriptLines(transcript: Transcript, maxChars: number): TranscriptForReading {
  const segments = transcript.segments
    .map((segment) => ({
      startMs: segment.startMs,
      text: (segment.text ?? segment.words.map((w) => w.text).join(" ")).replace(/\s+/g, " ").trim(),
    }))
    .filter((segment) => segment.text.length > 0);
  if (segments.length === 0) return { text: "", coveredSeconds: 0, truncated: false };

  const render = (group: number): string[] => {
    const lines: string[] = [];
    for (let i = 0; i < segments.length; i += group) {
      const chunk = segments.slice(i, i + group);
      lines.push(`[${(chunk[0].startMs / 1000).toFixed(1)}] ${chunk.map((c) => c.text).join(" ")}`);
    }
    return lines;
  };

  let group = 1;
  let lines = render(group);
  while (lines.join("\n").length > maxChars && group < segments.length) {
    group *= 2;
    lines = render(group);
  }

  const whole = lines.join("\n");
  if (whole.length <= maxChars) {
    return { text: whole, coveredSeconds: segments[segments.length - 1].startMs / 1000, truncated: false };
  }

  /*
    Merging has run out of room. All it ever recovered was the timestamps —
    the words are the same length however they are grouped — so past this point
    it is only making the *unit of loss* bigger, and one line holding forty
    stretches of speech is either sent whole or drops forty of them at once.
    So the cut is made against the finest rendering there is, which keeps the
    most material and the best times, and the tail is dropped at a line
    boundary, never mid-sentence, and never without saying so.
  */
  const finest = render(1);
  const kept: string[] = [];
  let used = 0;
  for (const line of finest) {
    if (used + line.length + 1 > maxChars) break;
    kept.push(line);
    used += line.length + 1;
  }
  const last = segments[Math.max(0, kept.length - 1)];
  return {
    text: kept.join("\n"),
    coveredSeconds: (last?.startMs ?? 0) / 1000,
    truncated: true,
  };
}

/* ── Grounding: does this sentence exist in what was said? ─────────────────── */

const ARABIC_MARKS = /[\u064B-\u0652\u0670\u0640]/g;

/**
 * One spelling of a word, chosen so that two spellings of the same word are the
 * same string.
 *
 * The Arabic half is not decoration. A recogniser writes «إن» and a model
 * writes «ان»; one emits «الشركه» and the other «الشركة». Compared literally,
 * every real quote in an Arabic video fails to match what was said, every one of
 * them is dropped as a hallucination, and the product's answer for Arabic
 * material is silently an empty structure — which is the exact class of bug
 * this file's whole design is aimed at, arriving through the door marked
 * "obviously correct string comparison".
 */
export function normaliseWord(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036F]/g, "")
    .replace(ARABIC_MARKS, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/[ىی]/g, "ي")
    .replace(/[ؤئ]/g, "ء")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

const tokensOf = (text: string): string[] => text.split(/\s+/).map(normaliseWord).filter((t) => t.length > 0);

/**
 * Where in the recording this sentence was said, or null if it never was.
 *
 * The search runs near the time the reader claimed first and over the whole
 * transcript second. Both, and in that order, because the two failures are
 * different and only one of them is fatal: a real quote with a wrong time is a
 * reading worth keeping once the time is corrected, while a quote that is
 * nowhere in the file is a sentence the product would be putting in somebody's
 * mouth.
 */
export function locateQuote(
  quote: string,
  words: SpokenWord[],
  nearSeconds?: number,
): { start: number; end: number } | null {
  const needle = tokensOf(quote);
  if (needle.length === 0 || words.length === 0) return null;

  const haystack = words.map((word) => normaliseWord(word.text ?? ""));
  const required =
    needle.length < QUOTE_EXACT_BELOW ? needle.length : Math.ceil(needle.length * QUOTE_MATCH_RATIO);

  /**
   * The longest run of `needle`, in order, starting at word `from`, and the
   * word it ended on.
   *
   * The end index is returned rather than derived from the count because a
   * recogniser emits words that normalise to nothing — a lone "-", a stray
   * bracket — and they are stepped over here. Counting them out of the span
   * would end the quote a word or two early, which is how a claim gets stored
   * pointing at a second of audio that stops mid-sentence.
   */
  const runAt = (from: number): { matched: number; last: number } => {
    let matched = 0;
    let w = from;
    let last = from;
    for (let n = 0; n < needle.length && w < haystack.length; ) {
      if (haystack[w] === "") {
        w += 1;
        continue;
      }
      if (haystack[w] === needle[n]) {
        matched += 1;
        last = w;
        w += 1;
        n += 1;
      } else if (matched > 0) {
        break;
      } else {
        return { matched: 0, last: from };
      }
    }
    return { matched, last };
  };

  let best: { start: number; end: number; matched: number; distance: number } | null = null;
  for (let i = 0; i < words.length; i += 1) {
    const { matched, last } = runAt(i);
    if (matched < required) continue;
    const distance = nearSeconds === undefined ? 0 : Math.abs(words[i].start - nearSeconds);
    const candidate = { start: words[i].start, end: words[last].end, matched, distance };
    // Nearest to where the reader said it, and among equals the longer match:
    // the same sentence can be said twice, and the one it meant is the one it
    // pointed at. When it pointed nowhere near, the match still stands — the
    // words are real, and the second they were said in is the only time about
    // them that was ever true.
    if (
      best === null ||
      candidate.distance < best.distance - 1e-9 ||
      (Math.abs(candidate.distance - best.distance) < 1e-9 && candidate.matched > best.matched)
    ) {
      best = candidate;
    }
  }

  return best ? { start: best.start, end: best.end } : null;
}

/* ── Turning a reader's answer into something that can be built on ─────────── */

const NOTES: Record<string, NotePair> = {
  fabricated: {
    en: "some of what the reading attributed to this video is not in it, and was dropped",
    ar: "بعض ما نسبته القراءة إلى هذا الفيديو ليس فيه، فأُسقط",
  },
  noHook: {
    en: "no line in this video was proposed as an opening that is actually in it",
    ar: "لا سطر في هذا الفيديو اقتُرح افتتاحيةً وهو موجود فيه فعلًا",
  },
  fromShape: {
    en: "the parts below come from the pauses in the speech, not from a reading of what was said",
    ar: "الأجزاء أدناه مأخوذة من سكتات الكلام، لا من قراءة لما قيل",
  },
  noClaims: {
    en: "nothing here says what was asserted: attributing a statement to somebody needs a reading, not a pause",
    ar: "لا شيء هنا يقول ما ادُّعي: نسبة قول إلى إنسان تحتاج قراءةً لا سكتة",
  },
  readerFailed: {
    en: "the reading could not be made, so the parts below come from the shape of the speech",
    ar: "تعذّرت القراءة، فالأجزاء أدناه من شكل الكلام",
  },
};

export interface ComprehendOptions {
  transcript: Transcript;
  /** The source's measured length. Everything is clamped into it. */
  durationSeconds: number;
  /** Absent or null means there is no model, and the fallback runs. */
  reader?: StructureReader | null;
  /** Why there is no reader, when there is none — from `providers.status.structure`. */
  unavailable?: NotePair | null;
  language?: Language;
  signal?: AbortSignal;
  /** How much transcript one request may carry. Overridable for the suite. */
  maxTranscriptChars?: number;
}

/**
 * Read the material. Never throws.
 *
 * A reading is not something anyone paid for and losing one must never cost a
 * render — so a reader that 500s, times out, or answers with prose degrades to
 * the shape-based path and says so, exactly like the transcript providers
 * degrade. The one thing it may not do is come back looking successful.
 */
export async function comprehend(options: ComprehendOptions): Promise<Comprehension> {
  const say = sayIn(options.language);
  const words = wordsOf(options.transcript);
  const duration = Math.max(0, options.durationSeconds);
  const base = {
    version: COMPREHENSION_VERSION,
    durationSeconds: round2(duration),
    language: options.transcript.language,
    digest: transcriptDigest(words),
  };

  if (words.length === 0) {
    return {
      ...base,
      how: "structure" as const,
      source: null,
      chapters: [],
      claims: [],
      questions: [],
      peaks: [],
      hook: null,
      notes: [],
    };
  }

  if (options.reader) {
    const sent = transcriptLines(options.transcript, options.maxTranscriptChars ?? TRANSCRIPT_BUDGET_CHARS);
    try {
      const read = await options.reader.read(sent.text, {
        language: options.transcript.language,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const reconciled = reconcile(read, words, duration, say);
      return {
        ...base,
        how: "model",
        source: options.reader.name,
        ...reconciled,
        notes: [
          // First, because it changes what every line under it means: this is
          // the structure of part of a video, presented beside a duration that
          // is the whole of it.
          ...(sent.truncated
            ? [
                say(
                  `this video was too long to read in one pass, so what is below covers its first ${minutesOf(sent.coveredSeconds)} minutes`,
                  `هذا الفيديو أطول من أن يُقرأ دفعةً واحدة، فما تحته يغطّي أوّل ${minutesOf(sent.coveredSeconds)} دقيقة منه`,
                ),
              ]
            : []),
          ...reconciled.notes,
        ],
      };
    } catch (error) {
      const shape = fromShape(words, duration, say);
      return {
        ...base,
        how: "structure",
        source: null,
        ...shape,
        notes: [
          `${pick(say, NOTES.readerFailed)}: ${messageOf(error)}`,
          ...shape.notes.filter((note) => note !== pick(say, NOTES.fromShape)),
        ],
      };
    }
  }

  const shape = fromShape(words, duration, say);
  return {
    ...base,
    how: "structure",
    source: null,
    ...shape,
    notes: [...(options.unavailable ? [pick(say, options.unavailable)] : []), ...shape.notes],
  };
}

type Parts = Pick<Comprehension, "chapters" | "claims" | "questions" | "peaks" | "hook" | "notes">;

/**
 * A reader's answer, measured against the words.
 *
 * Everything here is subtraction. Nothing is added, nothing is smoothed over,
 * and every element that survives is one whose time is a real boundary in this
 * file and whose words were really said in it.
 */
export function reconcile(
  read: StructureRead,
  words: SpokenWord[],
  duration: number,
  say: Say = sayIn("en"),
): Parts {
  const breaks = speechBreaks(words);
  const notes: string[] = [];
  let dropped = 0;

  const snap = (list: { at: number; gap: number }[], target: number): number => {
    let best: number | null = null;
    for (const candidate of list) {
      if (Math.abs(candidate.at - target) > CHAPTER_SNAP_SECONDS) continue;
      if (best === null || Math.abs(candidate.at - target) < Math.abs(best - target)) best = candidate.at;
    }
    return best ?? target;
  };

  // ── Chapters ──────────────────────────────────────────────────────────────
  const minChapter = Math.min(MIN_CHAPTER_SECONDS, Math.max(1, duration / 3));
  let chapters: ComprehendedChapter[] = read.chapters
    .filter((c) => Number.isFinite(c.startSeconds) && Number.isFinite(c.endSeconds))
    .map((c) => ({
      start: clamp(snap(breaks.starts, c.startSeconds), 0, duration),
      end: clamp(snap(breaks.ends, c.endSeconds), 0, duration),
      title: c.title.trim(),
    }))
    .filter((c) => c.title.length > 0 && c.end - c.start >= minChapter)
    .sort((a, b) => a.start - b.start);

  // Overlaps are trimmed rather than dropped: two chapters that overlap are one
  // boundary in the wrong place, not two wrong chapters.
  const tidy: ComprehendedChapter[] = [];
  for (const chapter of chapters) {
    const previous = tidy[tidy.length - 1];
    if (previous && chapter.start < previous.end) previous.end = chapter.start;
    if (previous && previous.end - previous.start < minChapter) tidy.pop();
    if (chapter.end - chapter.start >= minChapter) tidy.push({ ...chapter });
  }
  chapters = tidy.slice(0, MAX_CHAPTERS);
  if (chapters.length > 0) {
    // Rounding at the edges is closed; a real hole is left as one.
    if (chapters[0].start <= EDGE_TOLERANCE_SECONDS) chapters[0].start = 0;
    const last = chapters[chapters.length - 1];
    if (duration - last.end <= EDGE_TOLERANCE_SECONDS) last.end = duration;
  }

  // ── Claims and questions: quotes, and therefore checkable ─────────────────
  const claims: ComprehendedClaim[] = [];
  for (const claim of read.claims) {
    const at = locateQuote(claim.quote, words, finiteOr(claim.atSeconds));
    if (!at) {
      dropped += 1;
      continue;
    }
    claims.push({ at: round2(at.start), quote: claim.quote.trim() });
  }

  const questions: ComprehendedQuestion[] = [];
  for (const question of read.questions) {
    const at = locateQuote(question.quote, words, finiteOr(question.atSeconds));
    if (!at) {
      dropped += 1;
      continue;
    }
    // The answer's time is snapped like a chapter boundary and never allowed to
    // precede its own question — an answer before the question is a number the
    // reader got wrong, and carrying it would be worse than not having it.
    const answered = Number.isFinite(question.answeredAtSeconds as number)
      ? clamp(snap(breaks.starts, question.answeredAtSeconds as number), 0, duration)
      : null;
    questions.push({
      at: round2(at.start),
      quote: question.quote.trim(),
      answeredAt: answered !== null && answered > at.start ? round2(answered) : null,
    });
  }

  // ── Peaks: times only, so there is nothing to fabricate but the reason ────
  const peaks = tidyPeaks(
    read.peaks
      .filter((p) => Number.isFinite(p.startSeconds) && Number.isFinite(p.endSeconds))
      .map((p) => ({
        start: clamp(snap(breaks.starts, p.startSeconds), 0, duration),
        end: clamp(snap(breaks.ends, p.endSeconds), 0, duration),
        why: p.why.trim(),
        strength: clamp(p.strength, 0, 1),
      })),
  );

  // ── The hook ─────────────────────────────────────────────────────────────
  let hook: ComprehendedHook | null = null;
  if (read.hook) {
    const at = locateQuote(read.hook.quote, words, finiteOr(read.hook.atSeconds));
    if (at) hook = { at: round2(at.start), quote: read.hook.quote.trim() };
    else dropped += 1;
  }
  if (!hook) notes.push(pick(say, NOTES.noHook));

  if (dropped > 0) notes.unshift(`${pick(say, NOTES.fabricated)} (${dropped})`);

  return { chapters: chapters.map(round2Chapter), claims, questions, peaks, hook, notes };
}

/* ── With no model: what the shape of the speech alone can say ─────────────── */

const QUESTION_MARKS = /[?؟]/;

/**
 * Words that open a question in the two languages this product is spoken in.
 *
 * Recognisers punctuate unreliably and Arabic recognisers frequently not at
 * all, so a rule that trusted «؟» alone would find questions in English videos
 * and none in Arabic ones — the same asymmetry that left `dropFillers` doing
 * nothing for Arabic for months.
 */
const OPENERS = new Set([
  "what", "why", "how", "when", "where", "who", "which", "whose",
  "is", "are", "was", "were", "do", "does", "did", "can", "could",
  "should", "would", "will", "have", "has", "am",
  "ما", "ماذا", "لماذا", "كيف", "متى", "اين", "من", "هل", "أ", "كم", "ايش", "شو", "وين", "ليش", "مين",
]);

export function fromShape(
  words: SpokenWord[],
  duration: number,
  say: Say = sayIn("en"),
): Parts {
  const chapters = shapeChapters(words, duration);
  const questions = shapeQuestions(words);
  const peaks = shapePeaks(words, duration, say);
  return {
    chapters,
    claims: [],
    questions,
    peaks,
    hook: null,
    notes: [pick(say, NOTES.fromShape), pick(say, NOTES.noClaims), pick(say, NOTES.noHook)],
  };
}

/**
 * Boundaries at the longest silences, taken strongest-first.
 *
 * A pause is not a subject change, and this does not claim it is — the note
 * says where these came from. What a long pause *is* is the most likely place
 * for one, and taking them in order of length rather than in order of time is
 * what stops a talk with one long break in the middle from being divided into
 * eight equal pieces that ignore it.
 */
function shapeChapters(words: SpokenWord[], duration: number): ComprehendedChapter[] {
  const minChapter = Math.min(MIN_CHAPTER_SECONDS, Math.max(1, duration / 3));
  if (duration < minChapter * 2 || words.length === 0) {
    return duration > 0 ? [{ start: 0, end: round2(duration), title: openingWords(words, 0) }] : [];
  }

  const wanted = Math.max(1, Math.min(MAX_CHAPTERS, Math.round(duration / 90)));
  const candidates = speechBreaks(words)
    .starts.filter((s) => Number.isFinite(s.gap))
    .sort((a, b) => b.gap - a.gap || a.at - b.at);

  const cuts: number[] = [];
  for (const candidate of candidates) {
    if (cuts.length >= wanted - 1) break;
    const near = [0, duration, ...cuts].some((edge) => Math.abs(edge - candidate.at) < minChapter);
    if (!near) cuts.push(candidate.at);
  }
  cuts.sort((a, b) => a - b);

  const edges = [0, ...cuts, duration];
  const chapters: ComprehendedChapter[] = [];
  for (let i = 0; i < edges.length - 1; i += 1) {
    chapters.push({ start: round2(edges[i]), end: round2(edges[i + 1]), title: openingWords(words, edges[i]) });
  }
  return chapters;
}

/** The first few words actually spoken after `from` — the same rule the clip titles use. */
function openingWords(words: SpokenWord[], from: number): string {
  const taken: string[] = [];
  for (const word of words) {
    if (word.start < from - 1e-9) continue;
    const text = (word.text ?? "").trim();
    if (!text || word.filler || isFiller(text)) continue;
    taken.push(text);
    if (taken.length >= 6) break;
  }
  return taken.join(" ");
}

/**
 * Sentences that were questions.
 *
 * Grouped on the pauses rather than on punctuation, because punctuation is the
 * thing that cannot be relied on here. A group counts when it is marked or when
 * it opens on an interrogative — and the opener test is deliberately restricted
 * to the *first* word of a group, since "how" in the middle of a sentence is
 * usually "how to", not a question.
 */
function shapeQuestions(words: SpokenWord[]): ComprehendedQuestion[] {
  const groups: SpokenWord[][] = [];
  let current: SpokenWord[] = [];
  for (let i = 0; i < words.length; i += 1) {
    current.push(words[i]);
    const gap = i + 1 < words.length ? words[i + 1].start - words[i].end : Infinity;
    if (gap >= 0.35) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length > 0) groups.push(current);

  const out: ComprehendedQuestion[] = [];
  for (const group of groups) {
    const text = group.map((w) => (w.text ?? "").trim()).filter(Boolean).join(" ").trim();
    if (text.length === 0) continue;
    const first = normaliseWord(group.find((w) => (w.text ?? "").trim())?.text ?? "");
    if (!QUESTION_MARKS.test(text) && !OPENERS.has(first)) continue;
    out.push({ at: round2(group[0].start), quote: text, answeredAt: null });
    if (out.length >= 40) break;
  }
  return out;
}

/**
 * Where the talking is densest, which is the judgement `highlight.ts` already
 * makes — kept here on purpose rather than imported.
 *
 * This is not the same question. `chooseHighlight` picks one window of a length
 * somebody asked for; this marks every stretch that stands out, at a length
 * nobody specified. Sharing the code would mean one of them acquiring a
 * parameter for the other's sake, and `highlight.ts` belongs to a different
 * piece of work.
 */
function shapePeaks(
  words: SpokenWord[],
  duration: number,
  say: Say,
): ComprehendedPeak[] {
  const window = 15;
  if (duration <= window || words.length === 0) return [];

  const density = (start: number): number => {
    let value = 0;
    for (const word of words) {
      const overlap = Math.min(word.end, start + window) - Math.max(word.start, start);
      if (overlap <= 0) continue;
      value += word.filler ? -overlap : overlap;
    }
    return value;
  };

  const wanted = Math.max(1, Math.min(5, Math.round(duration / 120)));
  const starts = [...new Set(words.map((w) => w.start).filter((s) => s + window <= duration))].sort((a, b) => a - b);
  const scored = starts.map((start) => ({ start, score: density(start) })).sort((a, b) => b.score - a.score || a.start - b.start);
  const best = scored[0]?.score ?? 0;
  if (best <= 0) return [];

  const why = say("the densest speech in this stretch", "أكثف كلام في هذا المقطع");
  const taken: ComprehendedPeak[] = [];
  for (const candidate of scored) {
    if (taken.length >= wanted) break;
    if (candidate.score <= 0) break;
    if (taken.some((p) => candidate.start < p.end && candidate.start + window > p.start)) continue;
    taken.push({
      start: round2(candidate.start),
      end: round2(Math.min(duration, candidate.start + window)),
      why,
      strength: round2(Math.max(0, Math.min(1, candidate.score / best))),
    });
  }
  taken.sort((a, b) => a.start - b.start);
  return taken;
}

/* ── Small shared arithmetic ───────────────────────────────────────────────── */

function tidyPeaks(peaks: ComprehendedPeak[]): ComprehendedPeak[] {
  const kept: ComprehendedPeak[] = [];
  for (const peak of [...peaks].sort((a, b) => b.strength - a.strength || a.start - b.start)) {
    if (peak.end - peak.start < MIN_PEAK_SECONDS) continue;
    // The stronger of two overlapping peaks wins outright rather than the two
    // being merged: a merged peak is a stretch nobody scored.
    if (kept.some((k) => peak.start < k.end && peak.end > k.start)) continue;
    kept.push({ ...peak, start: round2(peak.start), end: round2(peak.end), strength: round2(peak.strength) });
    if (kept.length >= MAX_PEAKS) break;
  }
  kept.sort((a, b) => a.start - b.start);
  return kept;
}

function round2Chapter(chapter: ComprehendedChapter): ComprehendedChapter {
  return { ...chapter, start: round2(chapter.start), end: round2(chapter.end) };
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(high, Math.max(low, value));
}

function finiteOr(value: number): number | undefined {
  return Number.isFinite(value) ? value : undefined;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Whole minutes, for a note a person reads rather than a machine parses. */
function minutesOf(seconds: number): number {
  return Math.max(1, Math.round(seconds / 60));
}

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}
