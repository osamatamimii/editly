/**
 * Notes: one sentence, one moment, and the rule that lets it beat the plan.
 *
 * A prompt describes the whole video and produces a base plan. A note is
 * pinned to an instant — "leave this pause", "push in here" — and has to
 * survive every later prompt and win wherever the two disagree. Those are the
 * two ways to edit this product offers, and they are not two modes: they write
 * to the same plan at different scopes.
 *
 *     plan = base (regenerated from the sentence, thrown away each time)
 *          + notes (kept, applied on top, more specific and therefore final)
 *
 * ## The rule is specificity, and it already had a channel
 *
 * "Cut the silences" and "leave this pause" are not a contradiction to be
 * resolved by whichever arrived last. They compose: cut all of it *except
 * here*. `removeSilence.protect` is exactly that — a list of stretches the cut
 * must not pass through — and until now only the worker's scene reader wrote
 * to it. A human note is a second writer of the same field, which is why this
 * file is short: the mechanism existed and had one author.
 *
 * ## Two verbs, and why only two
 *
 * A verb is only real here if the plan can already say it. These two can:
 *
 *   - **keep** → an entry in `removeSilence.protect`
 *   - **punch** → a time in `zoomPunch.at`
 *
 * Both read the source clock, which is the clock a note is anchored to, so
 * neither needs converting. "Delete 0:30 to 0:45" is the obvious third and is
 * deliberately absent: the schema has no operation that removes a named range
 * — only `extractRange`, which keeps one — so accepting the sentence would
 * mean accepting an instruction nothing can carry out. A note that parses and
 * does nothing is worse than one that is refused, because only the second kind
 * tells anybody.
 */
import type { EditOperation } from "@workspace/api-zod";

/** A note as stored: a moment on the source clock and what was said about it. */
export interface Note {
  sourceMs: number;
  text: string;
}

/**
 * A word from the transcript, on the source clock, in **milliseconds**.
 *
 * Milliseconds because that is the unit a note's anchor is stored in and the
 * unit the stored transcript keeps its words in. The first version of this
 * interface asked for seconds, and the store that fills it read fields that do
 * not exist on a stored segment — so every snap silently fell through to "no
 * transcript" and used the raw click. Nothing errored. One clock, one unit, is
 * what stops that from being possible.
 */
export interface AnchorWord {
  startMs: number;
  endMs: number;
}

/** What a note turned out to mean, or that it meant nothing this layer knows. */
export type NoteVerb = "keep" | "punch" | "join" | "hard" | null;

/*
 * The vocabulary, in both languages, and refusals are not in it.
 *
 * A note is already scoped to a moment, so it has no "no" form to recognise:
 * "don't cut here" *is* the keep verb, and there is nothing for "don't push in
 * here" to override — the base plan does not push in at a moment somebody
 * pointed at. That asymmetry is why this list is shorter than the sentence
 * vocabulary in `plan-from-text.ts`, and it is a property of notes rather than
 * an omission.
 */
const KEEP_WORDS =
  /\bkeep\b|\bleave (?:this|it|that)\b|\bdon'?t (?:cut|remove|trim|touch)\b|\bno cut\b|\bhold (?:this|the pause)\b|\bpause\b|خلّ?ي|اترك|لا تقص|لا تقصّ|ما تقص|بلا قص|خليها|ابقِ|أبقِ|وقفة/i;

const PUNCH_WORDS =
  /\bzoom\b|\bpunch\b|\bpush in\b|\bemphasi[sz]e\b|\bcloser\b|\btighter here\b|قرّب|قرب|كبّر|كبر|زوم|شدّ هنا|أكّد|اكد/i;

/*
 * The two seam verbs, which the plan could not carry until it had a field.
 *
 * These were refused for as long as `transition` described a whole edit and
 * nothing else: "make this one a dissolve" parses easily and there was nowhere
 * to put it, and this file's own rule is that a verb is only real if the plan
 * can already say it. `TransitionOperation.joins` is where it goes now.
 *
 * `hard` is listed first below because it is the one people write more often.
 * Somebody watching an edit that dissolved somewhere they did not want it says
 * so; nobody asks for a dissolve at a seam they have not seen joined wrong.
 */
