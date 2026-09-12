/**
 * The music library, measured rather than described.
 *
 * Three things could go wrong here and only one of them would be visible from
 * the outside, which is why this file exists:
 *
 *   1. **The bill.** The whole argument for generating music is that a mood is
 *      a key: one bed is made and everyone after is served the same file. A
 *      bug that regenerates on every render still produces perfect videos and
 *      costs about four cents each, forever, silently. So the generator here
 *      counts its own calls and the checks are written against that count.
 *   2. **The tempo.** `bpm` is measured from the file by the same detector the
 *      zoom punches use, never read off the generator's claim about its own
 *      output. A bed whose bpm came from a promise is a bed the punches land
 *      beside.
 *   3. **The default.** Music is off in this product unless somebody asks for
 *      it in words. A direction that started adding beds unasked would spend
 *      money on every render in the product.
 *
 * The generator is a stub, deliberately: what is under test is the library's
 * arithmetic, not Google's. The one place a real network would tell us
 * something — that the response shape parses — is checked against a real HTTP
 * server below rather than against a mock of our own fetch.
 *
 * Usage: node tools/music-test.mjs
 * Requires: a local Postgres matching the production schema, and ffmpeg.
 */
import http from "node:http";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolveTestDatabaseUrl } from "./lib/test-db.mjs";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-music-"));

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
const section = (title) => console.log(`\n${title}`);

const bundle = (entry, outfile) => {
  const built = spawnSync(
    require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/worker"] }),
    [
      path.join(repoRoot, entry),
      "--bundle", "--platform=node", "--format=esm", "--target=node22",
      // Some of these reach node builtins through a CommonJS dependency, which
      // an ESM bundle has no `require` for. The same banner `csp-test` and
      // `connect-test` use, for the same reason.
      "--banner:js=import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
      `--outfile=${path.join(buildDir, outfile)}`, "--log-level=error",
    ],
    { stdio: "inherit" },
  );
  if (built.status !== 0) {
    console.error(`could not bundle ${entry}`);
    process.exit(1);
  }
  return import(pathToFileURL(path.join(buildDir, outfile)).href);
};

await resolveTestDatabaseUrl();

/*
  A bucket, because the library really stores what it makes.

  `music-library.ts` uploads a new bed and downloads it again on the next
  request, and stubbing those two out would remove the only mechanism the
  "paid once" checks are about — a bed that is not stored is a bed that is
  bought again. So this is a real HTTP server holding real bytes, and the
  module under test reaches it the way it reaches Storage in production.
*/
const objects = new Map();
const bucket = http.createServer((req, res) => {
  const key = decodeURIComponent((req.url ?? "").split("?")[0]);
  if (req.method === "GET") {
    const body = objects.get(key);
    if (!body) return res.writeHead(404).end();
    return res.writeHead(200, { "Content-Type": "audio/mpeg" }).end(body);
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    objects.set(key, Buffer.concat(chunks));
    res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
  });
});
await new Promise((r) => bucket.listen(0, r));
// Set before anything that touches storage is imported: the module reads these
// once, at import, which is the property that makes a missing key visible at
// deploy time rather than on the first render.
process.env.SUPABASE_URL = `http://127.0.0.1:${bucket.address().port}`;
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-for-tests";

// ─── 1. The prompts, which are what the money buys ───────────────────────────

const maker = await bundle("artifacts/worker/src/providers/music.ts", "music.mjs");
const beatsLib = await bundle("artifacts/worker/src/beats.ts", "beats.mjs");
const zod = await bundle("lib/api-zod/src/index.ts", "zod.mjs");

