/**
 * The sound layer, measured rather than read.
 *
 * A filter string is not a sound. This repository has shipped three features
 * that were present in the graph and absent from the file — `colorbalance` read
 * correctly and did nothing, so three looks were decoration; "no captions"
 * added captions; "cut the ums" cut the silence instead and reported success.
 * Every one of them passed a check that read what the code was about to do.
 *
 * So the middle of this file is arithmetic, which is cheap and exhaustive, and
 * the end of it renders real video with real ffmpeg and asks the *output* three
 * questions: is there more sound at the moment a cue was placed, is there none
 * where no cue was placed, and does the number in the plan change how much.
 * A sound layer that is silently absent would pass everything above and fail
 * every one of those.
 *
 * The suite also guards the seam nobody would notice moving: the palette names
 * are written in three files that cannot import each other — the contract the
 * API validates, the schema the model is handed, and the catalogue the renderer
 * builds from. A name that two of them know is a plan that validates and
 * renders as the default with nothing said.
 *
 * Usage: node tools/sfx-test.mjs
 * Requires: ffmpeg and ffprobe on PATH.
 */
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-sfx-"));

function build(source, name) {
  const outfile = path.join(buildDir, name);
  const built = spawnSync(
    require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/worker"] }),
    [
      path.join(repoRoot, source),
      "--bundle", "--platform=node", "--format=esm", "--target=node22",
      `--outfile=${outfile}`, "--log-level=error",
    ],
    { stdio: "inherit" },
  );
  if (built.status !== 0) process.exit(1);
  return pathToFileURL(outfile).href;
}

const sfx = await import(build("artifacts/worker/src/sfx.ts", "sfx.mjs"));
const timeline = await import(build("artifacts/worker/src/timeline.ts", "timeline.mjs"));
const render = await import(build("artifacts/worker/src/ffmpeg.ts", "ffmpeg.mjs"));
const zod = await import(build("lib/api-zod/src/index.ts", "zod.mjs"));
const keywords = await import(build("artifacts/api-server/src/lib/plan-from-text.ts", "plan.mjs"));

const SOUND_DIR = path.join(repoRoot, "artifacts/worker/assets/sfx");

/*
  The renderer looks for the sounds beside its own bundle first, and the bundle
  under test lives in a temp directory. Pointing it at the source tree is the
  same thing `EDITLY_FONT_SCRIPTS` does for the font repair, and it is the
  reason that override exists: a suite that had to build the whole worker to
  measure one filter would not be run.

  What ships is checked elsewhere and harder — the image build measures every
  file in `dist/sfx` and refuses to build if one of them decodes to silence.
*/
process.env["EDITLY_SFX_DIR"] = SOUND_DIR;

let checks = 0;
let failures = 0;
const check = (name, ok, detail = "") => {
  checks += 1;
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};
const section = (t) => console.log(`\n${t}`);

const scratch = () => mkdtemp(path.join(tmpdir(), "editly-sfx-r-"));

function ffprobe(file, entries, extra = []) {
  const r = spawnSync(
    "ffprobe",
    ["-v", "error", ...extra, "-show_entries", entries, "-of", "default=nw=1:nk=1", file],
    { encoding: "utf8" },
  );
  return r.stdout.trim().split("\n").filter(Boolean);
}

/** Mean and peak of one stretch of a file's audio, in dB. */
function level(file, from, to) {
  const filter = from === undefined ? "volumedetect" : `atrim=start=${from}:end=${to},volumedetect`;
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-af", filter, "-f", "null", "-"], {
    encoding: "utf8",
  });
  const mean = r.stderr.match(/mean_volume: ([-\d.]+) dB/);
  const peak = r.stderr.match(/max_volume: ([-\d.]+) dB/);
  return { mean: mean ? Number(mean[1]) : NaN, peak: peak ? Number(peak[1]) : NaN };
}

// ── The files behind the names ──────────────────────────────────────────────
//
// The catalogue in sfx.ts is a list of strings. Nothing in TypeScript checks
// that a string is a file, and nothing at render time fails when it is not:
// `ffmpeg.ts` treats a missing sound as a note, deliberately, because a
// flourish must never fail a render somebody paid for. So a name with no file
// is a feature that quietly stops existing, and this is the only place that
// notices.

section("Every name in the catalogue has a file, and every file has a name");
{
  const onDisk = (await readdir(SOUND_DIR)).filter((f) => f.endsWith(".flac")).map((f) => f.replace(/\.flac$/, ""));
  const named = sfx.SFX_CATALOGUE.map((s) => s.name);

  check("the catalogue is the size the image build expects", named.length >= 16, String(named.length));
  const missing = named.filter((n) => !onDisk.includes(n));
  check("no name in the catalogue is missing its file", missing.length === 0, missing.join(", "));
  const orphans = onDisk.filter((n) => !named.includes(n));
  check(
    "and no file ships that the catalogue cannot reach",
    orphans.length === 0,
    `${orphans.join(", ")} — weight in the image and a licence claim with nothing behind it`,
  );

  const dupes = named.filter((n, i) => named.indexOf(n) !== i);
  check("no name appears twice", dupes.length === 0, dupes.join(", "));
}

