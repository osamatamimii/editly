import type { EditOperation, Platform } from "@workspace/api-zod";
import type { Habit } from "./habits";
import type { PlannerAsset } from "./planner";

/**
 * The edit this material wants, before anybody asks for one.
 *
 * This is the weakness the rest of the product was symptoms of. The planner is
 * a **translator**: every line of its instructions says "choose this when they
 * ask for it", and not one says "this is what a good edit of this material
 * looks like — build it". So the ceiling on the output was the customer's
 * vocabulary. Somebody who knew to type "cut the silences, add captions, punch
 * in on the emphasis, level the audio" got a good edit; somebody who typed
 * "make this good" got nothing at all, and was told so politely.
 *
 * `direct` is the other half. It reads what the material *is* — how long, what
 * shape, whether anybody speaks, where the strong moments are — and produces
 * the plan a competent editor would apply without being asked. The sentence
 * then becomes an **amendment to a decision** rather than the source of one,
 * which is the whole of "one prompt and it starts working on its own".
 *
 * ## Nothing here overrides a person
 *
 * Every rule is skipped when the sentence already spoke about its subject —
 * whichever way it went. "No captions on this one" is a decision about
 * captions, and a direction that adds them anyway is the exact failure this
 * codebase keeps finding: a memory that silently changes what somebody gets.
 * And "cut the silences **only**" turns the whole thing off, because a person
 * who says only means only.
 *
 * ## And nothing here is silent
 *
 * Every operation it adds comes with the sentence that explains it, and those
 * go into the reply. A twelve-operation edit that arrives unannounced is not a
 * feature, it is a product doing things to somebody's video for reasons they
 * cannot see. The rule this file is written under is: **the person should be
 * able to read the reply and predict the video.**
 *
 * ## The thresholds are all on the side of doing less
 *
 * Every guard below refuses rather than guesses. A three-second clip gets
 * nothing; a video with no speech gets no captions; a grade happens only when
 * the person has already chosen one twice, because this product cannot name an
 * unnamed look and will not invent one.
 */

/** A phrase in both languages. The same pair the planner's reply is built from. */
export interface Phrase {
  en: string;
  ar: string;
}

const say = (en: string, ar: string): Phrase => ({ en, ar });

/**
 * What the reading of the video gives this file.
 *
 * A narrowed view of `comprehensions` rather than the whole row: everything
 * here is a *timing*, and a decision that could reach the claims or the
 * chapter titles would be a decision made from a model's prose, which is a
 * different and much less defensible thing to build an edit out of.
 */
export interface Reading {
  /** Where attention is held. Used for the punch-ins, strongest first. */
  peaks: Array<{ start: number; strength: number }>;
  /** The one line this should open on, when there is one. */
  hook: { at: number } | null;
  /** How many subjects the recording moves through. */
  chapters: number;
  /** Whether the reading came from a model or from the shape of the speech. */
  how: "model" | "structure";
}

export interface DirectionInput {
  /** Where this is going. Null when nobody has said, and then nothing is reframed. */
  platform: Platform | null;
  /** The source's length. Null when it was never measured, and then most rules stand down. */
  sourceSeconds: number | null;
  /** Whether anybody speaks. Captions, silence and tightening all rest on it. */
  hasSpeech: boolean;
  reading: Reading | null;
  assets: PlannerAsset[];
  habits: Habit[];
  /** The operation types the sentence itself produced. Never overridden. */
  spokenTypes: ReadonlySet<string>;
  /**
   * Subjects the sentence decided *about*, whichever way it went.
   *
   * The same set `applyHabits` reads, and for the same reason: "no captions"
   * produces no caption operation and is a decision about captions.
   */
  spoke: { platform: boolean; captions: boolean; silence: boolean };
  /** "cut the silences only" — the sentence is the whole plan. */
  onlyWhatWasAsked: boolean;
}

export interface Direction {
  operations: EditOperation[];
  /** One sentence per decision, for the reply. Never shorter than `operations`. */
  willDo: Phrase[];
}

/* ── the thresholds, and why each one is where it is ───────────────────────── */

/**
 * Below this, an edit is the clip.
 *
 * Ten seconds. A hook that somebody shot as a hook does not want silences cut
 * out of it, does not want a cold open lifted from its own middle, and does not
 * want a transition — there is nothing to transition between. Everything that
 * restructures is off below this line; captions and levelling still apply,
 * because those are true of a three-second clip too.
 */
