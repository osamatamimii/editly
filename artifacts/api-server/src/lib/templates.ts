/**
 * Named looks.
 *
 * A template is nothing more exotic than a saved edit plan. That is the whole
 * reason to have made the plan declarative: "make it like a Hormozi clip" is
 * not a prompt to be interpreted, it is a set of operations somebody already
 * chose, and the result is identical every time.
 *
 * Each of these was tuned against real footage rather than guessed. The numbers
 * are the interesting part — they are what separates motion that reads as
 * deliberate from motion that reads as a bug.
 */
import type { EditOperation, Platform } from "@workspace/api-zod";

export interface Template {
  id: string;
  name: string;
  /** One line, shown on the button. Says what it does, not how it feels. */
  description: string;
  /** Best suited to this kind of footage. */
  bestFor: string;
  /**
   * A file this look cannot be built without.
   *
   * Only one template has ever needed one, and it is the reason this field
   * exists rather than a boolean buried in `build`: a look that cuts to a track
   * has nothing to cut to in a project with no track, and the two dishonest
   * answers are both easy to reach by accident. It could quietly place its
   * punches on the speaker's emphasis instead — an edit nobody asked for,
   * wearing the name of one they did — or it could return an empty operation
   * list and render a video that is identical to the one that went in. So the
   * requirement is data: the route refuses before anything is queued, and the
   * button says what is missing.
   */
  needs?: "music";
  build: (context: TemplateContext) => EditOperation[];
}

export interface TemplateContext {
  platform: Platform;
  /**
   * Seconds, or null when nobody has measured the file yet.
   *
   * Null is not a missing value to be defaulted. It used to be filled in with
   * 30, which meant a template placed its punches as though every video were
   * half a minute long — on a ten-minute talk, four zooms in the first twenty
   * seconds and nothing after. An empty `at` is the better answer: it tells the
   * worker to choose the moments from the speech itself, which is what it would
   * rather do anyway.
   */
  durationSeconds: number | null;
  /** Free plans carry the mark. */
  watermark: boolean;
  /**
   * The track to lay under the edit, or null when this project has no audio.
   *
   * Null reaches only the one template that declares `needs: "music"`, because
   * the route refuses that template before calling it — so `build` never has to
   * decide what a beat-cut look means without a beat.
   */
  musicAssetId: string | null;
}

function withWatermark(operations: EditOperation[], context: TemplateContext): EditOperation[] {
  if (!context.watermark) return operations;
  return [...operations, { type: "watermark", text: "Edited with Editly", position: "bottom-right" }];
}

/**
 * Punches placed at even intervals through the clip, skipping the first and
 * last couple of seconds — a zoom on the opening frame fights the hook, and one
 * on the final frame lands after anyone has stopped watching.
 */