section("Every sound decodes, and none of them decodes to silence");
{
  for (const sound of sfx.SFX_CATALOGUE) {
    const file = path.join(SOUND_DIR, `${sound.name}.flac`);
    const seconds = Number(ffprobe(file, "format=duration")[0]);
    const { peak } = level(file);
    /*
      A FLAC that decodes to silence is exactly what a broken generator
      produces, and it is invisible everywhere else: the file exists, the
      length is right, the render succeeds, and the layer is not there. So the
      check is on the sound, not on the file.
    */
    check(
      `${sound.name} carries sound`,
      Number.isFinite(peak) && peak > -30,
      `peak ${peak} dB`,
    );
    check(
      `${sound.name} is the length the catalogue says`,
      Math.abs(seconds - sound.seconds) < 0.02,
      `${seconds}s against ${sound.seconds}s`,
    );
    /*
      Peak-normalised, all of them, and this is what makes `gainDb` mean one
      thing. If one file peaked 6 dB below the rest, the layer's loudness would
      depend on which sound the rotation happened to pick — a plan asking for
      -12 dB would get -12 or -18 depending on how many cuts there were.

      Not exactly -3: the maker ramps the first and last three milliseconds to
      stop the file clicking, and in a sound whose transient *is* the first
      three milliseconds that ramp takes a little off the top.
    */
    check(
      `${sound.name} peaks where every other sound peaks`,
      peak <= -2.5 && peak >= -4.2,
      `${peak} dB`,
    );
  }
}

section("And none of them sits at a different weight from the rest");
{
  /*
    Peak is not weight. A low sine rings for its whole length where a click is
    over in twenty milliseconds, so at equal peaks the sine is twice the sound.
    `trimDb` in the catalogue is the correction, and these numbers were
    measured — which means a regenerated asset with a different envelope would
    silently change the balance of the layer unless something re-measures them.
    This is that something.

    The risers are held to their own window on purpose: they climb from nothing,
    so a mean taken over the whole file is low by construction, and holding them
    to the same band as an impact would mean boosting a bed until it was a hit.
  */
  for (const sound of sfx.SFX_CATALOGUE) {
    const { mean } = level(path.join(SOUND_DIR, `${sound.name}.flac`));
    const balanced = mean + sound.trimDb;
    const [low, high] = sound.role === "riser" ? [-26, -19] : [-21, -13];
    check(
      `${sound.name} lands in its band once trimmed`,
      balanced >= low && balanced <= high,
      `${balanced.toFixed(1)} dB, band ${low}..${high}`,
    );
    check(`${sound.name} is trimmed down, never up`, sound.trimDb <= 0, String(sound.trimDb));
  }
}

section("The layer sits under the programme, whatever the recording was made at");
{
  /*
    `gainDb` is documented as "how far under the programme the layer sits", and
    the renderer applied it as a plain attenuation of a file that always ships
    peak-normalised to -3 dBFS — so the layer's level was a fact about the
    catalogue rather than about the edit. Measured on a source peaking at -17.7
    dBFS, which is an ordinary unnormalised phone or call recording, the whoosh
    came out at -16.5: a decibel *above* the speech it was meant to sit twelve
    under. The mix is deliberately upstream of `loudnorm`, so levelling could
    not recover the ratio either — the same take recorded further from the
    microphone got a completely different mix and the same sentence.

    The arithmetic is the decision, so it is checked as arithmetic; that the
    layer lands where it should and is audible is checked by the renders above.
  */
  check("a recording at the level the files were built for changes nothing", render.sfxLayerOffsetDb(-3) === 0, String(render.sfxLayerOffsetDb(-3)));
  check("a full-scale recording is never boosted", render.sfxLayerOffsetDb(0) === 0, String(render.sfxLayerOffsetDb(0)));
  check(
    "a recording twelve decibels quieter takes the layer twelve decibels down with it",
    Math.abs(render.sfxLayerOffsetDb(-17.7) - render.sfxLayerOffsetDb(-5.7) + 12) < 1e-9,
    `${render.sfxLayerOffsetDb(-17.7)} against ${render.sfxLayerOffsetDb(-5.7)}`,
  );
  check(
    "and a recording nobody could measure is left exactly as it was",
    render.sfxLayerOffsetDb(null) === 0,
    String(render.sfxLayerOffsetDb(null)),
  );
  check(
    "nothing is pulled down past the noise floor",
    render.sfxLayerOffsetDb(-90) === -30,
    String(render.sfxLayerOffsetDb(-90)),
  );
}

