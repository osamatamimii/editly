/**
 * The last look at a plan before ffmpeg runs it.
 *
 * Everything upstream of here decides what the edit *should* be without being
 * able to see what it will become. The API writes a plan having never opened
 * the file. `enrich` fills in the words and the emphasis, but it reads the
 * original — the file as recorded. And then the renderer cuts the silence out,
 * which changes the length of the video and moves every moment in it.
 *
 * That gap is where the bugs live, and they are all the same bug: a number
 * measured against one timeline being applied to another. Nobody notices,
 * because ffmpeg does exactly what it was told and the output plays fine. It is
 * just wrong — a punch on the wrong word, a caption for a sentence that has
 * been cut, a zoom that magnifies past the pixels we reserved for it.
 *
 * So this module owns the conversion, all of it, in one place. It is the reason
 * the renderer no longer shifts caption times itself: two places knowing about
 * source-versus-edited time is precisely how punches came to be forgotten.
 *
 * It repairs rather than refuses. A render that arrives slightly worse is worth
 * more to someone than a render that did not arrive, so every finding here
 * moves or trims or scales something down and writes a line saying so. The one
 * thing it will not do is leave a decision in place that it knows is wrong.
 */
import type { EditOperation } from "@workspace/api-zod";
import { remapTime, MOTION_OVERSCAN, type Segment, type SpokenWord } from "./timeline";
import { sayIn, countedAr, AR_NOUNS, type Language } from "./say";

export interface CriticInput {
  operations: EditOperation[];
  /** The language the notes come back in. Absent means English. */
  language?: Language;
  /** The kept stretches after silence removal, or null if nothing was cut. */
  kept: Segment[] | null;
  /** Length of the video the viewer will actually receive, in seconds. */
  effectiveDuration: number;
  /**
   * How long each join overlaps, in seconds. Zero for a hard cut.
   *
   * The critic decides where a punch may land, and "where" is a position on
   * the edited clock. A dissolve makes that clock run short by one overlap per
   * join, so a critic reading the un-overlapped clock would guard the wrong
   * splices and reject punches that are comfortably inside the file.
   */
  overlap?: number;
  /**
   * What was said and when, on the source clock, where a transcript exists.
   *
   * Only the fillers are used, and only to answer one question: is this punch
   * landing on "um". A zoom that emphasises a hesitation is worse than no zoom
   * — it tells the viewer to pay attention to the moment the speaker had
   * nothing to say, and it is the kind of mistake that reads as the software
   * not understanding the video rather than as a stylistic choice.
   */
  words?: SpokenWord[];
}

export interface CriticResult {
  operations: EditOperation[];
  /** What was changed and why, in the language the render notes are written in. */
  notes: string[];
}

/**
 * A punch closer than this to a splice reads as a glitch in the cut rather than
 * emphasis on a word — the frame jumps and zooms in the same instant, and the
 * eye attributes both to the edit going wrong.
 */
const SPLICE_GUARD_SECONDS = 0.15;

/** Two punches nearer than this are one punch with a stutter in it. */
const MIN_PUNCH_GAP_SECONDS = 0.9;

/**
 * How far past native resolution a punch may take the frame.
 *
 * Reframing crops to `MOTION_OVERSCAN` of the target and the base zoom scales
 * it back, so a zoom of exactly the overscan is native pixels. Beyond that we
 * are upscaling, and past about a quarter it is visible as softness on a face —
 * which is the one thing a punch-in is supposed to be showing you.
 */
const MAX_UPSCALE = 1.25;

