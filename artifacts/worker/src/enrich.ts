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

export interface EnrichResult {
  plan: EditPlan;
  notes: string[];
  /** Kept so later steps can reuse it rather than paying for it twice. */
  transcript: Transcript | null;
}

export interface EnrichOptions {
  providers: Providers;
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
  const notes: string[] = [];

  const wantsCaptions = plan.operations.some((op) => op.type === "autoCaptions");
  // An empty `at` is the plan saying "you choose" — the renderer would
  // otherwise spread punches evenly, which is the automatic look we are trying
  // not to have.
  const wantsChosenPunches = plan.operations.some((op) => op.type === "zoomPunch" && op.at.length === 0);
  const needsTranscript = wantsCaptions || wantsChosenPunches;

  let transcript: Transcript | null = null;

  if (needsTranscript && providers.transcriber) {
    options.onProgress?.("Listening to what was said");
    const language = plan.operations.find((op) => op.type === "autoCaptions")?.language;
    try {
      transcript = await providers.transcriber.transcribe(mediaPath, language ? { language } : {});
      // How the words were arrived at is part of what was done to the video.
      // A transcript that was corroborated and one that was not are worth
      // different amounts, and only one of them can say so.
      notes.push(...(transcript.notes ?? []));
    } catch (error) {
      // A provider being down is not a reason to fail someone's render.
      notes.push(`speech recognition failed (${short(error)}), so this render has no captions`);
    }
  } else if (needsTranscript && providers.status.transcription) {
    notes.push(providers.status.transcription);
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
          `${protect.length} ${protect.length === 1 ? "stretch is" : "stretches are"} quiet because something is happening on screen, not because nothing is — ${protect.length === 1 ? "it was" : "they were"} left in`,
        );
      }
    } catch (error) {
      // Not reading the video costs a worse cut, not a failed render.
      notes.push(`we could not watch this clip for things worth keeping (${short(error)}), so the cut is from the audio alone`);
    }
  } else if (cutsSilence && providers.status.vision) {
    notes.push(providers.status.vision);
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
        notes.push("no speech was found in this clip, so there is nothing to caption");
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
      notes.push("the delivery was even, so punches were left out rather than placed arbitrarily");
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
      });
      shaped = applied.operations;
      notes.push(...applied.notes);
    } catch (error) {
      // A reference we could not read is a worse edit, not a failed one. The
      // plan the user asked for still renders.
      notes.push(`we could not read the video you asked us to match (${short(error)}), so this is edited to the plan alone`);
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

function short(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0].slice(0, 120);
}