section("And each one's own moment is where the catalogue says it is");
{
  /*
    `cue.at` is the instant the *file starts*, which is only the instant the
    sound arrives for a sound that begins with its transient. `whoosh-air` is a
    symmetric swell 27 dB down at its own start, peaking 0.44s in — so placing
    its start 60ms before a cut put its loudest point 380ms *after* the picture
    changed, and it is one of the three files the default palette rotates
    through on every cut. `anchorSeconds` is that offset, measured, and this
    re-measures it for the same reason `trimDb` is re-measured: a regenerated
    asset with a different envelope would move every accent in the product with
    nothing failing.
  */
  for (const sound of sfx.SFX_CATALOGUE) {
    const file = path.join(SOUND_DIR, `${sound.name}.flac`);
    const out = spawnSync(
      "ffmpeg",
      ["-hide_banner", "-nostats", "-i", file, "-af",
       "asetnsamples=n=256:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.Peak_level:file=-",
       "-f", "null", "-"],
      { encoding: "utf8" },
    );
    let at = null;
    let best = -Infinity;
    let frame = null;
    for (const line of out.stdout.split("\n")) {
      const time = /pts_time:([\d.]+)/.exec(line);
      if (line.startsWith("frame:") && time) frame = Number(time[1]);
      else if (line.includes("Peak_level=") && frame !== null) {
        const value = Number(line.split("=").pop());
        if (Number.isFinite(value) && value > best) {
          best = value;
          at = frame;
        }
      }
    }
    if (sound.role === "riser") {
      // A riser's moment is the hole at its end, not its loudest point: the
      // climb stops and the seam lands in the silence. So its anchor is its
      // own length, and its peak is just before that.
      check(
        `${sound.name} is anchored on its end`,
        Math.abs(sound.anchorSeconds - sound.seconds) < 1e-9 && at !== null && at < sound.seconds,
        `anchor ${sound.anchorSeconds}s, length ${sound.seconds}s, peak ${at}s`,
      );
      continue;
    }
    check(
      `${sound.name} peaks where anchorSeconds says`,
      at !== null && Math.abs(at - sound.anchorSeconds) <= 0.03,
      `peak at ${at}s, catalogue says ${sound.anchorSeconds}s`,
    );
  }
}

section("A moment that could not take an accent is counted, not swallowed");
{
  /*
    Only budget thinning was counted. A join dropped for sitting inside
    `MIN_GAP` of another incremented nothing — so the note written precisely to
    say "somebody who cut forty times and hears eleven whooshes should know
    that was a decision" was skipped in exactly the case it was written for.
    `MIN_SEGMENT_SECONDS` is 0.05, so any stutter-heavy silence cut produces
    joins closer together than the gap rule allows.
  */
  const crowded = sfx.placeSoundEffects({
    duration: 16,
    joins: [2, 2.2, 2.4, 2.6, 2.8, 3.0, 3.2],
    punches: [],
    onCuts: true,
    onPunches: false,
    onOpen: false,
    palette: "clean",
  });
  check(
    "seven joins a fifth of a second apart do not become seven accents",
    crowded.cues.length < 7,
    String(crowded.cues.length),
  );
  check(
    "and the ones that could not be laid are counted",
    crowded.thinned === 7 - crowded.cues.length,
    `${crowded.thinned} thinned against ${7 - crowded.cues.length} missing`,
  );
}

section("The riser's two refusals are two different sentences");
{
  /*
    "There is no join to announce" and "there is a join and no room to climb
    into it" are different facts, and the file keeps them apart — then reported
    the first for both, because the test for room sat inside the branch that
    set the value.
  */
  const early = sfx.placeSoundEffects({
    duration: 20,
    joins: [0.9],
    punches: [],
    onCuts: false,
    onPunches: false,
    onOpen: true,
    palette: "clean",
  });
  check("a join too early to climb into is 'no room'", early.riserSkipped === "no-room", String(early.riserSkipped));

  const none = sfx.placeSoundEffects({
    duration: 20,
    joins: [],
    punches: [3, 6, 9],
    onCuts: false,
    onPunches: true,
    onOpen: true,
    palette: "clean",
  });
  check("and an edit with no joins at all is 'no join'", none.riserSkipped === "no-join", String(none.riserSkipped));
}

section("Every palette names sounds that exist, and every sound is reachable");
{
  const reachable = new Set();
  const timelines = [
    // Enough joins and punches that the rotation gets all the way round.
    { label: "a long edit", joins: [4, 8, 12, 16, 20, 24, 28, 32], punches: [6, 10, 14, 18, 22, 26, 30], onCuts: true, onPunches: true, onOpen: false },
    // And four first seams, because which riser is chosen is a question about
    // how much room there is before the first cut — a video that cuts at 1.4s
    // and one that cuts at five seconds get different files, by design.
    ...[1.4, 2.4, 3.4, 5].map((seam) => ({
      label: `a first seam at ${seam}s`,
      joins: [seam, seam + 12],
      punches: [],
      onCuts: false,
      onPunches: false,
      onOpen: true,
    })),
  ];
  for (const palette of sfx.paletteNames()) {
    for (const shape of timelines) {
      const placed = sfx.placeSoundEffects({
        duration: 60,
        joins: shape.joins,
        punches: shape.punches,
        palette,
        onCuts: shape.onCuts,
        onPunches: shape.onPunches,
        onOpen: shape.onOpen,
      });
      for (const cue of placed.cues) {
        check(
          `${palette}, ${shape.label}: ${cue.sound} is a sound that exists`,
          Boolean(sfx.soundNamed(cue.sound)),
          cue.sound,
        );
        reachable.add(cue.sound);
      }
    }
  }
  const unreachable = sfx.SFX_CATALOGUE.map((s) => s.name).filter((n) => !reachable.has(n));
  check(
    "no palette can reach it is no reason to ship it",
    unreachable.length === 0,
    `${unreachable.join(", ")} — bytes in the image nothing can play`,
  );
}

// ── The three places the palette names are written ──────────────────────────

