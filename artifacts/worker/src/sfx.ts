/**
 * Where the sounds go.
 *
 * Half of what makes a clip feel *made* is in the audio, and it is the half
 * nobody watching notices — which is exactly why it works. A cut with a breath
 * of air across it reads as a decision; the same cut dry reads as a file that
 * ended. Until this file existed the renderer had twenty operations and not one
 * of them put a sound anywhere.
 *
 * ## Why this is a pure function
 *
 * Nothing here opens a file, spawns anything or knows what ffmpeg is. It takes
 * a description of the finished edit — how long it runs, where the joins are,
 * where the punch-ins land — and returns a list of moments and file names. The
 * renderer turns that into inputs and a mix.
 *
 * That split is the same one `shots.ts` and `tighten.ts` are built on, and the
 * reason is testability: every threshold below can be checked in milliseconds
 * against a made-up timeline, so the suite that guards them does not need a
 * video. What ffmpeg then *does* with the list is a separate question, and
 * `sfx-test.mjs` answers it by measuring the sound that comes out — because a
 * check that reads a filter string passes a feature that is not there.
 *
 * ## Every threshold points at "do nothing"
 *
 * A sound effect layer fails in one direction. Too few is an edit that could
 * have been better; too many is an edit that is worse than silence, and the
 * person hears it immediately and cannot say why. Two whooshes 200ms apart do
 * not read as two accents, they read as a fault. So:
 *
 * - Nothing lands within `MIN_GAP` of another sound. The louder role wins.
 * - No more than one sound per `SECONDS_PER_CUE` of finished video, ever, and
 *   never more than `MAX_CUES`. On a forty-cut edit the joins are thinned by
 *   taking every n-th one rather than the first n, because accents on the first
 *   ten cuts and silence afterwards is worse than either.
 * - Nothing is placed where its own tail would be cut off by the end of the
 *   video: a truncated impact is a click.
 * - The riser is placed only if it fits *whole* before the moment it announces.
 *   Half a riser is a noise.
 *
 * ## The lead
 *
 * A sound on a cut starts slightly *before* the picture changes. That is not a
 * flourish, it is how the ear and the eye are actually put together: sound
 * arriving with the frame reads as late. 60ms is the number every editor uses
 * and it is small enough that it cannot move a sound onto the wrong side of
 * anything.
 */

/** What a sound is for. The role decides which moments it is eligible for. */
export type SfxRole = "whoosh" | "impact" | "riser" | "accent";

/**
 * How loud a layer, and made of what.
 *
 * Three, not a slider, and not a free-text style. A palette is a set of files
 * that were balanced against each other; a number between them would be a
 * promise this catalogue cannot keep.
 */
export type SfxPalette = "clean" | "punchy" | "quiet";

export interface SfxSound {
  /** File stem in `artifacts/worker/assets/sfx`, without the extension. */
  name: string;
  role: SfxRole;
  /** As built. The renderer needs it to know whether a cue fits before the end. */
  seconds: number;
  /**
   * A pull-back, never a boost.
   *
   * Every file ships peak-normalised to -3 dBFS, which is what lets one
   * `gainDb` in the plan mean the same thing whichever file is chosen. But peak
   * is not weight: a low sine rings for its whole length where a click is over
   * in twenty milliseconds, so at equal peaks the sine is twice the sound. These
   * numbers were measured — mean level of the file — and `sfx-test.mjs`
   * re-measures them, because a regenerated asset with a different envelope
   * would otherwise change the balance of the layer with nothing failing.
   */
  trimDb: number;
  /**
   * Where the sound's own moment is, measured from its first sample.
   *
   * `cue.at` is the instant the *file starts*, which is only the instant the
   * sound arrives for a sound that begins with its transient. Most of these do.
   * `whoosh-air` is a symmetric swell whose peak sits 0.44s in and which is 27
   * dB down at its own start — so placing its start 60ms before a cut put its
   * loudest point 380ms *after* the picture changed, which is the exact
   * failure `LEAD_SECONDS` exists to prevent, and it is one of the three files
   * the default palette rotates through on every cut.
   *
   * Measured per file rather than guessed, and re-measured by the suite, for
   * the same reason `trimDb` is: a regenerated asset with a different envelope
   * would otherwise move every accent in the product with nothing failing.
   *
   * A riser is the exception and the reason the field is called an anchor
   * rather than a peak: its moment is the hole at its end, where the climb
   * stops and the seam lands. So its anchor is its own length.
   */
  anchorSeconds: number;
}

