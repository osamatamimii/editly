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
import { EditOperation, TransitionStyle, type Platform } from "@workspace/api-zod";
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
    "extractHighlight",
    "extractRange",
    "extractClips",
    "coldOpen",
    "fade",
    "transition",
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
            "targetSeconds",
            "startSeconds",
            "endSeconds",
            "clipCount",
            "assetId",
            "atSeconds",
            "durationSeconds",
            "titleText",
            "titleStyle",
            "placement",
          ],
          properties: {
            type: { type: "string", enum: types },
            platform: {
              type: ["string", "null"],
              enum: ["tiktok", "reels", "shorts", "youtube", "square", null],
            },
            captionStyle: { type: ["string", "null"], enum: ["bold-white", "bold-yellow", "karaoke-box", null] },
            captionAnimation: { type: ["string", "null"], enum: ["none", "pop", "karaoke", null] },
            /** 1.02–1.5. How far a slow push travels. */
            zoomTo: { type: ["number", "null"] },
            /** 0.02–0.6. How hard a punch hits. */
            punchAmount: { type: ["number", "null"] },
            /** Milliseconds. Pauses shorter than this are speech, not dead air. */
            minSilenceMs: { type: ["number", "null"] },
            /** Seconds. For extractHighlight: how long the kept stretch should be. */
            targetSeconds: { type: ["number", "null"] },
            /** Seconds. For extractRange: where the named stretch begins. */
            startSeconds: { type: ["number", "null"] },
            /** Seconds. For extractRange: where it ends. */
            endSeconds: { type: ["number", "null"] },
            /** For extractClips: how many pieces to cut. */
            clipCount: { type: ["number", "null"] },
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
    "extractHighlight keeps only the strongest stretch of the clip — choose it when they ask for the best part,",
    "a highlight, or the top N seconds. targetSeconds is the length they asked for (default 30); the worker",
    "chooses where those seconds live, from the speech itself. Never choose it for requests about the whole video.",
    "extractRange keeps exactly the stretch the person named — 'from 1:20 to 2:10', 'the first 40 seconds',",
    "'minute two to minute three'. startSeconds and endSeconds are seconds on the source clock; convert",
    "minutes yourself. Choose it only when they name the moments; when they ask for 'the best part', that is",
    "extractHighlight, whose window the worker chooses.",
    "extractClips cuts the video into several separate clips, each its own output — choose it when they ask",
    "for N clips, to split it into shorts, or for pieces to post separately. clipCount is how many (2-6),",
    "targetSeconds how long each should be. The worker chooses where each clip lives, from the speech.",
    "One clip of the best material is extractHighlight, not extractClips with clipCount 1.",
    "formatForPlatform reframes the picture. tiktok, reels and shorts are the vertical 9:16 feeds; youtube is",
    "widescreen 16:9 for a long-form player; square is 1:1, the shape a feed post shares. Choose the one they",
    "named - 'for YouTube' is widescreen unless they said shorts, which is vertical.",
    "coldOpen builds a hook: it opens the video on its strongest moment and then plays from the top",
    "without it - choose it when they ask for a hook, a cold open, or to start with the best bit.",
    "durationSeconds is how long the opening moment should be (1-15, default 4).",
    "fade opens the video from black and closes it to black — choose it when they ask for a fade, a fade in or",
    "out, or a soft opening or ending. durationSeconds is how long each fade runs (0.1-2, default 0.5). It never",
    "goes between cuts, only at the ends.",
    "transition is the other one: it joins each cut to the next instead of jumping. style is one of dissolve,",
    "wipeLeft, wipeRight, wipeUp, wipeDown, slideLeft, slideRight, slideUp, slideDown, flash - dissolve mixes the",
    "two shots, a wipe pushes a hard edge across, a slide pushes the whole frame, flash goes through white.",
    "Default dissolve unless they name a shape. durationSeconds is how long each join overlaps (0.08-1, default",
    "0.25). It only does anything when there are cuts to join, so it goes with removeSilence.",
    "If they just say 'transitions' with nothing else, choose fade and a dissolve transition.",
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
      // The fallback sees the library too. Without that, a deployment with no
      // model key has the operations, the files and the renderer, and no way
      // for a sentence to reach any of them.
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
      case "extractHighlight":
        // Clamped rather than rejected: "the best 3 minutes" should become
        // the longest highlight we make, not a keyword-matcher fallback.
        return { type, targetSeconds: Math.min(120, Math.max(5, numberOr(raw["targetSeconds"], 30))) };
      case "extractClips":
        // Clamped rather than rejected, like the highlight: "ten clips"
        // becomes six, and a missing count becomes three.
        return {
          type,
          count: Math.min(6, Math.max(2, Math.round(numberOr(raw["clipCount"], 3)))),
          targetSeconds: Math.min(120, Math.max(5, numberOr(raw["targetSeconds"], 30))),
        };
      case "extractRange": {
        // Repaired rather than rejected: an inverted window is re-ordered and
        // a missing end becomes half a minute, because the person plainly
        // wanted *a* stretch — the renderer clamps to the file's real length.
        const a = Math.max(0, numberOr(raw["startSeconds"], 0));
        const b = Math.max(0, numberOr(raw["endSeconds"], a + 30));
        const start = Math.min(a, b);
        const end = Math.max(a, b) > start ? Math.max(a, b) : start + 30;
        return { type, startSeconds: Math.min(start, 86400), endSeconds: Math.min(end, 86400) };
      }
      case "coldOpen":
        return { type, seconds: Math.min(15, Math.max(1, numberOr(raw["durationSeconds"], 4))) };
      case "fade":
        // Seconds from the model, milliseconds in the contract; clamped rather
        // than rejected, like every other numeric the model hands us.
        return {
          type,
          durationMs: Math.min(2000, Math.max(100, Math.round(numberOr(raw["durationSeconds"], 0.5) * 1000))),
        };
      case "transition": {
        // An unknown style is coerced to the dissolve rather than rejected,
        // like every other value a model hands us: the person asked for a
        // transition and a transition is what they get, even when the model
        // invented a name for it.
        const asked = typeof raw["style"] === "string" ? raw["style"] : "";
        const parsed = TransitionStyle.safeParse(asked);
        const style = parsed.success ? parsed.data : "dissolve";
        return {
          type,
          style,
          durationMs: Math.min(1000, Math.max(80, Math.round(numberOr(raw["durationSeconds"], 0.25) * 1000))),
        };
      }
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

/** Seconds as m:ss, because "80s" is a number and "1:20" is a moment. */
function clock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** The user-facing phrasing, derived from operations so it cannot overpromise. */
function describeAll(operations: EditOperation[]): string[] {
  return operations.map((op) => {
    switch (op.type) {
      case "removeSilence": return "cut out the silences and dead air";
      case "extractHighlight": return `pull the strongest ${Math.round(op.targetSeconds)} seconds into its own cut`;
      case "extractRange": return `cut it down to ${clock(op.startSeconds)}\u2013${clock(op.endSeconds)}, the stretch you named`;
      case "extractClips": return `cut it into ${op.count} separate clips of about ${Math.round(op.targetSeconds)} seconds each`;
      case "coldOpen": return `open on the strongest ${Math.round(op.seconds)} seconds, then play the rest from the top`;
      case "fade": return `open it from black and close it to black over ${(op.durationMs / 1000).toFixed(1)}s`;
      case "transition":
        return op.style === "dissolve"
          ? `dissolve between the cuts over ${(op.durationMs / 1000).toFixed(2)}s instead of jumping`
          : `join the cuts with a ${op.style.replace(/([A-Z])/g, " $1").toLowerCase()} over ${(op.durationMs / 1000).toFixed(2)}s`;
      case "formatForPlatform":
        return `reframe it to ${
          op.platform === "youtube" ? "16:9" : op.platform === "square" ? "1:1" : "9:16"
        } for ${op.platform}`;
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
