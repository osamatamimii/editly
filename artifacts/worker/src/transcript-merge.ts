/**
 * Two recognisers, one transcript.
 *
 * A wrong word burned onto the screen is the most visible failure this product
 * can produce. It is worse than a missing caption, worse than a late one, and
 * unlike almost everything else in the pipeline the viewer does not need to
 * know anything about editing to see it. Transcription is also the single
 * largest line in what a minute costs us, which means accuracy here is the one
 * place where spending more money buys something the audience can actually
 * see.
 *
 * So we ask twice. Deepgram Nova-3 (5.26% word error) and ElevenLabs Scribe
 * (3.3%) hear the same audio and rarely make the same mistake, because they
 * are different models trained on different data. Where they agree, the word
 * is almost certainly right — far more certainly than either one's own
 * confidence score says, since two independent systems arriving at the same
 * answer is much stronger evidence than one system being sure. Where they
 * disagree, we have learned something we could not have learned from either
 * alone: that this word is contested.
 *
 * The division of labour is deliberate and asymmetric:
 *
 *   Timing comes from the primary, always. Cuts, punches and karaoke sweeps
 *   are all measured against one clock, and mixing two providers' word
 *   boundaries would put a splice in the middle of a syllable for reasons
 *   nobody could trace.
 *
 *   Wording comes from the secondary when they differ, because it is the more
 *   accurate reader — that is the entire reason it is here.
 *
 *   Confidence comes from their agreement, not from either score. A contested
 *   word drops below the caption layer's threshold and gets drawn as "…",
 *   which tells the truth: something was said here and we are not sure what.
 *
 * Everything degrades. One provider missing, one provider failing, one
 * provider returning nothing usable — each of those ends with a working
 * transcript and a line in the render notes, never with a failed render.
 */
import type { Transcript, TranscriptSegment, TranscriptWord } from "./providers/types";
import { sayIn, type Language } from "./say";
import { isFiller } from "./providers/fillers";

/** A pause this long is a safe place to break the comparison in two. */
const SPLIT_GAP_MS = 400;

/**
 * Alignment is quadratic, so a stretch of continuous speech longer than this
 * is left as the primary heard it rather than allowed to cost minutes of CPU.
 * At ~150 words a minute this is over two minutes without a 400ms pause, which
 * essentially does not happen in speech — but "essentially" is not "never",
 * and a render that hangs is worse than one that skipped a check.
 */
const MAX_CHUNK_WORDS = 400;

/** Substituting is cheaper than deleting and inserting, so gaps cost more. */
const SCORE_MATCH = 2;
const SCORE_MISMATCH = -1;
const SCORE_GAP = -2;

/**
 * What a contested word is worth.
 *
 * The floor of the two scores, discounted. Two confident readers disagreeing
 * usually means a homophone or a formatting difference, and the more accurate
 * one's answer is still the best guess available — that survives. Two unsure
 * readers disagreeing means nobody heard it, and this drops it under the
 * caption threshold so it is drawn as an ellipsis instead of a guess.
 */
const CONTESTED_TRUST = 0.8;

/** Heard by one reader and not the other: kept, but no longer unimpeachable. */
const UNCORROBORATED_TRUST = 0.9;

/**
 * How far ahead the primary has to be, in confidence, to keep its own word on a
 * contested one.
 *
 * The secondary is the more accurate reader on average, so a close call goes to
 * it. But "more accurate on average" is not "more accurate on this word": when
 * the primary heard a name at 0.99 and the secondary guessed at 0.50, taking the
 * secondary blindly burns the wrong word onto the video — and if that guess is a
 * filler, the real word is dropped entirely. So a clear gap in the primary's
 * favour keeps the primary's word. 0.25 sits well above the ordinary spread
 * between two readers that heard the same thing (the 0.9-vs-0.88 kind of
 * disagreement still goes to the secondary) and well below a genuine mishearing.
 */
const CONTEST_MARGIN = 0.25;

/** Below this there is no room to place a word the primary never heard. */
const MIN_INSERT_ROOM_MS = 40;

export interface MergeResult {
  transcript: Transcript;
  /** For the render notes, in the user's language of "what did you do to my video". */
  notes: string[];
  /** Counted for the tests and for anyone wondering whether this is earning its cost. */
  stats: {
    agreed: number;
    contested: number;
    primaryOnly: number;
    secondaryOnly: number;
    inserted: number;
    unchecked: number;
  };
}

