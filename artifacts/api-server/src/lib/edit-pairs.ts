/**
 * What the product got wrong, kept so it can be learned from.
 *
 * The asset here is not a model and it is not a library of videos. It is the
 * record of *our own decisions being corrected*: we put a title at twelve
 * seconds for two and a half, the customer made it four; we cut on a 320 ms
 * pause, they wanted 500; we wrote three words and they wrote five. A million
 * of those is a description of editing judgement that nobody can buy, copy or
 * scrape, because it only exists where an editor and a customer disagree.
 *
 * ## The one line that is not crossed
 *
 * Three places in the product say, in the customer's words, that we do not use
 * their **videos** to train models. That sentence is not being edited — it is
 * being built toward, which is what this repository does with a written
 * promise.
 *
 * And it is a sentence about their footage, not about their instructions. The
 * title they typed, the font they chose, the length they asked a card to hold:
 * those are things they told *us*, in our own product, about an edit. What
 * came out of the video is different, and there is exactly one place in a plan
 * where it appears — the burnt caption cues, which are the words their
 * recording said, transcribed. Those become a shape and never a sentence.
 *
 * ## Which is a denylist, and a denylist needs a guard
 *
 * A denylist of field names is correct the day it is written and wrong the day
 * somebody adds one — and nothing fails, because the new field is simply not on
 * the list, so it is kept, for every customer, from that commit onward.
 *
 * So the list below is not the whole protection. `edit-pairs-test` walks the
 * real schema, collects every path in a plan that can hold a string, and fails
 * on any path nobody has classified. Adding a field to the plan is therefore a
 * decision about this file, made deliberately, rather than a default.
 */
import type { EditPlan } from "@workspace/api-zod";

/**
 * The paths in a plan whose value came out of the customer's video.
 *
 * One entry, twice — a cue and the words inside it. These are the transcript,
 * burnt onto the frame: not something anybody typed into this product, but
 * what their recording said. They are the promise on the privacy page, so they
 * become a shape and never a sentence.
 *
 * Paths rather than field names, because `text` is both a title somebody wrote
 * and a word the microphone heard, and only the path tells them apart.
 */
const FROM_THE_VIDEO = new Set(["cues[].text", "cues[].words[].text"]);


/** Roughly which writing system a line is in. Never which words. */
export function scriptOf(text: string): "arabic" | "latin" | "other" | "mixed" {
  const arabic = /[؀-ۿݐ-ݿ]/.test(text);
  const latin = /[A-Za-z]/.test(text);
  if (arabic && latin) return "mixed";
  if (arabic) return "arabic";
  if (latin) return "latin";
  return "other";
}

export interface WordShape {
  words: number;
  characters: number;
  script: ReturnType<typeof scriptOf>;
}

/** The shape of a line, which is everything about it except what it says. */
export function shapeOf(text: string): WordShape {
  const trimmed = text.trim();
  return {
    words: trimmed === "" ? 0 : trimmed.split(/\s+/).length,
    characters: trimmed.length,
    script: scriptOf(trimmed),
  };
}

/* ── Redaction ──────────────────────────────────────────────────────────── */

/**
 * One value, at a known path, with the video taken out of it.
 *
 * Everything else is kept — the words they typed, the font they picked, the id
 * of the asset they reached for. Those are the corrections worth having: "your
 * three words should have been five" is a lesson, and "a string was here" is
 * not.
 */
