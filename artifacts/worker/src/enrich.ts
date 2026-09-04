/**
 * Filling in the parts of a plan that only the video knows.
 *
 * The API writes a plan without ever seeing the file. It can say "put captions
 * on this" and "punch in where the emphasis falls", but it cannot say what the
 * words are or where the emphasis is — those live in the media, and only the
 * worker has both the media and the models. This step closes that gap, and it
 * runs once per job, before ffmpeg.
 *
 * Everything here is best-effort by design. A plan that asked for captions on a
 * deployment with no recogniser should still render: it loses the captions, not
 * the edit. What it must not do is lose them silently, so every degradation
 * comes back as a note that reaches the job record and the user.
 */
import type { EditOperation, EditPlan, Platform } from "@workspace/api-zod";
import { buildCaptionCues, emphasisPoints } from "./captions";
import { captionLayout } from "./caption-layout";
import { faceById } from "@workspace/api-zod/fonts";
import { defaultHeightFor, frameFor, shapeFor, probeDuration } from "./ffmpeg";
import { missingCapabilityNotes, type Providers } from "./providers";
import { measureStyle, styleToSettings } from "./style-measure";
import { applyReferenceStyle } from "./reference-style";
import type { Transcript } from "./providers/types";
import { sayIn, type Language } from "./say";

/**
 * How wide one caption line may be, as a single budget for a whole transcript.
 *
 * The grouping is one number; the wrap re-measures per cue in that cue's own
 * face and, where the two disagree, truncates rather than spills. So the budget
 * is taken against the **wider** of the font's two faces — its Latin and its
 * Arabic, either of which may be the default this font does not itself cover.
 * Against the Latin face alone, an Arabic line grouped to fit Latin overflowed
 * the wrap whenever the Arabic face ran wider, and lost its last words to an
 * ellipsis: measured at a third to three-quarters of Arabic captions. The wider
 * face makes the group fit whichever face draws it — a Latin line then has a
 * little room to spare, which the wrap fills, and nothing is truncated.
 *
 * Exported because it is the piece with the decision in it, and the only way to
 * be sure grouping and wrapping agree is to measure a real cue through both.
 */
export function captionLineBudget(
  layout: { usableWidth: number; capHeight: number },
  font: string | undefined,
): number {
  return (
    layout.usableWidth /
    layout.capHeight /
    Math.max(faceById(font, "latin").widthScale, faceById(font, "arabic").widthScale)
  );
}

export interface EnrichResult {
  plan: EditPlan;
  notes: string[];
  /** Kept so later steps can reuse it rather than paying for it twice. */
  transcript: Transcript | null;
}

export interface EnrichOptions {
  providers: Providers;
  /** The language every note this returns is written in. Absent means English. */
  language?: Language;
  onProgress?: (stage: string) => void;
  /** Overridable so tests do not need a key. */
  now?: () => number;
  /**
   * A local copy of the video whose look this edit should match, when the
   * project has one and the plan allows it.
   *
   * It is read here rather than in the renderer for the same reason the
   * transcript is: this is where a plan meets the files it was written without
   * having seen. By the time the renderer runs, a plan should be final.
   */
  referencePath?: string | null;
}