/**
 * @param primary   The timing authority. Its segmentation and word boundaries survive.
 * @param secondary The wording authority. Its text wins where the two differ.
 */
export function mergeTranscripts(primary: Transcript, secondary: Transcript, language?: Language): MergeResult {
  const stats = { agreed: 0, contested: 0, primaryOnly: 0, secondaryOnly: 0, inserted: 0, unchecked: 0 };

  const primaryFlat = flatten(primary);
  const secondaryFlat = secondary.segments.flatMap((s) => s.words);

  if (primaryFlat.length === 0 || secondaryFlat.length === 0) {
    return {
      transcript: primary,
      notes: [
        "the second speech model returned nothing usable, so the words were not cross-checked",
      ],
      stats,
    };
  }

  const merged: Placed[] = [];

  for (const chunk of chunkBoth(primaryFlat, secondaryFlat)) {
    if (chunk.primary.length === 0) continue;

    if (chunk.primary.length > MAX_CHUNK_WORDS || chunk.secondary.length > MAX_CHUNK_WORDS) {
      stats.unchecked += chunk.primary.length;
      merged.push(...chunk.primary);
      continue;
    }
    if (chunk.secondary.length === 0) {
      stats.primaryOnly += chunk.primary.length;
      merged.push(...chunk.primary.map(discount));
      continue;
    }

    merged.push(...reconcile(chunk.primary, chunk.secondary, stats));
  }

  const t = sayIn(language);
  const notes: string[] = [];
  if (stats.contested > 0) {
    notes.push(
      t(
        `${stats.contested} word${stats.contested === 1 ? "" : "s"} the two speech models disagreed on ${stats.contested === 1 ? "was" : "were"} resolved in favour of the more accurate one, and the shakiest of them are shown as "…" rather than guessed at`,
        `${stats.contested} كلمة اختلف عليها نموذجا الكلام حُسمت لصالح الأدقّ منهما، وأشدّها اهتزازًا تُعرض "…" بدل تخمينها`,
      ),
    );
  }
  if (stats.unchecked > 0) {
    notes.push(
      t(
        `${stats.unchecked} words came in one unbroken stretch too long to cross-check, so they are as the first model heard them`,
        `${stats.unchecked} كلمة جاءت في دفعة واحدة أطول من أن تُقابَل، فهي كما سمعها النموذج الأول`,
      ),
    );
  }

  return {
    transcript: {
      segments: reassemble(merged, primary.segments),
      language: primary.language ?? secondary.language,
      source: `${primary.source}+${secondary.source}`,
    },
    notes,
    stats,
  };
}

// ─── The comparison itself ───────────────────────────────────────────────────

interface Placed extends TranscriptWord {
  /** Which of the primary's segments this word belongs to. */
  segment: number;
}

function flatten(transcript: Transcript): Placed[] {
  return transcript.segments.flatMap((segment, index) =>
    segment.words.map((word) => ({ ...word, segment: index })),
  );
}

/**
 * Break both streams at the same moments, so alignment runs on minutes of
 * speech rather than hours of it.
 *
 * A split is only taken where *both* readers heard silence. Cutting where only
 * one of them has a gap would put the same word on opposite sides of a
 * boundary in the two streams, and the comparison would report a disagreement
 * that is really a bookkeeping error.
 */
function chunkBoth(
  primary: Placed[],
  secondary: TranscriptWord[],
): Array<{ primary: Placed[]; secondary: TranscriptWord[] }> {
  const splits: number[] = [];
  for (let i = 1; i < primary.length; i += 1) {
    const gap = primary[i].startMs - primary[i - 1].endMs;
    if (gap < SPLIT_GAP_MS) continue;
    const at = primary[i - 1].endMs + gap / 2;
    if (secondary.some((w) => w.startMs < at && w.endMs > at)) continue;
    splits.push(at);
  }

  const chunks: Array<{ primary: Placed[]; secondary: TranscriptWord[] }> = [];
  let from = -Infinity;
  for (const to of [...splits, Infinity]) {
    chunks.push({
      primary: primary.filter((w) => midpoint(w) >= from && midpoint(w) < to),
      secondary: secondary.filter((w) => midpoint(w) >= from && midpoint(w) < to),
    });
    from = to;
  }
  return chunks;
}

