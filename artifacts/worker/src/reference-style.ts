/**
 * Editing to match a video someone likes.
 *
 * `style-measure.ts` reads a reference and `styleToSettings` turns the reading
 * into knobs. This is the piece between those and the plan: it decides what a
 * measured look actually changes about an edit, and — as much as anything here
 * — what it does not.
 *
 * The rule it follows is that **a reference adjusts an edit, it does not
 * replace one.** The plan already says what kind of edit this is: whether to
 * cut silence at all, whether there is motion, whether captions are burnt in.
 * Those are the user's decisions and a reference has no opinion about them. It
 * only sets the numbers inside decisions already made. So a plan with no
 * `removeSilence` does not gain one because the reference cuts hard, and a plan
 * with no motion does not sprout a push because the reference is restless.
 *
 * The exception is the grade, which cannot be expressed by any operation the
 * plan would have written for itself, so a `grade` is added when — and only
 * when — the two videos measure differently enough to be worth it.
 *
 * Everything is stated in the notes. "We matched your reference" is not a claim
 * anyone can check; "the reference cuts about 9 times a minute, so pauses over
 * 320ms come out" is.
 */
import type { EditOperation } from "@workspace/api-zod";
import type { StyleProfile, StyleSettings } from "./style-measure";
import { sayIn, type Language } from "./say";

export interface StyleApplication {
  operations: EditOperation[];
  notes: string[];
}

/**
 * Below this the grade is a change nobody would see, and adding an operation
 * for it costs a filter stage and an entry in the notes for nothing.
 */
const GRADE_DEADBAND = 0.04;

/** Punch amounts and hold are the reference's; the count comes from its rhythm. */
const MIN_PUNCHES = 1;

export function applyReferenceStyle(
  operations: EditOperation[],
  settings: StyleSettings,
  context: { reference: StyleProfile; sourceSeconds: number; language?: Language },
): StyleApplication {
  const t = sayIn(context.language);
  const notes: string[] = [];
  const minutes = Math.max(0.1, context.sourceSeconds / 60);
  const out: EditOperation[] = [];

  for (const operation of operations) {
    if (operation.type === "removeSilence") {
      // What the reference was willing to leave in is exactly what we should be
      // willing to leave in. An editor who lets a line breathe and one who cuts
      // on the breath are making the same decision at different thresholds.
      out.push({
        ...operation,
        minSilenceMs: settings.maxSilenceMs,
        paddingMs: settings.leadInMs,
      });
      notes.push(
        t(
          `your reference keeps pauses of about ${settings.maxSilenceMs}ms, so anything longer than that comes out`,
          `مرجعك يُبقي وقفات بنحو ${settings.maxSilenceMs} مللي ثانية، فكل ما طال عن ذلك يخرج`,
        ),
      );
      continue;
    }

    if (operation.type === "kenBurns") {
      out.push({ ...operation, to: settings.kenBurnsTo });
      notes.push(
        t(
          `it cuts about ${round(context.reference.cutsPerMinute)} times a minute, which is ${context.reference.cutsPerMinute > 12 ? "restless" : "calm"} — the push is set to match`,
          `يقصّ نحو ${round(context.reference.cutsPerMinute)} مرّة في الدقيقة، وهذا ${context.reference.cutsPerMinute > 12 ? "إيقاع لا يهدأ" : "إيقاع هادئ"} — فضُبطت الحركة لتطابقه`,
        ),
      );
      continue;
    }

    if (operation.type === "zoomPunch") {
      // The reference's own rhythm decides how many, its motion decides how
      // hard. `at` is emptied rather than computed here: the worker picks the
      // moments from the speech, which is better than spacing them evenly, and
      // this only says how many of them to keep.
      const wanted = Math.max(MIN_PUNCHES, Math.round(settings.punchesPerMinute * minutes));
      const chosen = operation.at.length > 0 ? thin(operation.at, wanted) : [];

      out.push({ ...operation, at: chosen, amount: settings.punchAmount });
      notes.push(
        operation.at.length > wanted
          ? t(
              `its punches land about ${settings.punchesPerMinute} times a minute, so ${operation.at.length - chosen.length} of the ${operation.at.length} we found were left out`,
              `تقريباته تقع نحو ${settings.punchesPerMinute} مرّة في الدقيقة، فتُركت ${operation.at.length - chosen.length} من ${operation.at.length} وجدناها`,
            )
          : t(
              `punch strength set to ${settings.punchAmount} to match how much your reference moves`,
              `ضُبطت قوّة التقريب على ${settings.punchAmount} لتطابق مقدار حركة مرجعك`,
            ),
      );
      continue;
    }

    if (operation.type === "normalizeLoudness") {
      out.push({ ...operation, targetLufs: settings.targetLufs });
      if (context.reference.audioMeasured) {
        notes.push(
          t(
            `levelled to ${round(settings.targetLufs)} LUFS, which is where your reference sits`,
            `سُوّي المستوى إلى ${round(settings.targetLufs)} LUFS، وهو حيث يجلس مرجعك`,
          ),
        );
      }
      continue;
    }

    out.push(operation);
  }

  // A grade already in the plan is the user's, and it wins: the reference is a
  // suggestion, a number someone typed is an instruction.
  const boost = settings.saturationBoost;
  if (operations.some((op) => op.type === "grade")) {
    notes.push(
      t(
        "kept the colour setting already in the plan rather than the reference's",
        "أبقيت إعداد اللون الموجود في الخطّة بدل إعداد المرجع",
      ),
    );
  } else if (Math.abs(boost - 1) >= GRADE_DEADBAND) {
    // No look: the reference decides how much colour, and nothing about mood.
    // Inventing a look here would be putting words in the reference's mouth.
    out.push({ type: "grade", saturation: boost, look: "none" });
    notes.push(
      boost > 1
        ? t(
            `your reference is more saturated than this footage, so the colour is pushed ${percent(boost)} toward it`,
            `مرجعك أكثر تشبّعًا من هذه اللقطة، فدُفع اللون ${percent(boost)} نحوه`,
          )
        : t(
            `your reference is flatter than this footage, so the colour is pulled back ${percent(boost)}`,
            `مرجعك أقلّ تشبّعًا من هذه اللقطة، فسُحب اللون ${percent(boost)}`,
          ),
    );
  }

  return { operations: out, notes };
}

/**
 * Keep `wanted` of these, spread across the clip rather than clustered.
 *
 * Taking the first N would put every punch in the opening minute of a long
 * talk, which reads as an edit that gave up. Taking them at even indices keeps
 * the shape of where the emphasis actually fell.
 */
function thin(at: number[], wanted: number): number[] {
  if (at.length <= wanted) return at;
  if (wanted <= 0) return [];
  const step = at.length / wanted;
  const out: number[] = [];
  for (let i = 0; i < wanted; i += 1) out.push(at[Math.min(at.length - 1, Math.floor(i * step))]);
  return [...new Set(out)];
}

const round = (value: number): number => Math.round(value * 10) / 10;
const percent = (multiplier: number): string => `${Math.round(Math.abs(multiplier - 1) * 100)}%`;