export async function enrichPlan(
  mediaPath: string,
  plan: EditPlan,
  options: EnrichOptions,
): Promise<EnrichResult> {
  const { providers } = options;
  const t = sayIn(options.language);
  const notes: string[] = [];

  const wantsCaptions = plan.operations.some((op) => op.type === "autoCaptions");
  // An empty `at` is the plan saying "you choose" — the renderer would
  // otherwise spread punches evenly, which is the automatic look we are trying
  // not to have.
  //
  // A *beat* punch is the exception, and it looks identical from here: its `at`
  // is empty for the same reason, and for an entirely different one. The
  // renderer fills those from the track's beat grid, which is decoded from the
  // audio and owes nothing to what was said — so a beat-synced edit that asked
  // for nothing else would pay a transcription provider, wait on it, and throw
  // the words away. Worse, when the provider is down it would answer "we could
  // not hear the words in this clip, so this render has no captions" on a
  // render that never wanted any.
  //
  // The same predicate lives in the API's `start-render.ts`, which decides the
  // other meaning of an empty list. Written out in both rather than shared,
  // because the two deploy separately and a package between them for one
  // condition would be a build dependency for a line.
  const wantsChosenPunches = plan.operations.some(
    (op) => op.type === "zoomPunch" && op.on !== "beat" && op.at.length === 0,
  );
  // A highlight is chosen from the words: without them the renderer falls
  // back to the middle of the clip, which is a guess, not a judgement.
  const wantsHighlight = plan.operations.some((op) => op.type === "extractHighlight");
  // Clips are placed by the same speech-density judgement the highlight uses,
  // so a clips plan wants ears for the same reason a highlight plan does.
  const wantsClips = plan.operations.some((op) => op.type === "extractClips");
  const needsTranscript = wantsCaptions || wantsChosenPunches || wantsHighlight || wantsClips;
  // Read up here rather than beside the vision call below, because what the
  // render can say about its own capabilities is decided once, in one place.
  const cutsSilence = plan.operations.some((op) => op.type === "removeSilence");

  /*
   * What this deployment could not bring to this plan, said once.
   *
   * These two conditions used to be written out here as `else if` branches on
   * whether a provider existed, which is the same test `missingCapabilityNotes`
   * already makes, and the copy left one of its three notes behind: the
   * cross-check. With one speech model configured instead of two, captions rest
   * on a single reading rather than two that agree, and the function has said
   * so since it was written. Nothing called it. It was exported, covered by
   * two suites, and unreachable from the product, so the sentence had never
   * once reached a person.
   *
   * That is why it is a call now and not two branches. The duplicate was not
   * wrong when it was written; it was wrong the moment a third note was added
   * next door and nobody thought to add it here too.
   */
  notes.push(...missingCapabilityNotes(providers.status, { transcript: needsTranscript, vision: cutsSilence }, t));

  let transcript: Transcript | null = null;

  if (needsTranscript && providers.transcriber) {
    options.onProgress?.("Listening to what was said");
    const language = plan.operations.find((op) => op.type === "autoCaptions")?.language;
    try {
      // The language of the request travels with it as a *belief*, not an
      // instruction: whoever wrote in Arabic probably filmed in Arabic, and a
      // provider whose detector cannot name Arabic has nothing better to go
      // on. A provider that can detect the language ignores this and detects,
      // because a working detector beats an assumption — and because two
      // models handed the same answer stop being a cross-check.
      transcript = await providers.transcriber.transcribe(mediaPath, {
        ...(language ? { language } : {}),
        ...(options.language ? { expected: options.language } : {}),
        /*
          Speaker labels, and only for the plan that can use them.

          Both providers have implemented `diarize` since the day this folder
          was written and nothing has ever set it, so the capability has been
          built, tested and unreachable — which is the same shape as the note
          nothing called and the operation no sentence could ask for. It is
          switched on here rather than everywhere because it costs more at the
          provider and buys nothing on a single talking head: what it buys is
          the one boundary a conversation has that a pause does not, the moment
          the *other* person stopped, and only `extractClips` cuts on that.
        */
        ...(wantsClips ? { diarize: true } : {}),
      });
      // How the words were arrived at is part of what was done to the video.
      // A transcript that was corroborated and one that was not are worth
      // different amounts, and only one of them can say so.
      notes.push(...(transcript.notes ?? []));

      // Which language was heard — but only when it is not the one they wrote
      // in.
      //
      // Captions in the wrong language are the one failure that looks
      // completely normal from here: the render succeeds, the words are
      // confident, the timings are right, and the file is wrong. So it is
      // worth a line. But a note is for something worth knowing, and telling
      // somebody who typed English that we heard English is noise — and a
      // pipeline that produces a note when nothing deviated has stopped being
      // able to say when something did.
      //
      // A mismatch is the whole signal: they wrote Arabic and we heard
      // English, which is either a detector that slipped or a clip that is not
      // the one they meant.
      const heard = transcript.language?.toLowerCase().split(/[-_]/)[0];
      if (!language && heard && heard !== (options.language ?? "en")) {
        notes.push(
          t(
            `heard the speech as ${heard}. Name the language if that is wrong and the captions will follow it`,
            `سمعت الكلام على أنه ${heard}، سمِّ اللغة إن كان ذلك خطأً وستتبعها الترجمة`,
          ),
        );
      }
    } catch (error) {
      // A provider being down is not a reason to fail someone's render.
      const excuse = visionExcuse(error);
      notes.push(
        t(
          `we could not hear the words in this clip${excuse.en}, so this render has no captions`,
          `لم نستطع سماع الكلام في هذا المقطع${excuse.ar}، فهذا التصيير بلا كابشن`,
        ),
      );
    }
  }

  // What only someone who watched the video could know: where a demo is
  // running, where a beat is being held. Silence detection hears all of those
  // as dead air, and cutting one out does not read as a tight edit — it reads
  // as a broken video. Read only when the plan actually cuts silence, because
  // that is the only decision it changes.
  let protect: Array<{ startMs: number; endMs: number }> = [];
  if (cutsSilence && providers.sceneReader) {
    options.onProgress?.("Watching for anything that shouldn't be cut");
    try {
      const scenes = await providers.sceneReader.read(mediaPath);
      protect = scenes
        .filter((scene) => scene.protect && scene.endMs > scene.startMs)
        .map((scene) => ({ startMs: scene.startMs, endMs: scene.endMs }))
        // The schema caps this, and a plan that wanted to protect sixty
        // separate stretches is describing a video with nothing to cut.
        .slice(0, 60);
      if (protect.length > 0) {
        notes.push(
          t(
            `${protect.length} ${protect.length === 1 ? "stretch is" : "stretches are"} quiet because something is happening on screen, not because nothing is, so ${protect.length === 1 ? "it was" : "they were"} left in`,
            `${protect.length} فترة هادئة لأن شيئًا يحدث على الشاشة، لا لأن لا شيء يحدث، فأُبقيت`,
          ),
        );
      }
    } catch (error) {
      // Not reading the video costs a worse cut, not a failed render.
      //
      // These sentences end up in the person's chat, word for word, so the
      // *reason* has to be one a person can do something with. "gemini upload
      // start 429" is a log line, not a sentence — it leaked into the product
      // once, verbatim, and taught us that anything pushed onto `notes` is
      // copy, not telemetry. The raw error still goes to the log, where it is
      // for the people it is for.
      const excuse = visionExcuse(error);
      notes.push(
        t(
          `we could not watch this clip for things worth keeping${excuse.en}, so the cut is from the audio alone`,
          `لم نستطع مشاهدة هذا المقطع بحثًا عمّا يستحقّ الإبقاء${excuse.ar}، فالقصّ من الصوت وحده`,
        ),
      );
    }
  }

  const operations: EditOperation[] = [];

  for (const operation of plan.operations) {
    if (operation.type === "removeSilence" && protect.length > 0) {
      operations.push({ ...operation, protect });
      continue;
    }

    if (operation.type === "autoCaptions") {
      if (!transcript) continue; // The reason is already in `notes`.
      // Group the words for the space the target platform actually leaves, so
      // the grouping and the final wrap agree instead of fighting each other.
      const platform = platformOf(plan);
      const layout = captionLayout(referenceFrameFor(platform), platform);
      const cues = buildCaptionCues(transcript, {
        dropFillers: operation.dropFillers,
        maxCharsPerLine: layout.maxCharsPerLine,
        // The same width, in the same unit, that `wrapToLayout` breaks on.
        // The character count above is kept as the fallback for a caller with
        // no layout; when both are present the measurement wins, so grouping
        // and wrapping cannot disagree about the same sentence and truncate a
        // caption between them.
        /*
          Divided by the chosen face's width, because the grouping has to fit
          the same line the wrap will draw. A condensed face fits a third more
          on a line; grouping against Montserrat's width and drawing in Anton
          leaves a third of every line empty, and grouping against Anton's while
          drawing in Archivo Black overflows the safe area. Neither fails.

          The *wider* of the two faces — see `captionLineBudget`. Budgeting
          against the Latin face alone truncated a third to three-quarters of
          Arabic captions.
        */
        lineWidthInCaps: captionLineBudget(layout, operation.font),
        maxLines: layout.maxLines,
      });
      if (cues.length === 0) {
        notes.push(
          t("no speech was found in this clip, so there is nothing to caption", "لم يُعثر على كلام في هذا المقطع، فلا شيء يُكتب"),
        );
        continue;
      }
      operations.push({
        type: "burnCaptions",
        cues: cues.map((cue) => ({
          startMs: cue.startMs,
          endMs: cue.endMs,
          text: cue.text,
          words: cue.words,
        })),
        style: operation.style,
        /*
          The animation is passed through, karaoke included.

          The comment that used to sit here said this line refused karaoke when
          there were no word timings, and it did not — it has always passed the
          animation straight down. The refusal is real but it lives one layer
          on, in `animateCue`, which takes the karaoke branch only for a cue
          that actually carries words and falls back to a plain fade for one
          that does not. Right behaviour, wrong address: a comment describing a
          guard that is not on the line under it is worse than no comment,
          because the next person reads it instead of the code.
        */
        animation: operation.animation,
        ...(operation.font ? { font: operation.font } : {}),
        ...(operation.fontArabic ? { fontArabic: operation.fontArabic } : {}),
      });
      continue;
    }

    if (operation.type === "zoomPunch" && operation.at.length === 0 && transcript) {
      const at = emphasisPoints(transcript);
      if (at.length > 0) {
        operations.push({ ...operation, at });
        continue;
      }
      notes.push(
        t(
          "the delivery was even, so punches were left out rather than placed arbitrarily",
          "كان الإلقاء متساويًا، فتُركت التقريبات بدل وضعها اعتباطًا",
        ),
      );
      continue;
    }

    operations.push(operation);
  }

  // The reference is applied last, once the plan is otherwise final: it sets
  // the numbers inside decisions already made, so it needs those decisions to
  // have been made — including the punch moments the transcript just chose.
  let shaped = operations;
  if (options.referencePath) {
    options.onProgress?.("Reading the video you want to match");
    try {
      const [reference, own] = await Promise.all([
        measureStyle(options.referencePath),
        // The user's own footage, so the grade is a comparison rather than a
        // guess: the same saturation reading is a lift for flat log footage and
        // a cut for something already graded.
        measureStyle(mediaPath).catch(() => undefined),
      ]);
      // The full length of the user's own footage, not the two-minute sample
      // window and never the reference's length: the punch budget is spread
      // over the whole source. `own.sourceSeconds` is that length for free when
      // the footage was measured; a direct probe is the fallback when it was
      // not, because the reference's duration says nothing about the source's.
      const sourceSeconds =
        own?.sourceSeconds ?? (await probeDuration(mediaPath).catch(() => reference.sourceSeconds));
      const applied = applyReferenceStyle(shaped, styleToSettings(reference, own), {
        reference,
        sourceSeconds,
        language: options.language,
      });
      shaped = applied.operations;
      notes.push(...applied.notes);
    } catch (error) {
      // A reference we could not read is a worse edit, not a failed one. The
      // plan the user asked for still renders.
      const excuse = visionExcuse(error);
      notes.push(
        t(
          `we could not read the video you asked us to match${excuse.en}, so this is edited to the plan alone`,
          `لم نستطع قراءة الفيديو الذي طلبت مطابقته${excuse.ar}، فهذا مُعدَّل على الخطّة وحدها`,
        ),
      );
    }
  }

  // A plan can be emptied by all of the above — captions with no recogniser and
  // punches with nothing to punch on. Rendering nothing is worse than not
  // rendering, so we say so and let the caller decide.
  return { plan: { version: 1, operations: shaped } as EditPlan, notes, transcript };
}