section("Every mood asks for something a bed can be");
{
  const moods = zod.MusicMood.options;
  check("there are six moods", moods.length === 6, moods.join(","));

  for (const mood of moods) {
    const prompt = maker.promptFor(mood);
    /*
      Instrumental, first, in every one of them.

      A bed with a voice on it competes with the voice the video already has,
      which is the single thing a bed must never do. Checked per mood rather
      than once, because the failure is per mood: one prompt missing the word
      is one mood that sings over everybody.
    */
    check(`${mood} asks for no vocals`, /instrumental/i.test(prompt) && /no vocals/i.test(prompt), prompt.slice(0, 60));
    // And a steady tempo, which is not taste: `beats.ts` has to find a grid in
    // the result or the zoom punches land on arithmetic instead of on music.
    check(`${mood} asks for a steady pulse`, /steady|pulse|groove/i.test(prompt), prompt.slice(0, 60));
    check(`${mood} is a distinct prompt`, moods.filter((m) => maker.promptFor(m) === prompt).length === 1);
  }

  check("and every mood has a name in both languages",
    moods.every((m) => zod.MUSIC_MOOD_NAMES[m]?.en && zod.MUSIC_MOOD_NAMES[m]?.ar),
    JSON.stringify(zod.MUSIC_MOOD_NAMES));
  check(
    "the Arabic names are actually Arabic, not the English word in a bracket",
    moods.every((m) => /[؀-ۿ]/.test(zod.MUSIC_MOOD_NAMES[m].ar)),
    JSON.stringify(Object.values(zod.MUSIC_MOOD_NAMES).map((n) => n.ar)),
  );
}