section("The contract, the model's schema and the renderer agree on the sets");
{
  const contractPalettes =
    zod.SoundEffectsOperation?._zod?.def?.shape?.palette?._zod?.def?.innerType?._zod?.def?.entries ??
    zod.SoundEffectsOperation?._zod?.def?.shape?.palette?._zod?.def?.entries ??
    {};
  const fromContract = Object.values(contractPalettes).sort();
  const fromRenderer = sfx.paletteNames().sort();

  /*
    The model's schema is read out of the source for the same reason
    inventory.mjs reads the operation list out of the source: `buildSchema` is
    not exported, and a second copy kept here for the test to import would be a
    copy that can be right while the real one is wrong.
  */
  const plannerSource = await readFile(path.join(repoRoot, "artifacts/api-server/src/lib/planner.ts"), "utf8");
  const schemaLine = plannerSource.match(/sfxPalette:\s*\{[^}]*enum:\s*\[([^\]]*)\]/);
  const fromModel = schemaLine
    ? [...schemaLine[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]).sort()
    : [];

  check("the contract could be read", fromContract.length >= 3, JSON.stringify(fromContract));
  check(
    "the renderer builds exactly the palettes the contract accepts",
    JSON.stringify(fromRenderer) === JSON.stringify(fromContract),
    `${JSON.stringify(fromRenderer)} against ${JSON.stringify(fromContract)}`,
  );
  check(
    "and the model is offered exactly those and no others",
    JSON.stringify(fromModel) === JSON.stringify(fromContract),
    `${JSON.stringify(fromModel)} against ${JSON.stringify(fromContract)}`,
  );

  // The transformer's own guard list, which is a fourth copy by necessity.
  const guard = plannerSource.match(/const SFX_PALETTES = new Set\(\[([^\]]*)\]\)/);
  const fromGuard = guard ? [...guard[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]).sort() : [];
  check(
    "the transformer accepts exactly those too",
    JSON.stringify(fromGuard) === JSON.stringify(fromContract),
    `${JSON.stringify(fromGuard)} against ${JSON.stringify(fromContract)}`,
  );
}

// ── Where the sounds go, as arithmetic ──────────────────────────────────────

section("Joins land where the cut map says they do");
{
  const kept = [
    { start: 0, end: 4 },
    { start: 6, end: 10 },
    { start: 12, end: 16 },
  ];
  check(
    "with hard cuts, a join is where the next piece starts",
    JSON.stringify(sfx.joinTimes(kept, 0)) === JSON.stringify([4, 8]),
    JSON.stringify(sfx.joinTimes(kept, 0)),
  );
  /*
    The same arithmetic as `remapTime`, and checked against it rather than
    trusted. A dissolve pulls everything after the first join earlier by one
    overlap, so a whoosh placed by the un-overlapped map drifts further out of
    sync with every join it survives — which is the same failure captions had
    before `remapTime` learned about overlap, arriving through a different door.

    Half an overlap later than `remapTime`, deliberately. `remapTime` answers
    "where does this source moment land", and the moment a piece begins lands
    where the dissolve *begins* — while the outgoing shot is still the one on
    screen. A cut accent belongs where the picture has changed, which is the
    middle. Both conventions were the same number until this was written down,
    which is why the drift could not be caught here: the two agreed with each
    other and both were early.
  */
  const overlapped = sfx.joinTimes(kept, 0.5);
  check(
    "with a dissolve, every accent sits in the middle of the join remapTime opens",
    overlapped.every(
      (at, i) => Math.abs(at - (timeline.remapTime(kept[i + 1].start, kept, 0.5) + 0.25)) < 1e-9,
    ),
    JSON.stringify(overlapped),
  );
  check("one piece has no joins", sfx.joinTimes([{ start: 0, end: 5 }], 0).length === 0);
}

const spread = (n, step, from = 0) => Array.from({ length: n }, (_, i) => from + i * step);
const ask = (over) => ({
  duration: 60,
  joins: [],
  punches: [],
  palette: "clean",
  onCuts: true,
  onPunches: true,
  onOpen: false,
  ...over,
});

section("Two accents too close together are one fault, not two accents");
{
  // Eight joins a fifth of a second apart: a real thing, on a fast montage.
  const placed = sfx.placeSoundEffects(ask({ duration: 20, joins: spread(8, 0.2, 3) }));
  const gaps = placed.cues.slice(1).map((c, i) => c.at - placed.cues[i].at);
  check(
    "nothing is laid within the minimum gap of the sound before it",
    gaps.every((g) => g >= sfx.MIN_GAP - 1e-9),
    JSON.stringify(gaps),
  );

  // A punch landing on a join is one moment. The louder sound wins and the
  // other is dropped rather than stacked — two sounds on one frame is a fault
  // anybody hears and nobody can name.
  const both = sfx.placeSoundEffects(ask({ duration: 20, joins: [8], punches: [8] }));
  check("a punch on a join gets one sound, not two", both.cues.length === 1, JSON.stringify(both.cues));
  check("and it is the impact, which is the more deliberate of the two", both.cues[0]?.reason === "punch");
}