const midpoint = (word: { startMs: number; endMs: number }): number => (word.startMs + word.endMs) / 2;

/**
 * Needleman–Wunsch over normalised words.
 *
 * Global rather than local alignment because both sides are transcripts of the
 * same audio: every word should have a partner, and the interesting output is
 * exactly the places where one does not.
 */
function reconcile(primary: Placed[], secondary: TranscriptWord[], stats: MergeResult["stats"]): Placed[] {
  const a = primary.map((w) => normalise(w.text));
  const b = secondary.map((w) => normalise(w.text));

  const rows = a.length + 1;
  const cols = b.length + 1;
  const score = new Int32Array(rows * cols);
  // 0 diagonal, 1 up (primary only), 2 left (secondary only)
  const from = new Uint8Array(rows * cols);

  for (let i = 1; i < rows; i += 1) {
    score[i * cols] = i * SCORE_GAP;
    from[i * cols] = 1;
  }
  for (let j = 1; j < cols; j += 1) {
    score[j] = j * SCORE_GAP;
    from[j] = 2;
  }

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const diagonal = score[(i - 1) * cols + (j - 1)] + (a[i - 1] === b[j - 1] ? SCORE_MATCH : SCORE_MISMATCH);
      const up = score[(i - 1) * cols + j] + SCORE_GAP;
      const left = score[i * cols + (j - 1)] + SCORE_GAP;

      let best = diagonal;
      let direction = 0;
      if (up > best) {
        best = up;
        direction = 1;
      }
      if (left > best) {
        best = left;
        direction = 2;
      }
      score[i * cols + j] = best;
      from[i * cols + j] = direction;
    }
  }

  // Walk the traceback backwards, emit forwards.
  const out: Placed[] = [];
  let i = a.length;
  let j = b.length;
  const pendingInserts: TranscriptWord[] = [];

  const flushInserts = (before: Placed | null, after: Placed | null) => {
    if (pendingInserts.length === 0) return;
    const words = pendingInserts.splice(0, pendingInserts.length).reverse();
    stats.secondaryOnly += words.length;
    out.push(...place(words, before, after, stats));
  };

  while (i > 0 || j > 0) {
    const direction = i === 0 ? 2 : j === 0 ? 1 : from[i * cols + j];

    if (direction === 0) {
      const p = primary[i - 1];
      const s = secondary[j - 1];
      const word = a[i - 1] === b[j - 1] ? agree(p, s, stats) : contest(p, s, stats);
      flushInserts(word, out[out.length - 1] ?? null);
      out.push(word);
      i -= 1;
      j -= 1;
      continue;
    }

    if (direction === 1) {
      const word = discount(primary[i - 1]);
      stats.primaryOnly += 1;
      flushInserts(word, out[out.length - 1] ?? null);
      out.push(word);
      i -= 1;
      continue;
    }

    pendingInserts.push(secondary[j - 1]);
    j -= 1;
  }

  flushInserts(null, out[out.length - 1] ?? null);
  return out.reverse();
}

/**
 * Both readers heard the same word.
 *
 * The combined confidence is the probability that at least one of them is
 * right, treating them as independent — which is the whole argument for paying
 * for two. Two readers at 0.9 give 0.99, not 0.9.
 *
 * The primary's spelling survives even though the secondary is the more
 * accurate reader: at this point they agree on the word, and the primary is
 * the one that returns punctuation and capitalisation.
 */
function agree(primary: Placed, secondary: TranscriptWord, stats: MergeResult["stats"]): Placed {
  stats.agreed += 1;
  return {
    ...primary,
    confidence: round(1 - (1 - clamp(primary.confidence)) * (1 - clamp(secondary.confidence))),
  };
}

/**
 * They heard different words. The better reader's word, the timing authority's
 * clock — unless the primary is far more sure of its own.
 *
 * The secondary is the more accurate reader, so its word normally wins. But when
 * the primary is ahead by more than `CONTEST_MARGIN`, keeping the secondary's
 * word would replace a word the primary was sure of with one it was not — the
 * `Riyadh`-becomes-`Rihanna` case, burned onto the video at the threshold — and
 * would take the secondary's filler judgement with it, dropping a real word. So
 * a clear gap keeps the primary's word and the primary's own filler read; a
 * close call still trusts the reader that is usually right.
 */