/**
 * The frame this plan will actually be rendered into.
 *
 * This was a constant, `{1080, 1920}`, under a comment saying "all three
 * targets are 9:16" — true when the targets were TikTok, Reels and Shorts, and
 * false from the moment YouTube and square were added to `Platform`. Nothing
 * announced the change: the words were grouped for a 9:16 box and burned into a
 * 16:9 one, and the renderer's re-wrap — described here as the safety net that
 * "catches an unusual export" — caught it by silently cutting each cue down to
 * its first line and appending an ellipsis.
 *
 * A safety net that discards two thirds of the words without saying so is not a
 * safety net. It still runs, because the real output can differ from the
 * default height; it just is not asked to do the grouping's job any more.
 *
 * Derived from the same functions the renderer uses to pick its frame, so the
 * two cannot answer differently.
 */
function referenceFrameFor(platform: Platform | null): { width: number; height: number } {
  const shape = shapeFor(platform);
  const { w, h } = frameFor(defaultHeightFor(shape), shape);
  return { width: w, height: h };
}

function platformOf(plan: EditPlan): Platform | null {
  const reframe = plan.operations.find((op) => op.type === "formatForPlatform");
  return reframe && reframe.type === "formatForPlatform" ? reframe.platform : null;
}

/**
 * What a provider's failure is allowed to say to the person who uploaded the
 * video.
 *
 * These strings go into `notes`, which is persisted on the job row and returned
 * verbatim to the browser — and `index.ts` promotes `notes[0]` into the render's
 * whole failure message when a plan ends up empty. The provider errors are
 * thrown as `"<provider> <status>: <their response body>"`, so without this the
 * customer's explanation of their own render read:
 *
 *   speech recognition failed (deepgram 401: {"err_code":"INVALID_AUTH",
 *   "err_msg":"Project does not have access to this feature"}), so this
 *   render has no captions
 *
 * `providers/index.ts` states plainly that provider detail never reaches a job
 * record. Who failed and how are the two facts that make the note honest; their
 * JSON is ours to read in the log, not theirs to receive.
 */