section("A sound on every cut stops being an accent");
{
  const joins = spread(40, 1, 2); // forty cuts across a 45-second edit
  const placed = sfx.placeSoundEffects(ask({ duration: 45, joins }));
  check(
    "the layer is capped by the length of the edit, not by the number of cuts",
    placed.cues.length <= Math.floor(45 / sfx.SECONDS_PER_CUE),
    `${placed.cues.length} cues`,
  );
  check("and the moments passed over are counted so the note can say so", placed.thinned > 0, String(placed.thinned));

  /*
    Thinned by stepping, not by truncating.

    Taking the first n would put every accent in the first quarter and none
    afterwards, which does not sound like restraint — it sounds like the layer
    broke halfway through, which is worse than having no layer at all. So the
    last cue has to live near the end of the edit.
  */
  const last = placed.cues[placed.cues.length - 1].at;
  check("the accents reach the end of the edit rather than stopping a third of the way in", last > 30, String(last));

  const huge = sfx.placeSoundEffects(ask({ duration: 600, joins: spread(300, 2, 2) }));
  check("and there is a ceiling however long the video runs", huge.cues.length <= sfx.MAX_CUES, String(huge.cues.length));
}

section("Nothing is placed where it would be cut off");
{
  const placed = sfx.placeSoundEffects(ask({ duration: 10, joins: [3, 9.95] }));
  check(
    "a join in the last moment of the edit gets no sound",
    placed.cues.every((c) => c.at <= 10 - sfx.TAIL_ROOM),
    JSON.stringify(placed.cues),
  );
  const tiny = sfx.placeSoundEffects(ask({ duration: 2, joins: [1] }));
  check("and an edit too short for a layer gets none at all", tiny.cues.length === 0);
}

section("A riser fits whole or it is not there");
{
  const roomy = sfx.placeSoundEffects(ask({ duration: 40, joins: [8, 20], onOpen: true }));
  const riser = roomy.cues.find((c) => c.reason === "open");
  check("with room before the first join there is a riser", Boolean(riser), JSON.stringify(roomy.cues));
  /*
    It has to *end* on the seam. The file's own last 70ms are deliberately
    silent, and that hole landing exactly as the seam arrives is the entire
    effect — it is the deliberate silence before the important line, built into
    the sound rather than bolted onto the timeline.
  */
  check(
    "and it ends exactly where the first join is",
    riser && Math.abs(riser.at + riser.seconds - 8) < 1e-9,
    riser ? String(riser.at + riser.seconds) : "none",
  );
  check("the longest one that fits is the one chosen", riser?.sound === "riser-mid", riser?.sound);

  const tight = sfx.placeSoundEffects(ask({ duration: 40, joins: [0.9, 20], onOpen: true }));
  check(
    "a first join too early for any riser gets none",
    !tight.cues.some((c) => c.reason === "open") && tight.riserSkipped !== null,
    tight.riserSkipped ?? "placed",
  );
  const cutless = sfx.placeSoundEffects(ask({ duration: 40, joins: [], punches: [5], onOpen: true }));
  check("an edit with no joins has no seam to announce", cutless.riserSkipped === "no-join", cutless.riserSkipped);
  const unasked = sfx.placeSoundEffects(ask({ duration: 40, joins: [8], onOpen: false }));
  check(
    "and not asking for one is a different answer from not fitting one",
    unasked.riserSkipped === "not-asked",
    unasked.riserSkipped,
  );
}

section("The same sound eight times in a row is the tell of a machine");
{
  const placed = sfx.placeSoundEffects(ask({ duration: 40, joins: spread(6, 3, 3), onPunches: false }));
  const names = placed.cues.map((c) => c.sound);
  check("consecutive cuts do not get the same file", names.every((n, i) => i === 0 || n !== names[i - 1]), names.join(","));
  check("and the palette rotates through more than one", new Set(names).size > 1, names.join(","));
}

section("The switches are switches");
{
  const noCuts = sfx.placeSoundEffects(ask({ duration: 40, joins: [8, 16], punches: [12], onCuts: false }));
  check("onCuts false leaves the joins alone", noCuts.cues.every((c) => c.reason !== "cut"), JSON.stringify(noCuts.cues));
  const noPunch = sfx.placeSoundEffects(ask({ duration: 40, joins: [8, 16], punches: [12], onPunches: false }));
  check("onPunches false leaves the punches alone", noPunch.cues.every((c) => c.reason !== "punch"));
  check("and the joins still get theirs", noPunch.cues.some((c) => c.reason === "cut"));
}

// ── Both heads can ask for it ───────────────────────────────────────────────

section("A sentence can ask for it, and a sentence can refuse it");
{
  const has = (text) => keywords.planFromText(text).operations.some((o) => o.type === "soundEffects");
  for (const text of [
    "add sound effects",
    "put a whoosh on the cuts",
    "add sfx",
    "I want a riser before the drop",
    "ضيف مؤثرات صوتية",
    "حط مؤثّرات صوتية على القصات",
  ]) {
    check(`"${text}" asks for the layer`, has(text), JSON.stringify(keywords.planFromText(text).operations));
  }

  /*
    The refusals, and this half is the reason the patterns were written in one
    commit. A generous ask with no refusal beside it is exactly how "no
    captions" came to add captions: the refusal contains the ask as a substring,
    so a matcher that only looks for the ask does the opposite of what the
    sentence spent its last three words saying.
  */
  for (const text of [
    "add captions but no sound effects",
    "no sfx please",
    "clean it up without any sound effects",
    "ضيف ترجمة بدون مؤثرات صوتية",
    "نظفه بلا مؤثّرات صوتية",
  ]) {
    check(`"${text}" does not`, !has(text), JSON.stringify(keywords.planFromText(text).operations));
  }

  // And an ordinary edit does not get one thrown in. The layer is the one thing
  // in this product a person notices immediately and cannot say why they
  // dislike, so it is never added because an edit happens to have cuts in it.
  for (const text of ["cut the silences and add captions", "اقصّ الصمت", "make it vertical for tiktok"]) {
    check(`"${text}" is left alone`, !has(text), JSON.stringify(keywords.planFromText(text).operations));
  }
}

