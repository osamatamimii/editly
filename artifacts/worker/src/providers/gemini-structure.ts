/**
 * Reading the transcript for what it *means*.
 *
 * This is the cheapest model call in the product and the one that changes the
 * most. It sends no media at all — the words and their timestamps, as text —
 * and asks a single question: what is this material made of? Where does one
 * part end, what did the person actually assert, what did they ask, which
 * stretches are the reason anybody would watch, and which sentence is the one
 * to open on.
 *
 * ## Why text and not video
 *
 * `gemini.ts` exists next door and uploads a proxy of the file, because what it
 * is asking about is visual. Nothing here is. A chapter boundary, a claim, a
 * question and its answer are all in the words, and the transcript is already
 * paid for by the time this runs. Sending frames as well would multiply the
 * cost of the answer by a hundred to add nothing to it — a ninety-minute
 * podcast is a few tens of thousands of tokens as text and several million as
 * video.
 *
 * ## What this deliberately does not do
 *
 * It does not decide anything. It answers with times and quotes, and every one
 * of those is treated as a proposal that has to survive `comprehend.ts`:
 * timestamps are re-derived from the words' own clock, and a quote that does
 * not appear in the transcript is dropped on the floor. A model reading a
 * ninety-second clip will place a chapter at three minutes without hesitating,
 * and it will attribute a sentence to someone who never said it — neither of
 * those throws, neither logs, and both produce an edit that is confidently
 * about something that did not happen. So this file's job ends at "here is what
 * it said", and nothing downstream is allowed to trust that directly.
 */
import type { StructureRead, StructureReadOptions, StructureReader } from "./types";
import { withDeadline } from "./deadline";

const API_ROOT = "https://generativelanguage.googleapis.com";
const DEFAULT_MODEL = "gemini-flash-lite-latest";

/**
 * A hard ceiling on what this file will put in one request. A backstop, not the
 * budget.
 *
 * The budget is `TRANSCRIPT_BUDGET_CHARS` in `comprehend.ts`, which thins a
 * long transcript — merging adjacent lines, coarsening the timestamps — so that
 * the reading is still of the whole video. This number exists only so that a
 * caller which ignores that cannot send a gigabyte, and it is deliberately not
 * a second opinion about how much material a reading should cover.
 *
 * Why thinning and not windowing, which is what `gemini.ts` does next door:
 * scene reading is *local* — a shot change is understood without knowing what
 * happened forty minutes earlier — and structure is the opposite. A chapter
 * boundary is only a boundary relative to the whole, so a three-hour podcast
 * read in ten-minute windows returns eighteen unrelated openings and eighteen
 * hooks.
 */
export const MAX_TRANSCRIPT_CHARS = 200_000;

export interface GeminiStructureOptions {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    chapters: {
      type: "array",
      items: {
        type: "object",
        properties: {
          startSeconds: { type: "number" },
          endSeconds: { type: "number" },
          title: { type: "string" },
        },
        required: ["startSeconds", "endSeconds", "title"],
      },
    },
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: {
          atSeconds: { type: "number" },
          quote: { type: "string" },
        },
        required: ["atSeconds", "quote"],
      },
    },
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          atSeconds: { type: "number" },
          quote: { type: "string" },
          answeredAtSeconds: { type: "number" },
        },
        required: ["atSeconds", "quote"],
      },
    },
    peaks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          startSeconds: { type: "number" },
          endSeconds: { type: "number" },
          why: { type: "string" },
          strength: { type: "number" },
        },
        required: ["startSeconds", "endSeconds", "why", "strength"],
      },
    },
    hook: {
      type: "object",
      properties: {
        atSeconds: { type: "number" },
        quote: { type: "string" },
      },
      required: ["atSeconds", "quote"],
    },
  },
  required: ["chapters", "claims", "questions", "peaks"],
} as const;

/**
 * The instruction, and the one sentence in it that is doing the real work:
 * *copy the words exactly*.
 *
 * Everything downstream that makes this answer safe rests on being able to look
 * a quote up in the transcript. A paraphrase is unfalsifiable — it cannot be
 * found, so it cannot be checked, so a fabricated one and a real one are the
 * same object. Asking for the exact words is what converts "trust the model"
 * into "verify the model", and it costs nothing to ask.
 */
