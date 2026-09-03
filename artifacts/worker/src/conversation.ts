/**
 * Cutting clips out of a conversation, which is a different job from cutting
 * them out of a video.
 *
 * `highlight.ts` picks windows by speech density with a hesitation penalty. It
 * is a good measurement and, on a talk between two people, it is answering the
 * wrong question: the strongest forty seconds of an interview is not where the
 * talking was busiest, it is where somebody asked a real question and somebody
 * else answered it. Those two often coincide. When they do not, density wins
 * anyway, and the result is the thing every podcaster says about every
 * automatic clipper — the pieces are *plausible* and never the ones they would
 * have chosen.
 *
 * The material to fix that already exists. `comprehend.ts` reads the transcript
 * into questions with the second their answers begin, claims in the speaker's
 * own words, and the stretches that hold attention; and the transcript, when
 * diarisation is asked for, says who was talking. This module is the part that
 * was missing: turning that into windows.
 *
 * ## What makes a clip good, written down
 *
 * Three rules, and the first is worth more than the other two together.
 *
 * **It opens on a beginning.** A clip that starts with "…and that's why I think"
 * announces in its first second that a machine chose it. So every candidate
 * starts at a real boundary — the beginning of a speaker's turn where we know
 * who is speaking, the far side of a real pause where we do not — and a
 * candidate whose first word is a connective is punished hard enough that it
 * effectively cannot win.
 *
 * **It closes on a landing.** The end moves to the strongest pause inside the
 * length the person asked for, not to `start + thirty seconds`. Which means the
 * length is a *target*, not a promise: a good answer runs thirty-eight seconds
 * or seventy, and cutting it at thirty to honour a number is how a clip loses
 * the line it existed for. The band is deliberately wide and the score prefers
 * the middle of it.
 *
 * **It contains a whole thought.** A question with its answer, a claim with the
 * sentence that set it up, a peak with the turn it happened in. Never a
 * fragment of one, and never so much of the episode that it is not a clip.
 *
 * ## And when there is nothing to read
 *
 * This returns nothing, and the caller falls back to the density chooser and
 * says so in a note. A deployment with no reading is not a deployment that
 * should get worse clips silently — it should get the old ones, and be told.
 */
import { speechBreaks, type SpokenWord } from "./timeline";
import type { NotePair } from "./say";

/** The part of a stored comprehension this needs. Narrowed on purpose. */
export interface Reading {
  questions: Array<{ at: number; quote: string; answeredAt: number | null }>;
  claims: Array<{ at: number; quote: string }>;
  peaks: Array<{ start: number; end: number; why: string; strength: number }>;
  hook: { at: number; quote: string } | null;
}

export interface ConversationClip {
  start: number;
  end: number;
  /** The speaker's own words, never invented copy. Null when nothing fits. */
  title: string | null;
  /** Why this stretch was chosen, for the note the person reads. */
  why: NotePair;
  anchor: "question" | "claim" | "peak";
  score: number;
}

/* ── The numbers, and why each one is where it is ──────────────────────────── */

/**
 * How far the length may stray from what was asked for.
 *
 * Wide on purpose. Somebody asking for "thirty-second clips" of a conversation
 * is describing a shape, not specifying a duration — and the alternative to a
 * band is cutting an answer off at thirty seconds because thirty was the
 * number, which is the single most common way an automatic clip loses the
 * sentence it existed for. The score still prefers the middle of the band, so
 * the ask is honoured wherever the material lets it be.
 */
const SHORTEST = 0.6;
const LONGEST = 1.8;

/** Below this, a clip of a conversation is a soundbite with no context at all. */
const FLOOR_SECONDS = 8;

/** How far back a start may be pulled to reach the beginning of a turn. */
const MAX_LOOKBACK_SECONDS = 14;

/**
 * How much of the window has to be somebody talking.
 *
 * A stretch that is a third speech is a stretch with a long silence in it, and
 * on a conversation that is usually an edit point or dead air rather than a
 * dramatic pause.
 */
