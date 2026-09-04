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
  /*
    The same three, in Arabic.

    Required rather than optional, for the reason every pair in this repository
    is required: a template that *can* be added without its Arabic is one that
    *will* be, on the day somebody adds an eighth look in a hurry, and the
    symptom is one English card in a column of Arabic ones. `GET /templates`
    picks a side per request; nothing downstream knows there were two.

    The English keeps the plain field names because it is what
    `tools/combination-test.mjs` reads when it checks that a look which says it
    captions actually carries a caption operation. That check is about the words
    on the button matching the plan behind it, and it does that job in one
    language.
  */
  nameAr: string;
  descriptionAr: string;
  bestForAr: string;
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
  /**
   * The shortest source this look can honestly be built from.
   *
   * A look that lifts a clip out of a recording needs a recording to lift it
   * out of, and the two dishonest answers are both easy to reach by accident.
   * `three-clips` on a twenty-second upload queued a job and then failed deep
   * in the worker with an empty plan, after the person was already charged;
   * `the-highlight` and `podcast-clip` on a clip shorter than the window they
   * extract quietly returned the whole file with captions burned across it — a
   * correct render of an edit nobody can post, under a name that says the
   * opposite. So the length requirement is data, checked at the route before
   * anything is queued, the same as `needs`. Absent on a look that works at any
   * length.
   */
  needsSeconds?: number;
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

/**
 * The caption on a look that is meant to be posted.
 *
 * Not decoration and not an accessory: a talking clip in these feeds is read
 * with the sound off, and a look that produces a post without captions
 * produces something nobody can use. Three looks here did — the two built
 * around a person talking to camera, and the podcast one, which are between
 * them the most-used looks in the product.
 *
 * `karaoke` rather than `pop`, and that is a decision about information rather
 * than about taste. The pipeline already knows when each word was said — it
 * transcribes to write the captions in the first place — and `pop` throws that
 * away to scale the whole cue in at once. The wipe spends it: the colour
 * arrives with the voice, which is what holds somebody through a clip they are
 * watching muted. When word timings are genuinely missing the renderer falls
 * back to a plain fade rather than faking a rhythm, so this is never worse than
 * having asked for nothing.
 *
 * `dropFillers` throughout. "Um" burned onto a frame is the tell of a caption
 * nobody read before it went out.
 */
function captions(style: "bold-white" | "bold-yellow" | "karaoke-box") {
  return { type: "autoCaptions" as const, style, animation: "karaoke" as const, dropFillers: true };
}