/**
 * Everything in `artifacts/worker/assets/sfx`, and nothing else.
 *
 * A name here with no file behind it is a render that fails on an input ffmpeg
 * cannot open; a file there with no name here is dead weight in the image. The
 * suite checks the folder against this list in both directions.
 */
export const SFX_CATALOGUE: readonly SfxSound[] = [
  { name: "whoosh-soft", role: "whoosh", seconds: 0.55, trimDb: -1.5, anchorSeconds: 0.107 },
  { name: "whoosh-fast", role: "whoosh", seconds: 0.32, trimDb: 0, anchorSeconds: 0.032 },
  { name: "whoosh-down", role: "whoosh", seconds: 0.5, trimDb: 0, anchorSeconds: 0.064 },
  { name: "whoosh-air", role: "whoosh", seconds: 0.85, trimDb: -1.5, anchorSeconds: 0.443 },
  { name: "impact-soft", role: "impact", seconds: 0.5, trimDb: -1, anchorSeconds: 0 },
  { name: "impact-deep", role: "impact", seconds: 0.9, trimDb: -2, anchorSeconds: 0 },
  { name: "impact-tight", role: "impact", seconds: 0.25, trimDb: 0, anchorSeconds: 0 },
  { name: "impact-snap", role: "impact", seconds: 0.18, trimDb: 0, anchorSeconds: 0 },
  { name: "thud", role: "impact", seconds: 0.42, trimDb: -1.5, anchorSeconds: 0 },
  { name: "riser-short", role: "riser", seconds: 1.0, trimDb: 0, anchorSeconds: 1.0 },
  { name: "riser-mid", role: "riser", seconds: 2.0, trimDb: 0, anchorSeconds: 2.0 },
  { name: "riser-long", role: "riser", seconds: 3.0, trimDb: 0, anchorSeconds: 3.0 },
  { name: "tick", role: "accent", seconds: 0.08, trimDb: 0, anchorSeconds: 0 },
  { name: "pop", role: "accent", seconds: 0.14, trimDb: -1, anchorSeconds: 0 },
  { name: "blip", role: "accent", seconds: 0.16, trimDb: -2.5, anchorSeconds: 0 },
  { name: "sweep-up", role: "accent", seconds: 0.4, trimDb: -4, anchorSeconds: 0.096 },
];

const byName = new Map(SFX_CATALOGUE.map((s) => [s.name, s]));

export function soundNamed(name: string): SfxSound | undefined {
  return byName.get(name);
}

/**
 * Which files each palette draws on, in the order it rotates through them.
 *
 * Rotation rather than a single file per slot, because the same whoosh on eight
 * consecutive cuts is the most machine-made sound a video can make — it is the
 * audio version of the same transition every time. Rotation is also why every
 * file in the folder has a use: a sound nobody picks is weight in the image and
 * a licence claim with no benefit behind it.
 */
const PALETTES: Record<SfxPalette, Record<"cut" | "punch" | "open", readonly string[]>> = {
  // The default. Air on the joins, a soft body on the punches: present, and
  // not a sound anybody has to forgive.
  clean: {
    cut: ["whoosh-soft", "whoosh-air", "whoosh-fast"],
    punch: ["impact-soft", "impact-tight"],
    open: ["riser-mid", "riser-short"],
  },
  // Louder and lower. For the edits that are already shouting.
  punchy: {
    cut: ["whoosh-fast", "whoosh-down"],
    punch: ["impact-deep", "impact-tight", "thud"],
    open: ["riser-short", "riser-long"],
  },
  // Punctuation rather than percussion — a talking head, an explainer, a
  // podcast cut. Every sound here is under a fifth of a second.
  quiet: {
    cut: ["tick", "blip"],
    punch: ["pop", "impact-snap"],
    open: ["sweep-up"],
  },
};

export function paletteNames(): SfxPalette[] {
  return Object.keys(PALETTES) as SfxPalette[];
}

/** One sound, placed on the finished edit's clock. */
export interface SfxCue {
  /** Catalogue name; the renderer resolves it to a file. */
  sound: string;
  /** Seconds into the finished video. Never negative. */
  at: number;
  /** What this one is answering — carried so the note can say it. */
  reason: "cut" | "punch" | "open";
  /** The sound's own trim. The plan's `gainDb` is applied by the renderer. */
  trimDb: number;
  /** How long the file runs, so the renderer can trim its tail at the end. */
  seconds: number;
}