function contest(primary: Placed, secondary: TranscriptWord, stats: MergeResult["stats"]): Placed {
  stats.contested += 1;
  const p = clamp(primary.confidence);
  const s = clamp(secondary.confidence);
  const primaryWins = p - s >= CONTEST_MARGIN;
  return {
    ...primary,
    text: primaryWins ? primary.text : carryPunctuation(primary.text, secondary.text),
    filler: isFiller(primaryWins ? primary.text : secondary.text),
    confidence: round(Math.min(p, s) * CONTESTED_TRUST),
  };
}

/** Only one reader heard it at all. */
function discount(word: Placed): Placed {
  return { ...word, confidence: round(clamp(word.confidence) * UNCORROBORATED_TRUST) };
}

/**
 * Words only the secondary heard.
 *
 * These have no place on the primary's clock, so they are fitted into the
 * silence between the words either side of them — never overlapping, and never
 * on top of a word the primary did hear. A word that will not fit is dropped:
 * a caption drawn over its neighbour is a worse outcome than a missing word,
 * and this is the one case where both options are lossy.
 */
function place(
  words: TranscriptWord[],
  before: Placed | null,
  after: Placed | null,
  stats: MergeResult["stats"],
): Placed[] {
  const floor = before?.endMs ?? Math.max(0, words[0].startMs);
  const ceiling = after?.startMs ?? words[words.length - 1].endMs;
  const room = ceiling - floor;
  if (room < MIN_INSERT_ROOM_MS * words.length) return [];

  const each = room / words.length;
  const segment = before?.segment ?? after?.segment ?? 0;

  stats.inserted += words.length;
  return words.map((word, index) => ({
    text: word.text,
    startMs: Math.round(floor + each * index),
    endMs: Math.round(floor + each * (index + 1)),
    confidence: round(clamp(word.confidence) * UNCORROBORATED_TRUST),
    filler: isFiller(word.text),
    segment,
  }));
}

// ─── Putting it back together ────────────────────────────────────────────────

/**
 * The primary's sentence boundaries, refilled.
 *
 * Segmentation is a judgement about where sentences end, made by a model that
 * saw punctuation and pauses together. It is not something to recompute from a
 * word list, so the words move and the shape stays.
 */
function reassemble(words: Placed[], original: TranscriptSegment[]): TranscriptSegment[] {
  const byOriginal = new Map<number, Placed[]>();
  for (const word of words) {
    const list = byOriginal.get(word.segment);
    if (list) list.push(word);
    else byOriginal.set(word.segment, [word]);
  }

  return original
    .map((segment, index) => {
      const inside = (byOriginal.get(index) ?? []).sort((x, y) => x.startMs - y.startMs);
      if (inside.length === 0) return null;
      return {
        ...segment,
        startMs: inside[0].startMs,
        endMs: inside[inside.length - 1].endMs,
        text: inside.map((w) => w.text).join(" ").trim(),
        words: inside.map(({ segment: _segment, ...word }) => word),
      };
    })
    .filter((segment): segment is TranscriptSegment => segment !== null);
}

// ─── Small things ────────────────────────────────────────────────────────────

/**
 * What counts as the same word.
 *
 * Case and punctuation are formatting, not hearing: one model writing "Right,"
 * and the other "right" is agreement, and reporting it as a dispute would
 * flood the notes and mask perfectly good words. Apostrophes go too, so
 * "don't" and "dont" are the same word rather than an argument.
 */
export function normalise(text: string): string {
  return text.replace(/[‘’']/g, "").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
}

/**
 * Take the better reader's word, keep the formatter's punctuation.
 *
 * The secondary usually returns bare words. Dropping the primary's trailing
 * comma or full stop along with its wrong word would leave a caption that
 * reads as one long breathless line.
 */
function carryPunctuation(from: string, word: string): string {
  const trailing = from.match(/[^\p{L}\p{N}]+$/u)?.[0] ?? "";
  const bare = word.replace(/[^\p{L}\p{N}]+$/u, "");
  return bare + trailing;
}

const clamp = (value: number): number => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1);
const round = (value: number): number => Math.round(value * 1000) / 1000;