const MIN_DENSITY = 0.35;

/**
 * Words that cannot begin a clip.
 *
 * This is a *scoring* list and not a removal list, which is the difference that
 * makes it safe to include ordinary words. «يعني» and «طيب» are real words and
 * are deliberately absent from the filler list for that reason — but a clip
 * whose first word is «يعني» is a clip that started in the middle of somebody's
 * sentence, whatever the word means. The test is position, not vocabulary.
 */
const DANGLING = new Set([
  "and", "so", "but", "because", "which", "that", "then", "also", "or", "well",
  "yeah", "yes", "right", "okay", "ok", "anyway", "actually", "basically", "like",
  "و", "ف", "ثم", "لان", "لأن", "لكن", "بس", "يعني", "طيب", "اذن", "إذن", "او", "أو",
  "اللي", "الذي", "كمان", "برضو", "خلاص", "طب",
]);

const NOT_A_LETTER = /[^\p{L}\p{N}]/gu;
const ARABIC_MARKS = /[ً-ْٰـ]/g;

/** One spelling of a word, so two spellings of the same word are one string. */
function bare(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(ARABIC_MARKS, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/[ىی]/g, "ي")
    .replace(NOT_A_LETTER, "");
}

/* ── Turns, where we know who is talking ───────────────────────────────────── */

export interface Turn {
  start: number;
  end: number;
  speaker: number;
}

/**
 * Maximal runs of one speaker.
 *
 * Built here rather than taken from the transcript's segments because a segment
 * is a breath group — the recogniser splits on pauses as well as on speakers —
 * and the boundary a clip wants is the one where the *other* person stopped.
 * Returns nothing when the transcript carries no speaker labels, which is the
 * normal state on a plan that did not ask for them.
 */
export function turnsOf(words: SpokenWord[]): Turn[] {
  const labelled = words.filter((w) => typeof w.speaker === "number" && w.end > w.start);
  if (labelled.length === 0) return [];
  const turns: Turn[] = [];
  for (const word of labelled) {
    const last = turns[turns.length - 1];
    if (last && last.speaker === word.speaker) last.end = word.end;
    else turns.push({ start: word.start, end: word.end, speaker: word.speaker as number });
  }
  return turns;
}

/* ── Choosing ──────────────────────────────────────────────────────────────── */

export interface ChooseInput {
  reading: Reading;
  words: SpokenWord[];
  duration: number;
  count: number;
  targetSeconds: number;
}

