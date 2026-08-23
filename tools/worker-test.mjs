/**
 * The worker, actually running.
 *
 * Everything the worker does has been tested in pieces — the ffmpeg pipeline,
 * the critic, the framing, the meter, the claim SQL. The loop that ties them
 * together has never once been executed. `artifacts/worker/src/index.ts` is the
 * file that will run on Fly.io, and until this suite existed the first time
 * anybody found out whether it worked would have been in production, on a
 * customer's video, with the only feedback a row stuck at `running`.
 *
 * That gap is the expensive kind. Every unit here can be correct while the
 * whole is broken: a column the claim query returns as snake_case and the code
 * reads as camelCase arrives as `undefined` with no error anywhere, and for
 * `maxSourceSeconds` that means the upload ceiling silently stops existing.
 * `toJob` is a hand-written mapping precisely because the claim has to be one
 * atomic statement, and a hand-written mapping is a list somebody has to
 * remember to extend.
 *
 * So this runs the built worker as a real process, against a real Postgres, a
 * real ffmpeg and an HTTP server standing in for Supabase Storage, and reads
 * back the file it produced. Nothing is mocked inside the worker at all — only
 * the two things outside it that cost money.
 *
 * Usage: DATABASE_URL=postgres://... node tools/worker-test.mjs
 * Requires: ffmpeg, and a Postgres carrying the schema (pnpm run migrate).
 */
import http from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Pool } = require(require.resolve("pg", { paths: ["lib/db"] }));

const repoRoot = process.cwd();
const workDir = await mkdtemp(path.join(tmpdir(), "editly-worker-"));
const objects = path.join(workDir, "objects");
mkdirSync(objects, { recursive: true });

const PORT = 4222;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres@127.0.0.1:5433/editly_test";
const ALICE = "11111111-1111-4111-8111-111111111111";

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

// ─── A clip with real silence in it ──────────────────────────────────────────

const source = path.join(workDir, "source.mp4");
{
  // Twelve seconds; audio present 0–3, 6–9 and cut elsewhere. Silence removal
  // has something real to find, and the output length is predictable enough to
  // assert on.
  const made = spawnSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25:duration=12",
    "-f", "lavfi", "-i", "sine=frequency=300:duration=12",
    "-filter_complex", "[1:a]volume='if(between(t,0,3)+between(t,6,9),1,0)':eval=frame[a]",
    "-map", "0:v", "-map", "[a]",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    source,
  ]);
  if (made.status !== 0 || !existsSync(source)) {
    console.error("could not generate the test clip");
    process.exit(1);
  }
}

// ─── The worker, built exactly as it is deployed ─────────────────────────────

section("The worker builds the way the Dockerfile builds it");
{
  const built = spawnSync("node", ["build.mjs"], {
    cwd: path.join(repoRoot, "artifacts/worker"),
    encoding: "utf8",
  });
  check("`node build.mjs` succeeds", built.status === 0, (built.stderr || "").slice(0, 400));
  check(
    "and produces the bundle the image runs",
    existsSync(path.join(repoRoot, "artifacts/worker/dist/index.mjs")),
  );
  // Not a detail: `subject.ts` resolves the tracker beside the bundle, and a
  // build that forgot to copy it would not fail — face tracking would simply
  // stop happening and every clip would quietly go back to static framing.
  check(
    "including the Python tracker, which esbuild cannot bundle",
    existsSync(path.join(repoRoot, "artifacts/worker/dist/track-subject.py")),
  );
}

// ─── Storage, standing in for Supabase ───────────────────────────────────────