export function criticise(input: CriticInput): CriticResult {
  const t = sayIn(input.language);
  const notes: string[] = [];
  const { kept, effectiveDuration } = input;
  const overlap = input.overlap ?? 0;

  /** Source seconds to edited seconds. Identity when nothing was cut. */
  const toEdited = (seconds: number): number => (kept ? remapTime(seconds, kept, overlap) : seconds);

  /**
   * Did this moment survive the cut?
   *
   * `remapTime` collapses anything inside a removed stretch onto the cut point,
   * which is right for a caption — the words either side of it are still there.
   * For a punch it is wrong: the word that was going to be emphasised is gone,
   * and what remains is a zoom on whatever happened to follow.
   */
  const survived = (seconds: number): boolean => {
    if (!kept) return true;
    return kept.some((segment) => seconds >= segment.start && seconds <= segment.end);
  };

  const operations: EditOperation[] = [];

  // Read the motion operations up front: the zoom ceiling is a property of the
  // pair, not of either one alone.
  const kenBurns = input.operations.find((op) => op.type === "kenBurns");
  const punch = input.operations.find((op) => op.type === "zoomPunch");
  const zoom = capZoom(
    kenBurns?.type === "kenBurns" ? kenBurns.to : null,
    punch?.type === "zoomPunch" ? punch.amount : null,
  );
  if (zoom.note) notes.push(t(zoom.note, zoom.noteAr!));

  for (const operation of input.operations) {
    if (operation.type === "zoomPunch") {
      /**
       * A punch that is going to land on the beat has nothing here to review.
       *
       * Everything below reads `at` as seconds into the *recording* and moves
       * them onto the edited timeline. Beat moments are not on that clock and
       * do not exist yet: they are read off the music, which is laid under the
       * finished edit, so they are chosen after this pass and are already in
       * output time. Passing this through untouched is the only correct thing
       * to do — and it has to be said, because the branch below reads an empty
       * `at` as "every punch was cut" and drops the operation, which is how the
       * first version of beat sync produced a render with no punches and a note
       * explaining that none had survived a cut that never happened.
       */
      if (operation.on === "beat" && operation.at.length === 0) {
        operations.push({ ...operation, amount: zoom.punchAmount ?? operation.amount });
        continue;
      }

      const holdSeconds = operation.holdMs / 1000;
      const original = operation.at.length;

      const lost = operation.at.filter((at) => !survived(at)).length;

      // A punch is emphasis. Emphasising a hesitation is worse than not
      // emphasising anything: it points the viewer at the moment the speaker
      // had nothing to say.
      const onFiller = (seconds: number): boolean =>
        (input.words ?? []).some((word) => word.filler && seconds >= word.start && seconds <= word.end);
      const hesitations = operation.at.filter((at) => survived(at) && onFiller(at)).length;

      const edited = operation.at
        .filter(survived)
        .filter((seconds) => !onFiller(seconds))
        .map(toEdited);
      const settled = settlePunches(edited, { kept, effectiveDuration, overlap, holdSeconds });
      const crowded = settled.crowded;
      let at = settled.at;

      if (lost > 0) {
        notes.push(
          t(
            `${lost} punch${lost === 1 ? "" : "es"} fell in silence that was cut, so ${lost === 1 ? "it was" : "they were"} dropped`,
            `${lost} تقريبة وقعت في صمت مقصوص، فأُسقطت`,
          ),
        );
      }
      const trimmed = original - lost - hesitations - at.length - crowded;
      if (trimmed > 0) {
        notes.push(
          t(
            `${trimmed} punch${trimmed === 1 ? "" : "es"} landed past the end of the edit and ${trimmed === 1 ? "was" : "were"} dropped`,
            `${trimmed} تقريبة وقعت بعد نهاية التعديل فأُسقطت`,
          ),
        );
      }
      if (hesitations > 0) {
        notes.push(
          t(
            `${hesitations} punch${hesitations === 1 ? "" : "es"} would have landed on "um" or "uh", so ${hesitations === 1 ? "it was" : "they were"} dropped`,
            `${hesitations} تقريبة كانت ستقع على تردّد ("أمم" أو "اه")، فأُسقطت`,
          ),
        );
      }
      if (crowded > 0) {
        notes.push(
          t(
            `${crowded} punch${crowded === 1 ? "" : "es"} bunched up once the pauses were cut, so the ${crowded === 1 ? "extra one was" : "extras were"} dropped`,
            `${crowded} تقريبة تكدّست بعد قصّ الوقفات، فأُسقطت الزائدة`,
          ),
        );
      }

      if (at.length === 0) {
        /*
          Two different silences, and they were sharing one sentence.

          "No punch survived the cut" is a claim about a cut. It was printed
          whenever `at` ended up empty — including when it started empty, which
          is what `enrich` leaves behind when there is no transcript to read
          emphasis from: the operation passes through untouched with `at: []`,
          so `original` is zero, nothing was filtered, and nothing was cut.

          The reachable case is ordinary: a deployment with no speech key, or a
          provider answering 500. The customer then read "we could not hear the
          words in this clip this time" followed immediately by "no punch
          survived the cut" — on a render containing no cut at all, which reads
          as a second unrelated failure and is not one.
        */
        notes.push(
          original === 0
            ? t(
                "there was no moment to punch on: emphasis is read from the words, and this render had none to read",
                "لم يكن هناك ما يُقرَّب عليه: التقريبات تُقرأ من الكلمات، وهذا التعديل لم يكن فيه كلمات تُقرأ",
              )
            : t(
                "no punch survived the cut, so the clip is left without them rather than with arbitrary ones",
                "لم تنجُ أي تقريبة من القصّ، فتُرك المقطع بلا تقريبات بدل تقريبات اعتباطية",
              ),
        );
        continue;
      }

      operations.push({ ...operation, at, amount: zoom.punchAmount ?? operation.amount });
      continue;
    }

    if (operation.type === "kenBurns" && zoom.kenBurnsTo != null) {
      operations.push({ ...operation, to: zoom.kenBurnsTo });
      continue;
    }

    if (operation.type === "burnCaptions") {
      const cues = operation.cues
        .map((cue) => ({
          ...cue,
          startMs: toEdited(cue.startMs / 1000) * 1000,
          endMs: toEdited(cue.endMs / 1000) * 1000,
          words: cue.words?.map((word) => ({
            ...word,
            startMs: toEdited(word.startMs / 1000) * 1000,
            endMs: toEdited(word.endMs / 1000) * 1000,
          })),
        }))
        // A cue whose words were entirely inside a removed stretch collapses to
        // zero length. Burning it would flash a caption for a sentence nobody
        // can hear, on the frame where the cut happened.
        .filter((cue) => cue.endMs - cue.startMs >= 1)
        .filter((cue) => cue.startMs / 1000 < effectiveDuration)
        .map((cue) => ({ ...cue, endMs: Math.min(cue.endMs, effectiveDuration * 1000) }));

      const dropped = operation.cues.length - cues.length;
      if (dropped > 0) {
        notes.push(
          t(
            `${dropped} caption${dropped === 1 ? "" : "s"} covered speech that was cut, so ${dropped === 1 ? "it was" : "they were"} removed`,
            `${countedAr(dropped, AR_NOUNS.caption)} ${dropped === 1 ? "كان يغطّي" : "كانت تغطّي"} كلامًا مقصوصًا، ${dropped === 1 ? "فأُزيل" : "فأُزيلت"}`,
          ),
        );
      }

      if (cues.length === 0) {
        notes.push(
          t("every caption belonged to speech that was cut, so none were burned", "كل الكابشنات تخصّ كلامًا مقصوصًا، فلم يُحرق أيّ منها"),
        );
        continue;
      }

      operations.push({ ...operation, cues });
      continue;
    }

    operations.push(operation);
  }

  return { operations, notes };
}