export interface SfxPlacement {
  cues: SfxCue[];
  /** Joins that existed and got no sound because of the density cap. */
  thinned: number;
  /**
   * Why there is no riser, when there is none. `null` means there is one.
   *
   * Named rather than merely absent because "no room" and "not asked for" are
   * different answers and the person deserves the right one.
   */
  riserSkipped: "not-asked" | "no-join" | "no-room" | null;
}

export interface SfxRequest {
  /** Length of the finished edit, in seconds. */
  duration: number;
  /** Joins between the kept pieces, on the output clock. See `joinTimes`. */
  joins: readonly number[];
  /** Punch-in moments, on the output clock — `zoomPunch.at` after the critic. */
  punches: readonly number[];
  palette: SfxPalette;
  onCuts: boolean;
  onPunches: boolean;
  onOpen: boolean;
}

/** A sound arrives a touch before the frame it belongs to. */
export const LEAD_SECONDS = 0.06;
/** Two accents closer than this are one fault, not two accents. */
export const MIN_GAP = 0.35;
/** At most one sound per this much finished video. */
export const SECONDS_PER_CUE = 1.2;
/** And never more than this, however long the edit runs. */
export const MAX_CUES = 24;
/** A sound whose tail would be cut off by the end of the video is a click. */
export const TAIL_ROOM = 0.25;
/** Below this the edit has no room for a layer at all. */
export const MIN_EDIT_SECONDS = 2.5;

/**
 * Where the joins land on the finished clock.
 *
 * The same arithmetic as `remapTime` and `outputDuration`, and deliberately a
 * third place it is written rather than a call into `timeline.ts`: this one
 * answers "where does piece *i* start", which neither of those exposes. It is
 * checked against `remapTime` in the suite, so the two cannot drift.
 *
 * `overlap` is the dissolve's duration — every join after the first pulls
 * everything that follows it earlier by one overlap, so a whoosh placed by the
 * un-overlapped map would drift further out of sync with every join it
 * survived.
 */
export function joinTimes(kept: readonly { start: number; end: number }[], overlap = 0): number[] {
  const joins: number[] = [];
  let elapsed = 0;
  for (let i = 0; i < kept.length; i += 1) {
    /*
      The middle of the join, not its beginning.

      With a hard cut the two are the same instant. With a dissolve the join is
      a stretch — it begins at `elapsed - i·overlap` and ends one overlap
      later — and a whoosh placed on its beginning arrives while the outgoing
      shot is still the one on screen, half a dissolve before anything has
      visibly changed. Half an overlap later is the frame where the picture has
      changed as much as it is going to, which is what a cut accent is for.
    */
    if (i > 0) joins.push(Math.max(0, elapsed - i * overlap + overlap / 2));
    elapsed += kept[i]!.end - kept[i]!.start;
  }
  return joins;
}

/**
 * Thin a list of moments down to at most `keep`, evenly.
 *
 * Taking the first `keep` would put every accent in the first quarter of the
 * video and none afterwards — which sounds like the layer broke halfway
 * through, and is worse than having no layer at all. Stepping through the list
 * keeps the density even, which is what a person would do.
 */
function spread(moments: readonly number[], keep: number): number[] {
  if (keep >= moments.length) return [...moments];
  if (keep <= 0) return [];
  const step = moments.length / keep;
  const out: number[] = [];
  for (let i = 0; i < keep; i += 1) out.push(moments[Math.floor(i * step)]!);
  return out;
}

/**
 * The whole decision.
 *
 * Order matters: punches are laid first because an impact is the louder, more
 * deliberate sound, and where a punch lands on a join the two are one moment
 * and should be one sound. Then the joins fill in around them. The riser is
 * last and is allowed to overlap nothing.
 */