export function chooseConversationClips(input: ChooseInput): ConversationClip[] {
  const { reading, words, duration, count, targetSeconds } = input;
  const spoken = words.filter((w) => w.end > w.start).sort((a, b) => a.start - b.start);
  if (spoken.length === 0 || duration <= 0) return [];

  const shortest = Math.max(FLOOR_SECONDS, targetSeconds * SHORTEST);
  const longest = Math.min(duration, Math.max(shortest + 1, targetSeconds * LONGEST));
  if (duration < shortest) return [];

  const breaks = speechBreaks(spoken);
  const turns = turnsOf(spoken);

  /** The beginning of the thought that contains `at`. */
  const openingBefore = (at: number): { start: number; gap: number; onTurn: boolean } => {
    const turn = turns.find((t) => at >= t.start - 0.01 && at <= t.end + 0.01);
    if (turn && at - turn.start <= MAX_LOOKBACK_SECONDS) {
      return { start: turn.start, gap: Infinity, onTurn: true };
    }
    let best: { at: number; gap: number } | null = null;
    for (const candidate of breaks.starts) {
      if (candidate.at > at + 0.01) continue;
      if (at - candidate.at > MAX_LOOKBACK_SECONDS) continue;
      if (best === null || candidate.at > best.at) best = candidate;
    }
    return best ? { start: best.at, gap: best.gap, onTurn: false } : { start: at, gap: 0, onTurn: false };
  };

  /** The strongest place to stop, inside the band. */
  const landingAfter = (from: number, notBefore: number): { end: number; gap: number } => {
    const low = Math.max(from + shortest, notBefore);
    const high = Math.min(duration, from + longest);
    let best: { at: number; gap: number } | null = null;
    for (const candidate of breaks.ends) {
      if (candidate.at < low || candidate.at > high) continue;
      // Strongest pause wins; among equals the one nearest the ask, so a clip
      // lands on the biggest silence available rather than the first one.
      const target = Math.min(high, from + targetSeconds);
      if (
        best === null ||
        candidate.gap > best.gap + 1e-9 ||
        (Math.abs(candidate.gap - best.gap) < 1e-9 &&
          Math.abs(candidate.at - target) < Math.abs(best.at - target))
      ) {
        best = candidate;
      }
    }
    if (best) return { end: best.at, gap: best.gap };
    /*
      No pause inside the band.

      The tempting answer is `from + longest`, and it is wrong: on the one
      recording where this happens — an answer followed by a long silence — that
      lands the clip's end in dead air, several seconds after anybody stopped
      talking. So the fallback is the last place somebody *did* stop before the
      band runs out, even though it makes the clip shorter than asked for. If
      that is too short, the length floor rejects the candidate, which is the
      honest outcome: this material does not hold a clip of the length that was
      asked for.
    */
    let latest: { at: number; gap: number } | null = null;
    for (const candidate of breaks.ends) {
      if (candidate.at <= from + 0.01 || candidate.at > high) continue;
      if (latest === null || candidate.at > latest.at) latest = candidate;
    }
    return latest ? { end: latest.at, gap: latest.gap } : { end: Math.min(high, duration), gap: 0 };
  };

  const firstWordIn = (start: number, end: number): SpokenWord | undefined =>
    spoken.find((w) => w.start >= start - 0.01 && w.start < end && !w.filler && (w.text ?? "").trim().length > 0);

  const densityIn = (start: number, end: number): number => {
    let value = 0;
    for (const word of spoken) {
      const overlap = Math.min(word.end, end) - Math.max(word.start, start);
      if (overlap > 0 && !word.filler) value += overlap;
    }
    return end > start ? value / (end - start) : 0;
  };

  const turnsInside = (start: number, end: number): number =>
    turns.filter((t) => t.start >= start - 0.01 && t.end <= end + 0.01).length;

  const candidates: ConversationClip[] = [];

  const consider = (
    anchorAt: number,
    notBefore: number,
    anchor: ConversationClip["anchor"],
    base: number,
    why: NotePair,
    title: string | null,
  ): void => {
    const opening = openingBefore(anchorAt);
    const landing = landingAfter(opening.start, notBefore);
    const start = Math.max(0, opening.start);
    const end = Math.min(duration, landing.end);
    const length = end - start;
    if (length < shortest - 0.01) return;

    const density = densityIn(start, end);
    if (density < MIN_DENSITY) return;

    const first = firstWordIn(start, end);
    const dangling = first ? DANGLING.has(bare(first.text ?? "")) : false;

    /*
      The score, and the shape of it.

      Every term but the first is about *edges*, because the edges are what a
      person notices. A clip that opens mid-sentence is wrong in its first
      second; a clip that ends mid-sentence is wrong in its last. Content
      decides which stretches are worth looking at, and craft decides where
      they start and stop.
    */
    const openness = opening.onTurn ? 1 : Math.min(opening.gap, 2) / 2;
    const closing = Math.min(landing.gap, 2) / 2;
    const fit = 1 - Math.min(1, Math.abs(length - targetSeconds) / Math.max(1, targetSeconds));
    const wholeTurns = Math.min(2, turnsInside(start, end)) / 2;

    const score =
      base +
      openness * 0.6 +
      closing * 0.4 +
      fit * 0.5 +
      density * 0.4 +
      wholeTurns * 0.3 -
      // Large enough that a dangling opening cannot be bought back by a strong
      // anchor. This is the tell every podcaster names first.
      (dangling ? 1.5 : 0);

    candidates.push({ start, end, title, why, anchor, score });
  };

  /*
    A question and its answer, which is the shape of a podcast clip.

    `notBefore` is the answer's own start plus a few seconds: a clip that
    contains the question and stops before the answer has said anything is
    worse than no clip, because it looks complete.
  */
  for (const question of reading.questions) {
    if (!Number.isFinite(question.at)) continue;
    const answered = question.answeredAt !== null && Number.isFinite(question.answeredAt);
    consider(
      question.at,
      answered ? (question.answeredAt as number) + 6 : 0,
      "question",
      answered ? 1.6 : 1.15,
      answered
        ? {
            en: "opens on the question and runs to where the answer lands",
            ar: "يبدأ عند السؤال ويمتدّ إلى حيث يستقرّ الجواب",
          }
        : {
            en: "opens on a question that was asked out loud",
            ar: "يبدأ عند سؤال قيل بصوت مسموع",
          },
      shorten(question.quote),
    );
  }

  /*
    A claim, with whatever came before it.

    A number or an assertion lands because of the sentence that set it up, so
    the start is the opening of the thought the claim is *in* rather than the
    claim's own second — which `openingBefore` already does, and is the reason
    it looks back as far as it does.
  */
  for (const claim of reading.claims) {
    if (!Number.isFinite(claim.at)) continue;
    consider(
      claim.at,
      claim.at + 3,
      "claim",
      1.25,
      { en: "built around something the speaker asserted", ar: "مبنيّ حول شيء ادّعاه المتحدّث" },
      shorten(claim.quote),
    );
  }

  for (const peak of reading.peaks) {
    if (!Number.isFinite(peak.start)) continue;
    consider(
      peak.start,
      Number.isFinite(peak.end) ? peak.end : peak.start + 2,
      "peak",
      0.7 + Math.max(0, Math.min(1, peak.strength)) * 0.7,
      { en: "one of the moments that holds attention", ar: "إحدى اللحظات التي تمسك الانتباه" },
      null,
    );
  }

  if (candidates.length === 0) return [];

  /*
    Greedy, with a spacing rule, then greedy again without it.

    The spacing exists because the strongest three moments of a ninety-minute
    episode are frequently the same five minutes of it, and three clips from one
    exchange is one clip posted three times. Relaxing it on a second pass rather
    than lowering it from the start means a short recording — where spacing is
    impossible — still returns the pieces it has instead of returning fewer than
    were asked for on a rule that was about long ones.
  */
  const spacing = Math.min(120, duration / Math.max(2, count * 4));
  const ordered = [...candidates].sort((a, b) => b.score - a.score || a.start - b.start);

  const take = (minGap: number, into: ConversationClip[]): void => {
    for (const candidate of ordered) {
      if (into.length >= count) return;
      const clashes = into.some(
        (taken) =>
          candidate.start < taken.end + minGap && candidate.end + minGap > taken.start,
      );
      if (!clashes) into.push(candidate);
    }
  };

  const chosen: ConversationClip[] = [];
  take(spacing, chosen);
  if (chosen.length < count) take(0, chosen);

  chosen.sort((a, b) => a.start - b.start);
  return chosen;
}

/** A quote cut to the length of a title, at a word, with an ellipsis if cut. */
function shorten(quote: string, max = 56): string | null {
  const text = (quote ?? "").replace(/\s+/g, " ").trim();
  if (text.length === 0) return null;
  if (text.length <= max) return text;
  const parts: string[] = [];
  for (const word of text.split(" ")) {
    if ([...parts, word].join(" ").length > max) break;
    parts.push(word);
  }
  return parts.length > 0 ? `${parts.join(" ")}…` : null;
}