section("The palettes can be asked for by name");
{
  const paletteOf = (text) =>
    keywords.planFromText(text).operations.find((o) => o.type === "soundEffects")?.palette;
  check("plain asks get the default", paletteOf("add sound effects") === "clean");
  check("a punchy ask gets the loud set", paletteOf("add punchy sound effects") === "punchy", paletteOf("add punchy sound effects"));
  check("a subtle ask gets the short set", paletteOf("add subtle sound effects") === "quiet", paletteOf("add subtle sound effects"));
  check("and in Arabic too", paletteOf("ضيف مؤثرات صوتية خفيفة") === "quiet", paletteOf("ضيف مؤثرات صوتية خفيفة"));
}

section("The model has it in its vocabulary too");
{
  const plannerSource = await readFile(path.join(repoRoot, "artifacts/api-server/src/lib/planner.ts"), "utf8");
  const types = plannerSource.slice(plannerSource.indexOf("const types = ["), plannerSource.indexOf("];", plannerSource.indexOf("const types = [")));
  check("it is in the list the model chooses from", types.includes('"soundEffects"'), "");
  /*
    Unconditional, unlike b-roll, overlays and music. Those three appear only
    when the project holds a file of that kind, because there is nothing to
    place without one. These sixteen sounds ship in the image, so an operation
    that came and went with the library would be the schema lying about what
    the product can do on an empty project.
  */
  check(
    "and it is there whether or not the project has any files",
    !/length > 0 \? \["soundEffects"\]/.test(types),
    types,
  );
  check("the instructions tell the model what it is", plannerSource.includes("soundEffects puts a layer of sound"), "");
}

section("The contract holds the line on the numbers");
{
  const parse = (over) => zod.SoundEffectsOperation.safeParse({ type: "soundEffects", ...over });
  check("a bare operation is valid and carries the defaults", parse({}).success && parse({}).data.gainDb === -12);
  check("the default palette is the quiet one", parse({}).data.palette === "clean", parse({}).data.palette);
  check("a level above zero is refused", !parse({ gainDb: 6 }).success);
  check("and one below the floor is refused", !parse({ gainDb: -60 }).success);
  check("a palette nobody built is refused", !parse({ palette: "cinematic" }).success);
  check(
    "and the operation is in the union the API validates against",
    zod.EditPlan.safeParse({ version: 1, operations: [{ type: "soundEffects" }] }).success,
  );
}

// ── The output, measured ────────────────────────────────────────────────────
//
// Everything above this line would pass on a renderer that computed a perfect
// list of moments and put none of them in the file.

section("A clip with no sound of its own comes out with the layer on it");
{
  const dir = await scratch();
  const source = path.join(dir, "silent.mp4");
  spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=9",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", source,
  ]);

  const { output, notes, hasAudioOut } = await render.renderPlan(
    source,
    {
      version: 1,
      operations: [
        { type: "zoomPunch", at: [2, 4, 6], amount: 0.13, holdMs: 1000, on: "emphasis" },
        { type: "soundEffects", gainDb: 0, palette: "punchy", onCuts: true, onPunches: true, onOpen: true },
      ],
    },
    { workDir: dir },
  );

  /*
    The whole point of this fixture: the source has no audio stream at all, so
    every decibel in the output is the layer. There is nowhere for a
    false positive to hide.
  */
  check(
    "the render maps an audio stream it did not have before",
    ffprobe(output, "stream=codec_type").includes("audio") && hasAudioOut,
    ffprobe(output, "stream=codec_type").join(","),
  );

  const atPunch = level(output, 1.9, 2.6).mean;
  const between = level(output, 2.9, 3.7).mean;
  check("there is sound where the punch is", atPunch > -40, `${atPunch} dB`);
  check(
    "and silence where there is no cue, so the sounds are placed rather than spread",
    between < atPunch - 20,
    `${between} dB against ${atPunch} dB at the punch`,
  );

  // Same plan, thirty decibels quieter. A `gainDb` the renderer read and did
  // not apply is exactly the shape `colorbalance` had: three looks that were
  // read correctly and did nothing at all.
  const quiet = await render.renderPlan(
    source,
    {
      version: 1,
      operations: [
        { type: "zoomPunch", at: [2, 4, 6], amount: 0.13, holdMs: 1000, on: "emphasis" },
        { type: "soundEffects", gainDb: -30, palette: "punchy", onCuts: true, onPunches: true, onOpen: true },
      ],
    },
    { workDir: await scratch() },
  );
  const quieter = level(quiet.output, 1.9, 2.6).mean;
  check(
    "the level in the plan is the level in the file",
    quieter < atPunch - 20,
    `${quieter} dB against ${atPunch} dB`,
  );

  check("and the notes say what was laid", notes.some((n) => /sound effect/.test(n)), notes.join(" | "));
  await rm(dir, { recursive: true, force: true });
}

