/**
 * The model that turns a sentence into an edit plan.
 *
 * This is the head the product has been missing. Everything under it — the
 * renderer, the transcript, the framing, the caption placement — has been
 * waiting for something that can read "make the intro punchier and put captions
 * on it" and choose operations, instead of matching the word "punch".
 *
 * The design constraint is not accuracy. It is that the model must not be able
 * to promise something the worker cannot do. Two rules enforce that, and they
 * are the whole reason this file is small:
 *
 * The model chooses only from operations that exist, in a schema the API
 * enforces at its end, and we re-validate against the real EditOperation union
 * at ours. A plan that fails validation is discarded entirely — not repaired,
 * because a repaired plan is a plan nobody wrote.
 *
 * The reply the user reads is still generated from the operations, never by the
 * model. That is what makes "I'll cut the dead air and caption it" true by
 * construction. A model writing its own summary is a model that can apologise
 * beautifully for work it did not do.
 *
 * When there is no key, when the request fails, or when the answer does not
 * validate, we fall back to the keyword matcher. It is worse, and it is honest,
 * and it means a missing key degrades the product instead of breaking it.
 */
import { EditOperation, type Platform } from "@workspace/api-zod";
import { planFromText, replyFor, type ParsedIntent } from "./plan-from-text";

const ENDPOINT = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-5-mini";

/** A model that thinks for ten seconds about a one-line request is a bug. */
const TIMEOUT_MS = 20_000;

export interface PlannerOptions {
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

export interface PlanResult extends ParsedIntent {
  /** Which path produced this, for the reply and for the logs. */
  source: "model" | "keywords";
  /** Present when the model was tried and could not be used. */
  degraded?: string;
}

/**
 * The operations the model may choose from, spelled out for it rather than
 * derived from the Zod schema. Deriving it would drift silently the day someone
 * adds an operation the renderer cannot do yet; writing it out means adding an
 * operation to the model's vocabulary is a deliberate act.
 */
const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["operations"],
  properties: {
    operations: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type"],
        properties: {
          type: {
            type: "string",
            enum: [
              "removeSilence",
              "formatForPlatform",
              "autoCaptions",
              "kenBurns",
              "zoomPunch",
              "normalizeLoudness",
            ],
          },
          platform: { type: ["string", "null"], enum: ["tiktok", "reels", "shorts", null] },
          captionStyle: { type: ["string", "null"], enum: ["bold-white", "bold-yellow", "karaoke-box", null] },
          captionAnimation: { type: ["string", "null"], enum: ["none", "pop", "karaoke", null] },
          /** 1.02–1.5. How far a slow push travels. */
          zoomTo: { type: ["number", "null"] },
          /** 0.02–0.6. How hard a punch hits. */
          punchAmount: { type: ["number", "null"] },
          /** Milliseconds. Pauses shorter than this are speech, not dead air. */
          minSilenceMs: { type: ["number", "null"] },
        },
      },
    },
  },
} as const;

const INSTRUCTION = [
  "You choose video edit operations from a fixed list. You never invent one.",
  "Choose only what the person asked for, plus what their request obviously requires:",
  "asking for TikTok implies formatForPlatform, asking to tighten implies removeSilence.",
  "Do not add operations because they are usually nice. An edit nobody asked for is an edit nobody wants.",
  "zoomPunch places punch-ins where the speaker stresses a word; the worker finds those, you only ask for it.",
  "autoCaptions takes the words from the video itself; you only choose whether captions are wanted and how they look.",
  "If the request is about something none of these operations do — music, b-roll, emojis, colour grading —",
  "return no operations for it rather than substituting something else.",
].join(" ");

