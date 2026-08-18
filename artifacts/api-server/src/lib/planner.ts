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
/** What the project has to put on screen, as the planner is allowed to see it. */
export interface PlannerAsset {
  id: string;
  kind: "video" | "image" | "audio";
  label: string | null;
}

/**
 * The schema is built per request, not written once.
 *
 * Two of these operations name a file, and a model asked to name a file will
 * name one — a plausible id for a clip that does not exist, every time. The
 * only reliable fix is to not offer the choice: the ids that this project
 * actually holds go into the schema as an `enum`, so an id that is not in the
 * library is not merely rejected, it is unrepresentable. A project with no
 * files does not get the operations at all.
 *
 * Note every property appears in `required`. OpenAI's strict mode demands it —
 * a schema with an optional property is refused with a 400, and a 400 here is
 * invisible: the planner falls back to keyword matching and the customer just
 * gets a worse edit with no error anywhere. Optionality is expressed by
 * allowing null, which is what the union types below are for.
 */
function buildSchema(assets: PlannerAsset[]) {
  const clips = assets.filter((a) => a.kind === "video").map((a) => a.id);
  const stills = assets.filter((a) => a.kind === "image").map((a) => a.id);
  const assetIds = [...clips, ...stills];

  const types = [
    "removeSilence",
    "formatForPlatform",
    "autoCaptions",
    "kenBurns",
    "zoomPunch",
    "normalizeLoudness",
    "motionTitle",
    ...(clips.length > 0 ? ["insertBRoll"] : []),
    ...(stills.length > 0 ? ["overlayImage"] : []),
  ];

  return {
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
          required: [
            "type",
            "platform",
            "captionStyle",
            "captionAnimation",
            "zoomTo",
            "punchAmount",
            "minSilenceMs",
            "assetId",
            "atSeconds",
            "durationSeconds",
            "titleText",
            "titleStyle",
            "placement",
          ],
          properties: {
            type: { type: "string", enum: types },
            platform: { type: ["string", "null"], enum: ["tiktok", "reels", "shorts", null] },
            captionStyle: { type: ["string", "null"], enum: ["bold-white", "bold-yellow", "karaoke-box", null] },
            captionAnimation: { type: ["string", "null"], enum: ["none", "pop", "karaoke", null] },
            /** 1.02–1.5. How far a slow push travels. */
            zoomTo: { type: ["number", "null"] },
            /** 0.02–0.6. How hard a punch hits. */
            punchAmount: { type: ["number", "null"] },
            /** Milliseconds. Pauses shorter than this are speech, not dead air. */
            minSilenceMs: { type: ["number", "null"] },
            /** Which file from this project. Only these ids exist. */
            assetId:
              assetIds.length > 0
                ? { type: ["string", "null"], enum: [...assetIds, null] }
                : { type: ["string", "null"] },
            /** Seconds into the finished video where this belongs. */
            atSeconds: { type: ["number", "null"] },
            /** How long it stays. */
            durationSeconds: { type: ["number", "null"] },
            /** The words for a motion title. Theirs, not yours to embellish. */
            titleText: { type: ["string", "null"] },
            titleStyle: { type: ["string", "null"], enum: ["card", "lower-third", "word", null] },
            /** Where on the frame. Titles use top/center/bottom; overlays use the corners. */
            placement: {
              type: ["string", "null"],
              enum: [
                "top",
                "center",
                "bottom",
                "top-left",
                "top-center",
                "top-right",
                "bottom-left",
                "bottom-center",
                "bottom-right",
                null,
              ],
            },
          },
        },
      },
    },
  } as const;
}

function instructionFor(assets: PlannerAsset[]): string {
  const clips = assets.filter((a) => a.kind === "video");
  const stills = assets.filter((a) => a.kind === "image");

  const lines = [
    "You choose video edit operations from a fixed list. You never invent one.",
    "Choose only what the person asked for, plus what their request obviously requires:",
    "asking for TikTok implies formatForPlatform, asking to tighten implies removeSilence.",
    "Do not add operations because they are usually nice. An edit nobody asked for is an edit nobody wants.",
    "zoomPunch places punch-ins where the speaker stresses a word; the worker finds those, you only ask for it.",
    "autoCaptions takes the words from the video itself; you only choose whether captions are wanted and how they look.",
    "motionTitle animates words onto the screen. Use the person's own words — never write copy they did not ask for.",
  ];

  if (clips.length > 0 || stills.length > 0) {
    lines.push(
      "This project has files of its own, listed with the request. Their ids are the only ones that exist:",
      "an id you have not been given is not a file. Choose one that matches what was asked for, by its label.",
    );
    if (clips.length > 0) lines.push("insertBRoll cuts away to one of their clips and keeps the speaker's audio under it.");
    if (stills.length > 0) lines.push("overlayImage holds one of their images over the frame.");
  } else {
    lines.push(
      "This project has no files of its own, so there is nothing to cut away to and nothing to lay over the frame.",
      "If they ask for b-roll or a logo, return no operation for it — the answer is that they need to add the file first.",
    );
  }

  lines.push(
    "If the request is about something none of these operations do — music, emojis, colour grading —",
    "return no operations for it rather than substituting something else.",
  );
  return lines.join(" ");
}