/**
 * The failure, phrased for the person whose chat it lands in.
 *
 * Two duties pull on this sentence and models-test.mjs holds both. The note
 * must stay *honest*: who failed and with what status are what let a person —
 * or support — tell "their key is wrong" from "the service was down", so the
 * provider's name and the bare status survive. And it must not become a
 * *conduit*: the provider's error codes, prose, request ids and JSON are ours
 * to read in a log, not the customer's to puzzle over. "gemini upload start
 * 429", verbatim in a chat bubble, was the second failure; a note scrubbed of
 * everything was the first. This keeps the noun and the number, drops the
 * rest, and glosses the one status a person can act on (429: try again
 * later). A message not shaped like a provider status passes through capped,
 * because truncating it to nothing would say even less.
 */
/**
 * Why a provider could not answer, in words, in both languages.
 *
 * Two things were wrong with the single string this used to return.
 *
 * It was English, and it was pasted into the Arabic half of every note that
 * used it. `say.ts` makes both halves required arguments precisely so that a
 * note cannot be written English-only, and a template hole filled from one
 * language walks around that guarantee at the seam: an Arabic customer read
 * «لم نستطع سماع الكلام في هذا المقطع this time (…)». Returning a pair puts
 * the two halves back under the same rule as every other sentence here.
 *
 * And its fallback pasted 120 characters of the raw error into a note. The
 * comment at the call site says, in as many words, that anything pushed onto
 * `notes` is copy rather than telemetry, and that a raw provider line leaked
 * into the product once already. It was still leaking, from three lines lower
 * down: a customer whose transcription failed for an unshaped reason was shown
 * `[in#0 @ 0x55bd6a269f00] Error opening input: No such file or directory`,
 * memory address and all. A provider and a status code are facts a person can
 * act on ("it was overloaded, try again"); anything else we could not shape
 * into a sentence is a log line, and the log already has it.
 */