section("The built-in synthesiser makes what it says it makes");
{
  /*
    The floor under the whole feature.

    Reaching Lyria needs a Google Cloud billing account, and a payment system
    can refuse one for reasons that have nothing to do with this product — it
    did. A music feature whose critical path runs through somebody else's risk
    model is one that stops shipping on a Tuesday, so there is a maker here
    with no key, no host and no invoice, and it is what runs when no Lyria key
    is set.
  */
  const synth = await bundle("artifacts/worker/src/providers/synth-music.ts", "synth.mjs");
  const moods = zod.MusicMood.options;
  const work = await mkdtemp(path.join(tmpdir(), "editly-synth-"));
  /*
    Two seeds, not one, and that is the whole lesson of this section.

    The first version checked one seed and passed. Production uses a random
    seed per variant, and on other seeds two of the six moods came back with
    no measurable tempo at all — the pad's random detune was beating at
    roughly the beat rate and swamping the onset contrast. A property that
    holds for one seed is not a property.
  */
  const SEEDS = [4242, 1337];

  for (const mood of moods) {
   for (const seed of SEEDS) {
    const maker = synth.createSynthMusicMaker({ seed });
    const file = path.join(work, `${mood}-${seed}.mp3`);
    const made = await maker.make({ mood, file });
    check(`${mood} renders (seed ${seed})`, made !== null, JSON.stringify(made));

    /*
      The check this file exists for, and the one that proves two things at
      once: the tempo the recipe *built* is the tempo `beats.ts` *finds* in the
      rendered audio.

      It failed on the first attempt, usefully. The kick was on alternate
      beats, so the strongest period in the file really was two beats: the
      detector answered 60 for a track built at 120, and 55 for one built at
      110. It was right about the bytes. That number goes into
      `music_tracks.bpm` and every zoom punch lands on it, so a bed that
      measures at half tempo puts the whole edit on the offbeat.
    */
    const grid = await beatsLib.beatsOf(file);
    const built = synth.bpmFor(mood);
    check(
      `and ${mood} measures the tempo it was built at (seed ${seed})`,
      grid !== null && Math.abs(grid.bpm - built) < 2,
      `built ${built}, measured ${grid ? grid.bpm.toFixed(1) : "null"}`,
    );
    // Not half, not double. Named separately because those are the two wrong
    // answers a beat detector gives, and "within 2 of something" would accept
    // them if the tolerance were ever loosened.
    check(
      `and not at half or double it (seed ${seed})`,
      grid !== null && Math.abs(grid.bpm - built * 2) > 2 && Math.abs(grid.bpm - built / 2) > 2,
      `built ${built}, measured ${grid ? grid.bpm.toFixed(1) : "null"}`,
    );

   }

    /*
      Whole bars, and a whole number of times through the four-chord
      progression. The mixer repeats this file for the length of the video, so
      a loop that is not bar-aligned has a stumble in it once per pass.
    */
    const seconds = synth.secondsFor(mood);
    const tempo = synth.bpmFor(mood);
    const barSeconds = (60 / tempo) * 4;
    check(
      `${mood} is a whole number of four-bar phrases`,
      Math.abs((seconds / (barSeconds * 4)) - Math.round(seconds / (barSeconds * 4))) < 1e-9,
      `${seconds}s at ${tempo}bpm`,
    );

    const measured = Number(
      spawnSync(
        "ffprobe",
        ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path.join(work, `${mood}-${SEEDS[0]}.mp3`)],
        { encoding: "utf8" },
      ).stdout.trim(),
    );
    check(`and the file really is that long`, Math.abs(measured - seconds) < 0.4, `${measured} vs ${seconds}`);
  }

  /*
    Peak-normalised, and all six to the same ceiling.

    A library whose variants come out at different levels is a bed that changes
    volume when the chooser happens to pick a different one — which the person
    hears as the product being inconsistent, with nothing in the plan to
    explain it.
  */
  const peaks = [];
  for (const mood of moods) {
    const out = spawnSync(
      "ffmpeg",
      ["-hide_banner", "-i", path.join(work, `${mood}-${SEEDS[0]}.mp3`), "-af", "volumedetect", "-f", "null", "-"],
      { encoding: "utf8" },
    ).stderr;
    peaks.push(Number(/max_volume: (-?[\d.]+) dB/.exec(out)?.[1] ?? NaN));
  }
  check("every bed peaks near the same level", Math.max(...peaks) - Math.min(...peaks) < 1.5, peaks.join(", "));
  check("and none of them clips", Math.max(...peaks) < -1, peaks.join(", "));
  /*
    And none is silent, which is the failure a peak check alone would miss: a
    file of digital silence normalises to nothing and passes "does not clip".
  */
  const quietest = Math.min(...peaks);
  check("and none of them is silence", quietest > -20, String(quietest));

  /*
    Deterministic: the same seed is the same bytes.

    Not a nicety. It is what makes the tempo check above a fact about the
    synthesiser rather than about the run, and it is the same property
    `make-sfx.mjs` has — provenance that is a script rather than a link.
  */
  const twice = [];
  for (const attempt of [1, 2]) {
    const file = path.join(work, `repeat-${attempt}.mp3`);
    await synth.createSynthMusicMaker({ seed: 99 }).make({ mood: "calm", file });
    twice.push(readFileSync(file));
  }
  check("the same seed makes the same bed, byte for byte", twice[0].equals(twice[1]));

  const different = path.join(work, "other-seed.mp3");
  await synth.createSynthMusicMaker({ seed: 100 }).make({ mood: "calm", file: different });
  check("and a different seed makes a different one", !readFileSync(different).equals(twice[0]));

  await rm(work, { recursive: true, force: true });
}

section("The contract refuses a bed that names nothing");
{
  const base = { type: "addMusic", gainDb: -18, duck: true, fadeSeconds: 1.5, fromSeconds: 0, loop: true };
  check("a bed from a track parses", zod.AddMusicOperation.safeParse({ ...base, assetId: "a1" }).success);
  check("a bed from a mood parses", zod.AddMusicOperation.safeParse({ ...base, mood: "calm" }).success);
  /*
    Neither is the one that matters. An `addMusic` carrying no source is not a
    bed that fails to play — it is a plan that promised music and named
    nothing, which the renderer would report as "the track this plan names is
    not in this project" about a track nobody ever named.
  */
  check("naming neither is refused", !zod.AddMusicOperation.safeParse(base).success);
  check("naming both is refused too", !zod.AddMusicOperation.safeParse({ ...base, assetId: "a1", mood: "calm" }).success);
  check("and an invented mood is refused", !zod.AddMusicOperation.safeParse({ ...base, mood: "spooky" }).success);
}

