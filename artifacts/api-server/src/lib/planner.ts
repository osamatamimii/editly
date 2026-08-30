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
import { languageOf, momentsNotHonoured, planFromText, replyFor, type ParsedIntent, type Phrase } from "./plan-from-text";

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
  const tracks = assets.filter((a) => a.kind === "audio").map((a) => a.id);
  const assetIds = [...clips, ...stills, ...tracks];

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
    "grade",
    ...(clips.length > 0 ? ["insertBRoll"] : []),
    ...(stills.length > 0 ? ["overlayImage"] : []),
    // No catalogue: without a track of their own there is nothing to lay under
    // the edit, so the operation is not in the model's vocabulary at all.
    ...(tracks.length > 0 ? ["addMusic"] : []),
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
            "look",
            "placement",
            "punchOn",
            "punchAt",
            "transitionStyle",
            "gainDb",
            "duck",
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
            /**
             * For zoomPunch: what "choose for me" means.
             *
             * The keyword matcher has been able to say this since beat sync was
             * built; without it here, a deployment that *has* a model key is a
             * deployment where "cut it to the beat" quietly becomes ordinary
             * punches on the voice. Two heads that cannot say the same things
             * make the product worse for the people paying for the better one.
             */
            punchOn: { type: ["string", "null"], enum: ["emphasis", "beat", null] },
            /**
             * The exact moments to punch on, in seconds, when the person named
             * them.
             *
             * The renderer has taken a list of seconds here since it was
             * written, and both heads sent an empty one every single time — so
             * "punch in at 0:12" produced punches wherever the speaker happened
             * to lean on a word, and nothing said that the moment had been
             * ignored. The keyword matcher can name moments now; without this
             * the model would be the head that *cannot*, which is the two-heads
             * rule pointing the other way.
             */
            punchAt: { type: ["array", "null"], items: { type: "number" } },
            /**
             * For transition: which join.
             *
             * The instructions have listed these ten since transitions were
             * built, and there was no property here to put the answer in — with
             * `additionalProperties: false` and strict mode the model could not
             * have said "wipeLeft" if it wanted to. The transformer read
             * `raw["style"]`, found nothing every single time, and fell back to
             * the dissolve with a comment explaining that an *unknown* style is
             * coerced. Every style was unknown. Nothing failed; the product
             * simply only ever did one of the ten.
             */
            transitionStyle: {
              type: ["string", "null"],
              enum: [
                "dissolve",
                "wipeLeft",
                "wipeRight",
                "wipeUp",
                "wipeDown",
                "slideLeft",
                "slideRight",
                "slideUp",
                "slideDown",
                "flash",
                null,
              ],
            },
            /**
             * For addMusic: the two knobs the instructions have always
             * described, and which the model has never until now been able to
             * turn. Same shape as the transition style: told about, then
             * forbidden by the schema, so every bed came out at -18 dB and
             * ducking whatever anybody asked for.
             */
            gainDb: { type: ["number", "null"] },
            duck: { type: ["boolean", "null"] },
            /** For grade: the named look. Nothing else is a look we have. */
            look: { type: ["string", "null"], enum: ["warm", "cool", "cinematic", "mono", "punch", null] },
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
  const tracks = assets.filter((a) => a.kind === "audio");

  const lines = [
    "You choose video edit operations from a fixed list. You never invent one.",
    "Choose only what the person asked for, plus what their request obviously requires:",
    "asking for TikTok implies formatForPlatform, asking to tighten implies removeSilence.",
    "Do not add operations because they are usually nice. An edit nobody asked for is an edit nobody wants.",
    "zoomPunch places punch-ins where the speaker stresses a word; the worker finds those, you only ask for it.",
    "extractHighlight keeps only the strongest stretch of the clip. Choose it when they ask for the best part,",
    "a highlight, or the top N seconds. targetSeconds is the length they asked for (default 30); the worker",
    "chooses where those seconds live, from the speech itself. Never choose it for requests about the whole video.",
    "extractRange keeps exactly the stretch the person named. 'from 1:20 to 2:10', 'the first 40 seconds',",
    "'minute two to minute three'. startSeconds and endSeconds are seconds on the source clock; convert",
    "minutes yourself. Choose it only when they name the moments; when they ask for 'the best part', that is",
    "extractHighlight, whose window the worker chooses.",
    "extractClips cuts the video into several separate clips, each its own output. Choose it when they ask",
    "for N clips, to split it into shorts, or for pieces to post separately. clipCount is how many (2-6),",
    "targetSeconds how long each should be. The worker chooses where each clip lives, from the speech.",
    "One clip of the best material is extractHighlight, not extractClips with clipCount 1.",
    "formatForPlatform reframes the picture. tiktok, reels and shorts are the vertical 9:16 feeds; youtube is",
    "widescreen 16:9 for a long-form player; square is 1:1, the shape a feed post shares. Choose the one they",
    "named - 'for YouTube' is widescreen unless they said shorts, which is vertical.",
    "coldOpen builds a hook: it opens the video on its strongest moment and then plays from the top",
    "without it - choose it when they ask for a hook, a cold open, or to start with the best bit.",
    "durationSeconds is how long the opening moment should be (1-15, default 4).",
    "fade opens the video from black and closes it to black. Choose it when they ask for a fade, a fade in or",
    "out, or a soft opening or ending. durationSeconds is how long each fade runs (0.1-2, default 0.5). It never",
    "goes between cuts, only at the ends.",
    "transition is the other one: it joins each cut to the next instead of jumping. style is one of dissolve,",
    "wipeLeft, wipeRight, wipeUp, wipeDown, slideLeft, slideRight, slideUp, slideDown, flash - dissolve mixes the",
    "two shots, a wipe pushes a hard edge across, a slide pushes the whole frame, flash goes through white.",
    "Default dissolve unless they name a shape. durationSeconds is how long each join overlaps (0.08-1, default",
    "0.25). It only does anything when there are cuts to join, so it goes with removeSilence.",
    "If they just say 'transitions' with nothing else, choose fade and a dissolve transition.",
    "autoCaptions takes the words from the video itself; you only choose whether captions are wanted and how they look.",
    "motionTitle animates words onto the screen. Use the person's own words. Never write copy they did not ask for.",
    "titleStyle: card is a full sentence held in the middle; lower-third is a name or label along the bottom;",
    "word is kinetic type, where the words land one after another - choose it when they ask for words that move,",
    "for kinetic or animated text, or for a short punchy line rather than a sentence.",
    "Emojis they typed are their own words: if they ask for emojis and put some in the message, a motionTitle",
    "carrying those emojis is the right answer. If they ask for emojis and typed none, do not choose any.",
    "zoomPunch takes punchAt, a list of seconds, when the person points at moments: 'punch in at 0:12', or a",
    "set of marks they made on the timeline. Use their numbers exactly and convert clock times to seconds.",
    "Leave punchAt null when they did not name any, which means the renderer chooses.",
    "zoomPunch has punchOn: emphasis puts the punches where the speaker leans on a word, beat puts them on the",
    "music instead. Choose beat only when they asked for the cuts to follow the beat, and only when this project",
    "has a track to follow. Otherwise emphasis.",
    "grade sets a named look: warm, cool, cinematic, mono (black and white) or punch. Choose it when they ask",
    "for a look or a colour, and choose the one they named. Cinematic is the teal-and-orange film look, punch is",
    "just more contrast and colour. If they name no look you have, choose no grade rather than guessing at one.",
  ];

  if (clips.length > 0 || stills.length > 0 || tracks.length > 0) {
    lines.push(
      "This project has files of its own, listed with the request. Their ids are the only ones that exist:",
      "an id you have not been given is not a file. Choose one that matches what was asked for, by its label.",
    );
    if (clips.length > 0) lines.push("insertBRoll cuts away to one of their clips and keeps the speaker's audio under it.");
    if (stills.length > 0) lines.push("overlayImage holds one of their images over the frame.");
    if (tracks.length > 0) {
      lines.push(
        "addMusic lays one of their audio files under the whole edit. It has no atSeconds: a bed runs the",
        "length of the finished cut. gainDb is how far under the voice it sits (-40 to 0, default -18) and",
        "duck true pulls it down while they speak. Choose it when they ask for music, a song, a soundtrack or",
        "a bed. If they also want the cuts to follow the music, that is zoomPunch with punchOn beat, alongside",
        "this: it needs a bed to land on, so the two go together.",
      );
    }
  } else {
    lines.push(
      "This project has no files of its own, so there is nothing to cut away to, nothing to lay over the frame,",
      "and no music to put under it.",
      "If they ask for b-roll, a logo or music, return no operation for it. The answer is that they need to add the file first.",
    );
  }

  /**
   * What the product genuinely cannot do — and nothing else.
   *
   * This line used to name emojis, colour grading and cutting in time with a
   * beat. All three were built, and the sentence stayed, so the same prompt
   * both explained `punchOn: beat` and told the model that cutting to a beat
   * was outside the product; explained the five named looks and told it colour
   * grading was outside the product; asked it to carry the person's emojis
   * into a motionTitle and told it emojis were outside the product. A model
   * handed a contradiction resolves it about half the time, which is the
   * shape of bug this codebase keeps finding: nothing fails, some requests
   * quietly come back refused, and the refusal reads like a considered answer.
   *
   * What is left is what the keyword matcher's own list is down to — a colour
   * ask that names no look we have and offers no reference to match.
   */
  lines.push(
    "If the request is about something none of these operations do, return no operations for it rather than",
    "substituting something else. The one that comes up is a colour look nobody has named. 'grade it like",
    "this film', 'make the reds deeper', where the honest answer is that you cannot, because grade only has",
    "the five looks above.",
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
                    ? `Files in this project (id, kind, label):\n${assets
                        .map((a) => `${a.id} | ${a.kind} | ${(a.label ?? "untitled").slice(0, 80)}`)
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
        const operations = pairBeatWithMusic(
          chosen
            .map((raw) => toOperation(raw, context.defaultPlatform ?? null, assets))
            .filter((op): op is EditOperation => op !== null),
          assets,
        );

        // Nothing survived validation: the model answered in a shape we do not
        // recognise. The keyword matcher is a worse answer than a good plan and
        // a much better answer than a plan we had to guess at.
        if (operations.length === 0) {
          return { ...fallback(), degraded: "the planner returned nothing we could execute" };
        }

        // The language is the person's, not the model's: it comes from the
        // sentence they typed, so a model that answers in English about an
        // Arabic ask cannot change what language they are replied to in.
        return {
          operations,
          willDo: describeAll(operations),
          /*
           * The model never refuses, because it only ever picks from operations
           * that exist — so it cannot promise something the worker cannot do,
           * and that is the whole design.
           *
           * A moment is the exception, and the only one. The model can return a
           * perfectly valid plan that happens to consume none of the seconds
           * somebody pointed at, and then nothing anywhere says the moment was
           * dropped. Shared with the matcher rather than written again, so the
           * two heads cannot come to say different things about it.
           */
          cannotYet: momentsNotHonoured(text, operations),
          language: languageOf(text),
          source: "model",
        };
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
   * is not a wrong edit, it is a worker crash. A video handed to addMusic is
   * the same mistake in the other direction.
   */
  const assetOfKind = (kind: "video" | "image" | "audio"): string | null => {
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
        const asked = typeof raw["transitionStyle"] === "string" ? raw["transitionStyle"] : "";
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
      case "zoomPunch": {
        // Empty `at` is the plan saying "you choose" — the worker puts them on
        // the emphasis, which it can only know after hearing the clip, or on
        // the beat of the bed when it was asked for one.
        //
        // Whether a beat punch can land is a question about the *plan*, not
        // about this operation — it depends on whether a bed is under the edit,
        // which is a different operation entirely. It is decided once, in
        // `pairBeatWithMusic`, after everything the model chose is known.
        // Moments the person named, kept only when they are real numbers on a
        // real clock. An empty list still means "you choose".
        const named = Array.isArray(raw["punchAt"])
          ? (raw["punchAt"] as unknown[])
              .map((n) => (typeof n === "number" ? n : Number.NaN))
              .filter((n) => Number.isFinite(n) && n >= 0 && n <= 6 * 3600)
              .sort((a, b) => a - b)
          : [];
        return {
          type,
          /*
           * Kept even when the ask was "on the beat", because the renderer has
           * already decided this question and decided it the other way.
           *
           * `ffmpeg.ts` reaches for the beat grid only `if (on === "beat" &&
           * at.length === 0)` — an explicit moment is more specific than "the
           * beat", so it wins there. Clearing the list here would have been
           * this file quietly overruling the file that actually runs, and the
           * two would have disagreed about the same question with no error
           * anywhere. Worse in the common case: a beat punch with no music
           * under it is demoted to emphasis later, and the moment somebody
           * named would have been thrown away on the way to a placement they
           * never asked for.
           */
          at: named.slice(0, 24),
          amount: numberOr(raw["punchAmount"], 0.13),
          holdMs: 1000,
          on: raw["punchOn"] === "beat" ? "beat" : "emphasis",
        };
      }
      case "normalizeLoudness":
        return { type, targetLufs: -14 };
      case "grade": {
        // No saturation from the model: that number belongs to the reference
        // matcher, which measures it. The model chooses a mood, nothing more.
        const look = raw["look"];
        if (!GRADE_LOOKS.has(look as string)) return null;
        return { type, saturation: 1, look };
      }
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
      case "addMusic": {
        // Same rule as b-roll: the model may pick the track, but only from the
        // ids it was offered, and the kind is checked as well as the id. There
        // is no catalogue to fall back to, so no library means no music.
        const assetId = assetOfKind("audio");
        if (!assetId) return null;
        return {
          type,
          assetId,
          // Clamped rather than rejected, like every other numeric here: "way
          // louder" arriving as 12 becomes 0 rather than a plan the schema
          // would refuse.
          gainDb: Math.min(0, Math.max(-40, numberOr(raw["gainDb"], -18))),
          duck: raw["duck"] !== false,
          // Not the model's to choose, and no longer pretending otherwise.
          // These three were read from a schema that could never carry them,
          // which is a more expensive way of writing a constant: it reads as a
          // knob the model turns and is one nobody can reach. A bed runs the
          // length of the edit from its own beginning and eases in; if any of
          // that ever becomes somebody's decision, it becomes a property here
          // first.
          fadeSeconds: 1.5,
          fromSeconds: 0,
          loop: true,
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

/**
 * A punch on the beat needs a beat to be on.
 *
 * The instructions say so — "it needs a bed to land on, so the two go together"
 * — and an instruction is not a guarantee. A model that chooses `punchOn: beat`
 * and forgets `addMusic` produces a plan the renderer can only answer with a
 * note: there is no music under this edit, so there is nothing to find a beat
 * in, so no punches at all. The person asked for cuts on the beat and got a
 * video with nothing done to it.
 *
 * The keyword matcher has always added the bed itself in exactly this case, so
 * this is also the two-heads rule: the cheap head must not be able to produce
 * an edit the paid head cannot. Whichever chose it, the plan that comes out is
 * the same one.
 *
 * With no track in the project at all, the punch is put back on the speaker's
 * emphasis rather than dropped. That is an edit that works on any footage and
 * it is what the person would have got had they never mentioned the music —
 * and the renderer's notes say what was done either way.
 */
export function pairBeatWithMusic(
  operations: EditOperation[],
  assets: PlannerAsset[],
): EditOperation[] {
  if (!operations.some((op) => op.type === "zoomPunch" && op.on === "beat")) return operations;
  if (operations.some((op) => op.type === "addMusic")) return operations;

  const track = assets.find((asset) => asset.kind === "audio");
  // A plan is at most twelve operations. Adding a thirteenth would fail the
  // whole plan on the way out, which is a worse answer than a punch on the
  // emphasis — so a full plan takes the same road as a project with no track.
  if (!track || operations.length >= MAX_OPERATIONS) {
    return operations.map((op) =>
      op.type === "zoomPunch" && op.on === "beat" ? { ...op, on: "emphasis" as const } : op,
    );
  }
  return [
    {
      type: "addMusic",
      assetId: track.id,
      // The same bed the matcher lays: under the voice, ducked, faded in, from
      // the top of the track, looped to the length of the cut.
      gainDb: -18,
      duck: true,
      fadeSeconds: 1.5,
      fromSeconds: 0,
      loop: true,
    },
    ...operations,
  ];
}

/** What `EditPlan` allows. A thirteenth operation fails the plan, not the operation. */
const MAX_OPERATIONS = 12;

/** The two placement vocabularies, kept apart because the model conflates them. */
const OVERLAY_PLACEMENTS = new Set([
  "top-left", "top-center", "top-right",
  "center",
  "bottom-left", "bottom-center", "bottom-right",
]);
/** The looks the model may name. "none" is absent on purpose: a grade with no
 * look and no saturation is an operation that does nothing, and the model
 * choosing it would be the model saying nothing while appearing to answer. */
const GRADE_LOOKS = new Set(["warm", "cool", "cinematic", "mono", "punch"]);

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

/**
 * The user-facing phrasing, derived from operations so it cannot overpromise.
 *
 * Both languages, for the same reason the matcher's notes carry both: the
 * model path and the keyword path reach the same reply, and one of them
 * answering in English would mean an Arabic speaker's reply changed language
 * depending on whether a key was configured that day.
 */
function describeAll(operations: EditOperation[]): Phrase[] {
  return operations.map((op): Phrase => {
    switch (op.type) {
      case "removeSilence":
        return { en: "cut out the silences and dead air", ar: "أقصّ الصمت والفراغات" };
      case "extractHighlight":
        return {
          en: `pull the strongest ${Math.round(op.targetSeconds)} seconds into its own cut`,
          ar: `أستخرج أقوى ${Math.round(op.targetSeconds)} ثانية في مقطع مستقلّ`,
        };
      case "extractRange":
        return {
          en: `cut it down to ${clock(op.startSeconds)}\u2013${clock(op.endSeconds)}, the stretch you named`,
          ar: `أقصّه إلى ${clock(op.startSeconds)}\u2013${clock(op.endSeconds)}، المدى الذي سمّيته`,
        };
      case "extractClips":
        return {
          en: `cut it into ${op.count} separate clips of about ${Math.round(op.targetSeconds)} seconds each`,
          ar: `أقسّمه إلى ${op.count} مقاطع منفصلة، كلٌّ منها نحو ${Math.round(op.targetSeconds)} ثانية`,
        };
      case "coldOpen":
        return {
          en: `open on the strongest ${Math.round(op.seconds)} seconds, then play the rest from the top`,
          ar: `أفتح على أقوى ${Math.round(op.seconds)} ثوانٍ، ثم يُعرض الباقي من البداية`,
        };
      case "fade":
        return {
          en: `open it from black and close it to black over ${(op.durationMs / 1000).toFixed(1)}s`,
          ar: `أفتحه من السواد وأُغلقه إليه خلال ${(op.durationMs / 1000).toFixed(1)} ثانية`,
        };
      case "transition":
        return op.style === "dissolve"
          ? {
              en: `dissolve between the cuts over ${(op.durationMs / 1000).toFixed(2)}s instead of jumping`,
              ar: `أذوّب بين القصّات خلال ${(op.durationMs / 1000).toFixed(2)} ثانية بدل القفز بينها`,
            }
          : {
              en: `join the cuts with a ${spaced(op.style)} over ${(op.durationMs / 1000).toFixed(2)}s`,
              ar: `أصل القصّات بـ${spaced(op.style)} خلال ${(op.durationMs / 1000).toFixed(2)} ثانية`,
            };
      case "formatForPlatform": {
        const shape = op.platform === "youtube" ? "16:9" : op.platform === "square" ? "1:1" : "9:16";
        return {
          en: `reframe it to ${shape} for ${op.platform}`,
          ar: `أعيد تأطيره ${shape} لـ${op.platform}`,
        };
      }
      case "autoCaptions":
        return { en: "caption it from what is actually said", ar: "أكتب الترجمة من الكلام المنطوق نفسه" };
      case "kenBurns":
        return { en: "add a slow push so the frame is not static", ar: "أضيف حركة بطيئة كي لا تبقى الصورة ثابتة" };
      case "zoomPunch":
        // Two punches, two sentences.
        //
        // `on: "beat"` and the default are different operations wearing one
        // name: one follows the music, the other follows the voice, and the
        // worker decides where each lands from entirely different evidence.
        // This returned the voice sentence for both, so somebody who typed "cut
        // it to the beat", got a beat-synced plan, and had the bed added for
        // them was told "I'll punch in where you lean on a word" — the thing
        // they asked for never named, and if no steady pulse turns up the
        // punches are dropped and that is said only in the render notes.
        //
        // The keyword matcher has said "on the beat of that track rather than
        // on your voice" since beat punches existed. This is the model path, so
        // until now the paid head described the plan *worse* than the free one
        // — the two-heads rule pointing the wrong way.
        return op.on === "beat"
          ? {
              en: "land the punches on the beat of that track rather than on your voice",
              ar: "أُوقع التقريبات على إيقاع تلك المقطوعة بدل صوتك",
            }
          : { en: "punch in where you lean on a word", ar: "أقرّب الصورة عند الكلمات التي تشدّد عليها" };
      case "normalizeLoudness":
        return {
          en: "level the audio to what these platforms expect",
          ar: "أضبط مستوى الصوت على ما تتوقّعه هذه المنصّات",
        };
      case "burnCaptions":
        return { en: "burn in the captions", ar: "أحرق الترجمة في الصورة" };
      case "watermark":
        return { en: "add the watermark", ar: "أضيف العلامة المائية" };
      case "grade":
        // Read back as a promise, so it has to say which of the two it is.
        return op.look === "mono"
          ? { en: "take the colour out", ar: "أنزع اللون" }
          : op.look === "punch"
            ? { en: "push the contrast and the colour", ar: "أرفع التباين واللون" }
            : op.look && op.look !== "none"
              ? { en: `grade it ${op.look}`, ar: `أدرّجه ${op.look}` }
              : { en: "match the colour to your reference", ar: "أطابق اللون مع مرجعك" };
      // The three that put something from the project's library on screen.
      // Phrased by what a person would see rather than by the operation's
      // name, because this list is read back to them as a promise.
      case "insertBRoll":
        return {
          en: `cut away to one of your clips at ${Math.round(op.at)}s`,
          ar: `أقطع إلى أحد مقاطعك عند الثانية ${Math.round(op.at)}`,
        };
      case "addMusic":
        return op.duck
          ? {
              en: "lay your music under the whole edit, ducking out of the way while you talk",
              ar: "أضع موسيقاك تحت التعديل كلّه، تنخفض بينما تتكلّم",
            }
          : { en: "lay your music under the whole edit", ar: "أضع موسيقاك تحت التعديل كلّه" };
      case "overlayImage":
        return {
          en: `hold one of your images over the frame at ${Math.round(op.at)}s`,
          ar: `أثبّت إحدى صورك فوق الكادر عند الثانية ${Math.round(op.at)}`,
        };
      case "motionTitle":
        return {
          en: `bring in the words "${op.text}" at ${Math.round(op.at)}s`,
          ar: `أُدخل عبارة "${op.text}" عند الثانية ${Math.round(op.at)}`,
        };
    }
  });
}

/** "wipeLeft" as "wipe left", which is how both languages name the shapes. */
const spaced = (style: string): string => style.replace(/([A-Z])/g, " $1").toLowerCase();

export { replyFor };