export const SHORTEST_TO_RESTRUCTURE = 10;

/**
 * Above this, a recording is material rather than a video.
 *
 * Three minutes, and the number comes from the other end: the shortest
 * platform this product posts to takes sixty seconds, so anything past three
 * minutes cannot go out whole and the only question is which part goes. Below
 * it, extracting a highlight would be throwing away a video somebody could have
 * posted.
 */
export const LONG_ENOUGH_TO_CLIP = 180;

/** How long a highlight is cut to when one is taken. Under every platform's ceiling. */
export const HIGHLIGHT_SECONDS = 45;

/** The most punch-ins a direction will place, however many peaks the reading found. */
export const MAX_PUNCHES = 6;

/** Peaks below this are not moments, they are the middle of a sentence. */
export const PUNCH_STRENGTH = 0.55;

/** The platforms a phone holds upright, where a landscape source has to be reframed. */
const VERTICAL: ReadonlySet<string> = new Set(["tiktok", "reels", "shorts"]);

/** How many times a habit has to have been chosen before a direction acts on it. */
const HABIT_TIMES = 2;

function habit(habits: Habit[], key: string): string | null {
  const found = habits.find((h) => h.key === key);
  return found && found.times >= HABIT_TIMES ? found.value : null;
}

/**
 * The plan this material wants.
 *
 * Pure: everything it needs is an argument, so the whole table of decisions can
 * be checked without a database, a model or a video. That is deliberate and it
 * is the same rule `upload-policy.ts` follows — a decision that is only
 * checkable end to end is a decision that gets checked once.
 */
