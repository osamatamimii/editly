/**
 * What the reference drew, in the language we can draw it back in.
 *
 * `graphics.ts` finds the moments and measures them: which rectangle, between
 * which seconds, which way it came in and how far it travelled. Everything
 * there is arithmetic and none of it needs a model.
 *
 * What arithmetic cannot say is what is *inside* the rectangle — that this one
 * is a flat plate with a heavy line of text on it and that one is a phone with
 * a screenshot in it. So the shortlist becomes three or four stills, and a
 * model with eyes answers in the layer vocabulary rather than in prose.
 *
 * ## What comes back is a template, not a copy
 *
 * The model is asked for the *style* of the text and never for the words. That
 * is not caution about the schema, it is the product: the words in a customer's
 * video are the customer's, and the planner is instructed nowhere to write copy
 * they did not ask for. Lifting a sentence out of somebody else's video and
 * putting it in theirs would be wrong even when it fitted.
 *
 * So a text layer comes back as a slot — how large, how heavy, what colour,
 * which way it is aligned, and how many words the line carried — and
 * `fillTemplate` puts the customer's own words into it. Everything geometric is
 * measured rather than described: the box, the timing and the entrance all come
 * from `graphics.ts`, so the model cannot move a card by guessing at a number.
 *
 * That division is also what makes it cheap. One still per moment, capped, at
 * 512 pixels wide — the question is small because the expensive half of the
 * answer is already known.
 */
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import type { SceneLayer } from "@workspace/api-zod";
import type { DrawnBox, DrawnMoment, Entrance, GraphicsRead } from "./graphics";
import { safeColor } from "./motion";
import { withDeadline } from "./providers/deadline";
import { guard, LIMITS } from "./deadline";

/**
 * Moments asked about in one call.
 *
 * A reference states its language in its first few compositions; the tenth card
 * in a two-minute video is the same card again. Six stills at 512 pixels is a
 * few thousand input tokens — a fraction of a cent at flash-lite prices, and
 * far less than the machine time the read itself costs.
 */
export const MAX_MOMENTS = 6;

/** Wide enough to read a weight and a colour off, small enough to be free. */
const STILL_WIDTH = 512;

/**
 * One request carrying six small stills. Longer than the review's minute
 * because this runs *before* a render rather than after one, so nothing is
 * being held out of service while it waits.
 */
const TIMEOUT_MS = 90_000;

const API_ROOT = "https://generativelanguage.googleapis.com";
const DEFAULT_MODEL = "gemini-flash-lite-latest";

/** How long a moment is held when the reference never took it off screen. */
const DEFAULT_HOLD_SECONDS = 2.5;

export type TemplateContent =
  | {
      kind: "text";
      /** Cap size as a fraction of frame height. */
      size: number;
      weight: number;
      color: string;
      align: "start" | "center" | "end";
      /** How many words the line carried. A slot, not the words themselves. */
      words: number;
      /** Whether one part of the line was set apart from the rest. */
      emphasis: boolean;
    }
  | { kind: "fill"; color: string }
  | { kind: "gradient"; from: string; to: string; angle: number }
  | { kind: "device"; device: "phone" | "browser" | "laptop"; shell: string };

export interface TemplateLayer {
  /** Fractions of the *frame*, like everything else here — never of the moment. */
  box: DrawnBox;
  content: TemplateContent;
  radius?: number;
  shadow?: 0 | 1 | 2 | 3;
}

export interface TemplateMoment {
  at: number;
  durationSeconds: number;
  enter: Entrance;
  travel: number;
  layers: TemplateLayer[];
}

export interface SceneTemplate {
  moments: TemplateMoment[];
}

export interface SceneReadContext {
  workDir: string;
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  /** Injected so the stills can be produced without ffmpeg in a test. */
  grabStill?: (file: string, atSeconds: number, to: string) => Promise<void>;
}

/* ── Asking ─────────────────────────────────────────────────────────────── */

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    moments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          layers: {
            type: "array",
            items: {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["text", "fill", "gradient", "device"] },
                x: { type: "number" },
                y: { type: "number" },
                w: { type: "number" },
                h: { type: "number" },
                color: { type: "string" },
                from: { type: "string" },
                to: { type: "string" },
                angle: { type: "number" },
                size: { type: "number" },
                weight: { type: "integer" },
                align: { type: "string", enum: ["start", "center", "end"] },
                words: { type: "integer" },
                emphasis: { type: "boolean" },
                device: { type: "string", enum: ["phone", "browser", "laptop"] },
                shell: { type: "string" },
                radius: { type: "number" },
                shadow: { type: "integer" },
              },
              required: ["kind", "x", "y", "w", "h"],
            },
          },
        },
        required: ["index", "layers"],
      },
    },
  },
  required: ["moments"],
} as const;