function visionExcuse(error: unknown): { en: string; ar: string } {
  const message = (error instanceof Error ? error.message : String(error)).split("\n")[0];
  const shaped = message.match(/^([a-z][a-z0-9_-]*)(?:\s+[a-z0-9 _-]*?)?\s+(\d{3})\b/i);
  if (shaped) {
    const [, provider, status] = shaped;
    if (status === "429") {
      return {
        en: ` this time (${provider} answered ${status}: it was overloaded, and later usually works)`,
        ar: ` هذه المرّة (أجاب ${provider} بالرمز ${status}: كان محمّلًا فوق طاقته، وغالبًا ينجح لاحقًا)`,
      };
    }
    return {
      en: ` this time (${provider} answered ${status})`,
      ar: ` هذه المرّة (أجاب ${provider} بالرمز ${status})`,
    };
  }
  // A deadline is the one unshaped failure that means something to a person:
  // it says the provider was reached and did not answer, which is different
  // from being refused, and it is the case where "try again" is the right
  // advice. It is recognised and said in words rather than passed through,
  // because passing it through would put an English clause inside an Arabic
  // sentence for the sake of four words.
  if (/\b(?:no response within|timed? ?out|timeout|ETIMEDOUT|AbortError)\b/i.test(message)) {
    return {
      en: " this time (it did not answer in time, and later usually works)",
      ar: " هذه المرّة (لم يُجب في الوقت المتاح، وغالبًا ينجح لاحقًا)",
    };
  }

  return { en: " this time", ar: " هذه المرّة" };
}