export function direct(input: DirectionInput): Direction {
  const operations: EditOperation[] = [];
  const willDo: Phrase[] = [];

  // A person who says "only" means only. Nothing below runs, and that is not a
  // special case bolted on: it is the same respect for an explicit sentence
  // that every other rule here shows, said once at the top.
  if (input.onlyWhatWasAsked) return { operations, willDo };

  const seconds = input.sourceSeconds;
  const known = typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0;
  const longEnoughToRestructure = known && (seconds as number) >= SHORTEST_TO_RESTRUCTURE;
  const vertical = input.platform !== null && VERTICAL.has(input.platform);

  /**
   * Whether anything decided so far actually cuts.
   *
   * Read at the point of use rather than computed once, because three rules
   * below depend on it and they are separated by others that could add a cut.
   * A transition, a change of shot size and a sound effect on a join are all
   * the same claim — that there are joins — and a video that was never cut has
   * none: a dissolve from a shot to itself is invisible, and a quarter of a
   * second of nothing at the front of somebody's video.
   */
  const cutsSoFar = (): boolean =>
    operations.some(
      (op) => op.type === "removeSilence" || op.type === "tighten" || op.type === "extractHighlight",
    );

  const add = (operation: EditOperation, phrase: Phrase): void => {
    if (input.spokenTypes.has(operation.type)) return;
    operations.push(operation);
    willDo.push(phrase);
  };

  /*
    Where it is going, first.

    Everything downstream is measured against the finished frame: a punch-in is
    a fraction of a width, a caption is placed inside a safe area. Deciding the
    shape last would mean deciding everything else against a shape that is about
    to change.

    Skipped when the sentence spoke about the platform at all — including when
    it said not to reframe.
  */
  if (input.platform && !input.spoke.platform) {
    add(
      { type: "formatForPlatform", platform: input.platform },
      say(`frame it for ${input.platform}`, `أؤطّره لـ${input.platform}`),
    );
  }

  /*
    Then the length, because it decides what there is to work on.

    A two-hour recording going to a vertical feed is not a video that needs
    tightening; it is material, and the only honest edit is to take the strongest
    piece. Doing this before the silence cut matters: cutting silence out of two
    hours and *then* taking forty-five seconds spends the whole render on
    material that is thrown away.
  */
  const willClip = known && (seconds as number) >= LONG_ENOUGH_TO_CLIP && vertical && input.hasSpeech;
  if (willClip) {
    add(
      { type: "extractHighlight", targetSeconds: HIGHLIGHT_SECONDS },
      say(
        `take the strongest ${HIGHLIGHT_SECONDS} seconds out of it, because this is longer than the feed takes`,
        `آخذ أقوى ${HIGHLIGHT_SECONDS} ثانية منه، لأنه أطول ممّا يقبله الفيد`,
      ),
    );
  }

  /*
    The first thing any editor does, and the first thing this product ever did.

    Only where somebody speaks: silence detection on a music video is a cut list
    of the quiet bars.
  */
  if (input.hasSpeech && longEnoughToRestructure && !input.spoke.silence) {
    add(
      { type: "removeSilence", thresholdDb: -32, minSilenceMs: 500, paddingMs: 80 },
      say("cut out the silences and dead air", "أقصّ الصمت والفراغات"),
    );
    /*
      And the hesitations, which is the second thing an editor does and the
      first one this product could not do until recently.

      Held to material with enough of it to be worth the risk: under thirty
      seconds a dropped "um" is a noticeable hole rather than a tightening, and
      the cap on how much may be dropped is in `tighten.ts` for the same reason.
    */
    if (known && (seconds as number) >= 30) {
      add(
        { type: "tighten", fillers: true, repeats: true },
        say("and the ums and the restarts", "والترددات والبدايات المكرّرة"),
      );
    }
  }

  /*
    Captions, which are not a decoration on a phone.

    Most short-form video is watched with the sound off, and a talking head with
    no captions is a silent film. The style and the animation are deliberately
    left at their defaults here: `applyHabits` runs after this and fills in what
    this person keeps choosing, which is a better answer than anything this
    function could invent and is announced separately.
  */
  if (input.hasSpeech && !input.spoke.captions) {
    add(
      { type: "autoCaptions", style: "bold-white", animation: "pop", dropFillers: true },
      say("put captions on it, because most of this is watched with the sound off", "أضع كابشنز، لأن أكثره يُشاهَد بلا صوت"),
    );
  }

  /*
    Levelling, always.

    The one operation with no argument against it: a phone recording is quiet, a
    room is loud, and a feed plays everything at the same volume. `voice` only
    when somebody speaks, because the voice curve on music is a filter applied
    to the wrong material.
  */
  add(
    { type: "normalizeLoudness", targetLufs: -14, voice: input.hasSpeech },
    say("level the audio to what the feeds play at", "أضبط مستوى الصوت على ما تشغّله المنصّات"),
  );

  /*
    The punch-ins, and this is the one that could not exist before the video was
    read.

    Where they land used to be a guess about audio density; now it is where the
    reading says attention is held. Strongest first, capped, and only above a
    strength that means "a moment" rather than "the middle of a sentence" — six
    punch-ins in forty-five seconds is an edit, and twenty is a nervous tic.

    Not placed at all when a highlight is being taken: the timings in the
    reading are against the *source*, and the highlight is about to renumber
    every second in the video. A punch at 04:12 of a clip that starts at 04:30
    is a punch that lands nowhere, and nothing about that fails.
  */
  const peaks = (input.reading?.peaks ?? [])
    .filter((p) => p.strength >= PUNCH_STRENGTH && Number.isFinite(p.start) && p.start >= 0)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, MAX_PUNCHES)
    .map((p) => Math.round(p.start * 10) / 10)
    .sort((a, b) => a - b);
  if (peaks.length > 0 && !willClip && longEnoughToRestructure) {
    add(
      { type: "zoomPunch", at: peaks, amount: 0.12, holdMs: 1200, on: "emphasis" },
      say(
        `push in on the ${peaks.length} moments that hold attention`,
        `أقرّب على ${peaks.length} من اللحظات التي تمسك الانتباه`,
      ),
    );
  }

  /*
    The cold open, which is the most designed moment short-form video has.

    Only when the reading found a hook that is not already at the start, only
    for a vertical feed, and only when there is enough video that moving four
    seconds out of the middle leaves a video behind. It moves the moment rather
    than copying it — see the operation — so it is a real edit and not a trailer.
  */
  const hookAt = input.reading?.hook?.at ?? null;
  if (hookAt !== null && hookAt > 6 && vertical && known && (seconds as number) >= 20 && !willClip) {
    add(
      { type: "coldOpen", seconds: 4 },
      say(
        "open on the strongest line instead of on the setup",
        "أبدأ بأقوى جملة بدل المقدّمة",
      ),
    );
  }

  /*
    Two shot sizes, which is the thing every human edit has and this one did not.

    A single camera at a single focal length is what an automatic edit looks
    like; cutting between a wide and a tight version of the same window is what
    a second camera would have given. It costs nothing — the wide size is the
    overscan the renderer already crops and throws away — so the only reason not
    to is that there is nothing to alternate *between*.

    Which is the guard: it needs cuts, and it needs enough of them that a change
    of size reads as coverage rather than as a mistake. Under a minute, with the
    silences taken out, that is one or two joins, and a video that changes size
    once is a video where something went wrong.
  */
  if (cutsSoFar() && known && (seconds as number) >= 60) {
    add(
      { type: "alternateFraming", amount: 0.15 },
      say("cut between a wide and a tight framing, the way a second camera would", "أبدّل بين كادر واسع وآخر ضيّق، كما لو أن هناك كاميرا ثانية"),
    );
  }

  /*
    A join between the pieces, and only when there are pieces.

    A transition on a video that was never cut is a dissolve from a shot to
    itself: invisible, and a quarter of a second of nothing at the front of
    somebody's video. So it is emitted only where something above actually cuts.
  */
  if (cutsSoFar()) {
    add(
      { type: "transition", style: "dissolve", durationMs: 250 },
      say("join the cuts rather than jumping between them", "أصل بين القطع بدل القفز بينها"),
    );
  }

  /*
    And the half of a professional edit that lives in the audio.

    On the cuts, the punches and the opening, quietly. `-12 dB` is under the
    voice rather than beside it: an effect anybody notices as an effect is one
    that was too loud. Held to the vertical feeds, where this reads as
    production; on a long-form talk it reads as a distraction.
  */
  if (vertical && cutsSoFar()) {
    add(
      { type: "soundEffects", gainDb: -12, palette: "clean", onCuts: true, onPunches: true, onOpen: true },
      say("put quiet effects under the cuts and the punches", "أضع مؤثّرات خافتة تحت القطع والتقريبات"),
    );
  }

  /*
    Colour, only when this person has already chosen one twice.

    The product refuses to grade to a look it does not have, by name, in
    `NOT_YET` — so inventing one here would be the product contradicting itself
    in the same request. A habit is not an invention: it is the look they keep
    picking, applied to the video where they did not say it again.
  */
  const look = habit(input.habits, "grade");
  if (look && look !== "none") {
    add(
      { type: "grade", saturation: 1, look: look as never },
      say(`grade it ${look}, the way you usually do`, `أدرّجه ${look}، كما تفعل عادةً`),
    );
  }

  /*
    Music, only from a file this project holds.

    There is no library here and this product will not fetch a track: a piece of
    music laid under somebody's video is a licence taken on their behalf, and
    the one place that is safe is a file they uploaded.
  */
  const track = input.assets.find((a) => a.kind === "audio");
  if (track && longEnoughToRestructure) {
    add(
      { type: "addMusic", assetId: track.id, gainDb: -18, duck: true, fadeSeconds: 1, fromSeconds: 0, loop: true },
      say("lay your track under it, ducked under the voice", "أضع مقطوعتك تحته، خافتة تحت الصوت"),
    );
  }

  /*
    And an ending, because a video that stops mid-frame reads as a file that was
    cut off rather than as a video that finished.
  */
  if (longEnoughToRestructure) {
    add({ type: "fade", durationMs: 500 }, say("fade it out at the end", "أنهيه بتلاشٍ"));
  }

  return { operations, willDo };
}

/**
 * The person's plan, with the direction underneath it.
 *
 * Order matters to nothing in the renderer — it looks operations up by type —
 * so the person's come first for one human reason: the reply is built in this
 * order, and what they asked for should be the first thing it says back.
 *
 * A type appearing on both sides keeps the person's. That cannot happen through
 * `direct`, which already skips what the sentence produced, and it is enforced
 * here anyway: two operations of one type is a plan the renderer resolves by
 * `find`, which silently uses the first and discards the other.
 */
export function withDirection(spoken: EditOperation[], direction: EditOperation[]): EditOperation[] {
  const taken = new Set(spoken.map((op) => op.type));
  return [...spoken, ...direction.filter((op) => !taken.has(op.type))];
}