/**
 * Keep the compound zoom inside the pixels reframing reserved.
 *
 * The two motion operations do not know about each other: a slow push to 150%
 * and a 60% punch are each defensible alone and together magnify the frame to
 * well over twice native, which is a soft, crawling mess exactly when the
 * viewer is being asked to look closely. The push is reduced first because it
 * is ambient — losing some of it is barely perceptible, where a punch that has
 * been flattened has stopped doing its job.
 */
function capZoom(
  kenBurnsTo: number | null,
  punchAmount: number | null,
): { kenBurnsTo: number | null; punchAmount: number | null; note?: string; noteAr?: string } {
  if (kenBurnsTo == null && punchAmount == null) return { kenBurnsTo: null, punchAmount: null };

  const base = MOTION_OVERSCAN;
  const ceiling = base * MAX_UPSCALE;

  const peak = (to: number | null, amount: number | null): number =>
    base + (to != null ? (to - 1) * base : 0) + (amount != null ? amount * base : 0);

  if (peak(kenBurnsTo, punchAmount) <= ceiling) {
    return { kenBurnsTo: null, punchAmount: null };
  }

  // Give the push back first, down to a floor where it is still a push.
  let to = kenBurnsTo;
  if (to != null) {
    const room = ceiling - base - (punchAmount != null ? punchAmount * base : 0);
    to = Math.max(1.02, Math.min(to, 1 + room / base));
  }

  let amount = punchAmount;
  if (amount != null && peak(to, amount) > ceiling) {
    const room = ceiling - base - (to != null ? (to - 1) * base : 0);
    amount = Math.max(0.02, room / base);
  }

  const easedPush = to != null && to !== kenBurnsTo;
  const easedPunch = amount != null && amount !== punchAmount;

  /*
    The sentence names what was actually eased back.

    It was one fixed string — "the push and the punches together … so both were
    eased back" — returned whenever anything was capped, and the two inputs are
    independently nullable. A plan with `kenBurns{to: 1.3}` and no `zoomPunch`
    at all exceeds the ceiling on its own and was told its *punches* had been
    eased back, on a render that has none. So was the reverse: `zoomPunch`
    alone at 0.4, which the schema allows up to 0.6. And a plan carrying both
    where only one of them actually moved was told both had.

    Three sentences instead of one, chosen from what changed rather than from
    what was passed in. And nothing is said at all when nothing moved — the
    old shape could return a note beside two nulls.
  */
  if (!easedPush && !easedPunch) return { kenBurnsTo: null, punchAmount: null };

  const note = easedPush && easedPunch
    ? "the push and the punches together would have magnified past the frame we kept, so both were eased back"
    : easedPush
      ? "the slow push would have magnified past the frame we kept, so it was eased back"
      : "the punches would have magnified past the frame we kept, so they were eased back";
  const noteAr = easedPush && easedPunch
    ? "الحركة البطيئة والتقريبات معًا كانت ستكبّر الصورة أبعد من الكادر الذي أبقيناه، فخُفّفت الاثنتان"
    : easedPush
      ? "الحركة البطيئة كانت ستكبّر الصورة أبعد من الكادر الذي أبقيناه، فخُفّفت"
      : "التقريبات كانت ستكبّر الصورة أبعد من الكادر الذي أبقيناه، فخُفّفت";

  return {
    kenBurnsTo: easedPush ? round(to as number) : null,
    punchAmount: easedPunch ? round(amount as number) : null,
    note,
    noteAr,
  };
}

