/**
 * The look at the file after ffmpeg has made it.
 *
 * `critic.ts` inspects the plan — numbers measured on one timeline about to be
 * applied to another. This module inspects the *result*: the actual bytes the
 * viewer is about to receive. The two are different jobs. A plan can be
 * perfectly consistent and still come out wrong, because between the plan and
 * the file stands an encoder with opinions of its own.
 *
 * The concrete case that earns this module its place: `loudnorm` in one pass.
 * We ask it for -14 LUFS and it *usually* obliges, but on short clips and on
 * clips with a wide loudness range it lands whole LU away from the target —
 * and the render notes were still telling the user "levelled to -14 LUFS",
 * because the note was written when the filter was requested, not when the
 * result was measured. The fix is the textbook one: measure what actually came
 * out, and run a second, linear pass built from those measurements. The video
 * stream is copied untouched, so the correction costs seconds, not a re-render.
 *
 * Everything else here is a tripwire rather than a repair. A deterministic
 * pipeline that produced a black picture or lost the audio will do it again if
 * re-run, so there is nothing to retry — but there is something to *say*, and
 * saying it in the notes beats the user discovering it in the export. The rule
 * is the same one the plan critic lives by: a render that arrives slightly
 * worse is worth more than one that does not arrive, and the one unforgivable
 * thing is to know about a defect and stay quiet.
 *
 * ## And then the half that measurement cannot reach
 *
 * Everything above is arithmetic: a level, a length, a mean luma. All of it can
 * be true of a video nobody would watch. Nothing in this file could say "the
 * captions are sitting across his mouth" or "the first three seconds give
 * nobody a reason to stay", and those are the two defects that actually cost a
 * post its audience — the second of them is the whole reason short-form editing
 * exists as a craft.
 *
 * So the finished file is also *looked at*. Frames out of the render, plus the
 * opening, put in front of a vision model with two questions and nothing else:
 * **does this hold anyone?** and **what is covered by something?**
 *
 * The answer comes back in a vocabulary we chose, not in the model's own words.
 * That is the important design decision in here and it is worth being explicit
 * about: what may be covered is an enumeration, what may be covering it is an
 * enumeration, and the verdict on the opening is three values. Every sentence
 * the customer reads is then written by us, in both languages, from those
 * values — while the model's own prose goes to the log and no further. A note
 * is this product's honesty layer; free text from a model, machine-translated
 * into somebody's second language and shown as our judgement of their work, is
 * not honesty, it is a liability with good grammar.
 *
 * Failures of the review itself never fail the render: every path in here
 * degrades to "deliver the file we have". That goes double for this half,
 * which depends on somebody else's server: no key, no answer, a bad answer, a
 * slow answer — each one ends with the file being delivered and a line in the
 * log, never with a paid render turned into a failure.
 */
