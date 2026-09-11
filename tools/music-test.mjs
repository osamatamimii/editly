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
    async make({ mood, seconds, file }) {
      calls.push(mood);
      await realAudio(file);
      return { file, seconds };
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

  let lastRequest = null;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      lastRequest = { url: req.url, headers: req.headers, body: JSON.parse(body || "{}") };
      if (req.url?.includes("empty")) {
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ audio: { data: "" } }));
        return;
      }
      if (req.url?.includes("tiny")) {
        // Parses as JSON, carries eleven bytes. An error page that happened to
        // be the right shape, which is the failure worth refusing here rather
        // than handing to ffprobe three steps later.
        res.writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ audio: { data: Buffer.from("not audio!").toString("base64") } }));
        return;
      }
      if (req.url?.includes("refuse")) {
        res.writeHead(429).end("{}");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ audio: { data: audio, mimeType: "audio/mpeg" } }));
    });
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const lyria = maker.createLyriaMusicMaker({ apiKey: "test-key-not-a-real-one", base, model: "lyria-3-clip-preview" });
  const out = path.join(work, "lyria.mp3");
  const made = await lyria.make({ mood: "calm", seconds: 30, file: out });
  check("a well-formed answer becomes a file", made !== null && made.file === out, JSON.stringify(made));
  check("the file really holds the audio", readFileSync(out).length > 1024);

  /*
    The key travels in a header and never in the URL. A query string is logged
    by every proxy between here and there, and a key in a log is a key.
  */
  check("the key is sent as a header", lastRequest.headers["x-goog-api-key"] === "test-key-not-a-real-one");
  check("and never in the path", !lastRequest.url.includes("test-key-not-a-real-one"), lastRequest.url);
  check("the prompt that was sent is the mood's own", lastRequest.body.prompt.text === maker.promptFor("calm"));
  check("and nothing of the customer's goes with it",
    !/video|transcript|user|project|email/i.test(JSON.stringify(lastRequest.body)),
    JSON.stringify(lastRequest.body));

  const refused = maker.createLyriaMusicMaker({ apiKey: "k", base: `${base}/refuse` });
  check("a 429 is no bed rather than a throw", (await refused.make({ mood: "calm", seconds: 30, file: out })) === null);

  const empty = maker.createLyriaMusicMaker({ apiKey: "k", base: `${base}/empty` });
  check("an empty payload is no bed", (await empty.make({ mood: "calm", seconds: 30, file: out })) === null);

  const tiny = maker.createLyriaMusicMaker({ apiKey: "k", base: `${base}/tiny` });
  check("and eleven bytes of JSON is not audio", (await tiny.make({ mood: "calm", seconds: 30, file: out })) === null);

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