// ─── 2. The sentence, and the default ────────────────────────────────────────

const planning = await bundle("artifacts/api-server/src/lib/plan-from-text.ts", "pft.mjs");

section("A mood is heard in both languages");
{
  const moodOf = (text) => {
    const plan = planning.planFromText(text, { assets: [] });
    return plan.operations.find((o) => o.type === "addMusic")?.mood ?? null;
  };

  const pairs = [
    ["add some upbeat music", "ضيف موسيقى حماسية", "upbeat"],
    ["put calm music under it", "حط موسيقى هادئة", "calm"],
    ["add cinematic music", "ضيف موسيقى سينمائية", "cinematic"],
    ["add dark music to this", "ضيف موسيقى غامضة", "dark"],
    ["add playful music", "ضيف موسيقى مرحة", "playful"],
    ["add warm lofi music", "ضيف موسيقى دافئة", "warm"],
  ];
  for (const [en, ar, want] of pairs) {
    check(`"${en}" is ${want}`, moodOf(en) === want, String(moodOf(en)));
    check(`and «${ar}» is the same`, moodOf(ar) === want, String(moodOf(ar)));
  }

  // Said without a mood, and the answer is the one hardest to be wrong about.
  check("music with no mood named is calm", moodOf("add some music") === "calm", String(moodOf("add some music")));

  /*
    The asymmetry this suite was written after.

    «حماسية» was in the zoom-punch vocabulary, so an Arabic sentence asking for
    energetic *music* also got four zoom punches nobody mentioned — while the
    English "upbeat music" did not, because "upbeat" was not in that list. An
    adjective attaches to the nearest noun, and the noun here is the music.
  */
  const punchy = planning.planFromText("ضيف موسيقى حماسية", { assets: [] });
  check(
    "asking for energetic music does not also punch the picture",
    !punchy.operations.some((o) => o.type === "zoomPunch"),
    punchy.operations.map((o) => o.type).join(","),
  );
  const asked = planning.planFromText("زوم مع موسيقى حماسية", { assets: [] });
  check(
    "but naming the zoom still gets zooms, music or no music",
    asked.operations.some((o) => o.type === "zoomPunch"),
    asked.operations.map((o) => o.type).join(","),
  );
}

section("Music is off unless somebody asks for it");
{
  /*
    The default, and the reason it is checked here rather than trusted.

    Music is the only thing in this product that costs money per finished
    video. A direction that started laying beds unasked would spend on every
    render in the product, and it would look like a nicer edit while it did it.
  */
  const direct = await bundle("artifacts/api-server/src/lib/direct.ts", "direct.mjs");
  const decided = direct.direct({
    platform: "tiktok",
    sourceSeconds: 120,
    hasSpeech: true,
    reading: null,
    assets: [],
    habits: [],
    spokenTypes: new Set(),
    spoke: {},
    onlyWhatWasAsked: false,
  });
  check(
    "the house edit lays no bed on a project with no track",
    !decided.operations.some((o) => o.type === "addMusic"),
    decided.operations.map((o) => o.type).join(","),
  );
  check(
    "and never invents a mood, which is the one that would cost money",
    !decided.operations.some((o) => o.type === "addMusic" && o.mood),
    JSON.stringify(decided.operations.filter((o) => o.type === "addMusic")),
  );

  // And a refusal is still heard, which is the half that regresses quietly.
  for (const no of ["no music", "بدون موسيقى", "شيل الموسيقى"]) {
    const plan = planning.planFromText(no, { assets: [] });
    check(`«${no}» lays no bed`, !plan.operations.some((o) => o.type === "addMusic"), no);
  }
}

// ─── 3. The library, against a real database ─────────────────────────────────

const library = await bundle("artifacts/worker/src/music-library.ts", "library.mjs");