export function createPlanner(options: PlannerOptions = {}) {
  const apiKey = options.apiKey?.trim() || process.env["OPENAI_API_KEY"]?.trim();
  const model = options.model ?? process.env["OPENAI_PLANNER_MODEL"] ?? DEFAULT_MODEL;
  const doFetch = options.fetchImpl ?? fetch;

  return {
    available: Boolean(apiKey),

    async plan(text: string, context: { defaultPlatform?: Platform | null }): Promise<PlanResult> {
      const fallback = (): PlanResult => ({ ...planFromText(text, context), source: "keywords" });
      if (!apiKey) return fallback();

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

        const response = await doFetch(ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: INSTRUCTION },
              {
                role: "user",
                content: context.defaultPlatform
                  ? `${text}\n\n(This project targets ${context.defaultPlatform} unless the request says otherwise.)`
                  : text,
              },
            ],
            response_format: {
              type: "json_schema",
              json_schema: { name: "edit_plan", strict: true, schema: PLAN_SCHEMA },
            },
          }),
          signal: controller.signal,
        }).finally(() => clearTimeout(timer));

        if (!response.ok) {
          return { ...fallback(), degraded: `planner returned ${response.status}` };
        }

        const chosen = readOperations(await response.json());
        const operations = chosen
          .map((raw) => toOperation(raw, context.defaultPlatform ?? null))
          .filter((op): op is EditOperation => op !== null);

        // Nothing survived validation: the model answered in a shape we do not
        // recognise. The keyword matcher is a worse answer than a good plan and
        // a much better answer than a plan we had to guess at.
        if (operations.length === 0) {
          return { ...fallback(), degraded: "the planner returned nothing we could execute" };
        }

        return { operations, willDo: describeAll(operations), cannotYet: [], source: "model" };
      } catch (error) {
        return {
          ...fallback(),
          degraded: error instanceof Error && error.name === "AbortError" ? "the planner timed out" : "the planner is unreachable",
        };
      }
    },
  };
}

function readOperations(payload: unknown): Array<Record<string, unknown>> {
  const root = payload as { choices?: Array<{ message?: { content?: string } }> };
  const content = root.choices?.[0]?.message?.content;
  if (!content) return [];
  try {
    const parsed = JSON.parse(content) as { operations?: Array<Record<string, unknown>> };
    return Array.isArray(parsed.operations) ? parsed.operations : [];
  } catch {
    return [];
  }
}

/**
 * The model's flat choice becomes a real operation, or nothing.
 *
 * Every value goes through the actual schema. The model is a good writer and a
 * poor engineer: it will happily return a zoom of 3.0, and the difference
 * between rejecting that and clamping it is the difference between a plan we
 * can explain and a plan we cannot.
 */
function toOperation(raw: Record<string, unknown>, defaultPlatform: Platform | null): EditOperation | null {
  const type = raw["type"];
  const candidate: Record<string, unknown> | null = (() => {
    switch (type) {
      case "removeSilence":
        return {
          type,
          thresholdDb: -32,
          minSilenceMs: numberOr(raw["minSilenceMs"], 500),
          paddingMs: 80,
        };
      case "formatForPlatform":
        return { type, platform: raw["platform"] ?? defaultPlatform ?? "tiktok" };
      case "autoCaptions":
        return {
          type,
          style: raw["captionStyle"] ?? "bold-white",
          animation: raw["captionAnimation"] ?? "pop",
          dropFillers: true,
        };
      case "kenBurns":
        return { type, to: numberOr(raw["zoomTo"], 1.08) };
      case "zoomPunch":
        // Empty `at` is the plan saying "you choose" — the worker puts them on
        // the emphasis, which it can only know after hearing the clip.
        return { type, at: [], amount: numberOr(raw["punchAmount"], 0.13), holdMs: 1000 };
      case "normalizeLoudness":
        return { type, targetLufs: -14 };
      default:
        return null;
    }
  })();

  if (!candidate) return null;
  const validated = EditOperation.safeParse(candidate);
  return validated.success ? validated.data : null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** The user-facing phrasing, derived from operations so it cannot overpromise. */
function describeAll(operations: EditOperation[]): string[] {
  return operations.map((op) => {
    switch (op.type) {
      case "removeSilence": return "cut out the silences and dead air";
      case "formatForPlatform": return `reframe it to 9:16 for ${op.platform}`;
      case "autoCaptions": return "caption it from what is actually said";
      case "kenBurns": return "add a slow push so the frame is not static";
      case "zoomPunch": return "punch in where you lean on a word";
      case "normalizeLoudness": return "level the audio to what these platforms expect";
      case "burnCaptions": return "burn in the captions";
      case "watermark": return "add the watermark";
      case "grade": return "match the colour to your reference";
      // The three that put something from the project's library on screen.
      // Phrased by what a person would see rather than by the operation's
      // name, because this list is read back to them as a promise.
      case "insertBRoll":
        return `cut away to one of your clips at ${Math.round(op.at)}s`;
      case "overlayImage":
        return `hold one of your images over the frame at ${Math.round(op.at)}s`;
      case "motionTitle":
        return `bring in the words "${op.text}" at ${Math.round(op.at)}s`;
    }
  });
}

export { replyFor };