section("On a real cut, the sound is at the cut and nowhere else");
{
  const dir = await scratch();
  const source = path.join(dir, "talk.mp4");
  // Speech, a gap, speech, a gap, speech. The gaps are what the cuts come
  // from, so the joins in the finished edit are known arithmetic rather than a
  // guess: 6.08 and 9.24 on the output clock.
  spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=15.4",
    "-f", "lavfi", "-i", "sine=frequency=300:duration=6",
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=1.2",
    "-f", "lavfi", "-i", "sine=frequency=300:duration=3",
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=1.2",
    "-f", "lavfi", "-i", "sine=frequency=300:duration=4",
    // Levelled to near full scale on purpose: the effects layer is placed
    // *relative to the programme*, so a fixture recorded quietly would move
    // every number below by however quiet it happened to be. The section after
    // this one is the one that checks the relationship itself.
    "-filter_complex", "[1:a][2:a][3:a][4:a][5:a]concat=n=5:v=0:a=1,volume=12dB[a]",
    "-map", "0:v", "-map", "[a]",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source,
  ]);

  const cut = { type: "removeSilence", thresholdDb: -32, minSilenceMs: 500, paddingMs: 80 };
  const dry = await render.renderPlan(source, { version: 1, operations: [cut] }, { workDir: await scratch() });
  const wet = await render.renderPlan(
    source,
    {
      version: 1,
      operations: [cut, { type: "soundEffects", gainDb: 0, palette: "clean", onCuts: true, onPunches: true, onOpen: true }],
    },
    { workDir: await scratch() },
  );

  check("both renders come out the same length", Math.abs(dry.estimatedSeconds - wet.estimatedSeconds) < 1e-6);

  /*
    In energy, not in decibels.

    The layer sits *under* the programme by `gainDb`, so at a moment where the
    programme is loud the layer barely moves the mean — and where the programme
    is silent (a join, which is exactly where the accents are) a decibel
    difference is dominated by the silence, not by the sound. The energy the
    layer added is the layer's own contribution either way.
  */
  const energy = (db) => (Number.isFinite(db) ? 10 ** (db / 10) : 0);
  const added = (from, to) =>
    energy(level(wet.output, from, to).mean) - energy(level(dry.output, from, to).mean);

  /*
    Where the accent actually arrives, not where its file starts.

    `cue.at` is the instant the file starts, and the 60ms lead in front of it is
    only correct for a sound that begins with its transient. `whoosh-air` — the
    second entry in the default palette's rotation, so every second cut in the
    product — is a symmetric swell that peaks 0.44s in and is 27 dB down at its
    own start. Placing its start 60ms before the cut put its loudest point 380ms
    *after* the picture changed, which is the exact failure the lead exists to
    prevent.

    Measured as the loudest 40ms window of what the layer added, against the
    join the cut map puts at 9.24s.
  */
  {
    // In energy, not in decibels: the dry render dips to near-silence at the
    // join itself, so a difference measured in dB peaks on that dip whichever
    // sound was laid and whenever it arrived. The energy the layer *added* is
    // the layer's own envelope.
    let peakAt = null;
    let peak = -Infinity;
    for (let from = 8.7; from < 10.3; from += 0.04) {
      const gained = added(from, from + 0.04);
      if (gained > peak) {
        peak = gained;
        peakAt = from + 0.02;
      }
    }
    check(
      "the accent arrives on the cut, not a third of a second after it",
      peakAt !== null && Math.abs(peakAt - 9.24) <= 0.2,
      `loudest at ${peakAt?.toFixed(2)}s against a join at 9.24s`,
    );
  }
  const atFirstCut = added(6.0, 6.5);
  const atSecondCut = added(9.15, 9.7);
  const control = added(1.0, 3.5);
  check("the first cut has a sound on it", atFirstCut > Math.abs(control) * 8, `${atFirstCut.toExponential(2)} against ${control.toExponential(2)}`);
  check("so does the second", atSecondCut > Math.abs(control) * 8, `${atSecondCut.toExponential(2)} against ${control.toExponential(2)}`);
  /*
    And the stretch between them is untouched to within the noise of two
    encodes. This is the half that catches a layer laid down as one continuous
    bed instead of as accents — which would pass every "is it louder at the cut"
    check ever written.
  */
  check(
    "and the speech between the cuts is exactly as it was",
    Math.abs(control) < atFirstCut / 8,
    `${control.toExponential(2)} against ${atFirstCut.toExponential(2)} at the cut`,
  );

  await rm(dir, { recursive: true, force: true });
}