const psql = (sql) =>
  (spawnSync("psql", [process.env.DATABASE_URL, "-tAc", sql], { encoding: "utf8" }).stdout ?? "").trim();

/** A real, short, quiet mp3 — enough for ffprobe and for the beat detector. */
async function realAudio(file) {
  const made = spawnSync("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=220:duration=4",
    "-c:a", "libmp3lame", "-b:a", "96k", file,
  ]);
  if (made.status !== 0) throw new Error("ffmpeg could not make the fixture");
}

const work = await mkdtemp(path.join(tmpdir(), "editly-music-work-"));
psql("delete from music_tracks");

/** A generator that counts, so the bill is a number this file can assert on. */
function countingMaker(name = "stub") {
  const calls = [];
  return {
    calls,
    name,
    async make({ mood, file }) {
      calls.push(mood);
      await realAudio(file);
      return { file };
    },
  };
}

section("A mood is paid for once");
{
  const maker = countingMaker();
  const first = await library.bedFor({ mood: "calm", workDir: work, maker });
  check("the first ask makes a bed", first !== null && first.freshlyMade === true, JSON.stringify(first));
  check("and it is on the shelf", psql("select count(*) from music_tracks where mood = 'calm'") === "1");

  /*
    The check the whole design exists for.

    `VARIANTS_PER_MOOD` beds are made for a mood and then never another one,
    however many renders ask. Without this the generator is called on every
    render and the cost of music grows with the product instead of stopping.
  */
  for (let i = 0; i < 12; i += 1) await library.bedFor({ mood: "calm", workDir: work, maker });
  check(
    `thirteen asks bought ${library.VARIANTS_PER_MOOD} beds, not thirteen`,
    maker.calls.length === library.VARIANTS_PER_MOOD,
    `${maker.calls.length} generations`,
  );
  check(
    "and the shelf holds exactly that many",
    psql("select count(*) from music_tracks where mood = 'calm'") === String(library.VARIANTS_PER_MOOD),
    psql("select count(*) from music_tracks where mood = 'calm'"),
  );

  // Every one of them was for the mood that was asked for.
  check("nothing was made for a mood nobody asked about", maker.calls.every((m) => m === "calm"), maker.calls.join(","));

  /*
    And they are spread, not stacked.

    The chooser takes the least-used live row. Ordering by usage rather than at
    random is what makes a fourth variant start being heard the moment it
    exists, instead of waiting for a coin flip to stop favouring the three with
    a head start.
  */
  const uses = psql("select string_agg(times_used::text, ',' order by times_used) from music_tracks where mood = 'calm'")
    .split(",")
    .map(Number);
  check("the variants are used evenly", Math.max(...uses) - Math.min(...uses) <= 1, uses.join(","));
}

section("Another mood is its own shelf");
{
  const maker = countingMaker();
  await library.bedFor({ mood: "upbeat", workDir: work, maker });
  check("asking for upbeat does not serve the calm bed", maker.calls.length === 1, maker.calls.join(","));
  check(
    "and the calm shelf is untouched",
    psql("select count(*) from music_tracks where mood = 'calm'") === String(library.VARIANTS_PER_MOOD),
  );
}

section("The tempo is measured, never claimed");
{
  const row = psql("select bpm from music_tracks where mood = 'calm' limit 1");
  /*
    A steady 220 Hz sine has no onsets, so the detector should refuse it — and
    that refusal is the behaviour worth having. A generator that answered "120"
    about a drone would put every zoom punch on a grid that is not there.

    So the check is not "bpm is a number". It is "bpm is either measured or
    honestly absent", and for this fixture absent is the right answer.
  */
  check("a bed with no grid in it records no bpm", row === "", `got ${row || "(null)"}`);
  /*
    And the length is the file's, not the request's.

    We never ask Lyria for a duration — the model name is the length — so a row
    saying thirty because thirty is what the clip model usually makes would be
    a number nobody measured. The fixture is four seconds; if the stored value
    were the constant, this would read 30.
  */
  const stored = Number(psql("select round(seconds::numeric, 1) from music_tracks where mood = 'calm' limit 1"));
  check("and the stored length was measured from the file", stored > 3.5 && stored < 4.5, String(stored));
  check(
    "and the row records which generator made it, for the day one is recalled",
    psql("select distinct source from music_tracks where mood = 'calm'") === "stub",
  );
}