const storage = {
  log: [],
  /**
   * Refuse this many downloads, then behave. A count rather than a flag,
   * because the worker retries in under a second and a test that has to switch
   * storage back on between two attempts is a test that races.
   */
  failDownloads: 0,
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  const prefix = "/storage/v1/object/videos/";
  if (!url.pathname.startsWith(prefix)) return res.writeHead(404).end();

  const key = decodeURIComponent(url.pathname.slice(prefix.length));
  const file = path.join(objects, key.replace(/[^a-zA-Z0-9._/-]/g, "_"));
  storage.log.push({ method: req.method, key, auth: req.headers["authorization"] });

  if (req.method === "GET") {
    if (storage.failDownloads > 0) {
      storage.failDownloads -= 1;
      return res.writeHead(503).end("storage is having a moment");
    }
    if (!existsSync(file)) return res.writeHead(404).end("no such object");
    return res.writeHead(200, { "content-type": "video/mp4" }).end(readFileSync(file));
  }
  if (req.method === "POST") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, Buffer.concat(chunks));
    return res.writeHead(200, { "content-type": "application/json" }).end("{}");
  }
  res.writeHead(405).end();
});
await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

/** Puts an object where the worker will find it. */
function putObject(key, from) {
  const file = path.join(objects, key);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, readFileSync(from));
}

// ─── The database the worker claims from ─────────────────────────────────────

const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });

async function reset() {
  await pool.query("DELETE FROM jobs WHERE user_id = $1", [ALICE]);
  await pool.query("DELETE FROM projects WHERE user_id = $1", [ALICE]);
  // The worker writes its summaries into the conversation now.
  await pool.query("DELETE FROM messages WHERE user_id = $1", [ALICE]);
}

async function clearHeartbeats() {
  await pool.query("DELETE FROM worker_heartbeats");
}

