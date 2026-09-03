/**
 * What this person always asks for, learned from what they actually rendered.
 *
 * Osama named this second of the two things he wanted most: «ان يحفظ الai
 * مدخلات المستخدم المعتادة و اسلوبه». Somebody who has made forty vertical
 * TikTok cuts with karaoke captions in Cairo Black should not have to type
 * "vertical, karaoke captions, Cairo Black" for the forty-first. Their north
 * star for the whole product is one sentence and it starts working; a sentence
 * that has to re-state everything they always want is not one sentence.
 *
 * ## Where the answer comes from
 *
 * From the plans that rendered, not from a settings screen and not from a
 * model asked to summarise a person.
 *
 * A settings screen is a second place to say the same thing, which people fill
 * in once and then contradict with every sentence they type. And a preference
 * somebody *stated* is a worse signal than one they demonstrated eleven times:
 * the plans that rendered are what they actually accepted, at the end of the
 * only process that has their attention.
 *
 * So this is arithmetic over `jobs.plan`. It costs one query, it needs no new
 * table to drift out of step with reality, and it cannot be wrong about what
 * somebody did — only about what it means.
 *
 * ## Why the thresholds are where they are
 *
 * A habit applied wrongly is worse than a habit missed. Missing one costs a
 * few words typed; applying one wrongly puts something in a person's video
 * that they did not ask for and may not notice until it is posted.
 *
 * So: at least four renders showing it, and at least seven in ten of the
 * renders where it *could* have appeared. Four because three is a week of one
 * project and not a way of working. Seven in ten because a person who does it
 * two times out of three is a person with two ways of working, and choosing
 * one of them for them is not knowing them better, it is guessing.
 *
 * The denominator is "renders that could have carried this", never the total.
 * Captions cannot appear in a plan that was only a reframe, and counting those
 * as evidence against would mean the more different things somebody does, the
 * less this knows about any of them.
 *
 * ## And it is always said out loud
 *
 * `applyHabits` fills only what a sentence left silent, and every fill is
 * returned so the reply can name it. A memory that silently changes what a
 * person gets is the exact failure this codebase is written against: the
 * render succeeds, the video is fine, and it is not the video they asked for.
 */
import type { EditOperation, EditPlan, Platform } from "@workspace/api-zod";

/** How far back a habit is read from. A season of work, not a career. */
const RENDERS_READ = 24;

/** The floor, in renders. Three is one busy project; four is a way of working. */
const MIN_TIMES = 4;

/** And the share of the renders that could have shown it. */
const MIN_SHARE = 0.7;

export type HabitKey =
  | "platform"
  | "captions"
  | "captionStyle"
  | "captionAnimation"
  | "latinFont"
  | "arabicFont"
  | "removeSilence"
  | "dropFillers";

export interface Habit {
  key: HabitKey;
  /** The value they keep choosing. A platform name, a style name, a face id. */
  value: string;
  /** How many of the renders that could have carried it, did. */
  times: number;
  /** How many could have. The pair is the evidence, and it is shown. */
  outOf: number;
}

type Caption = Extract<EditOperation, { type: "autoCaptions" | "burnCaptions" }>;

const isCaption = (op: EditOperation): op is Caption =>
  op.type === "autoCaptions" || op.type === "burnCaptions";

/**
 * One question asked of every plan.
 *
 * `of` returns the value that plan chose, or undefined for "this plan is not
 * evidence either way" — which is the difference between the denominator being
 * honest and the whole thing being a count of how varied somebody's work is.
 */
interface Question {
  key: HabitKey;
  of: (plan: EditPlan) => string | undefined;
}

const QUESTIONS: Question[] = [
  {
    // Not "did they reframe" but "to what". A plan with no reframe is silent
    // about the platform rather than a vote against having one.
    key: "platform",
    of: (plan) => {
      const op = plan.operations.find((o) => o.type === "formatForPlatform");
      return op ? ((op as { platform: Platform }).platform as string) : undefined;
    },
  },
  {
    /*
      The only question whose "no" is evidence.

      Every plan could have had captions, so a plan without them is a person
      choosing not to have them — which is exactly the case where assuming
      would be worst. Somebody who captions two videos in ten must not get
      captions on the third.
    */
    key: "captions",
    of: (plan) => (plan.operations.some(isCaption) ? "yes" : "no"),
  },
  {
    key: "captionStyle",
    of: (plan) => plan.operations.find(isCaption)?.style,
  },
  {
    key: "captionAnimation",
    of: (plan) => plan.operations.find(isCaption)?.animation,
  },
  {
    key: "latinFont",
    of: (plan) => (plan.operations.find(isCaption) as { font?: string } | undefined)?.font,
  },
  {
    key: "arabicFont",
    of: (plan) => (plan.operations.find(isCaption) as { fontArabic?: string } | undefined)?.fontArabic,
  },
  {
    key: "removeSilence",
    of: (plan) => (plan.operations.some((o) => o.type === "removeSilence") ? "yes" : "no"),
  },
  {
    key: "dropFillers",
    of: (plan) => {
      /*
        Only `autoCaptions` carries it, and that is not a detail to smooth
        over. `burnCaptions` is handed finished cues by a caller who already
        decided what words are in them, so it has no filler question to answer
        — and reading a missing field as "no" would count every such plan as a
        vote for keeping "um" in.
      */
      const captions = plan.operations.find((o) => o.type === "autoCaptions") as
        | { dropFillers?: boolean }
        | undefined;
      if (!captions) return undefined;
      return captions.dropFillers ? "yes" : "no";
    },
  },
];