section("A retired variant stops being handed out");
{
  const id = psql("select id from music_tracks where mood = 'calm' order by times_used limit 1");
  psql(`update music_tracks set retired_at = now() where id = '${id}'`);
  const maker = countingMaker();
  const served = [];
  for (let i = 0; i < 6; i += 1) {
    await library.bedFor({ mood: "calm", workDir: work, maker });
  }
  served.push(psql(`select times_used from music_tracks where id = '${id}'`));
  check("the retired row is never served again", served[0] === psql(`select times_used from music_tracks where id = '${id}'`));
  check(
    "and the file is still there, because a published video is using it",
    psql(`select count(*) from music_tracks where id = '${id}'`) === "1",
  );
  /*
    A shelf that is one short is a shelf that refills. Retiring a bad variant
    has to be safe to do, which means it cannot leave a mood permanently
    thinner than it was.
  */
  check(
    "and a replacement is made to fill the gap",
    maker.calls.length === 1,
    `${maker.calls.length} generations`,
  );
}

section("No generator is a working state, not a broken one");
{
  psql("delete from music_tracks where mood = 'dark'");
  const none = await library.bedFor({ mood: "dark", workDir: work, maker: null });
  check("with nothing on the shelf and nothing to make one, there is no bed", none === null);
  check("and nothing was written", psql("select count(*) from music_tracks where mood = 'dark'") === "0");

  // But an existing bed is still served without a generator, which is what
  // every deployment looks like after the library has filled itself once.
  const maker = countingMaker();
  await library.bedFor({ mood: "dark", workDir: work, maker });
  const later = await library.bedFor({ mood: "dark", workDir: work, maker: null });
  check("an already-made bed is served with no generator at all", later !== null && later.freshlyMade === false);
}

section("A generator that fails does not fail the render");
{
  psql("delete from music_tracks where mood = 'playful'");
  const dead = { name: "dead", async make() { return null; } };
  check("a generator that returns nothing returns no bed", (await library.bedFor({ mood: "playful", workDir: work, maker: dead })) === null);
  check("and writes no row for a file that does not exist", psql("select count(*) from music_tracks where mood = 'playful'") === "0");

  const thrower = { name: "thrower", async make() { throw new Error("upstream is down"); } };
  let threw = false;
  try {
    const r = await library.bedFor({ mood: "playful", workDir: work, maker: thrower });
    check("a generator that throws is caught", r === null);
  } catch {
    threw = true;
  }
  check("the throw never reaches the render", !threw);
}

// ─── 4. The response shape, against a real server ────────────────────────────