import { spawn } from "node:child_process";
import { guard, LIMITS } from "./deadline";
import { readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { EditOperation } from "@workspace/api-zod";
import { sayIn, type Language } from "./say";
import { withDeadline } from "./providers/deadline";

export interface ReviewContext {
  operations: EditOperation[];
  /** The language the notes come back in. Absent means English. */
  language?: Language;
  /** The file the render started from, for "was it like this when it arrived". */
  sourcePath: string;
  /** Whether the source carried an audio track, probed before the render. */
  sourceHadAudio: boolean;
  /**
   * Whether the render was built to produce sound — the renderer's own
   * `source.hasAudio || musicUsable`, carried over rather than guessed at.
   *
   * These are two different questions and this file used to ask only the first.
   * A silent clip with a bed laid under it comes out with sound the source
   * never had: the render maps an audio stream, the plan asks for a level, and
   * the review skipped the measurement because the *source* was silent. A
   * music-only edit could ship at any loudness at all and nothing would say so.
   * Absent means fall back to the source, which is what every caller that
   * predates the field means.
   */
  expectedAudio?: boolean;
  /** Seconds the cut map said the edit should run, or null when unknown. */
  expectedSeconds: number | null;
  workDir: string;
  /**
   * How the look at the picture reaches the model, when it does.
   *
   * Absent in production: the deployment's own `GEMINI_API_KEY` is read here,
   * the same key and the same model the scene reader already uses, so this adds
   * no secret to the deploy and no line to any workflow. Present in the suite,
   * where `fetchImpl` is a stub — because the one thing worth testing about a
   * call to somebody else's server is everything except the server.
   */
  vision?: { apiKey?: string; model?: string; fetchImpl?: typeof fetch };
}

export interface ReviewResult {
  /** User-facing lines, in the language of the render notes. */
  notes: string[];
  /** Diagnostics for the log. Never shown to the user. */
  warnings: string[];
  /** True when the output file was rewritten in place. */
  repaired: boolean;
  /** Integrated loudness of the delivered file, when it was measured. */
  measuredLufs: number | null;
  /**
   * What the look at the picture came back with, or null when it did not run.
   *
   * Null and "it ran and found nothing wrong" are different facts, which is why
   * this is a field and not an empty list. A deployment with no key answers
   * null quietly and deliberately — that is a purchase somebody chose not to
   * make, not an incident — and every other way of reaching null puts its
   * reason in `warnings` on the way past.
   */
  seen: VisionRead | null;
}

/**
 * How far the mix may land from the requested level before we intervene.
 *
 * One LU is about the smallest difference anyone reliably hears in an A/B, and
 * platform normalisers ignore errors of that size anyway. Correcting inside
 * the tolerance would re-encode every render's audio for a change nobody could
 * perceive.
 */
const LOUDNESS_TOLERANCE_LU = 1.0;

/** Quieter than this and the mix is silence, not a level to be corrected. */
const SILENT_MIX_LUFS = -55;

/**
 * Output duration may drift this far from the cut map's arithmetic before it is
 * worth a diagnostic — concat and frame boundaries legitimately move the end a
 * few hundred milliseconds.
 */
const DURATION_SLACK = (expected: number): number => Math.max(1.5, expected * 0.05);

/**
 * Mean 8-bit luma below this, across the sampled frames, is a black picture.
 *
 * Limited-range video puts black at Y=16, not 0 — a frame of pure black
 * measures exactly 16 — so the line sits just above that plus encode noise.
 */
const BLACK_LUMA = 18;

/** ...and a source needs to sit above this before we call the black our fault. */
const SOURCE_LUMA_FLOOR = 36;

/** Seconds of picture to sample when checking for black output. */
const LUMA_SAMPLE_SECONDS = 30;

/**
 * What may be hidden, and what may be hiding it.
 *
 * Closed lists, and that is the point. The model picks from these; we write the
 * sentence. A free-text field here would be a stranger's prose shown to a
 * customer as our assessment of their work, in a language it was not written
 * in half the time — and unreviewable besides, because there is no way to test
 * a sentence that has not been written yet.
 *
 * Each entry carries both languages at the point of declaration, so a value the
 * model can return but we cannot say does not compile.
 */
const COVERABLE = {
  face: { en: "the speaker's face", ar: "وجه المتحدّث" },
  mouth: { en: "the speaker's mouth", ar: "فم المتحدّث" },
  eyes: { en: "the speaker's eyes", ar: "عينا المتحدّث" },
  screenText: { en: "text on screen", ar: "نصّ على الشاشة" },
  subject: { en: "the thing the shot is about", ar: "موضوع اللقطة" },
} as const;

const COVERING = {
  captions: { en: "the captions", ar: "الكابشن" },
  watermark: { en: "the watermark", ar: "العلامة المائية" },
  overlay: { en: "an overlay", ar: "طبقة فوقها" },
  other: { en: "something laid over the picture", ar: "شيء موضوع فوق الصورة" },
} as const;

export type Coverable = keyof typeof COVERABLE;
export type Covering = keyof typeof COVERING;

export interface Occlusion {
  what: Coverable;
  by: Covering;
  /** Where it was seen, for the log. Null when the model did not say. */
  atSeconds: number | null;
}

export interface VisionRead {
  /** Whether the opening gives anyone a reason to keep watching. */
  holds: "yes" | "no" | "unsure";
  /** The model's own words, for the log. Never shown to anybody. */
  because: string;
  occlusions: Occlusion[];
}

/**
 * Which moments of the render to look at.
 *
 * Two groups, because the two questions are not about the same part of the
 * file. **The opening** decides whether anybody watches the rest, so it is
 * sampled densely inside the first three seconds — that is where a post is won
 * or lost and it is a stretch nothing else in this pipeline has ever examined.
 * **The body** is spread evenly across what is left, because an overlay that
 * covers a face usually covers it for a long stretch and a handful of spread
 * samples finds that; a caption that covers a face for four frames is not the
 * complaint anybody has.
 *
 * The first and last moments are avoided: a fade-in makes the opening frame
 * dark and the final frame is often the tail of a transition, and both would
 * be read as a defect by anything looking at one picture.
 *
 * Pure, and exported, so the plan can be checked without an encoder.
 */
export const HOOK_SECONDS = 3;
const HOOK_AT = [0.2, 1.1, 2.2];
const BODY_FRACTIONS = [0.1, 0.26, 0.42, 0.58, 0.74, 0.9];
/** Two samples closer together than this are one sample and a wasted request. */
const MIN_FRAME_GAP = 0.25;

export function framePlan(durationSeconds: number): number[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return [];
  const wanted = [
    ...HOOK_AT.filter((at) => at < durationSeconds),
    ...BODY_FRACTIONS.map((f) => Number((durationSeconds * f).toFixed(2))),
  ]
    .filter((at) => at > 0 && at < durationSeconds)
    .sort((a, b) => a - b);

  const kept: number[] = [];
  for (const at of wanted) {
    if (kept.length === 0 || at - kept[kept.length - 1]! >= MIN_FRAME_GAP) kept.push(at);
  }
  return kept;
}

/** Below this there is not enough picture to have an opinion about. */
const MIN_FRAMES_TO_LOOK = 3;

/*
  What this costs, because a clips render asks it twelve times.

  Nine stills at the model's default tile resolution is on the order of two
  thousand input tokens, against a flash-lite price that makes one look a small
  fraction of a cent. A twelve-clip render therefore spends less on looking at
  all twelve than the render spends on a second of machine time — which is why
  there is no per-clip gate here. If that arithmetic ever changes, the gate
  belongs at the call site that knows it is making twelve of something, not in
  a constant hidden in this file.
*/

/** Wide enough for a caption to be legible, small enough to be a rounding error. */
const FRAME_WIDTH = 512;

/**
 * The look is bounded far tighter than an ordinary provider call.
 *
 * It happens after the render is finished and paid for, on a machine that
 * cannot claim another job until this returns. A minute is generous for one
 * request carrying nine small stills, and every second past that is a render
 * machine held out of service to improve a note.
 */
const VISION_TIMEOUT_MS = 60_000;

const VISION_API_ROOT = "https://generativelanguage.googleapis.com";
const VISION_DEFAULT_MODEL = "gemini-flash-lite-latest";

const VISION_SCHEMA = {
  type: "object",
  properties: {
    holds: { type: "string", enum: ["yes", "no", "unsure"] },
    because: { type: "string" },
    occlusions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          what: { type: "string", enum: Object.keys(COVERABLE) },
          by: { type: "string", enum: Object.keys(COVERING) },
          atSeconds: { type: "number" },
        },
        required: ["what", "by"],
      },
    },
  },
  required: ["holds", "because", "occlusions"],
} as const;