export function evenlySpacedPunches(durationSeconds: number | null, count: number): number[] {
  // "We do not know how long this is" and "this is 30 seconds" are different
  // claims, and only one of them is ever true. Handing back an empty list makes
  // the worker pick the emphasis from the transcript instead of from a guess.
  if (durationSeconds == null || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return [];
  const start = 2;
  const end = Math.max(start + 1, durationSeconds - 2);
  if (end <= start) return [];
  const step = (end - start) / (count + 1);
  return Array.from({ length: count }, (_, i) => Number((start + step * (i + 1)).toFixed(2)));
}

export const TEMPLATES: Template[] = [
  {
    id: "tight-talking-head",
    name: "Tight talking head",
    description: "Cuts every pause, pushes in slowly, levels the audio.",
    bestFor: "One person to camera",
    build: (context) =>
      withWatermark(
        [
          { type: "removeSilence", thresholdDb: -32, minSilenceMs: 400, paddingMs: 70 },
          { type: "formatForPlatform", platform: context.platform },
          // A locked-off camera plus a slow push is the entire look. 1.08 over
          // the clip is roughly a percent every few seconds — felt, not seen.
          { type: "kenBurns", to: 1.08 },
          { type: "normalizeLoudness", targetLufs: -14 },
        ],
        context,
      ),
  },
  {
    id: "high-energy",
    name: "High energy",
    description: "Aggressive silence cuts and punch-in zooms throughout.",
    bestFor: "Rants, reactions, anything fast",
    build: (context) =>
      withWatermark(
        [
          // 250ms is short enough to remove the breath between sentences, which
          // is what makes this style feel relentless.
          { type: "removeSilence", thresholdDb: -30, minSilenceMs: 250, paddingMs: 40 },
          { type: "formatForPlatform", platform: context.platform },
          {
            type: "zoomPunch",
            // Named moments, so "choose for me" never comes up — but the field
            // is not optional, and a template that leaves it to a default is a
            // template that changes meaning the day the default does.
            on: "emphasis",
            at: evenlySpacedPunches(context.durationSeconds, 4),
            amount: 0.14,
            holdMs: 900,
          },
          { type: "normalizeLoudness", targetLufs: -13 },
        ],
        context,
      ),
  },
  {
    id: "clean-cut",
    name: "Clean cut",
    description: "Silence removed and reframed. Nothing else touched.",
    bestFor: "Footage that already looks how you want",
    build: (context) =>
      withWatermark(
        [
          { type: "removeSilence", thresholdDb: -34, minSilenceMs: 700, paddingMs: 120 },
          { type: "formatForPlatform", platform: context.platform },
          { type: "normalizeLoudness", targetLufs: -14 },
        ],
        context,
      ),
  },
  {
    id: "the-look",
    name: "The look",
    description: "Cuts the pauses, dissolves between them, and grades it cinematic.",
    bestFor: "A take you want to look produced rather than recorded",
    build: (context) =>
      withWatermark(
        [
          // The order here is the order the renderer applies them in, and two
          // of these only make sense together. The silence cut is what creates
          // the joins; the transition is what makes those joins stop reading as
          // jump cuts. A dissolve on an uncut video has nothing to join and
          // says so, which is why this template never ships one without the
          // other.
          { type: "removeSilence", thresholdDb: -34, minSilenceMs: 700, paddingMs: 120 },
          // 220ms: long enough to read as a dissolve rather than a glitch,
          // short enough that a one-second piece is still on screen by itself.
          // The renderer shortens it further on pieces too short to carry it.
          { type: "transition", style: "dissolve", durationMs: 220 },
          { type: "formatForPlatform", platform: context.platform },
          // The grade goes on the picture and not on what is drawn over it, so
          // the captions below stay white rather than drifting with the look.
          { type: "grade", saturation: 1, look: "cinematic" },
          { type: "autoCaptions", style: "bold-white", animation: "pop", dropFillers: true },
          { type: "normalizeLoudness", targetLufs: -14 },
        ],
        context,
      ),
  },
  {
    id: "the-highlight",
    name: "The highlight",
    description: "Keeps only the strongest 30 seconds, reframed and captioned.",
    bestFor: "Long takes you want one clip from",
    build: (context) =>
      withWatermark(
        [
          // The worker chooses the window from the speech; the silences are
          // then cut inside it, so "the strongest 30 seconds" means the
          // strongest 30 of source — arriving a touch tighter than 30.
          { type: "extractHighlight", targetSeconds: 30 },
          { type: "removeSilence", thresholdDb: -34, minSilenceMs: 700, paddingMs: 120 },
          { type: "formatForPlatform", platform: context.platform },
          // A highlight exists to be posted, and posted clips get read with
          // the sound off. Captions are the look, not an accessory to it.
          { type: "autoCaptions", style: "bold-white", animation: "pop", dropFillers: true },
          { type: "normalizeLoudness", targetLufs: -14 },
        ],
        context,
      ),
  },
  {
    id: "three-clips",
    name: "Three clips",
    description: "Cuts the take into three posts, each captioned and titled by what is said in it.",
    bestFor: "One long recording, a week of posting",
    build: (context) =>
      withWatermark(
        [
          // The one look that produces several files. Thirty seconds each
          // because that is what these platforms reward, and three because
          // a long take rarely holds more than three moments worth posting
          // — the worker returns fewer rather than padding to a number.
          { type: "extractClips", count: 3, targetSeconds: 30 },
          { type: "removeSilence", thresholdDb: -34, minSilenceMs: 700, paddingMs: 120 },
          { type: "formatForPlatform", platform: context.platform },
          // Same reasoning as the highlight: a clip made to be posted is a
          // clip read with the sound off.
          { type: "autoCaptions", style: "bold-white", animation: "pop", dropFillers: true },
          { type: "normalizeLoudness", targetLufs: -14 },
          // Half a second at each end. A piece cut out of the middle of a
          // recording starts and stops mid-room; the fade is what makes it
          // read as a post rather than as an excerpt.
          { type: "fade", durationMs: 500 },
        ],
        context,
      ),
  },
  {
    id: "on-the-beat",
    name: "On the beat",
    description: "Lays your track under the cut and punches in on the bar.",
    bestFor: "B-roll, montages, anything with music",
    needs: "music",
    build: (context) =>
      withWatermark(
        [
          // The track first: everything below is timed against it, and the
          // worker reads the beat from the file this names.
          {
            type: "addMusic",
            // Never empty in practice: the route refuses this template before
            // building it when the project has no audio, which is what `needs`
            // is for. And if it ever were, the renderer says so out loud —
            // "the track this plan names is not in this project" — rather than
            // dropping the bed quietly. A fallback whose failure is visible is
            // a fallback; one whose failure is silent is a bug waiting.
            assetId: context.musicAssetId ?? "",
            gainDb: -14,
            duck: true,
            fadeSeconds: 1.5,
            fromSeconds: 0,
            loop: true,
          },
          { type: "removeSilence", thresholdDb: -32, minSilenceMs: 400, paddingMs: 70 },
          { type: "formatForPlatform", platform: context.platform },
          {
            type: "zoomPunch",
            on: "beat",
            // Deliberately empty, and the only template that leaves it so.
            // Every other look places its punches by arithmetic on the running
            // time; this one cannot, because where the beats are is a fact
            // about the audio and nothing here has heard it. The worker reads
            // the track, finds the grid, and fills these in — or finds no
            // steady pulse and says so in the notes rather than inventing one.
            at: [],
            // Bigger than the emphasis punches, and shorter. A punch on the bar
            // is a hit; a punch on a word is a lean.
            amount: 0.16,
            holdMs: 420,
          },
          // A flash on a cut that lands on the beat is the oldest music-video
          // trick there is, and it only works because the cut is already there:
          // the silence removal makes the joins, this makes them read.
          { type: "transition", style: "flash", durationMs: 140 },
          { type: "normalizeLoudness", targetLufs: -13 },
        ],
        context,
      ),
  },
  {
    id: "podcast-clip",
    name: "Podcast clip",
    description: "Keeps the natural rhythm, adds a gentle push and even levels.",
    bestFor: "Two people talking, longer takes",
    build: (context) =>
      withWatermark(
        [
          // A long threshold on purpose: cutting every pause out of a
          // conversation makes it sound like an argument.
          { type: "removeSilence", thresholdDb: -36, minSilenceMs: 900, paddingMs: 150 },
          { type: "formatForPlatform", platform: context.platform },
          { type: "kenBurns", to: 1.05 },
          { type: "normalizeLoudness", targetLufs: -14 },
        ],
        context,
      ),
  },
];

export function findTemplate(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