const INSTRUCTION = [
  "Each still below is one moment from a video, in order. Something has just been drawn on the frame",
  "and has come to rest. You are told the rectangle it occupies, measured, in fractions of the frame.",
  "",
  "Describe what is inside that rectangle as a stack of layers, back to front. Coordinates are fractions",
  "of the whole frame, not of the rectangle: 0,0 is the top left corner of the picture and 1,1 the bottom right.",
  "",
  "Layer kinds:",
  "  fill      — one flat colour. Give 'color' as a hex value.",
  "  gradient  — two colours. Give 'from', 'to' and 'angle' in degrees.",
  "  device    — a drawn phone, browser window or laptop. Give 'device' and 'shell' (the body colour).",
  "  text      — a line of words. Give 'size' as the cap height divided by the frame height,",
  "              'weight' (100-900), 'color', 'align', 'words' (how many words are on the line),",
  "              and 'emphasis' (true when one word is set apart from the rest by colour or weight).",
  "",
  "Do NOT transcribe the words. Report how many there are and how they are set. The words in the",
  "finished video will be somebody else's, and only the setting is being copied.",
  "",
  "Report at most six layers per moment, and only what you can actually see. A moment that is one",
  "flat card with one line on it is two layers, and that is a complete answer.",
].join("\n");

/**
 * One still, with a clock on it.
 *
 * The clock is not decoration and it is not belt-and-braces: this runs inside
 * the render loop, and a child that wedges holds that loop open with nothing to
 * report it — the machine looks busy, the queue stops, and the only symptom is
 * that renders stop being claimed. `worker-test` asserts that every spawn in
 * this package is guarded for exactly that reason, and it caught this one the
 * day it was written.
 */
async function ffmpegStill(file: string, atSeconds: number, to: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
      // Before `-i`: the fast seek, which decodes from the nearest keyframe
      // rather than from the top of the file.
      "-ss", atSeconds.toFixed(2),
      "-i", file,
      "-frames:v", "1",
      "-vf", `scale=${STILL_WIDTH}:-2`,
      "-q:v", "4",
      to,
    ]);
    const deadline = guard(child, { ...LIMITS.analysis, what: "taking a still out of the reference" });
    child.on("error", (error) => {
      deadline.clear();
      reject(error);
    });
    child.on("close", (code) => {
      deadline.clear();
      if (deadline.expired) {
        reject(deadline.error);
        return;
      }
      code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`));
    });
  });
}

/**
 * The stills, the question, and a template or null.
 *
 * Every failure inside is a null and a line in `warnings`, like the review's
 * look: there is no path out of here that can fail a render, and none that
 * stays quiet.
 */
export async function readReferenceScene(
  file: string,
  read: GraphicsRead,
  ctx: SceneReadContext,
  warnings: string[],
): Promise<SceneTemplate | null> {
  const apiKey = (ctx.apiKey ?? process.env["GEMINI_API_KEY"] ?? "").trim();
  if (!apiKey) {
    // Not a warning. A deployment without the key has decided not to buy this.
    return null;
  }
  if (!read.measured || read.moments.length === 0) return null;

  const moments = read.moments.slice(0, MAX_MOMENTS);
  const grab = ctx.grabStill ?? ffmpegStill;
  const grabbed: string[] = [];
  const asked: DrawnMoment[] = [];

  try {
    const parts: unknown[] = [];
    for (const [index, moment] of moments.entries()) {
      const still = path.join(ctx.workDir, `scene-${index}.jpg`);
      /*
        A little after it settled, not at the moment it settled.

        The settle sample is the first one at which nothing moved, which on a
        spring is the frame where the overshoot has just come back — the card is
        there but its shadow and its last few pixels of travel are not. A fifth
        of a second later is the composition as a viewer sees it, and it is
        still inside the moment whenever the moment is worth asking about.
      */
      const at = Math.max(0, moment.settledAt + 0.2);
      try {
        await grab(file, at, still);
      } catch {
        // One still that would not come out is not a reason to abandon the ask.
        continue;
      }
      grabbed.push(still);
      asked.push(moment);
      parts.push({
        text:
          `Moment ${asked.length - 1}, at ${moment.at.toFixed(1)}s. ` +
          `Rectangle: x=${moment.box.x.toFixed(3)} y=${moment.box.y.toFixed(3)} ` +
          `w=${moment.box.w.toFixed(3)} h=${moment.box.h.toFixed(3)}.`,
      });
      parts.push({
        inlineData: { mimeType: "image/jpeg", data: (await readFile(still)).toString("base64") },
      });
    }

    if (asked.length === 0) {
      warnings.push("could not read a single still out of the reference to look at");
      return null;
    }
    parts.push({ text: INSTRUCTION });

    const doFetch = withDeadline(ctx.fetchImpl ?? fetch, TIMEOUT_MS);
    const model = ctx.model ?? process.env["GEMINI_MODEL"]?.trim() ?? DEFAULT_MODEL;
    const response = await doFetch(`${API_ROOT}/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
          temperature: 0.1,
        },
      }),
    });
    if (!response.ok) {
      warnings.push(`the look at the reference was refused: ${response.status}`);
      return null;
    }
    return parseSceneRead(await response.json(), asked);
  } catch (error) {
    warnings.push(`the look at the reference did not finish: ${String(error).slice(0, 200)}`);
    return null;
  } finally {
    for (const still of grabbed) await unlink(still).catch(() => {});
  }
}