const VISION_INSTRUCTION = [
  "These stills are taken from one short video that has just been edited automatically.",
  `The first few are inside the opening ${HOOK_SECONDS} seconds, in order; the rest are spread across the whole thing.`,
  "Answer two questions and nothing else.",
  "",
  "1. holds: looking only at the opening frames, would this make somebody scrolling a feed stop and watch?",
  "   Answer 'no' only if the opening is genuinely inert — a blank or near-blank frame, a title card with",
  "   nothing happening, or somebody visibly still setting up. Answer 'unsure' when a still cannot tell you.",
  "   Put your reasoning in 'because', in one sentence.",
  "",
  "2. occlusions: is anything laid over the picture hiding something that matters?",
  "   Report it only when it genuinely obscures — a caption whose box crosses a mouth, a watermark over",
  "   on-screen text. Do not report an element that merely sits near something. If nothing is obscured,",
  "   return an empty list. Give 'atSeconds' as roughly where in the video you saw it, if you can tell.",
].join("\n");

/**
 * The whole look: grab the frames, ask, and come back with something or null.
 *
 * Every failure inside is a null and a line in `warnings`. There is no path out
 * of here that can fail a render, and there is no path that stays quiet: a look
 * that silently did nothing on every render for a month is the failure this
 * repository keeps finding, and the log is what makes it visible.
 */