const HARD_WORDS =
  /\bhard cut\b|\bcut hard\b|\bstraight cut\b|\bno (?:transition|dissolve|fade) here\b|قطع حاد|قطعة حاد|قصّ?ة حاد|بلا انتقال|بدون انتقال|بلا ذوبان/i;

const JOIN_WORDS =
  /\bdissolve\b|\bcross ?fade\b|\bsmooth(?:er)? here\b|\btransition here\b|ذوّب|ذوب هنا|انتقال هنا|نعّم|نعم هنا|وصلة ناعمة/i;

/**
 * What one note means.
 *
 * Order is priority, and it decides the sentences that say more than one thing.
 * `keep` still wins over everything for the reason it always did: getting the
 * punch and losing the pause is a worse outcome than the reverse, and a pause
 * that was cut out is gone without a trace where a missing push-in is visible
 * and can be asked for again.
 *
 * `hard` comes before `join` because "no dissolve here, a hard cut" says both
 * words and means one of them, and the one it means is the refusal. Both come
 * before `punch` because neither vocabulary overlaps it and the order between
 * them is then only about which is checked first.
 */
export function verbOf(text: string): NoteVerb {
  if (KEEP_WORDS.test(text)) return "keep";
  if (HARD_WORDS.test(text)) return "hard";
  if (JOIN_WORDS.test(text)) return "join";
  if (PUNCH_WORDS.test(text)) return "punch";
  return null;
}

/**
 * How much of the source a "keep this" protects, in milliseconds either side.
 *
 * Nine hundred, and the number comes from what people point at. A note is
 * placed on a word, and the thing worth keeping is almost never the word — it
 * is the beat around it, the held breath before the punchline or the silence a
 * demo runs in. Too narrow and the cut takes the pause and leaves the word,
 * which is the exact failure the note was written to prevent; too wide and one
 * note disables silence removal across a whole sentence.
 */
export const KEEP_PADDING_MS = 900;

/**
 * Move an anchor onto the nearest word boundary.
 *
 * A person clicks a word in the transcript and the client sends a millisecond,
 * but the millisecond it sends is wherever the click landed inside that word.
 * Left alone, "keep this" can protect from the middle of a word, and a cut
 * that starts mid-syllable is the sound of a broken video.
 *
 * Nearest **boundary**, not nearest word start: a note placed at the end of a
 * sentence is usually about the pause that follows it, and snapping backwards
 * to the start of the last word would move the protection off the very thing
 * it was pointing at.
 *
 * With no transcript the anchor is used as given. That is the honest fallback
 * — the alternative is inventing a boundary — and it is what a project with no
 * speech in it needs anyway.
 */
export function snapAnchor(sourceMs: number, words: AnchorWord[]): number {
  if (words.length === 0) return Math.max(0, Math.round(sourceMs));
  let best = sourceMs;
  let closest = Infinity;
  for (const word of words) {
    for (const edge of [word.startMs, word.endMs]) {
      const gap = Math.abs(edge - sourceMs);
      if (gap < closest) {
        closest = gap;
        best = Math.round(edge);
      }
    }
  }
  return Math.max(0, best);
}

/** Every note that this layer understood, with what it understood. */
export interface AppliedNote {
  note: Note;
  verb: Exclude<NoteVerb, null>;
  /** The anchor after snapping, which is what actually reached the plan. */
  atMs: number;
}

export interface NotesResult {
  operations: EditOperation[];
  applied: AppliedNote[];
  /** Notes whose sentence this layer has no verb for. Reported, never dropped. */
  unread: Note[];
}

/**
 * Fold the notes into a plan.
 *
 * Additive on purpose: nothing here removes or rewrites an operation the base
 * plan produced. A note narrows what an operation does — protecting a stretch
 * from a cut that still happens everywhere else — or adds a moment to one that
 * takes a list. Rewriting the base would make the result depend on the order
 * the two were written in, and "the same two instructions give a different
 * video depending on which you typed first" is not a rule anybody can hold in
 * their head.
 *
 * A "keep" with no `removeSilence` in the plan does nothing and says so
 * through `unread`... no: it is *applied* and simply has nothing to narrow
 * this time, which is correct — the same note becomes live the moment a later
 * prompt asks for silence to be cut, and that is precisely the persistence
 * these rows exist for.
 */