/* ── Distrusting the answer ─────────────────────────────────────────────── */

const clamp = (value: unknown, low: number, high: number, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(high, Math.max(low, n)) : fallback;
};

/**
 * The answer, reduced to things the renderer knows how to draw.
 *
 * Exported and pure so the shape can be checked without a key or a network, and
 * written to distrust its input throughout. A response schema is a request, not
 * a guarantee — and this one reaches a *stylesheet*: a colour is a value the
 * browser parses, so `safeColor` is the same gate the layer renderer already
 * applies rather than a second opinion about it.
 *
 * Geometry is clamped rather than dropped. A model that answers `w: 1.4` has
 * described a layer wider than the frame, which is a real thing a composition
 * does; a model that answers `w: 40` has made an arithmetic mistake, and the
 * clamp turns both into the widest layer the schema allows instead of failing
 * the moment.
 */
export function parseSceneRead(payload: unknown, moments: DrawnMoment[]): SceneTemplate | null {
  const root = payload as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = root?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text.trim()) return null;

  let parsed: { moments?: unknown };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return null;
  }

  const out: TemplateMoment[] = [];
  const seen = new Set<number>();
  for (const raw of Array.isArray(parsed.moments) ? parsed.moments : []) {
    const entry = raw as { index?: unknown; layers?: unknown };
    const index = Number(entry.index);
    const moment = Number.isInteger(index) ? moments[index] : undefined;
    // An index that names no moment is the failure that would otherwise place a
    // composition at a time nothing happened.
    if (!moment || seen.has(index)) continue;
    seen.add(index);

    const layers: TemplateLayer[] = [];
    for (const rawLayer of Array.isArray(entry.layers) ? entry.layers : []) {
      const layer = layerFrom(rawLayer);
      if (layer) layers.push(layer);
      if (layers.length >= 6) break;
    }
    if (layers.length === 0) continue;

    out.push({
      at: moment.at,
      durationSeconds:
        moment.leavesAt !== null
          ? Math.max(0.4, moment.leavesAt - moment.at)
          : DEFAULT_HOLD_SECONDS,
      enter: moment.enter,
      travel: moment.travel,
      layers,
    });
  }

  return out.length > 0 ? { moments: out } : null;
}

function layerFrom(raw: unknown): TemplateLayer | null {
  const l = raw as Record<string, unknown>;
  const box: DrawnBox = {
    x: clamp(l["x"], -1, 2, 0),
    y: clamp(l["y"], -1, 2, 0),
    w: clamp(l["w"], 0.01, 3, 1),
    h: clamp(l["h"], 0.01, 3, 1),
  };
  const radius = l["radius"] === undefined ? undefined : clamp(l["radius"], 0, 0.5, 0);
  const shadowRaw = Math.round(clamp(l["shadow"], 0, 3, 0));
  const shadow = l["shadow"] === undefined ? undefined : ((shadowRaw as 0 | 1 | 2 | 3));

  const kind = l["kind"];
  if (kind === "fill") {
    const color = safeColor(String(l["color"] ?? ""));
    if (!color) return null;
    return { box, content: { kind: "fill", color }, ...(radius !== undefined ? { radius } : {}), ...(shadow !== undefined ? { shadow } : {}) };
  }
  if (kind === "gradient") {
    const from = safeColor(String(l["from"] ?? ""));
    const to = safeColor(String(l["to"] ?? ""));
    if (!from || !to) return null;
    return {
      box,
      content: { kind: "gradient", from, to, angle: clamp(l["angle"], -360, 360, 180) },
      ...(radius !== undefined ? { radius } : {}),
      ...(shadow !== undefined ? { shadow } : {}),
    };
  }
  if (kind === "device") {
    const device = l["device"];
    if (device !== "phone" && device !== "browser" && device !== "laptop") return null;
    const shell = safeColor(String(l["shell"] ?? "")) ?? "#111111";
    return { box, content: { kind: "device", device, shell }, ...(shadow !== undefined ? { shadow } : {}) };
  }
  if (kind === "text") {
    const color = safeColor(String(l["color"] ?? "")) ?? "#111111";
    const align = l["align"];
    return {
      box,
      content: {
        kind: "text",
        size: clamp(l["size"], 0.008, 0.4, 0.06),
        weight: Math.round(clamp(l["weight"], 100, 900, 700)),
        color,
        align: align === "start" || align === "end" ? align : "center",
        // One word is a word; zero is a model that did not look. Capped at the
        // most a single line of a title ever carries.
        words: Math.round(clamp(l["words"], 1, 12, 3)),
        emphasis: l["emphasis"] === true,
      },
      ...(radius !== undefined ? { radius } : {}),
      ...(shadow !== undefined ? { shadow } : {}),
    };
  }
  return null;
}