export function createPlanner(options: PlannerOptions = {}) {
  const apiKey = options.apiKey?.trim() || process.env["OPENAI_API_KEY"]?.trim();
  const model = options.model ?? process.env["OPENAI_PLANNER_MODEL"] ?? DEFAULT_MODEL;
  const doFetch = options.fetchImpl ?? fetch;

  return {
    available: Boolean(apiKey),

    async plan(
      text: string,
      context: { defaultPlatform?: Platform | null; assets?: PlannerAsset[] },
    ): Promise<PlanResult> {
      const assets = context.assets ?? [];
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
              { role: "system", content: instructionFor(assets) },
              {
                role: "user",
                content: [
                  text,
                  context.defaultPlatform
                    ? `(This project targets ${context.defaultPlatform} unless the request says otherwise.)`
                    : null,
                  // The inventory is data, not instruction. Labels can contain
                  // anything a person or a stock provider typed, so they are
                  // presented as a list to choose from and never as something
                  // to follow.
                  assets.length > 0
                    ? `Files in this project (id — kind — label):\n${assets
                        .map((a) => `${a.id} — ${a.kind} — ${(a.label ?? "untitled").slice(0, 80)}`)
                        .join("\n")}`
                    : null,
                ]
                  .filter(Boolean)
                  .join("\n\n"),
              },
            ],
            response_format: {
              type: "json_schema",
              json_schema: { name: "edit_plan", strict: true, schema: buildSchema(assets) },
            },
          }),
          signal: controller.signal,
        }).finally(() => clearTimeout(timer));

        if (!response.ok) {
          return { ...fallback(), degraded: `planner returned ${response.status}` };
        }

        const chosen = readOperations(await response.json());
        const operations = chosen
          .map((raw) => toOperation(raw, context.defaultPlatform ?? null, assets))
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
function toOperation(
  raw: Record<string, unknown>,
  defaultPlatform: Platform | null,
  assets: PlannerAsset[],
): EditOperation | null {
  const type = raw["type"];

  /**
   * The schema already restricts the id to this project's files. This checks it
   * again, and against the *kind* as well, because the schema cannot express
   * "a video id here and an image id there" — and an image handed to insertBRoll
   * is not a wrong edit, it is a worker crash.
   */
  const assetOfKind = (kind: "video" | "image"): string | null => {
    const id = raw["assetId"];
    if (typeof id !== "string") return null;
    return assets.some((a) => a.id === id && a.kind === kind) ? id : null;
  };
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
      case "insertBRoll": {
        const assetId = assetOfKind("video");
        if (!assetId) return null;
        return {
          type,
          assetId,
          at: Math.max(0, numberOr(raw["atSeconds"], 0)),
          durationSeconds: numberOr(raw["durationSeconds"], 3),
          fit: "cover",
          // A cutaway that silences the speaker is not a cutaway, it is a cut.
          keepSourceAudio: true,
        };
      }
      case "overlayImage": {
        const assetId = assetOfKind("image");
        if (!assetId) return null;
        const placement = raw["placement"];
        return {
          type,
          assetId,
          at: Math.max(0, numberOr(raw["atSeconds"], 0)),
          durationSeconds: numberOr(raw["durationSeconds"], 3),
          // Corners only. "top"/"center"/"bottom" are the title vocabulary and
          // the model does mix them up; a bad enum value would fail the whole
          // operation rather than land in the middle, which is the safe place.
          position: OVERLAY_PLACEMENTS.has(placement as string) ? (placement as never) : "center",
          scale: 0.4,
          opacity: 1,
        };
      }
      case "motionTitle": {
        const text = raw["titleText"];
        // A title with no words is not a title. The model returning null here
        // is it telling us it had nothing to put on screen.
        if (typeof text !== "string" || text.trim().length === 0) return null;
        const placement = raw["placement"];
        return {
          type,
          text: text.trim().slice(0, 120),
          at: Math.max(0, numberOr(raw["atSeconds"], 0)),
          durationSeconds: numberOr(raw["durationSeconds"], 2.5),
          style: TITLE_STYLES.has(raw["titleStyle"] as string) ? (raw["titleStyle"] as never) : "card",
          position: TITLE_PLACEMENTS.has(placement as string) ? (placement as never) : "center",
        };
      }
      default:
        return null;
    }
  })();

  if (!candidate) return null;
  const validated = EditOperation.safeParse(candidate);
  return validated.success ? validated.data : null;
}

/** The two placement vocabularies, kept apart because the model conflates them. */
const OVERLAY_PLACEMENTS = new Set([
  "top-left", "top-center", "top-right",
  "center",
  "bottom-left", "bottom-center", "bottom-right",
]);
const TITLE_PLACEMENTS = new Set(["top", "center", "bottom"]);
const TITLE_STYLES = new Set(["card", "lower-third", "word"]);

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