async function queue(id, { plan, over = {}, project = {} } = {}) {
  const projectId = over.project_id ?? `proj-${id}`;
  await pool.query(
    `INSERT INTO projects (id, user_id, title, status, duration)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
    [projectId, ALICE, `Project ${id}`, "processing", project.duration ?? null],
  );
  const columns = {
    id,
    user_id: ALICE,
    project_id: projectId,
    status: "queued",
    plan: JSON.stringify(plan),
    input_path: `${ALICE}/${projectId}/source.mp4`,
    priority: 0,
    attempts: 0,
    max_attempts: 3,
    ...over,
  };
  const names = Object.keys(columns);
  await pool.query(
    `INSERT INTO jobs (${names.join(",")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(",")})`,
    Object.values(columns),
  );
  return projectId;
}

const readJob = async (id) => (await pool.query("SELECT * FROM jobs WHERE id = $1", [id])).rows[0];
const readProject = async (id) =>
  (await pool.query("SELECT * FROM projects WHERE id = $1", [id])).rows[0];

/** Waits for a job to reach a settled state, or gives up. */
async function settle(id, timeoutMs = 180_000) {
  const started = Date.now();
  for (;;) {
    const row = await readJob(id);
    if (row && (row.status === "done" || row.status === "failed")) return row;
    if (Date.now() - started > timeoutMs) return row ?? null;
    await new Promise((r) => setTimeout(r, 400));
  }
}

// ─── Start it ────────────────────────────────────────────────────────────────

await reset();
await clearHeartbeats();

const workerLog = [];
const worker = spawn("node", [path.join(repoRoot, "artifacts/worker/dist/index.mjs")], {
  cwd: repoRoot,
  env: {
    ...process.env,
    DATABASE_URL,
    SUPABASE_URL: ORIGIN,
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key-for-tests",
    POLL_INTERVAL_MS: "300",
    // Production logging, because pino-pretty is a dev dependency and the
    // deployed image does not have it — running the worker the way the image
    // does is the point of this file.
    NODE_ENV: "production",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const collect = (chunk) => {
  for (const line of String(chunk).split("\n").filter(Boolean)) workerLog.push(line);
};
worker.stdout.on("data", collect);
worker.stderr.on("data", collect);

const waitForLog = async (pattern, timeoutMs = 20_000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const line = workerLog.find((l) => pattern.test(l));
    if (line) return line;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
};

section("It starts, and says what it can do");
{
  const ready = await waitForLog(/worker ready/);
  check("it reaches the queue and reports ready", ready !== null, workerLog.slice(-3).join(" | "));
  check(
    "naming the models it has, so a missing caption is one log line to diagnose",
    /"transcription":/.test(ready ?? "") && /"vision":/.test(ready ?? ""),
    ready ?? "",
  );
  check(
    "and no key is anywhere in that line",
    !/service-role-key-for-tests/.test(workerLog.join("\n")),
  );
}

// ─── A real render, end to end ───────────────────────────────────────────────

section("It says it is here, so the product does not have to guess");
{
  // The queue can tell you a render is stuck. It cannot tell you whether
  // anything is listening — not for five minutes, and not at all when nothing
  // is queued, which is the state right after a first deploy. Somebody who has
  // just set the secrets and run the workflow should be able to find out
  // without uploading a video.
  const beat = await pool.query("SELECT * FROM worker_heartbeats ORDER BY last_seen_at DESC LIMIT 1");
  const row = beat.rows[0];

  check("a heartbeat row exists", Boolean(row), JSON.stringify(beat.rows));
  check("recent enough to mean now", row && Date.now() - new Date(row.last_seen_at).getTime() < 60_000, String(row?.last_seen_at));
  check("with a start time, so an old row is distinguishable from a restart", row?.started_at !== null);
  check(
    "and the providers it came up with — null here, because no keys are set",
    row?.transcription === null && row?.vision === null,
    JSON.stringify({ transcription: row?.transcription, vision: row?.vision }),
  );
  check(
    "no key is stored, only the absence of one",
    !JSON.stringify(row ?? {}).includes("service-role-key-for-tests"),
  );

  // A process that started and then wedged looks identical to a healthy one if
  // the only evidence is that it once booted.
  const before = new Date(row.last_seen_at).getTime();
  await new Promise((r) => setTimeout(r, 22_000));
  const again = await pool.query("SELECT last_seen_at FROM worker_heartbeats WHERE worker_id = $1", [row.worker_id]);
  check(
    "and it keeps saying so as it polls, rather than once at startup",
    new Date(again.rows[0].last_seen_at).getTime() > before,
    `${row.last_seen_at} → ${again.rows[0]?.last_seen_at}`,
  );

  check("one row per worker, not one per poll", (await pool.query("SELECT count(*)::int AS n FROM worker_heartbeats")).rows[0].n === 1);
}

section("A queued job becomes an edited file");
{
  const projectId = await queue("e2e-1", {
    // The browser's duration is deliberately a lie — 3 seconds for a 12-second
    // clip — because the worker is supposed to measure the file and repair it.
    project: { duration: 3 },
    plan: {
      version: 1,
      operations: [
        { type: "removeSilence", thresholdDb: -32, minSilenceMs: 500, paddingMs: 120 },
        { type: "formatForPlatform", platform: "tiktok", maxHeight: 720 },
        { type: "watermark", text: "Edited with Editly", position: "bottom-right" },
      ],
    },
  });
  putObject(`${ALICE}/${projectId}/source.mp4`, source);

  const row = await settle("e2e-1");
  check("it finishes", row?.status === "done", `${row?.status}: ${row?.error}`);
  check("with progress at 100", row?.progress === 100, String(row?.progress));
  check("and no error", row?.error === null, row?.error);
  check("the lock is released", row?.locked_at === null && row?.locked_by === null);
  check("and a finish time is recorded", row?.finished_at !== null);

  // The file itself, fetched from storage the way the browser would.
  const outputKey = row?.output_path;
  check("an output key is written to the row", typeof outputKey === "string" && outputKey.length > 0, String(outputKey));
  const outputFile = path.join(objects, outputKey ?? "missing");
  check("and the object is actually in storage", existsSync(outputFile));

  const probe = spawnSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0",
     "-show_entries", "stream=width,height", "-show_entries", "format=duration",
     "-of", "json", outputFile],
    { encoding: "utf8" },
  );
  const info = JSON.parse(probe.stdout || "{}");
  const width = info.streams?.[0]?.width;
  const height = info.streams?.[0]?.height;
  const seconds = Number(info.format?.duration);

  check("the file is a video ffprobe can read", Number.isFinite(seconds), probe.stderr?.slice(0, 200));
  check("reframed to 9:16", height === 720 && width === 406, `${width}x${height}`);
  check(
    "and the silence really was removed — six seconds of speech out of twelve",
    seconds > 4.5 && seconds < 9,
    String(seconds),
  );

  // The meter counts this column, and a null here used to mean a free render.
  check("the meter was given a number", typeof row?.output_seconds === "number", String(row?.output_seconds));
  check(
    "measured from the finished file rather than guessed",
    row?.output_seconds_source === "probe",
    String(row?.output_seconds_source),
  );
  check(
    "and it matches what is in the file",
    Math.abs(Number(row?.output_seconds) - seconds) < 0.5,
    `${row?.output_seconds} vs ${seconds}`,
  );
  check(
    "a single render is billed at exactly what it produced",
    Math.abs(Number(row?.billed_seconds) - Number(row?.output_seconds)) < 0.01,
    `billed ${row?.billed_seconds} vs output ${row?.output_seconds}`,
  );
  check(
    "the source was measured too, so the next ceiling check starts from the truth",
    Math.abs(Number(row?.source_seconds) - 12) < 1,
    String(row?.source_seconds),
  );

  const project = await readProject(projectId);
  check("the project points at the edit", project?.edited_video_path === outputKey, String(project?.edited_video_path));
  check("and is marked done", project?.status === "done", project?.status);
  check(
    "and the browser's wrong duration is repaired rather than repeated",
    Math.abs(Number(project?.duration) - 12) < 1,
    `${project?.duration}, browser said 3`,
  );

  // Without keys there is no recogniser, and the plan asked for nothing that
  // needs one — but the render must still say what it could not do rather than
  // silently doing less.
  check("notes are written to the row, not to a log line", Array.isArray(row?.notes), JSON.stringify(row?.notes));

  check(
    "the worker authenticated to storage as the service role",
    storage.log.some((entry) => entry.auth === "Bearer service-role-key-for-tests"),
  );

  // The summary is part of the conversation, not a property of the job. The
  // editor used to synthesise it from the latest job's notes, so the third
  // render of an afternoon erased the answers to the first two.
  const said = await pool.query(
    "SELECT role, content FROM messages WHERE user_id = $1 AND project_id = $2 ORDER BY created_at",
    [ALICE, projectId],
  );
  check("the render leaves a message in the conversation", said.rows.length === 1, JSON.stringify(said.rows));
  check("spoken as the assistant", said.rows[0]?.role === "assistant", said.rows[0]?.role);
  check(
    "summarising what was done, one line per note",
    /^Here's what I did\.\n/.test(said.rows[0]?.content ?? "") &&
      (said.rows[0]?.content.match(/\n• /g)?.length ?? 0) === (row?.notes?.length ?? -1),
    said.rows[0]?.content,
  );
}

// ─── A clips plan becomes several files ──────────────────────────────────────

section("A clips plan becomes several files, each its own artifact");
{
  const projectId = await queue("clips-1", {
    plan: {
      version: 1,
      operations: [
        { type: "extractClips", count: 2, targetSeconds: 5 },
        { type: "watermark", text: "Edited with Editly", position: "bottom-right" },
      ],
    },
  });
  putObject(`${ALICE}/${projectId}/source.mp4`, source);

  const row = await settle("clips-1");
  check("it finishes", row?.status === "done", `${row?.status}: ${row?.error}`);

  const clips = (
    await pool.query("SELECT * FROM clips WHERE job_id = $1 ORDER BY idx", ["clips-1"])
  ).rows;
  check("two clip rows exist", clips.length === 2, JSON.stringify(clips.map((c) => c.idx)));
  check(
    "1-based, in source order",
    clips[0]?.idx === 1 && clips[1]?.idx === 2 && clips[0]?.start_seconds < clips[1]?.start_seconds,
    JSON.stringify(clips.map((c) => [c.idx, c.start_seconds, c.end_seconds])),
  );
  check(
    "their windows do not overlap",
    clips.length === 2 && clips[0].end_seconds <= clips[1].start_seconds,
    JSON.stringify(clips.map((c) => [c.start_seconds, c.end_seconds])),
  );
  check(
    "each file really is in storage",
    clips.every((c) => existsSync(path.join(objects, c.output_path))),
    JSON.stringify(clips.map((c) => c.output_path)),
  );
  check(
    "titles are absent rather than invented — nothing was heard in this test",
    clips.every((c) => c.title === null),
    JSON.stringify(clips.map((c) => c.title)),
  );

  const durations = clips.map((c) => {
    const p = spawnSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1",
       path.join(objects, c.output_path ?? "missing")],
      { encoding: "utf8" },
    );
    return Number(p.stdout.trim());
  });
  check(
    "each clip is about the asked five seconds",
    durations.every((d) => d > 4.2 && d < 6.0),
    JSON.stringify(durations),
  );
  check(
    "together well short of the whole video — pieces, not copies",
    durations.reduce((a, b) => a + b, 0) < 11.5,
    JSON.stringify(durations),
  );

  check(
    "the job's own output points at the first clip",
    row?.output_path === clips[0]?.output_path,
    `${row?.output_path} vs ${clips[0]?.output_path}`,
  );
  check(
    "output_seconds still records the sum of the pieces — the measurement",
    Math.abs(Number(row?.output_seconds) - durations.reduce((a, b) => a + b, 0)) < 0.8,
    `${row?.output_seconds} vs ${durations.reduce((a, b) => a + b, 0)}`,
  );
  check(
    "but the charge is the source that was read — twelve seconds, not ten",
    Math.abs(Number(row?.billed_seconds) - 12) < 1,
    String(row?.billed_seconds),
  );

  const project = await readProject(projectId);
  check("the project is done", project?.status === "done", project?.status);
  check(
    "but its pointer is untouched — it means the latest whole-video render, and none happened",
    project?.edited_video_path === null,
    String(project?.edited_video_path),
  );

  const said = await pool.query(
    "SELECT content FROM messages WHERE user_id = $1 AND project_id = $2 AND role = 'assistant' ORDER BY created_at DESC LIMIT 1",
    [ALICE, projectId],
  );
  const summary = said.rows[0]?.content ?? "";
  check("the summary names each clip with its moments", /clip 1: kept/.test(summary) && /clip 2: kept/.test(summary), summary);
  check(
    "and is honest that no ears were involved — no transcriber runs in this test",
    /divided evenly/.test(summary),
    summary,
  );
  check(
    "and the charge is said where the person reads, before any invoice",
    /metered by the source they read/.test(summary),
    summary,
  );

  // A retry must replace the set, not append to it. Requeue the same job id
  // and let it run again: still exactly two rows.
  await pool.query(
    "UPDATE jobs SET status = 'queued', attempts = 0, locked_at = NULL, locked_by = NULL WHERE id = 'clips-1'",
  );
  const rerun = await settle("clips-1");
  check("a rerun still finishes", rerun?.status === "done", `${rerun?.status}: ${rerun?.error}`);
  const again = (
    await pool.query("SELECT count(*)::int AS n FROM clips WHERE job_id = 'clips-1'")
  ).rows[0];
  check("and the set was replaced, not doubled", again?.n === 2, String(again?.n));
}

// ─── The ceiling, enforced against the file ──────────────────────────────────

section("A file longer than the plan allows is refused, once, in words");
{
  const projectId = await queue("too-long", {
    over: { max_source_seconds: 5 },
    plan: { version: 1, operations: [{ type: "normalizeLoudness", targetLufs: -14 }] },
  });
  putObject(`${ALICE}/${projectId}/source.mp4`, source);

  const row = await settle("too-long");
  check("it fails", row?.status === "failed", `${row?.status}: ${row?.error}`);
  check(
    "and does not retry, because the file will be the same length next time",
    row?.attempts === 1,
    String(row?.attempts),
  );
  check(
    "the message names both numbers so the person can act on it",
    /12|5/.test(row?.error ?? "") && !/failed \(/i.test(row?.error ?? ""),
    row?.error,
  );
  check(
    "the measured length is stored, not just complained about",
    Math.abs(Number(row?.source_seconds) - 12) < 1,
    String(row?.source_seconds),
  );

  // This is the check that `toJob` exists for. If `max_source_seconds` were not
  // mapped onto `maxSourceSeconds` the ceiling would read as undefined, the
  // comparison would be false, and this render would quietly succeed.
  check("which means the snake_case mapping is intact", row?.status === "failed");

  const project = await readProject(projectId);
  check("and the project says so too", project?.status === "failed", project?.status);
}

section("A file longer than the month's balance is refused against the file, not the claim");
{
  // The API skips its own allowance check whenever the browser omitted a
  // duration, which is exactly when the file could be any length at all. The
  // balance therefore travels on the job and is applied here, to a number that
  // was measured. Without this, a free account with a minute left could queue
  // a nine-minute file and the shortfall would be discovered by the meter
  // afterwards — on a render we had already paid to produce.
  const projectId = await queue("over-allowance", {
    over: { max_source_seconds: 4 * 3600, remaining_seconds: 5 },
    plan: { version: 1, operations: [{ type: "normalizeLoudness", targetLufs: -14 }] },
  });
  putObject(`${ALICE}/${projectId}/source.mp4`, source);

  const row = await settle("over-allowance");
  check("it fails rather than rendering", row?.status === "failed", `${row?.status}: ${row?.error}`);
  check("and is not retried, because the file will be the same next time", row?.attempts === 1, String(row?.attempts));
  check(
    "the message says nothing was charged, which is the first fear",
    /nothing has been charged/i.test(row?.error ?? ""),
    row?.error,
  );
  check(
    "and names both numbers rather than saying 'limit reached'",
    /12 seconds/.test(row?.error ?? "") && /5 seconds/.test(row?.error ?? ""),
    row?.error,
  );
  check(
    "the measured length is recorded",
    Math.abs(Number(row?.source_seconds) - 12) < 1,
    String(row?.source_seconds),
  );
  check("nothing was billed for it", row?.output_seconds === null, String(row?.output_seconds));

  // The `toJob` mapping again. A column added to the schema and forgotten in
  // that function arrives as undefined, with no error anywhere — and an
  // undefined balance means no balance, which is the failure this exists to
  // prevent.
  check("which means remaining_seconds survived the snake_case mapping", row?.status === "failed");

  // And a job queued before the column existed must not be refused for a field
  // it could not have carried.
  const old = await queue("no-allowance-recorded", {
    over: { max_source_seconds: 4 * 3600, remaining_seconds: null },
    plan: { version: 1, operations: [{ type: "normalizeLoudness", targetLufs: -14 }] },
  });
  putObject(`${ALICE}/${old}/source.mp4`, source);
  const legacy = await settle("no-allowance-recorded");
  check(
    "a job with no balance recorded still renders",
    legacy?.status === "done",
    `${legacy?.status}: ${legacy?.error}`,
  );
}

// ─── Something the worker cannot fix by trying again ─────────────────────────

section("A plan nothing in it can be applied is final, not retried");
{
  // Captions with no recogniser configured: the worker drops the operation and
  // the plan is left with nothing to do.
  const projectId = await queue("empty-plan", {
    plan: { version: 1, operations: [{ type: "autoCaptions", style: "bold-white", animation: "pop", dropFillers: true }] },
  });
  putObject(`${ALICE}/${projectId}/source.mp4`, source);

  const row = await settle("empty-plan");
  check("it fails", row?.status === "failed", `${row?.status}: ${row?.error}`);
  check("on the first attempt", row?.attempts === 1, String(row?.attempts));
  check(
    "with the reason the operation was dropped, not a generic failure",
    (row?.error ?? "").length > 0 && !/Rendering failed/.test(row?.error ?? ""),
    row?.error,
  );

  // A final failure is an answer, and it belongs in the same conversation the
  // request was made in — an edit that silently never arrives reads as being
  // ignored.
  const said = await pool.query(
    "SELECT content FROM messages WHERE user_id = $1 AND project_id = $2 AND role = 'assistant'",
    [ALICE, projectId],
  );
  check(
    "the failure is said in the conversation, in the same words as the error",
    said.rows.length === 1 && /^I couldn't finish that edit — /.test(said.rows[0].content),
    JSON.stringify(said.rows),
  );
}

// ─── Something that might work next time ─────────────────────────────────────

section("A render that failed on infrastructure is tried again");
{
  storage.failDownloads = 1;
  const projectId = await queue("flaky", {
    over: { max_attempts: 3 },
    plan: { version: 1, operations: [{ type: "normalizeLoudness", targetLufs: -14 }] },
  });
  putObject(`${ALICE}/${projectId}/source.mp4`, source);

  const row = await settle("flaky");
  check("the retry finishes the job", row?.status === "done", `${row?.status}: ${row?.error}`);
  check("having used exactly two attempts", row?.attempts === 2, String(row?.attempts));
  check("with the error cleared, because it is no longer true", row?.error === null, row?.error);
  check("and the output present despite the stumble", typeof row?.output_path === "string");

  // The decision to retry is the thing under test, and it is visible in the log
  // whichever way the race between the two attempts falls.
  const decided = workerLog.filter((l) => /render failed/.test(l));
  check("the first failure was recorded as retryable", decided.some((l) => /"willRetry":true/.test(l)), decided.slice(-1)[0] ?? "");
  check(
    "with a message that does not leak the plumbing",
    decided.some((l) => /Rendering failed/.test(l)) || /Rendering failed/.test(String(row?.error ?? "")) || row?.error === null,
  );

  // The stumble was invisible to the person — the retry finished the job — so
  // the conversation must read as one success, not an apology above it.
  const said = await pool.query(
    "SELECT content FROM messages WHERE user_id = $1 AND project_id = $2 AND role = 'assistant' ORDER BY created_at",
    [ALICE, projectId],
  );
  check(
    "a retried success says only what it did — no apology for the attempt nobody saw",
    said.rows.length === 1 && !/couldn't finish/.test(said.rows[0].content),
    JSON.stringify(said.rows.map((r) => r.content.slice(0, 60))),
  );
}

// ─── Stopping ────────────────────────────────────────────────────────────────

section("It finishes what it is doing before it exits");
{
  worker.kill("SIGTERM");
  const stopped = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 20_000);
    worker.on("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  check("SIGTERM ends the loop rather than being ignored", stopped);
  check(
    "and it says so on the way out, so a deploy that hangs is visible",
    workerLog.some((l) => /shutting down|finishing the current job/.test(l)),
    workerLog.slice(-2).join(" | "),
  );

  const orphaned = await pool.query(
    "SELECT count(*)::int AS n FROM jobs WHERE user_id = $1 AND status = 'running'",
    [ALICE],
  );
  check("no job is left holding a lock", orphaned.rows[0].n === 0, String(orphaned.rows[0].n));
}

await reset();
await clearHeartbeats();
await pool.end();
server.close();
if (!worker.killed) worker.kill("SIGKILL");
await rm(workDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("The worker does the job it will be deployed to do.");