export function applyNotes(
  operations: EditOperation[],
  notes: Note[],
  words: AnchorWord[] = [],
): NotesResult {
  const applied: AppliedNote[] = [];
  const unread: Note[] = [];

  const keeps: Array<{ startMs: number; endMs: number }> = [];
  const punches: number[] = [];
  /** Seams the notes named, in the shape the contract takes them. */
  const seams: Array<{ sourceMs: number; join: "hard" | "dissolve" }> = [];

  for (const note of notes) {
    const verb = verbOf(note.text);
    if (!verb) {
      unread.push(note);
      continue;
    }
    const atMs = snapAnchor(note.sourceMs, words);
    applied.push({ note, verb, atMs });
    if (verb === "keep") {
      keeps.push({ startMs: Math.max(0, atMs - KEEP_PADDING_MS), endMs: atMs + KEEP_PADDING_MS });
    } else if (verb === "hard" || verb === "join") {
      /* The raw anchor, not the padded one: a seam is an instant and the
         renderer does its own matching against the joins either side of it.
         `KEEP_PADDING_MS` exists because a protected stretch is a stretch;
         this is not one. */
      seams.push({ sourceMs: atMs, join: verb === "hard" ? "hard" : "dissolve" });
    } else {
      punches.push(atMs / 1000);
    }
  }

  const next = operations.map((operation) => {
    if (operation.type === "removeSilence" && keeps.length > 0) {
      /* Union, never replace. The worker's scene reader writes to this same
         field from what it saw on screen, and one writer overwriting the other
         is how a person's own instruction disappears without an error. The cap
         is the schema's. */
      const merged = [...(operation.protect ?? []), ...keeps].slice(0, 60);
      return { ...operation, protect: merged };
    }
    if (operation.type === "transition" && seams.length > 0) {
      /* Union with whatever is already there, for the reason `protect` is a
         union: two writers of one field and one of them overwriting is how a
         person's own instruction disappears without an error. */
      const merged = [...(operation.joins ?? []), ...seams].slice(0, 60);
      return { ...operation, joins: merged };
    }
    if (operation.type === "zoomPunch" && punches.length > 0) {
      const merged = [...(operation.at ?? []), ...punches].slice(0, 40);
      return { ...operation, at: merged };
    }
    return operation;
  });

  /*
   * A punch with nowhere to land gets somewhere to land.
   *
   * "Push in here" on a plan that contains no `zoomPunch` is not a note that
   * failed to parse — it is a person asking for one push-in, and the answer is
   * a `zoomPunch` holding exactly the moments they pointed at. `at` being an
   * explicit list is what stops the renderer from also choosing its own.
   *
   * `keep` gets no equivalent, and the asymmetry is real: protection only
   * means anything against a cut, so a "keep" with no `removeSilence` in the
   * plan is dormant rather than unsatisfied. It becomes live the day a prompt
   * asks for the silences to go, which is the whole reason these are rows.
   */
  if (punches.length > 0 && !next.some((operation) => operation.type === "zoomPunch")) {
    next.push({ type: "zoomPunch", at: punches.slice(0, 40), amount: 0.12, holdMs: 1200, on: "emphasis" });
  }

  /*
   * And a named seam with no transition operation to live in gets one.
   *
   * The same reasoning as the punch, and the same trap avoided: an operation
   * added here with `where: "scenes"` would join every scene change in the
   * video off the back of somebody pointing at one seam, which is not what
   * they asked for and is the more expensive kind of wrong — it changes joins
   * they never mentioned. `named` is the value that means this and nothing
   * else, and it exists for this line.
   *
   * A note that only says "hard" still adds the operation, and it is not
   * pointless: it is the row that keeps the seam hard the day a later prompt
   * asks for transitions everywhere. That is the persistence notes are for.
   */
  if (seams.length > 0 && !next.some((operation) => operation.type === "transition")) {
    next.push({
      type: "transition",
      style: "dissolve",
      durationMs: 250,
      where: "named",
      joins: seams.slice(0, 60),
    });
  }

  return { operations: next, applied, unread };
}