section("The music gets out of the way of the riser");
{
  const dir = await scratch();
  const source = path.join(dir, "talk.mp4");
  spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=15.4",
    "-f", "lavfi", "-i", "sine=frequency=300:duration=6",
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=1.2",
    "-f", "lavfi", "-i", "sine=frequency=300:duration=3",
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=1.2",
    "-f", "lavfi", "-i", "sine=frequency=300:duration=4",
    "-filter_complex", "[1:a][2:a][3:a][4:a][5:a]concat=n=5:v=0:a=1[a]",
    "-map", "0:v", "-map", "[a]",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source,
  ]);
  const track = path.join(dir, "bed.m4a");
  spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=220:duration=20", "-af", "volume=15dB", "-c:a", "aac", track,
  ]);
  const assets = new Map([["trk", { file: track, kind: "audio" }]]);

  const base = [
    { type: "removeSilence", thresholdDb: -32, minSilenceMs: 500, paddingMs: 80 },
    { type: "addMusic", assetId: "trk", gainDb: 0, duck: false, fadeSeconds: 1.5, fromSeconds: 0, loop: true },
  ];
  // The layer itself is put at the floor so what is being measured here is the
  // *bed*, not the riser sitting on top of it.
  const sound = (onOpen) => ({ type: "soundEffects", gainDb: -30, palette: "clean", onCuts: true, onPunches: true, onOpen });
  const withRiser = await render.renderPlan(source, { version: 1, operations: [...base, sound(true)] }, { workDir: await scratch(), assets });
  const without = await render.renderPlan(source, { version: 1, operations: [...base, sound(false)] }, { workDir: await scratch(), assets });

  const dipped = level(withRiser.output, 4.5, 6.0).mean;
  const undipped = level(without.output, 4.5, 6.0).mean;
  /*
    A riser works by taking things away, not by adding one. If the bed does not
    step out of the way, the lift is one more sound competing with the music it
    exists to clear — and every check that only looks at the riser itself would
    pass.
  */
  check("the bed drops while the riser climbs", dipped < undipped - 5, `${dipped.toFixed(1)} against ${undipped.toFixed(1)} dB`);
  check(
    "it is back before the seam is over",
    Math.abs(level(withRiser.output, 7.5, 9.0).mean - level(without.output, 7.5, 9.0).mean) < 0.6,
    `${level(withRiser.output, 7.5, 9.0).mean} against ${level(without.output, 7.5, 9.0).mean}`,
  );
  check(
    "and nothing before the riser is touched",
    Math.abs(level(withRiser.output, 1.8, 3.5).mean - level(without.output, 1.8, 3.5).mean) < 0.6,
    `${level(withRiser.output, 1.8, 3.5).mean} against ${level(without.output, 1.8, 3.5).mean}`,
  );
  check("and the render says it did it", withRiser.notes.some((n) => /pulled the music down/.test(n)), withRiser.notes.join(" | "));

  await rm(dir, { recursive: true, force: true });
}

section("An edit with nothing to accent says so rather than pretending");
{
  const dir = await scratch();
  const source = path.join(dir, "plain.mp4");
  spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=5",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", source,
  ]);
  const { output, notes, hasAudioOut } = await render.renderPlan(
    source,
    { version: 1, operations: [{ type: "soundEffects", gainDb: -12, palette: "clean", onCuts: true, onPunches: true, onOpen: true }] },
    { workDir: dir },
  );
  check(
    "no cuts and no punches means no sounds, and the note says why",
    notes.some((n) => /no cuts and no punch-ins|لا قصّات فيه/.test(n)),
    notes.join(" | "),
  );
  /*
    And no empty audio stream invented to carry them. A silent track on a clip
    that never had one is the kind of thing that looks like success everywhere
    and turns up as a file that is bigger than it should be with a stream nobody
    can hear.
  */
  check("and no silent audio stream is added to carry nothing", !hasAudioOut && !ffprobe(output, "stream=codec_type").includes("audio"), ffprobe(output, "stream=codec_type").join(","));
  await rm(dir, { recursive: true, force: true });
}

section("Levelling that could not happen is said, not dropped");
{
  /*
    The plan asks to level the audio *and* lay effects, on a clip with no sound
    of its own. The renderer reads `hasAudioOut` for the loudness pass before
    the effects layer turns it on, so the pass is skipped — correctly, because a
    soundtrack of four whooshes must not be pushed to speaking level. But the
    request was made, and a request that quietly does not happen is the failure
    this repository is written against: the notes have to say the levelling
    stood down, not stay silent about it while the file ships unlevelled.
  */
  const dir = await scratch();
  const source = path.join(dir, "silent-for-level.mp4");
  spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=9",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", source,
  ]);

  const { notes } = await render.renderPlan(
    source,
    {
      version: 1,
      operations: [
        { type: "zoomPunch", at: [2, 4, 6], amount: 0.13, holdMs: 1000, on: "emphasis" },
        { type: "soundEffects", gainDb: 0, palette: "punchy", onCuts: true, onPunches: true, onOpen: true },
        { type: "normalizeLoudness", targetLufs: -14 },
      ],
    },
    { workDir: dir },
  );

  check(
    "the effects were laid",
    notes.some((n) => /sound effect|مؤثّر/.test(n)),
    notes.join(" | "),
  );
  check(
    "and the skipped levelling is named rather than left silent",
    notes.some((n) => /did not level|only sound here is the effects|لم أُسوِّ المستوى/.test(n)),
    notes.join(" | "),
  );
  // The one that must never appear on this clip: it was not levelled, so no
  // note may claim it was.
  check(
    "and nothing claims a level it did not reach",
    !notes.some((n) => /-14 LUFS|LUFS/.test(n)),
    notes.join(" | "),
  );
  await rm(dir, { recursive: true, force: true });
}

await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("The sound is in the file, at the moments the plan put it.");