export function placeSoundEffects(request: SfxRequest): SfxPlacement {
  const palette = PALETTES[request.palette] ?? PALETTES.clean;
  const cues: SfxCue[] = [];
  let thinned = 0;

  const latest = request.duration - TAIL_ROOM;
  if (request.duration < MIN_EDIT_SECONDS || latest <= 0) {
    return { cues, thinned: 0, riserSkipped: request.onOpen ? "no-room" : "not-asked" };
  }

  const budget = Math.max(1, Math.min(MAX_CUES, Math.floor(request.duration / SECONDS_PER_CUE)));

  /**
   * Lay a sound so that *it* arrives on `moment`, if it fits and nothing is
   * already there.
   *
   * The cue carries the instant the file starts, because that is what
   * `adelay` needs. Where that instant is relative to the moment is the
   * sound's own business: `LEAD_SECONDS` of anticipation, plus however far
   * into the file its transient sits. Callers used to subtract the lead
   * themselves and nothing subtracted the anchor, so `whoosh-air` — one of
   * the three files the default palette rotates through on every cut — landed
   * 380ms after the picture changed.
   */
  const place = (moment: number, name: string, reason: SfxCue["reason"]): boolean => {
    const sound = byName.get(name);
    if (!sound) return false;
    const at = moment - LEAD_SECONDS - sound.anchorSeconds;
    if (at < 0 || at > latest) return false;
    if (cues.some((c) => Math.abs(c.at - at) < MIN_GAP)) return false;
    cues.push({ sound: name, at, reason, trimDb: sound.trimDb, seconds: sound.seconds });
    return true;
  };

  const usable = (moments: readonly number[]) =>
    moments.filter((m) => m - LEAD_SECONDS >= 0 && m - LEAD_SECONDS <= latest).sort((a, b) => a - b);

  if (request.onPunches) {
    const punches = usable(request.punches);
    // Punches take at most half the budget. A video whose every punch is also a
    // hit is a trailer, not an edit, and it leaves nothing for the joins — which
    // are the sounds that were actually asked for by the word "transition".
    const keep = Math.max(1, Math.ceil(budget / 2));
    const chosen = spread(punches, keep);
    thinned += punches.length - chosen.length;
    chosen.forEach((at, i) => {
      // A moment that cannot take a sound is one the person does not get, and
      // the note that says how many were left out has to know about it. Only
      // the budget used to count here, so an edit with seven cuts 0.2s apart
      // laid four accents and reported nothing.
      if (!place(at, palette.punch[i % palette.punch.length]!, "punch")) thinned += 1;
    });
  }

  if (request.onCuts) {
    const joins = usable(request.joins);
    const remaining = Math.max(0, budget - cues.length);
    const chosen = spread(joins, remaining);
    thinned += joins.length - chosen.length;
    let placed = 0;
    for (const at of chosen) {
      // The rotation counter advances only on a sound that was actually laid
      // down, so a join dropped for sitting next to a punch does not also skip
      // a variant and leave two identical whooshes either side of the hole.
      if (place(at, palette.cut[placed % palette.cut.length]!, "cut")) placed += 1;
      else thinned += 1;
    }
  }

  let riserSkipped: SfxPlacement["riserSkipped"] = request.onOpen ? "no-join" : "not-asked";
  if (request.onOpen) {
    /*
      The riser announces the first real seam in the video.

      When there is a cold open that seam is the hook ending and the piece
      starting, which is the single most-designed moment in short-form video —
      and it is the first join by construction, because the cold open makes the
      hook the first kept piece. When there is no cold open it is simply the
      first cut, which is still the first thing the edit does.

      It has to fit whole: the file's own last 70ms are deliberately silent, and
      that hole landing exactly on the seam is the entire effect. Started late
      it is a noise that stops; started before the video does it is half a
      riser.
    */
    /*
      Which of the two answers this is.

      "There is no join to announce" and "there is a join and no room to climb
      into it" are different facts, and the file goes to some trouble to keep
      them apart — then reported the first for both, because the `>= 1.2` test
      was inside the same branch that set the value. `placeSoundEffects({joins:
      [0.9], onOpen: true})` answered "no-join" about a join that plainly
      exists, and an edit with no joins at all was told there had been no room
      before the first one.
    */
    const seam = usable(request.joins)[0];
    if (seam !== undefined) riserSkipped = "no-room";
    if (seam !== undefined && seam >= 1.2) {
      // Longest first: a three-second lift is a better one, and the short files
      // are the fallback for an edit that cuts early.
      const candidates = [...palette.open]
        .map((name) => byName.get(name))
        .filter((s): s is SfxSound => Boolean(s))
        .sort((a, b) => b.seconds - a.seconds);
      for (const sound of candidates) {
        // A riser's anchor is its end — see `anchorSeconds`.
        const at = seam - sound.anchorSeconds;
        if (at < 0.15) continue;
        // A riser runs *into* the seam, so the sound on the seam itself is not
        // a collision — it is the landing. Only the riser's own start is
        // checked against the gap rule.
        if (cues.some((c) => Math.abs(c.at - at) < MIN_GAP)) continue;
        cues.push({ sound: sound.name, at, reason: "open", trimDb: sound.trimDb, seconds: sound.seconds });
        riserSkipped = null;
        break;
      }
    }
  }

  cues.sort((a, b) => a.at - b.at);
  return { cues, thinned, riserSkipped };
}