export const TEMPLATES: Template[] = [
  {
    id: "tight-talking-head",
    name: "Tight talking head",
    nameAr: "لقطة مشدودة للوجه",
    description: "Cuts every pause, pushes in slowly, captions it, levels the audio.",
    descriptionAr: "يقصّ كل وقفة، ويقرّب ببطء، ويضيف الكابشن، ويعاير الصوت.",
    bestFor: "One person to camera",
    bestForAr: "شخص واحد أمام الكاميرا",
    build: (context) =>
      withWatermark(
        [
          { type: "removeSilence", thresholdDb: -32, minSilenceMs: 400, paddingMs: 70 },
          { type: "formatForPlatform", platform: context.platform },
          // A locked-off camera plus a slow push is the entire look. 1.08 over
          // the clip is roughly a percent every few seconds — felt, not seen.
          { type: "kenBurns", to: 1.08 },
          captions("bold-white"),
          { type: "normalizeLoudness", targetLufs: -14, voice: true },
        ],
        context,
      ),
  },
  {
    id: "high-energy",
    name: "High energy",
    nameAr: "إيقاع عالٍ",
    description: "Aggressive silence cuts, punch-in zooms and loud captions throughout.",
    descriptionAr: "قصّ حادّ للصمت، وتقريب مفاجئ، وكابشن عريض طوال المقطع.",
    bestFor: "Rants, reactions, anything fast",
    bestForAr: "الحماس والردود وكل ما هو سريع",
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
          // Yellow, because this look is the loud one and a caption that
          // matches it reads as one edit rather than as a caption laid over
          // somebody else's.
          captions("bold-yellow"),
          { type: "normalizeLoudness", targetLufs: -13, voice: true },
        ],
        context,
      ),
  },
  {
    id: "clean-cut",
    name: "Clean cut",
    nameAr: "قصّ نظيف",
    description: "Silence removed and reframed. Nothing else touched.",
    descriptionAr: "إزالة الصمت وإعادة التأطير. ولا شيء غير ذلك.",
    bestFor: "Footage that already looks how you want",
    bestForAr: "لقطات تبدو كما تريدها أصلًا",
    build: (context) =>
      withWatermark(
        [
          { type: "removeSilence", thresholdDb: -34, minSilenceMs: 700, paddingMs: 120 },
          { type: "formatForPlatform", platform: context.platform },
          // `voice: false` alone among the speech looks, and on purpose: this
          // one promises that nothing else is touched. Filtering under the
          // voice is almost always an improvement and it is still a change,
          // and a look whose whole claim is restraint does not get to make it.
          { type: "normalizeLoudness", targetLufs: -14, voice: false },
        ],
        context,
      ),
  },
  {
    id: "the-look",
    name: "The look",
    nameAr: "المظهر",
    // The captions were always here — the comment in the build below has
    // referred to them since it was written — and the sentence a person reads
    // did not mention them. An omission rather than a lie, and still a look
    // that does something to somebody's video without saying it would.
    description: "Cuts the pauses, dissolves between them, captions it, and grades it cinematic.",
    descriptionAr: "يقصّ الوقفات، ويذوّب بينها، ويضيف الكابشن، ويمنحه تدرّجًا سينمائيًّا.",
    bestFor: "A take you want to look produced rather than recorded",
    bestForAr: "تسجيل تريده أن يبدو منتَجًا لا مصوَّرًا",
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
          captions("bold-white"),
          { type: "normalizeLoudness", targetLufs: -14, voice: true },
        ],
        context,
      ),
  },
  {
    id: "the-highlight",
    needsSeconds: 45,
    name: "The highlight",
    nameAr: "أقوى جزء",
    description: "Keeps only the strongest 30 seconds, reframed and captioned.",
    descriptionAr: "يبقي أقوى 30 ثانية وحدها، مؤطَّرة ومع كابشن.",
    bestFor: "Long takes you want one clip from",
    bestForAr: "تسجيلات طويلة تريد منها مقطعًا واحدًا",
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
          captions("bold-white"),
          { type: "normalizeLoudness", targetLufs: -14, voice: true },
        ],
        context,
      ),
  },
  {
    id: "three-clips",
    needsSeconds: 90,
    name: "Three clips",
    nameAr: "ثلاثة مقاطع",
    description: "Cuts the take into three posts, each captioned and titled by what is said in it.",
    descriptionAr: "يقسّم التسجيل إلى ثلاثة منشورات، لكل واحد كابشن وعنوان ممّا قيل فيه.",
    bestFor: "One long recording, a week of posting",
    bestForAr: "تسجيل طويل واحد، وأسبوع من النشر",
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
          captions("bold-white"),
          { type: "normalizeLoudness", targetLufs: -14, voice: true },
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
    nameAr: "على الإيقاع",
    description: "Lays your track under the cut and punches in on the bar.",
    descriptionAr: "يضع مقطوعتك تحت التعديل ويقرّب على المازورة.",
    bestFor: "B-roll, montages, anything with music",
    bestForAr: "اللقطات الإضافية والمونتاج وكل ما فيه موسيقى",
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
          // No high-pass under a track. Below 80Hz there is room tone on a
          // talking clip and the bottom octave of a kick drum here, and this
          // is the one look somebody picked *for* the music.
          { type: "normalizeLoudness", targetLufs: -13, voice: false },
        ],
        context,
      ),
  },
  {
    id: "podcast-clip",
    needsSeconds: 60,
    name: "Podcast clip",
    nameAr: "مقطع بودكاست",
    description: "Finds the best 45 seconds of the conversation, captions it in a box, evens the levels.",
    descriptionAr: "يجد أفضل 45 ثانية من الحوار، ويضع الكابشن في صندوق، ويسوّي المستويات.",
    bestFor: "Two people talking, longer takes",
    bestForAr: "شخصان يتحاوران، وتسجيلات أطول",
    build: (context) =>
      withWatermark(
        [
          /*
            It has to cut something out, or it is not a clip.

            This look was the whole take, cleaned: point it at a ninety-minute
            episode — which is precisely what "longer takes" invites — and it
            returned a ninety-minute file with captions burned across all of
            it. Nothing failed; it is a correct render of an edit nobody can
            post, under a name that says the opposite.

            Forty-five rather than the thirty the other looks use, because a
            moment from a conversation needs the line before the good line.
          */
          { type: "extractHighlight", targetSeconds: 45 },
          // A long threshold on purpose: cutting every pause out of a
          // conversation makes it sound like an argument.
          { type: "removeSilence", thresholdDb: -36, minSilenceMs: 900, paddingMs: 150 },
          { type: "formatForPlatform", platform: context.platform },
          { type: "kenBurns", to: 1.05 },
          // The box, and only here. A podcast is shot in whatever room the
          // people are in — a bright window behind one of them, a white wall,
          // a lamp — and white letters with an outline are a gamble against
          // that. An opaque backing is the one caption style that cannot be
          // lost to the shot behind it, and this is the look most likely to be
          // pointed at footage nobody lit.
          captions("karaoke-box"),
          { type: "normalizeLoudness", targetLufs: -14, voice: true },
        ],
        context,
      ),
  },
];

export function findTemplate(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

/**
 * Whether a look can be built for this project, decided before anything is
 * queued or billed.
 *
 * Both refusals live here rather than in the route so the same rule is checked
 * in one place and can be tested without a database: a look that cuts to a
 * track and a project with no track, and a look that lifts a clip out of a
 * recording and a recording too short to lift one out of. A duration of `null`
 * is "not measured yet", not "too short" — it cannot fail this check, because
 * the failure it guards against is a false refusal as much as a false render.
 */
export function templatePreflight(
  template: Template,
  context: { durationSeconds: number | null; hasMusic: boolean },
): { ok: true } | { ok: false; reason: string; reasonAr: string } {
  if (template.needs === "music" && !context.hasMusic) {
    return {
      ok: false,
      reason: "This look cuts to a track, and this project has no audio file yet. Upload one and press it again.",
      reasonAr: "هذا الشكل يقصّ على مقطوعة، ولا يحمل هذا المشروع ملفًّا صوتيًّا بعد. ارفع واحدًا ثم أعد الضغط.",
    };
  }
  if (
    template.needsSeconds != null &&
    context.durationSeconds != null &&
    context.durationSeconds < template.needsSeconds
  ) {
    return {
      ok: false,
      reason:
        `"${template.name}" lifts a clip out of a longer recording, and this one is ` +
        `${Math.round(context.durationSeconds)}s, and it needs at least ${template.needsSeconds}s. ` +
        `Try a look built for shorter clips.`,
      reasonAr:
        `«${template.nameAr}» يلتقط مقطعًا من تسجيل أطول، وهذا طوله ` +
        `${Math.round(context.durationSeconds)} ثانية، ويحتاج ${template.needsSeconds} ثانية على الأقل. ` +
        `جرّب شكلًا مصمَّمًا للمقاطع القصيرة.`,
    };
  }
  return { ok: true };
}