const INSTRUCTION = [
  "You are reading a transcript of one video so an editor can decide what to do with it.",
  "The transcript is one line per stretch of speech, prefixed with its start time in seconds.",
  "",
  "Return:",
  "- chapters: where one part of the material ends and the next begins, covering the whole video in order, with a short title for each. Split on subject, not on pauses.",
  "- claims: statements the speaker asserted as true. Only real assertions, not asides.",
  "- questions: questions that were asked out loud, with answeredAtSeconds where an answer follows.",
  "- peaks: the stretches somebody would stop scrolling for: a surprise, a punchline, a number, a reversal, the moment a point lands. strength is 0 to 1.",
  "- hook: the single line in this video that would make a stranger keep watching if it were first.",
  "",
  "Every quote must be copied from the transcript exactly, word for word, in the language it was spoken in.",
  "Do not paraphrase, do not translate, do not tidy the grammar. A quote that is not in the transcript is worse than no quote.",
  "Titles and the reason on a peak are yours to write; quotes are not.",
  "Times are seconds from the start of the video, taken from the line the words are on.",
  "If the material has none of one of these, return an empty list for it rather than inventing one.",
].join("\n");

export function createGeminiStructureReader(options: GeminiStructureOptions): StructureReader {
  const model = options.model ?? DEFAULT_MODEL;
  const doFetch = withDeadline(options.fetchImpl ?? fetch);

  return {
    name: `gemini/${model}`,

    async read(transcript: string, opts: StructureReadOptions = {}): Promise<StructureRead> {
      const parts: unknown[] = [
        { text: INSTRUCTION },
        ...(opts.language ? [{ text: `The video is in ${opts.language}. Write titles in that language.` }] : []),
        { text: `Transcript:\n${transcript.slice(0, MAX_TRANSCRIPT_CHARS)}` },
      ];

      const response = await doFetch(`${API_ROOT}/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": options.apiKey },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: RESPONSE_SCHEMA,
            // Low, not zero. This is a reading, and a reading at zero collapses
            // onto the most obvious sentence in the file — which for a hook is
            // reliably the first one, which is the answer we already have
            // without a model.
            temperature: 0.2,
          },
        }),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });

      if (!response.ok) {
        throw new Error(`gemini ${response.status}: ${(await response.text()).slice(0, 300)}`);
      }
      return parseStructure(await response.json());
    },
  };
}

/**
 * Pulled out so the shape can be tested without a key or a network — the same
 * reason `parseScenes` is exported next door.
 *
 * This normalises and nothing more. It does not check that a time is inside the
 * video or that a quote was ever said, because those are questions about the
 * *transcript* and this function has never seen one. They are asked in
 * `comprehend.ts`, once, where the words are.
 */
export function parseStructure(payload: unknown): StructureRead {
  const root = payload as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = root.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  const empty: StructureRead = { chapters: [], claims: [], questions: [], peaks: [], hook: null };
  if (!text.trim()) return empty;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("gemini returned something that is not the JSON its own schema asked for");
  }

  const list = (value: unknown): Array<Record<string, unknown>> =>
    Array.isArray(value) ? (value.filter((v) => v && typeof v === "object") as Array<Record<string, unknown>>) : [];

  const hookRaw = parsed["hook"] as Record<string, unknown> | undefined | null;
  const hookQuote = str(hookRaw?.["quote"], 400);

  return {
    chapters: list(parsed["chapters"]).map((c) => ({
      startSeconds: num(c["startSeconds"]),
      endSeconds: num(c["endSeconds"]),
      title: str(c["title"], 120),
    })),
    claims: list(parsed["claims"]).map((c) => ({
      atSeconds: num(c["atSeconds"]),
      quote: str(c["quote"], 400),
    })),
    questions: list(parsed["questions"]).map((q) => ({
      atSeconds: num(q["atSeconds"]),
      quote: str(q["quote"], 400),
      // Absent rather than zero when the model did not answer that part: zero
      // is a real second in every video, and "answered at the very start" is a
      // sentence this would otherwise say about every unanswered question.
      ...(Number.isFinite(Number(q["answeredAtSeconds"]))
        ? { answeredAtSeconds: num(q["answeredAtSeconds"]) }
        : {}),
    })),
    peaks: list(parsed["peaks"]).map((p) => ({
      startSeconds: num(p["startSeconds"]),
      endSeconds: num(p["endSeconds"]),
      why: str(p["why"], 200),
      strength: clamp01(num(p["strength"])),
    })),
    hook: hookRaw && hookQuote ? { atSeconds: num(hookRaw["atSeconds"]), quote: hookQuote } : null,
  };
}

function num(value: unknown): number {
  const out = Number(value);
  return Number.isFinite(out) ? out : NaN;
}

function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