/** The habits visible in a set of plans. Pure, so it can be checked without a database. */
export function habitsIn(plans: EditPlan[]): Habit[] {
  const habits: Habit[] = [];
  for (const question of QUESTIONS) {
    const answers = plans.map(question.of).filter((a): a is string => a !== undefined);
    if (answers.length === 0) continue;
    const counts = new Map<string, number>();
    for (const answer of answers) counts.set(answer, (counts.get(answer) ?? 0) + 1);
    // The most common answer, and ties broken by nothing: a tie is not a habit
    // and will fail the share test below anyway.
    const [value, times] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
    if (times < MIN_TIMES) continue;
    if (times / answers.length < MIN_SHARE) continue;
    habits.push({ key: question.key, value, times, outOf: answers.length });
  }
  return habits;
}

/**
 * The same, read from what this person has actually rendered.
 *
 * The database is imported here rather than at the top of the file, and that
 * is not style. Everything above is arithmetic on plans, and a suite that
 * checks the arithmetic should not need a database to import the module —
 * `@workspace/db` throws on import when `DATABASE_URL` is unset. The rules in
 * this file are the dangerous part; the query is the easy part.
 */
export async function habitsFor(userId: string): Promise<Habit[]> {
  const { db, jobsTable } = await import("@workspace/db");
  const { and, desc, eq } = await import("drizzle-orm");
  const rows = await db
    .select({ plan: jobsTable.plan })
    .from(jobsTable)
    .where(and(eq(jobsTable.userId, userId), eq(jobsTable.status, "succeeded")))
    .orderBy(desc(jobsTable.createdAt))
    .limit(RENDERS_READ);
  return habitsIn(rows.map((row) => row.plan as EditPlan));
}

const habitBy = (habits: Habit[], key: HabitKey) => habits.find((h) => h.key === key);

/** What a fill is called when the reply says it happened. */
export interface Applied {
  key: HabitKey;
  value: string;
  en: string;
  ar: string;
}

/**
 * Fill in what the sentence left out, and say what was filled.
 *
 * Only silence is filled. A sentence that mentions captions decides captions,
 * including by saying no — `spoke` is what the parser recognised in the words,
 * and anything in it is untouched here.
 *
 * Nothing here creates a plan out of nothing either: habits are added to a
 * plan that already has operations in it. "Make it vertical" plus a captions
 * habit is a reframe with captions; a sentence that produced no operations at
 * all is a sentence we did not understand, and answering it with somebody's
 * usual edit would be inventing a request.
 */
export function applyHabits(
  operations: EditOperation[],
  habits: Habit[],
  spoke: { platform: boolean; captions: boolean; silence: boolean; music: boolean },
): { operations: EditOperation[]; applied: Applied[] } {
  if (operations.length === 0 || habits.length === 0) return { operations, applied: [] };

  const next = [...operations];
  const applied: Applied[] = [];

  const platform = habitBy(habits, "platform");
  if (!spoke.platform && platform && !next.some((o) => o.type === "formatForPlatform")) {
    next.push({ type: "formatForPlatform", platform: platform.value as Platform });
    applied.push({
      key: "platform",
      value: platform.value,
      // Phrased as the rest of `willDo` is, because that is where it goes:
      // the reply reads "I'll <this>, and <that>". A sentence in a different
      // voice from the ones beside it is how a list stops reading as one.
      en: `reframe it for ${platform.value}, where your edits usually go`,
      ar: `أعيد تأطيره لـ${platform.value}، حيث تذهب تعديلاتك عادةً`,
    });
  }

  const captions = habitBy(habits, "captions");
  if (!spoke.captions && captions?.value === "yes" && !next.some(isCaption)) {
    const style = habitBy(habits, "captionStyle")?.value ?? "bold-white";
    const animation = habitBy(habits, "captionAnimation")?.value ?? "pop";
    const latin = habitBy(habits, "latinFont")?.value;
    const arabic = habitBy(habits, "arabicFont")?.value;
    next.push({
      type: "autoCaptions",
      style,
      animation,
      // The one field with a default rather than a habit: somebody who has
      // never turned filler-dropping off has expressed no view on it, and
      // "um" in a caption is not a thing anybody wants and did not ask for.
      dropFillers: habitBy(habits, "dropFillers")?.value !== "no",
      ...(latin ? { font: latin } : {}),
      ...(arabic ? { fontArabic: arabic } : {}),
    } as EditOperation);
    applied.push({
      key: "captions",
      value: "yes",
      en: "caption it the way you usually have them",
      ar: "أكتب الكابشنز بالشكل الذي تعتاده",
    });
  }

  const silence = habitBy(habits, "removeSilence");
  if (!spoke.silence && silence?.value === "yes" && !next.some((o) => o.type === "removeSilence")) {
    next.push({ type: "removeSilence", thresholdDb: -32, minSilenceMs: 500, paddingMs: 80 });
    applied.push({
      key: "removeSilence",
      value: "yes",
      en: "cut the dead air, which you ask for every time",
      ar: "أقصّ الفراغات، وأنت تطلبها في كل مرّة",
    });
  }

  return { operations: next, applied };
}