async function lookAtPicture(
  file: string,
  ctx: ReviewContext,
  durationSeconds: number,
  warnings: string[],
): Promise<VisionRead | null> {
  const apiKey = (ctx.vision?.apiKey ?? process.env["GEMINI_API_KEY"] ?? "").trim();
  if (!apiKey) {
    // Not a warning. A deployment without the key has decided not to buy this,
    // and a log line on every render would be noise about a choice.
    return null;
  }

  const moments = framePlan(durationSeconds);
  if (moments.length < MIN_FRAMES_TO_LOOK) {
    warnings.push(`too little picture to look at: ${moments.length} frames from ${durationSeconds.toFixed(1)}s`);
    return null;
  }

  const grabbed: string[] = [];
  try {
    const parts: unknown[] = [];
    for (const [index, at] of moments.entries()) {
      const still = path.join(ctx.workDir, `review-frame-${index}.jpg`);
      try {
        await ffmpegOrThrow([
          "-y",
          // Before `-i`, which is the fast seek: it decodes from the nearest
          // keyframe rather than from the top of the file, and on a ninety
          // minute render the difference is the whole cost of this feature.
          "-ss", at.toFixed(2),
          "-i", file,
          "-frames:v", "1",
          "-vf", `scale=${FRAME_WIDTH}:-2`,
          "-q:v", "4",
          still,
        ]);
      } catch {
        // One frame that would not come out is not a reason to abandon the
        // look. The plan has nine; the questions survive losing one.
        continue;
      }
      grabbed.push(still);
      parts.push({
        inlineData: { mimeType: "image/jpeg", data: (await readFile(still)).toString("base64") },
      });
    }

    if (parts.length < MIN_FRAMES_TO_LOOK) {
      warnings.push(`could not read enough frames out of the render to look at it (${parts.length})`);
      return null;
    }
    parts.push({ text: VISION_INSTRUCTION });

    const doFetch = withDeadline(ctx.vision?.fetchImpl ?? fetch, VISION_TIMEOUT_MS);
    const model = ctx.vision?.model ?? process.env["GEMINI_MODEL"]?.trim() ?? VISION_DEFAULT_MODEL;
    const response = await doFetch(`${VISION_API_ROOT}/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: VISION_SCHEMA,
          temperature: 0.1,
        },
      }),
    });
    if (!response.ok) {
      warnings.push(`the look at the picture was refused: ${response.status}`);
      return null;
    }
    return parseVisionRead(await response.json());
  } catch (error) {
    warnings.push(`the look at the picture did not finish: ${String(error).slice(0, 200)}`);
    return null;
  } finally {
    for (const still of grabbed) await unlink(still).catch(() => {});
  }
}

/**
 * The answer, reduced to things this file knows how to say.
 *
 * Pulled out so the shape can be tested without a key or a network — and
 * written to distrust its input, because a schema is a request rather than a
 * guarantee: a value outside the enumeration, a verdict that is not one of
 * three, a number where a string belongs. Anything unrecognised is dropped
 * rather than passed along, since the alternative is an undefined key reaching
 * a template and a customer reading "the undefined is covered by undefined".
 */
export function parseVisionRead(payload: unknown): VisionRead | null {
  const root = payload as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = root?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text.trim()) return null;

  let parsed: { holds?: unknown; because?: unknown; occlusions?: unknown };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return null;
  }

  const holds =
    parsed.holds === "yes" || parsed.holds === "no" || parsed.holds === "unsure" ? parsed.holds : "unsure";

  const seen = new Set<string>();
  const occlusions: Occlusion[] = [];
  for (const raw of Array.isArray(parsed.occlusions) ? parsed.occlusions : []) {
    const entry = raw as { what?: unknown; by?: unknown; atSeconds?: unknown };
    const what = typeof entry.what === "string" && entry.what in COVERABLE ? (entry.what as Coverable) : null;
    const by = typeof entry.by === "string" && entry.by in COVERING ? (entry.by as Covering) : null;
    if (!what || !by) continue;
    // The same complaint about the same pair, seen in four frames, is one
    // complaint. A note repeated four times reads as a broken product.
    const key = `${what}/${by}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const at = Number(entry.atSeconds);
    occlusions.push({ what, by, atSeconds: Number.isFinite(at) && at >= 0 ? at : null });
  }

  return {
    holds,
    because: typeof parsed.because === "string" ? parsed.because.slice(0, 300) : "",
    occlusions,
  };
}

/**
 * What the customer is told, in their own language, from values we chose.
 *
 * Exported and pure so that every sentence this feature can produce is
 * enumerable by a test — which is the only way to be sure none of them is a
 * model's words wearing our voice.
 *
 * The opening verdict is reported only when it is `no`. `unsure` is the honest
 * answer to a question asked of still frames and there is nothing to do with
 * it, and `yes` is a compliment nobody needs from their own tooling.
 */
export function notesFromVision(read: VisionRead, language: Language | null | undefined): string[] {
  const t = sayIn(language);
  const notes: string[] = [];

  for (const occlusion of read.occlusions) {
    const what = COVERABLE[occlusion.what];
    const by = COVERING[occlusion.by];
    notes.push(
      t(
        `${what.en} is covered by ${by.en} in places. Moving it, or turning it off, is a one-line change and worth it`,
        `${what.ar} يغطّيه ${by.ar} في مواضع. تحريكه أو إيقافه تعديل بسطر واحد ويستحقّ`,
      ),
    );
  }

  if (read.holds === "no") {
    notes.push(
      t(
        `the first ${HOOK_SECONDS} seconds do not give anybody a reason to keep watching. Starting on the moment rather than on the introduction is usually the whole fix`,
        `أوّل ${HOOK_SECONDS} ثوانٍ لا تعطي أحدًا سببًا ليكمل. البدء من اللحظة نفسها بدل المقدّمة هو الحلّ عادةً`,
      ),
    );
  }

  return notes;
}

export async function reviewOutput(file: string, ctx: ReviewContext): Promise<ReviewResult> {
  const t = sayIn(ctx.language);
  const notes: string[] = [];
  const warnings: string[] = [];
  let repaired = false;
  let measuredLufs: number | null = null;

  const probe = await probeStreams(file);
  /** What the render intended to produce, not what arrived with the footage. */
  const expectedAudio = ctx.expectedAudio ?? ctx.sourceHadAudio;

  // ── Length ────────────────────────────────────────────────────────────────
  // A mismatch here is a bug in the cut arithmetic or the concat, and it is
  // ours to chase, not the user's to act on — so it goes to the log, never the
  // notes. The billing meter already measures the file directly.
  if (ctx.expectedSeconds != null && ctx.expectedSeconds > 0 && probe.duration > 0) {
    const drift = Math.abs(probe.duration - ctx.expectedSeconds);
    if (drift > DURATION_SLACK(ctx.expectedSeconds)) {
      warnings.push(
        `output runs ${probe.duration.toFixed(1)}s where the cut map computed ${ctx.expectedSeconds.toFixed(1)}s`,
      );
    }
  }

  // ── The sound is still there ──────────────────────────────────────────────
  // The renderer maps an audio stream whenever the source has one, so a source
  // with sound and an output without it means the graph dropped a link on the
  // floor. Deterministic, so not retried — but said out loud.
  if (expectedAudio && !probe.hasAudio) {
    warnings.push(
      ctx.sourceHadAudio
        ? "source had an audio track and the output does not"
        : "music was laid under a silent source and the output has no audio stream",
    );
    notes.push(
      t(
        "the sound did not survive this edit. That is a fault on our side, not in your footage",
        "لم ينجُ الصوت من هذا التعديل. وهذا عطل عندنا، لا في لقطتك",
      ),
    );
  }

  // ── The level actually reached ────────────────────────────────────────────
  const loudness = ctx.operations.find((op) => op.type === "normalizeLoudness");
  if (loudness && loudness.type === "normalizeLoudness" && expectedAudio && probe.hasAudio) {
    const target = loudness.targetLufs;
    const measured = await measureLoudness(file, target);
    if (!measured) {
      warnings.push("could not measure the output loudness");
    } else {
      measuredLufs = measured.inputI;
      if (measured.inputI <= SILENT_MIX_LUFS) {
        // Levelling silence is not a miss to be corrected; it is a clip with
        // nothing in it, and gain would only raise the noise floor.
        warnings.push(`output mix measures ${measured.inputI.toFixed(1)} LUFS, effectively silent`);
      } else if (Math.abs(measured.inputI - target) > LOUDNESS_TOLERANCE_LU) {
        const corrected = await correctLoudness(file, target, measured, ctx.workDir);
        if (corrected != null) {
          repaired = true;
          measuredLufs = corrected;
          notes.push(
            t(
              `the levelling missed on the first pass. The mix came out at ${measured.inputI.toFixed(1)} LUFS instead of ${target}, so it was measured and corrected`,
              `أخطأت التسوية في التمريرة الأولى: خرج المزيج عند ${measured.inputI.toFixed(1)} LUFS بدل ${target}، فقيس وصُحّح`,
            ),
          );
        } else {
          warnings.push(
            `mix measured ${measured.inputI.toFixed(1)} LUFS against a ${target} target and the correction did not land`,
          );
          notes.push(
            t(
              `the mix came out at ${measured.inputI.toFixed(1)} LUFS instead of ${target} and a correction did not take, so it ships as it is`,
              `خرج المزيج عند ${measured.inputI.toFixed(1)} LUFS بدل ${target} ولم ينجح التصحيح، فيُسلَّم كما هو`,
            ),
          );
        }
      }
    }
  }

  // ── The picture is a picture ──────────────────────────────────────────────
  // Only when the output looks black do we pay for a second read to ask
  // whether the source was black too — someone rendering an audio-only clip
  // over a black frame deserves no apology for their own footage.
  let blackPicture = false;
  if (probe.hasVideo) {
    const outLuma = await meanLuma(file);
    if (outLuma != null && outLuma < BLACK_LUMA) {
      blackPicture = true;
      const sourceLuma = await meanLuma(ctx.sourcePath);
      if (sourceLuma != null && sourceLuma > SOURCE_LUMA_FLOOR) {
        warnings.push(
          `output luma ${outLuma.toFixed(1)} against source luma ${sourceLuma.toFixed(1)}. The picture is black`,
        );
        notes.push(
          t(
            "the picture came out black. That is a bug on our side, not in your footage",
            "خرجت الصورة سوداء. وهذا عطل عندنا، لا في لقطتك",
          ),
        );
      }
    }
  }

  // ── And the look at it ────────────────────────────────────────────────────
  /*
    Skipped on a picture already known to be black, and that is not an
    optimisation.

    A black render has already been reported above, in the one sentence that is
    true about it. Asking a model whether a black rectangle holds an audience
    would spend a request to be told what a mean luma of 16 already said, and
    then add a second note underneath the first — two complaints about one
    defect, the second one softer than the truth.
  */
  let seen: VisionRead | null = null;
  if (probe.hasVideo && !blackPicture && probe.duration > 0) {
    seen = await lookAtPicture(file, ctx, probe.duration, warnings);
    if (seen) {
      notes.push(...notesFromVision(seen, ctx.language));
      if (seen.because) warnings.push(`opening read as "${seen.holds}": ${seen.because}`);
      for (const occlusion of seen.occlusions) {
        warnings.push(
          `${occlusion.what} covered by ${occlusion.by}` +
            (occlusion.atSeconds != null ? ` around ${occlusion.atSeconds.toFixed(1)}s` : ""),
        );
      }
    }
  }

  return { notes, warnings, repaired, measuredLufs, seen };
}

// ── Measurements ────────────────────────────────────────────────────────────

interface LoudnessReading {
  inputI: number;
  inputTp: number;
  inputLra: number;
  inputThresh: number;
  targetOffset: number;
}

/**
 * What `loudnorm` itself would measure, in the shape its second pass wants.
 *
 * ebur128 could give the integrated number alone, but the correction pass
 * needs the filter's own idea of threshold and offset, and the only honest way
 * to get those is to ask the same filter that will use them.
 */
async function measureLoudness(file: string, target: number): Promise<LoudnessReading | null> {
  const said = await ffmpeg([
    "-i", file,
    "-af", `loudnorm=I=${target}:TP=-1.5:LRA=11:print_format=json`,
    "-vn", "-sn", "-f", "null", "-",
  ]);
  const json = lastJsonBlock(said);
  if (!json) return null;
  const numberField = (name: string): number | null => {
    const v = Number(json[name]);
    return Number.isFinite(v) ? v : null;
  };
  const inputI = numberField("input_i");
  const inputTp = numberField("input_tp");
  const inputLra = numberField("input_lra");
  const inputThresh = numberField("input_thresh");
  if (inputI == null || inputTp == null || inputLra == null || inputThresh == null) return null;
  return { inputI, inputTp, inputLra, inputThresh, targetOffset: numberField("target_offset") ?? 0 };
}

/**
 * The second, linear pass, built from the first pass's measurements.
 *
 * The video stream is copied, not re-encoded: the correction touches only the
 * audio, costs seconds, and cannot soften a frame. The corrected file replaces
 * the original only after its own level has been measured again and found
 * closer to the target than the one it replaces — a correction is not taken on
 * faith from the same filter that just missed.
 *
 * Returns the corrected file's measured loudness, or null when the correction
 * failed or did not improve matters (the original is kept untouched).
 */
async function correctLoudness(
  file: string,
  target: number,
  measured: LoudnessReading,
  workDir: string,
): Promise<number | null> {
  const fixed = path.join(workDir, "relevelled.mp4");
  try {
    await ffmpegOrThrow([
      "-y", "-i", file,
      "-map", "0:v?", "-map", "0:a",
      "-c:v", "copy",
      "-af",
      `loudnorm=I=${target}:TP=-1.5:LRA=11` +
        `:measured_I=${measured.inputI}:measured_TP=${measured.inputTp}` +
        `:measured_LRA=${measured.inputLra}:measured_thresh=${measured.inputThresh}` +
        `:offset=${measured.targetOffset}:linear=true`,
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
      "-movflags", "+faststart",
      fixed,
    ]);
    const again = await measureLoudness(fixed, target);
    if (!again) return null;
    const before = Math.abs(measured.inputI - target);
    const after = Math.abs(again.inputI - target);
    if (after >= before) return null;
    await rename(fixed, file);
    return again.inputI;
  } catch {
    await unlink(fixed).catch(() => {});
    return null;
  }
}

/**
 * Mean luma over the opening stretch, sampled at one frame a second.
 *
 * One fps at a thumbnail size is enough to tell a black render from a dark
 * one, and keeps the check to well under a second of work. Null when the read
 * fails — an unmeasurable picture is not evidence of a black one.
 */
async function meanLuma(file: string): Promise<number | null> {
  const said = await ffmpeg([
    "-t", String(LUMA_SAMPLE_SECONDS),
    "-i", file,
    "-vf", "fps=1,scale=160:-2,signalstats,metadata=print:file=-",
    "-an", "-sn", "-f", "null", "-",
  ]);
  const values: number[] = [];
  for (const m of said.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)) {
    const v = Number(m[1]);
    if (Number.isFinite(v)) values.push(v);
  }
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// ── Plumbing ────────────────────────────────────────────────────────────────

const FFMPEG = process.env["FFMPEG_PATH"] ?? "ffmpeg";
const FFPROBE = process.env["FFPROBE_PATH"] ?? "ffprobe";

/**
 * Runs ffmpeg for its report, not its output; never throws on exit code.
 *
 * "Never throws on exit code" is exactly why the deadline has to be checked
 * separately here. A killed child closes like a finished one, and this
 * function's whole contract is to hand back whatever was said — so without the
 * flag a hung measurement pass would return a few lines of ffmpeg banner and
 * the critic would review a render against nothing.
 */
function ffmpeg(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ["-hide_banner", "-nostdin", ...args]);
    const deadline = guard(child, { ...LIMITS.analysis, what: "measuring the finished render" });
    let said = "";
    const collect = (d: Buffer) => {
      deadline.touch();
      said += d.toString();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (err) => {
      deadline.clear();
      reject(err);
    });
    child.on("close", () => {
      deadline.clear();
      if (deadline.expired) reject(deadline.error);
      else resolve(said);
    });
  });
}

