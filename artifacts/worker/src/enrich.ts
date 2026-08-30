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
import type { Providers } from "./providers";
import { measureStyle, styleToSettings } from "./style-measure";
import { applyReferenceStyle } from "./reference-style";
import type { Transcript } from "./providers/types";
import { pick, sayIn, type Language } from "./say";

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
            `heard the speech as ${heard} — name the language if that is wrong and the captions will follow it`,
            `سمعت الكلام على أنه ${heard} — سمِّ اللغة إن كان ذلك خطأً وستتبعها الترجمة`,
          ),
        );
      }
    } catch (error) {
      // A provider being down is not a reason to fail someone's render.
      notes.push(
        t(
          `we could not hear the words in this clip${visionExcuse(error)}, so this render has no captions`,
          `لم نستطع سماع الكلام في هذا المقطع${visionExcuse(error)}، فهذا التصيير بلا كابشن`,
        ),
      );
    }
  } else if (needsTranscript && providers.status.transcription) {
    notes.push(pick(t, providers.status.transcription));
  }

  // What only someone who watched the video could know: where a demo is
  // running, where a beat is being held. Silence detection hears all of those
  // as dead air, and cutting one out does not read as a tight edit — it reads
  // as a broken video. Read only when the plan actually cuts silence, because
  // that is the only decision it changes.
  let protect: Array<{ startMs: number; endMs: number }> = [];
  const cutsSilence = plan.operations.some((op) => op.type === "removeSilence");
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
            `${protect.length} ${protect.length === 1 ? "stretch is" : "stretches are"} quiet because something is happening on screen, not because nothing is — ${protect.length === 1 ? "it was" : "they were"} left in`,
            `${protect.length} فترة هادئة لأن شيئًا يحدث على الشاشة، لا لأن لا شيء يحدث — فأُبقيت`,
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
      notes.push(
        t(
          `we could not watch this clip for things worth keeping${visionExcuse(error)}, so the cut is from the audio alone`,
          `لم نستطع مشاهدة هذا المقطع بحثًا عمّا يستحقّ الإبقاء${visionExcuse(error)}، فالقصّ من الصوت وحده`,
        ),
      );
    }
  } else if (cutsSilence && providers.status.vision) {
    notes.push(pick(t, providers.status.vision));
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
      const layout = captionLayout(REFERENCE_FRAME, platformOf(plan));
      const cues = buildCaptionCues(transcript, {
        dropFillers: operation.dropFillers,
        maxCharsPerLine: layout.maxCharsPerLine,
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
        // Karaoke without word timings is a lie about the rhythm; the schema
        // allows it, so refuse it here rather than letting it render wrong.
        animation: operation.animation,
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
      const applied = applyReferenceStyle(shaped, styleToSettings(reference, own), {
        reference,
        sourceSeconds: own?.sampledSeconds ?? reference.sampledSeconds,
        language: options.language,
      });
      shaped = applied.operations;
      notes.push(...applied.notes);
    } catch (error) {
      // A reference we could not read is a worse edit, not a failed one. The
      // plan the user asked for still renders.
      notes.push(
        t(
          `we could not read the video you asked us to match${visionExcuse(error)}, so this is edited to the plan alone`,
          `لم نستطع قراءة الفيديو الذي طلبت مطابقته${visionExcuse(error)}، فهذا مُعدَّل على الخطّة وحدها`,
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
 * All three targets are 9:16, so one reference frame is enough to decide how
 * many characters fit on a line. The renderer re-wraps against the real output
 * size before burning, which is what catches an unusual export.
 */
const REFERENCE_FRAME = { width: 1080, height: 1920 };

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
function visionExcuse(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).split("\n")[0];
  const shaped = message.match(/^([a-z][a-z0-9_-]*)(?:\s+[a-z0-9 _-]*?)?\s+(\d{3})\b/i);
  if (shaped) {
    const [, provider, status] = shaped;
    const gloss = status === "429" ? " — it was overloaded, and later usually works" : "";
    return ` this time (${provider} answered ${status}${gloss})`;
  }
  return ` this time (${message.slice(0, 120)})`;
}

function short(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split("\n")[0];
  const shaped = firstLine.match(/^([a-z][a-z0-9 _-]*?\s+\d{3})\b/i);
  if (shaped) return shaped[1];
  return firstLine.slice(0, 120);
}