/* ── Filling it with the customer's own words ───────────────────────────── */

export interface FilledScene {
  layers: SceneLayer[];
  /** Text slots the caller had no words for, and which were therefore dropped. */
  unfilled: number;
}

/**
 * The template, plus the customer's lines, as layers the renderer can draw.
 *
 * Pure, and the reason it is pure is that every number in it came from
 * somewhere that can be checked: the box and the timing from `graphics.ts`, the
 * setting from a model whose answer has already been reduced to the schema, the
 * words from the person whose video it is. Nothing here invents a value.
 *
 * `lines` are consumed in order — the first text slot in the first moment takes
 * the first line. A slot with no line left is dropped rather than filled with
 * something, and `unfilled` says how many, because a card that arrives empty is
 * worse than one that does not arrive.
 */
export function fillTemplate(template: SceneTemplate, lines: string[]): FilledScene {
  const layers: SceneLayer[] = [];
  const queue = [...lines];
  let unfilled = 0;

  for (const moment of template.moments) {
    for (const [depth, layer] of moment.layers.entries()) {
      const shared = {
        box: layer.box,
        at: moment.at,
        durationSeconds: moment.durationSeconds,
        enter: moment.enter,
        // Paint order is the order the model reported, back to front, and the
        // moment's own place in the reference decides nothing about it.
        z: depth,
        ...(moment.travel > 0 ? { travel: Math.min(1, moment.travel) } : {}),
        ...(layer.radius !== undefined ? { radius: layer.radius } : {}),
        ...(layer.shadow !== undefined ? { shadow: layer.shadow } : {}),
      };

      if (layer.content.kind === "text") {
        const line = queue.shift();
        if (!line || !line.trim()) {
          unfilled += 1;
          continue;
        }
        layers.push({
          ...shared,
          content: {
            kind: "text",
            runs: [{ text: line.trim() }],
            size: layer.content.size,
            color: layer.content.color,
            weight: layer.content.weight,
            align: layer.content.align,
            // A line the reference set in several words arrives one word at a
            // time, which is the difference between a caption and a title.
            staggerRuns: layer.content.words > 1,
          },
        } as SceneLayer);
        continue;
      }

      layers.push({ ...shared, content: layer.content } as SceneLayer);
    }
  }

  return { layers, unfilled };
}

/**
 * The reference's compositions, placed where the *plan* says a title goes.
 *
 * This is the same rule `reference-style.ts` follows, applied to the picture
 * instead of to the numbers: **a reference adjusts an edit, it does not replace
 * one.** The plan has already decided that there is a title at twelve seconds
 * and what it says — those are the customer's decisions and a reference has no
 * opinion about either. What the reference decides is what a title *looks
 * like*: the plate behind it, the colours, the size and weight, which way it
 * arrives.
 *
 * So the template's own timings are dropped. Replaying them would put a card at
 * two seconds because somebody else's video had one there, over footage that
 * has nothing happening at two seconds — which is not matching a reference, it
 * is playing it.
 *
 * Compositions are taken in turn and repeat when the plan has more titles than
 * the reference had compositions. That is what a reference *is*: a video with
 * three looks in it and eleven titles has three looks.
 */
export function titlesAsScene(
  titles: Array<{ text: string; at: number; durationSeconds: number }>,
  template: SceneTemplate,
): { layers: SceneLayer[]; unfilled: number } {
  const layers: SceneLayer[] = [];
  let unfilled = 0;
  if (template.moments.length === 0) return { layers, unfilled };

  for (const [index, title] of titles.entries()) {
    const moment = template.moments[index % template.moments.length];
    if (!moment) continue;
    const filled = fillTemplate(
      { moments: [{ ...moment, at: title.at, durationSeconds: title.durationSeconds }] },
      [title.text],
    );
    layers.push(...filled.layers);
    unfilled += filled.unfilled;
  }
  return { layers, unfilled };
}