/**
 * Move a punch clear of the nearest splice.
 *
 * Only forward: a punch is emphasis on something about to be said, and pulling
 * it earlier puts it on the word before.
 */
/**
 * The three things a punch has to survive once its time is known.
 *
 * Room to open and close, spacing from its neighbours, and clear of the joins.
 * Written as one function because there are two callers and they were not
 * doing the same thing: the critic applied all three, and the beat placer —
 * which chooses its times *after* the critic has run, from the music — applied
 * none. A beat punch could therefore open half a second before the end of the
 * edit and leave the video ending mid-zoom, or land inside a dissolve, both of
 * which the critic exists to prevent for every punch that arrives another way.
 */
export function settlePunches(
  seconds: readonly number[],
  options: { kept: Segment[] | null; effectiveDuration: number; overlap: number; holdSeconds: number },
): { at: number[]; crowded: number } {
  // A punch needs room to open and close. One that starts with less than its
  // own hold left plays as a zoom that never comes back.
  const inRange = [...seconds]
    .filter((at) => at >= 0 && at + options.holdSeconds <= options.effectiveDuration)
    .sort((a, b) => a - b);

  // Cutting silence pulls moments together: two emphases a second apart in the
  // recording can end up touching once the pause between them is gone.
  const spaced: number[] = [];
  for (const at of inRange) {
    if (spaced.length === 0 || at - spaced[spaced.length - 1]! >= MIN_PUNCH_GAP_SECONDS) spaced.push(at);
  }

  return {
    at: spaced.map((at) => nudgeOffSplice(at, options.kept, options.effectiveDuration, options.overlap)),
    crowded: inRange.length - spaced.length,
  };
}

function nudgeOffSplice(seconds: number, kept: Segment[] | null, limit: number, overlap = 0): number {
  if (!kept || kept.length < 2) return seconds;

  // Where the joins land on the edited clock. With a dissolve a join is not an
  // instant but a stretch, and the guard is measured from where it ends: a
  // punch that opens inside the dissolve is a zoom on two shots at once, which
  // is the very thing the guard exists to prevent.
  let elapsed = 0;
  for (let i = 0; i < kept.length; i += 1) {
    elapsed += kept[i]!.end - kept[i]!.start;
    /*
      Where the join *ends*, which is what the guard is measured from.

      This computed `elapsed - (i + 1) * overlap`, which is where the join
      begins — the renderer's own `offset` for that xfade. So the window sat
      one whole overlap early: it cleared punches out of the stretch *before*
      the dissolve, which needed no clearing, and left the dissolve itself
      open. A punch that opens inside a dissolve is a zoom on two shots at
      once, which is the one thing this function exists to prevent, and with a
      quarter-second dissolve it was landing there by construction.

      The join between piece i and piece i+1 runs from
      `sum(0..i) - (i+1)·overlap` to `sum(0..i) - i·overlap`; the second of
      those is what a punch has to clear.
    */
    const joinEnd = elapsed - i * overlap;
    if (joinEnd - overlap >= limit) break;
    if (seconds > joinEnd - overlap - SPLICE_GUARD_SECONDS && seconds < joinEnd + SPLICE_GUARD_SECONDS) {
      return Math.min(joinEnd + SPLICE_GUARD_SECONDS, limit);
    }
  }
  return seconds;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