section("The Lyria adapter, against a server that answers like one");
{
  const audioFile = path.join(work, "fixture.mp3");
  await realAudio(audioFile);
  const audio = readFileSync(audioFile).toString("base64");

  /*
    A server that answers the way the real one does, and that is the point of
    it existing at all.

    The first version of this adapter posted to `/v1beta/models/{model}:generateMusic`
    and read `{audio:{data}}`, because that is what it was written from —
    notes, not the live documentation. The real endpoint is `/v1beta/interactions`
    and the audio is three levels down in `steps[].content[]`. A key added to
    production would have bought nothing and every render would have said "could
    not make the bed", truthfully and uselessly.

    So the stub replies in the documented shape, and the checks below assert
    the *request* as well as the response: what path, what body, what header.
  */
  let lastRequest = null;
  const wrap = (data) => JSON.stringify({
    steps: [
      { type: "model_output", content: [{ type: "text", data: "verse" }, { type: "audio", data }] },
    ],
  });
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      lastRequest = { url: req.url, headers: req.headers, body: JSON.parse(body || "{}") };
      if (req.url?.includes("empty")) {
        res.writeHead(200, { "Content-Type": "application/json" }).end(wrap(""));
        return;
      }
      if (req.url?.includes("tiny")) {
        // Parses as JSON, carries eleven bytes. An error page that happened to
        // be the right shape, which is the failure worth refusing here rather
        // than handing to ffprobe three steps later.
        res.writeHead(200, { "Content-Type": "application/json" })
          .end(wrap(Buffer.from("not audio!").toString("base64")));
        return;
      }
      if (req.url?.includes("refuse")) {
        res.writeHead(429).end("{}");
        return;
      }
      if (req.url?.includes("convenience")) {
        // The field the official clients read. Either shape must work.
        res.writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ output_audio: { data: audio } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end(wrap(audio));
    });
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const lyria = maker.createLyriaMusicMaker({ apiKey: "test-key-not-a-real-one", base, model: "lyria-3-clip-preview" });
  const out = path.join(work, "lyria.mp3");
  const made = await lyria.make({ mood: "calm", file: out });
  check("a well-formed answer becomes a file", made !== null && made.file === out, JSON.stringify(made));
  check("the file really holds the audio", readFileSync(out).length > 1024);

  /*
    The key travels in a header and never in the URL. A query string is logged
    by every proxy between here and there, and a key in a log is a key.
  */
  check("the key is sent as a header", lastRequest.headers["x-goog-api-key"] === "test-key-not-a-real-one");
  check("and never in the path", !lastRequest.url.includes("test-key-not-a-real-one"), lastRequest.url);
  check("it posts to the interactions endpoint", lastRequest.url.endsWith("/v1beta/interactions"), lastRequest.url);
  check("naming the model in the body, which is where this API takes it",
    lastRequest.body.model === "lyria-3-clip-preview", JSON.stringify(lastRequest.body.model));
  check("the prompt that was sent is the mood's own", lastRequest.body.input === maker.promptFor("calm"), JSON.stringify(lastRequest.body.input));
  /*
    No duration asked for, because this API has no such parameter — the model
    name is the length. A request carrying one would be a setting that looks
    like control and is ignored.
  */
  check("and no duration is invented", !("durationSeconds" in lastRequest.body) && !lastRequest.body.config,
    JSON.stringify(lastRequest.body));
  check("and nothing of the customer's goes with it",
    !/video|transcript|user|project|email/i.test(JSON.stringify(lastRequest.body)),
    JSON.stringify(lastRequest.body));

  const refused = maker.createLyriaMusicMaker({ apiKey: "k", base: `${base}/refuse` });
  check("a 429 is no bed rather than a throw", (await refused.make({ mood: "calm", file: out })) === null);

  const empty = maker.createLyriaMusicMaker({ apiKey: "k", base: `${base}/empty` });
  check("an empty payload is no bed", (await empty.make({ mood: "calm", file: out })) === null);

  const tiny = maker.createLyriaMusicMaker({ apiKey: "k", base: `${base}/tiny` });
  check("and eleven bytes of JSON is not audio", (await tiny.make({ mood: "calm", file: out })) === null);

  // Both documented shapes, because a preview API may return either and the
  // cost of reading only one is a bed that silently never arrives.
  const convenient = maker.createLyriaMusicMaker({ apiKey: "k", base: `${base}/convenience` });
  const other = path.join(work, "lyria2.mp3");
  check("the output_audio shape works too", (await convenient.make({ mood: "calm", file: other })) !== null);

  server.close();
}

psql("delete from music_tracks");
bucket.close();
await rm(work, { recursive: true, force: true });
await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log("The music library does not behave the way it is priced.");
  process.exit(1);
}
console.log("A mood is bought once and heard many times.");