/** Runs ffmpeg for its output file; a non-zero exit is a failure. */
function ffmpegOrThrow(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ["-hide_banner", "-nostdin", ...args]);
    const deadline = guard(child, { ...LIMITS.analysis, what: "cutting a sample of the render" });
    let said = "";
    child.stderr.on("data", (d: Buffer) => {
      deadline.touch();
      said += d.toString();
    });
    child.on("error", (err) => {
      deadline.clear();
      reject(err);
    });
    child.on("close", (code) => {
      deadline.clear();
      if (deadline.expired) reject(deadline.error);
      else if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${said.slice(-400)}`));
    });
  });
}

/**
 * The last {...} block in a stream of ffmpeg chatter, parsed.
 *
 * loudnorm prints its JSON at the very end of stderr, after the progress
 * lines. There are no other braces in ffmpeg's output on these invocations,
 * but taking the last block keeps a future filter's stray braces from
 * poisoning the read.
 */
function lastJsonBlock(text: string): Record<string, unknown> | null {
  const open = text.lastIndexOf("{");
  const close = text.lastIndexOf("}");
  if (open < 0 || close <= open) return null;
  try {
    return JSON.parse(text.slice(open, close + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function probeStreams(file: string): Promise<{ duration: number; hasAudio: boolean; hasVideo: boolean }> {
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn(FFPROBE, [
      "-v", "error",
      "-show_entries", "format=duration:stream=codec_type",
      "-of", "json",
      file,
    ]);
    const deadline = guard(child, { ...LIMITS.probe, what: "reading the render's own header" });
    let said = "";
    child.stdout.on("data", (d: Buffer) => {
      said += d.toString();
    });
    child.on("error", (err) => {
      deadline.clear();
      reject(err);
    });
    child.on("close", () => {
      deadline.clear();
      if (deadline.expired) reject(deadline.error);
      else resolve(said);
    });
  });
  try {
    const parsed = JSON.parse(out) as {
      format?: { duration?: string };
      streams?: Array<{ codec_type?: string }>;
    };
    return {
      duration: Number(parsed.format?.duration) || 0,
      hasAudio: (parsed.streams ?? []).some((s) => s.codec_type === "audio"),
      hasVideo: (parsed.streams ?? []).some((s) => s.codec_type === "video"),
    };
  } catch {
    return { duration: 0, hasAudio: false, hasVideo: false };
  }
}