function redactValue(trail: string, value: unknown): unknown {
  if (typeof value === "string") {
    return FROM_THE_VIDEO.has(trail) ? shapeOf(value) : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const out = value.map((entry) => redactValue(`${trail}[]`, entry)).filter((v) => v !== undefined);
    return out.length > 0 ? out : undefined;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const redacted = redactValue(trail === "" ? k : `${trail}.${k}`, v);
      if (redacted !== undefined) out[k] = redacted;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  // null, undefined, a function somebody put in a plan — none of them is craft.
  return undefined;
}

/**
 * A plan with everything a person wrote taken out of it.
 *
 * Operations keep their order and their `type`, because order is craft: a plan
 * that captions before it cuts is a different plan from one that cuts first.
 */
export function redactPlan(plan: EditPlan): Array<Record<string, unknown>> {
  return plan.operations.map((operation) => {
    const redacted = redactValue("", operation);
    return (redacted && typeof redacted === "object" ? redacted : { type: operation.type }) as Record<string, unknown>;
  });
}

/* ── The change itself ──────────────────────────────────────────────────── */

export interface PlanChange {
  /** The operation type the change is about. */
  op: string;
  /** Which of that type, when a plan has several. */
  index: number;
  /** Dotted path inside the operation, e.g. `durationSeconds` or `box.w`. */
  field: string;
  from: unknown;
  to: unknown;
}

export type ChangeKind = "added" | "removed" | "changed";

export interface EditPair {
  before: Array<Record<string, unknown>>;
  after: Array<Record<string, unknown>>;
  changes: PlanChange[];
  /** Operations the customer added or took away entirely. */
  structure: Array<{ op: string; kind: Exclude<ChangeKind, "changed"> }>;
}

function flatten(value: unknown, prefix: string, into: Map<string, unknown>): void {
  if (value === null || value === undefined) return;
  if (typeof value !== "object") {
    into.set(prefix, value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, i) => flatten(entry, `${prefix}[${i}]`, into));
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    flatten(v, prefix === "" ? k : `${prefix}.${k}`, into);
  }
}

/**
 * What the customer changed, as a list rather than as two documents.
 *
 * Two plans side by side are a thing a person can read and a thing a model
 * cannot learn much from; "they made the title 1.5 seconds longer" is the
 * lesson. The documents are kept as well, because a change means nothing
 * without what it was a change *to* — a title lengthened on a plan with eleven
 * of them is a different correction from the same edit on a plan with one.
 *
 * Operations are matched by type and by their order within that type. That is
 * the only matching available: the plan has no ids, and a customer who deletes
 * the second of three titles has not renamed anything.
 */
export function pairFrom(before: EditPlan, after: EditPlan): EditPair {
  const a = redactPlan(before);
  const b = redactPlan(after);

  const byType = (plan: Array<Record<string, unknown>>): Map<string, Array<Record<string, unknown>>> => {
    const map = new Map<string, Array<Record<string, unknown>>>();
    for (const operation of plan) {
      const type = String(operation["type"] ?? "unknown");
      const list = map.get(type) ?? [];
      list.push(operation);
      map.set(type, list);
    }
    return map;
  };

  const beforeByType = byType(a);
  const afterByType = byType(b);
  const types = new Set([...beforeByType.keys(), ...afterByType.keys()]);

  const changes: PlanChange[] = [];
  const structure: EditPair["structure"] = [];

  for (const type of types) {
    const was = beforeByType.get(type) ?? [];
    const now = afterByType.get(type) ?? [];
    for (let i = 0; i < Math.max(was.length, now.length); i += 1) {
      const from = was[i];
      const to = now[i];
      if (!from && to) {
        structure.push({ op: type, kind: "added" });
        continue;
      }
      if (from && !to) {
        structure.push({ op: type, kind: "removed" });
        continue;
      }
      if (!from || !to) continue;

      const flatA = new Map<string, unknown>();
      const flatB = new Map<string, unknown>();
      flatten(from, "", flatA);
      flatten(to, "", flatB);
      for (const field of new Set([...flatA.keys(), ...flatB.keys()])) {
        if (field === "type") continue;
        const valueA = flatA.get(field);
        const valueB = flatB.get(field);
        if (valueA === valueB) continue;
        changes.push({ op: type, index: i, field, from: valueA ?? null, to: valueB ?? null });
      }
    }
  }

  return { before: a, after: b, changes, structure };
}

/**
 * Whether a pair is worth keeping.
 *
 * A re-render with nothing changed is a customer pressing the button twice, and
 * a row that says "they changed nothing" teaches a model that changing nothing
 * is what editors do. There are a great many more of those than there are real
 * corrections, which is exactly how a training set ends up describing the
 * button instead of the craft.
 */
export function worthKeeping(pair: EditPair): boolean {
  return pair.changes.length > 0 || pair.structure.length > 0;
}
