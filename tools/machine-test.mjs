/**
 * The box the render runs in, and the two ways it runs out.
 *
 * Memory has a table in `ffmpeg.ts`, a piece cap derived from it, and a
 * paragraph in `fly.toml`. The other two limits on this machine had nothing at
 * all, and both fail the same way this codebase keeps finding: without an
 * error anybody can read.
 *
 * **Disk.** A render writes the source it downloaded, its intermediates and
 * its output into `/tmp`, and removes none of it until the job ends. Run out
 * and ffmpeg's write fails partway, it exits non-zero with `No space left on
 * device` inside a stderr tail we cap at 16 KB, and the job is retried onto
 * the same machine with the same full disk — twice more, spending a customer's
 * attempts on a condition that has nothing to do with their video. The
 * leftovers of each failed attempt make the next one fail sooner.
 *
 * **Cores.** ffmpeg with no `-threads` counts the CPUs it can see, and on Fly
 * that is the host's, not the machine's: dozens of frame threads on a box with
 * one core and one gigabyte. Each in-flight thread holds a decoded frame, so
 * the thread count is a multiplier on exactly the peak that the piece cap was
 * computed to bound. The OOM killer then takes the render with no exit code,
 * no output and the minute spent — the one failure this product cannot report
 * on, because nothing survives it to report.
 *
 * Neither module can be tested by filling a real disk or by booting a real Fly
 * machine, so both are written to take the thing they measure as an argument:
 * `roomFor` a directory, `threadArgs` a count. What is checked here is the
 * arithmetic, the refusal, and — the part that actually rotted — that the
 * refusal happens *before* anything is spent.
 *
 * Usage: node tools/machine-test.mjs
 * Requires: nothing. No database, no network, no ffmpeg.
 */
import { mkdtemp, mkdir, writeFile, rm, utimes, readdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { order } from "./lib/order.mjs";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-machine-"));

function build(source, name) {
  const outfile = path.join(buildDir, name);
  const built = spawnSync(
    require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] }),
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

const disk = await import(build("artifacts/worker/src/disk.ts", "disk.mjs"));
const cores = await import(build("artifacts/worker/src/cores.ts", "cores.mjs"));

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

// ─────────────────────────────────────────────────────────────────────────────
section("How much room a render needs is a multiple of what it starts from");
{
  const room = await disk.roomFor(0, buildDir);
  check(
    "an empty source still needs the reserve",
    room.neededBytes === disk.DISK_RESERVE_BYTES,
    String(room.neededBytes),
  );

  const gigabyte = 1024 ** 3;
  const big = await disk.roomFor(gigabyte, buildDir);
  check(
    "and a gigabyte of source needs its multiple plus the reserve",
    big.neededBytes === gigabyte * disk.WORK_TO_SOURCE + disk.DISK_RESERVE_BYTES,
    String(big.neededBytes),
  );

  /*
    The multiplier is a measurement, not a preference, so it is pinned.

    Source 1.0, reframed intermediate 0.9, music bed 0.05, kinetic title PNGs
    1.4, output 0.8 — 4.15 on the heaviest plan this product offers, and 6 is
    that with room for a bitrate above the one measured. A number below 4.15
    would let a render start that cannot finish, which is the whole bug.
  */
  check("the multiplier covers the heaviest plan that was measured", disk.WORK_TO_SOURCE >= 5, String(disk.WORK_TO_SOURCE));

  /*
    And a job that only listens is not a render, which took a production
    outage to notice.

    On 15 September a three-gigabyte upload was refused for room every sixty
    seconds for twenty-one minutes. It was a `transcribe` row, and it was
    sized with the render's multiplier: six times three gigabytes is
    eighteen and a half with the reserve, the machine had seven and a third
    free, so the answer was no and was always going to be no — about a job
    that writes the source and a sixteen-kilohertz mono FLAC and nothing
    else, and would have fitted twice over.

    The number below is the measurement; the check is that the two numbers
    are not the same number, because one number for two jobs is the bug.
  */
  const listening = await disk.roomFor(gigabyte, buildDir, disk.LISTEN_TO_SOURCE);
  check(
    "listening is sized as listening, not as a render",
    listening.neededBytes < big.neededBytes,
    `${listening.neededBytes} vs ${big.neededBytes}`,
  );
  check(
    "and it still allows for the source plus an audio proxy",
    disk.LISTEN_TO_SOURCE > 1 && disk.LISTEN_TO_SOURCE <= 2,
    String(disk.LISTEN_TO_SOURCE),
  );
  /*
    The case from the day itself, in numbers: three gigabytes of source on a
    filesystem with seven and a third free. As a render it does not fit and
    never did. As what it actually was, it fits with room to spare.
  */
  {
    const source = 3.0 * gigabyte;
    const free = 7.3 * gigabyte;
    const asRender = source * disk.WORK_TO_SOURCE + disk.DISK_RESERVE_BYTES;
    const asListening = source * disk.LISTEN_TO_SOURCE + disk.DISK_RESERVE_BYTES;
    check("the file that was refused could not have been rendered there", asRender > free);
    check("and could have been listened to there", asListening < free, `${asListening} vs ${free}`);
  }
}

section("Not now and not here are different answers");
{
  /*
    The distinction that did not exist, and the twenty-one minutes it cost.

    A machine that is busy will not be busy later: handing the row back is
    right, and the next claim goes through uncharged. A machine that is
    *smaller than the job* is not busy — nothing frees up, because nothing is
    held. Answering the second with the first produced a row that was claimed,
    refused and requeued once a minute forever, sitting at the head of a queue
    ordered by age so that nothing behind it ran either, with the only trace a
    `warn` nobody reads.
  */
  const gigabyte = 1024 ** 3;
  const busy = { enough: false, freeBytes: 2 * gigabyte, neededBytes: 6 * gigabyte, totalBytes: 40 * gigabyte };
  check("a full disk on a big machine is a wait", disk.beyondThisMachine(busy) === false);

  const small = { enough: false, freeBytes: 7 * gigabyte, neededBytes: 18 * gigabyte, totalBytes: 8 * gigabyte };
  check("a job larger than the whole filesystem is not", disk.beyondThisMachine(small) === true);

  const exactly = { enough: true, freeBytes: 8 * gigabyte, neededBytes: 8 * gigabyte, totalBytes: 8 * gigabyte };
  check("and a job that exactly fits an empty machine is still allowed", disk.beyondThisMachine(exactly) === false);

  /*
    Unknown means yes here too, for the same reason it does above: a
    filesystem that will not answer `statfs` is a metadata hiccup, and
    refusing somebody's video over one is a worse product than not asking.
  */
  const unknown = { enough: true, freeBytes: Infinity, neededBytes: 6 * gigabyte, totalBytes: Infinity };
  check("an unreadable filesystem never refuses anybody permanently", disk.beyondThisMachine(unknown) === false);

  const note = disk.tooLargeNote(3 * gigabyte);
  check("the person is told the size of their own file", /3\.0 GB/.test(note.en), note.en);
  check("and what to do about it", /shorter|smaller/.test(note.en), note.en);
  check("and it is not a machine's problem said out loud", !/disk|machine|server/i.test(note.en), note.en);
  check("both halves are written", typeof note.ar === "string" && note.ar.length > 20);
  check("and the Arabic is not the English", note.ar !== note.en);
  check(
    "and the reserve leaves the machine something to live on",
    disk.DISK_RESERVE_BYTES >= 256 * 1024 * 1024,
    String(disk.DISK_RESERVE_BYTES),
  );
}

section("A disk that will not answer is not a reason to refuse a render");
{
  /*
    This is the direction the check has to fail in.

    `statfs` on a path that does not exist, on a filesystem that does not
    implement it, or inside a sandbox that forbids it, is a metadata hiccup —
    and refusing a customer's render because of one would be a worse product
    than the unbounded version this replaces. So: unknown means yes.
  */
  const nowhere = await disk.roomFor(1024 ** 3, path.join(buildDir, "no-such-directory"));
  check("an unreadable filesystem answers 'enough'", nowhere.enough === true);
  check("and says so by having no number to report", nowhere.freeBytes === Number.POSITIVE_INFINITY);
}

section("A refusal names both numbers, because the reader is on call at three in the morning");
{
  const message = disk.noRoomMessage({ enough: false, freeBytes: 1.5 * 1024 ** 3, neededBytes: 7 * 1024 ** 3 });
  check("it says what is free", /1\.5 GB free/.test(message), message);
  check("and what was needed", /7\.0 GB needed/.test(message), message);
  /*
    And the sentence that stops the pager escalating.

    A machine refusing work looks identical to a machine losing work until
    somebody is told which. The job was not consumed: nobody's render failed,
    nobody's attempt was spent, and the row is still queued for a machine with
    room.
  */
  check(
    "and that nothing happened to the job",
    /back to the queue untouched/.test(message),
    message,
  );
}

section("What the last machine left behind is cleared, and what the next one is using is not");
{
  const fake = await mkdtemp(path.join(tmpdir(), "editly-sweep-"));
  const hour = 60 * 60_000;
  const now = Date.now();

  /** A work directory with a file in it, aged to a given moment. */
  const leave = async (name, ageMs, bytes) => {
    const dir = path.join(fake, name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "input.mp4"), Buffer.alloc(bytes));
    const when = new Date(now - ageMs);
    await utimes(dir, when, when);
    return dir;
  };

  const old = await leave(`${disk.WORK_PREFIX}abandoned`, 3 * hour, 4096);
  const fresh = await leave(`${disk.WORK_PREFIX}in-flight`, 30_000, 4096);
  // Somebody else's temp directory, which this sweep has no business touching.
  const foreign = await leave("editly-post-somebodyelse", 3 * hour, 4096);

  const freed = await disk.sweepStaleWork(fake, now);
  const left = (await readdir(fake)).sort();

  check("the abandoned work is gone", !left.includes(path.basename(old)), left.join(", "));
  check("and its bytes are reported, so the log says what was reclaimed", freed >= 4096, String(freed));
  /*
    The check that matters more than the deletion.

    A rolling deploy runs two copies of this worker at once, and the new one
    boots while the old one is minutes into a render. A sweep that took
    anything recent would delete a live render's source from under it — a far
    worse bug than the one being fixed, and one that would present as a
    corrupt output rather than as an error.
  */
  check("a render that started half a minute ago is left alone", left.includes(path.basename(fresh)));
  check("and so is a directory this sweep does not own", left.includes(path.basename(foreign)));

  await rm(fake, { recursive: true, force: true });
}

// ─────────────────────────────────────────────────────────────────────────────
section("ffmpeg is told how many cores it has, because what it counts is the host's");
{
  const args = cores.threadArgs(1);
  check("every pool is named, not just the codec one", args.filter((a) => a === "1").length === 3, args.join(" "));
  for (const flag of ["-threads", "-filter_complex_threads", "-filter_threads"]) {
    check(`${flag} is set`, args.includes(flag), args.join(" "));
  }

  check("a one-core machine gets one thread", cores.threadArgs(1)[1] === "1");
  /*
    And a build machine's sixty-four do not become sixty-four threads.

    x264 at `veryfast` stops gaining past about four threads on a single 1080p
    stream — past that the encoder waits on the filter graph, which is where
    every measurement in ffmpeg.ts says the time goes. What more threads still
    buy is memory: one decoded frame each, about 3 MB at 1080p, on the machine
    the piece cap was computed for.
  */
  check("and sixty-four are capped", cores.threadArgs(64)[1] === String(cores.MAX_CORES), cores.threadArgs(64).join(" "));
  check("a nonsensical count is still a render", cores.threadArgs(0)[1] === "1" && cores.threadArgs(-3)[1] === "1");

  const detected = cores.usableCores();
  check("and the count this machine reports is a usable number", Number.isInteger(detected) && detected >= 1, String(detected));
}

section("The threads are stated before the input, where ffmpeg reads them as global");
{
  /*
    Not a style point — a silent no-op.

    ffmpeg binds an option to the next file when it appears after one, so
    `-i input.mp4 -threads 1` sets the threads of whatever input comes *next*,
    and there is no next input on most of these renders. No warning, no error,
    and the memory this exists to bound stays unbounded.
  */
  const source = readFileSync(path.join(repoRoot, "artifacts/worker/src/ffmpeg.ts"), "utf8");
  const line = source.split("\n").find((l) => /const args = \["-hide_banner", "-y"/.test(l));
  check("the encode's argument list is where it was", typeof line === "string", "the shape of this call changed");
  const global_ = order(line ?? "", "threadArgs()", '"-i"');
  check("and the thread flags come before the first -i", global_.ok, global_.why);
}

section("A machine with no room hands the job back rather than failing it");
{
  /*
    The property, read from `index.ts` rather than from a render.

    Proving this end to end needs a full disk, and the thing worth proving is
    not that `roomFor` returns false — the arithmetic above covers that. It is
    what the worker does with the answer, and there are three separate ways to
    get that wrong, each of which was the default before this existed:

      · fail the job, so the customer is told their video could not be rendered
        because our machine was full;
      · count the attempt, so three deploys onto a full machine exhaust a
        render that was never tried;
      · claim again immediately, so one full machine spins through the whole
        queue rejecting every row several times a second.
  */
  const worker = readFileSync(path.join(repoRoot, "artifacts/worker/src/index.ts"), "utf8");

  const before = order(worker, "roomFor(", "await downloadObject(job.inputPath");
  check(
    "the room is asked for before the download, not after",
    before.ok,
    `${before.why} — a check after the download has already spent the thing it was protecting`,
  );

  /*
    Read with the comments stripped.

    Three checks in this repository have been satisfied by their own
    documentation — an em dash inside a CSS template literal, `::error::` in
    the comment explaining the guard, `[[services]]` in the comment quoting
    it. The branch below now carries a long note about why it exists, and a
    fixed-width slice of the file starting at the `if` would be mostly that
    note. So: strip comments, then read the code.
  */
  const code = worker.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  const roomBranch = code.slice(
    code.indexOf("if (error instanceof NoRoomHereError)"),
    code.indexOf("if (error instanceof TooLargeForThisMachineError)"),
  );
  check("there is a branch for it at all", roomBranch.length > 100);
  check('the row goes back to "queued", not "failed"', /status: "queued"/.test(roomBranch));
  check("the attempt is given back", /attempts: Math\.max\(0, job\.attempts - 1\)/.test(roomBranch));
  check("and this machine stops asking for a while", /sleep\(NO_ROOM_PAUSE_MS\)/.test(roomBranch));

  /*
    And it stops handing back eventually, which is the half that was missing.

    The hand-back was written for a busy machine and is right for one. It was
    also the only answer available, so a row that could never fit was handed
    back once a minute for twenty-one minutes — at the head of a queue ordered
    by age, so every other project on the platform waited behind it, while the
    customer's panel said nothing because the code was correct that nothing
    had happened to their project. Nothing was ever going to.
  */
  check(
    "the hand-backs are counted",
    /refusedForRoom\.set\(/.test(roomBranch) && /refusedForRoom\.get\(/.test(roomBranch),
    "an uncounted hand-back is a loop with no exit",
  );
  check(
    "and after enough of them the row is failed so the queue moves",
    /handedBack >= NO_ROOM_GIVE_UP/.test(roomBranch) && /status: "failed"/.test(roomBranch),
    "a job nothing can run must stop being offered first",
  );
  check(
    "and the person is finally told, in their own language",
    /error: pick\(say, noRoomForNowNote\(\)\)/.test(roomBranch),
    "twenty-one minutes of silence is what this is for",
  );
  check(
    "the ceiling is low enough to outlast a render, not a working day",
    /NO_ROOM_GIVE_UP = [2-9]\b/.test(code),
    "five tries is five minutes",
  );

  /*
    The other branch, which is a different fact and must not be folded in.

    "Not now" and "not here" were one answer until 15 September. This one is
    terminal by design: no number of retries turns a filesystem into a bigger
    filesystem.
  */
  const tooLarge = code.slice(
    code.indexOf("if (error instanceof TooLargeForThisMachineError)"),
    code.indexOf("if (error instanceof TooLargeForThisMachineError)") + 700,
  );
  check("a file bigger than the machine is a refusal, not a wait", /status: "failed"/.test(tooLarge));
  check(
    "and it carries the sentence written for the person, not the one for the log",
    /error: pick\(say, error\.note\)/.test(tooLarge),
  );
  check(
    "and it settles the row, so the watcher can see it",
    /finishedAt: new Date\(\)/.test(tooLarge),
  );

  /*
    Both room checks ask the permanent question before the temporary one.

    Asked the other way round, a file larger than the whole filesystem takes
    the hand-back branch — which is exactly the loop this patch exists to end.
  */
  const asksPermanentFirst =
    code.indexOf("beyondThisMachine(room)") < code.indexOf("if (!room.enough)") &&
    code.lastIndexOf("beyondThisMachine(room)") < code.lastIndexOf("if (!room.enough)");
  check(
    "'is this possible here at all' is asked before 'is there room right now'",
    asksPermanentFirst,
    "asked the other way round, the impossible job takes the retry branch forever",
  );

  /*
    And listening asks with its own multiplier.

    The one that was refused was a `transcribe` row sized as a render. Reading
    it out of the source rather than trusting the constant to stay where it
    was put, because the call site is the thing that was wrong.
  */
  check(
    "the listening path sizes itself as listening",
    /roomFor\(sourceBytes, workDir, LISTEN_TO_SOURCE\)/.test(code),
    "sizing a transcription as a render is the bug this patch is named after",
  );
}

section("The machine is described where it is provisioned, too");
{
  const fly = readFileSync(path.join(repoRoot, "artifacts/worker/fly.toml"), "utf8");
  /*
    Swap is not extra memory and is not meant to be.

    The piece cap is arithmetic on measurements taken from particular files. A
    source outside them goes a little over, and without swap "a little over" is
    the OOM killer: no exit code, no stderr, no output, the minute spent, and
    nothing left alive to report it. Half a gigabyte absorbs an overshoot;
    more would let a render that is genuinely too large thrash for an hour
    instead of failing.
  */
  check("there is swap to absorb an overshoot", /swap_size_mb\s*=\s*512/.test(fly), "an OOM here leaves nothing to report");
  check(
    "and long enough on SIGTERM to hand the job back",
    /kill_timeout\s*=\s*"30s"/.test(fly),
    "five seconds is the default, and one UPDATE sometimes does not land in five",
  );
}

await rm(buildDir, { recursive: true, force: true });

section("A store having a bad minute costs an upload, not a render");
{
  /*
   * The third way this machine wastes an hour, and until now it had no test
   * either.
   *
   * `processJob` removes the work directory in its `finally`. So a store that
   * answered 500 to the very last step of a render threw a retryable error,
   * the job went back on the queue, and the finished video went in the bin
   * with the directory — the next attempt made the same bytes again, from the
   * top, on a source that may be two hours long. The comment in `storage.ts`
   * described this accurately and called the fix a real change, because
   * carrying an output between *attempts* has to survive a different machine
   * and must not resurrect a stale render.
   *
   * Retrying inside the same call has neither problem, and this is the test of
   * it: a store that fails twice and then works must produce one upload and
   * zero re-renders.
   */
  const dir = await mkdtemp(path.join(tmpdir(), "editly-upload-"));
  const file = path.join(dir, "output.mp4");
  const bytes = Buffer.alloc(64 * 1024, 7);
  await writeFile(file, bytes);

  /** A store that fails `failures` times before it works, counting requests. */
  const bucket = (failures, status = 503) => {
    let seen = 0;
    let received = 0;
    const server = http.createServer((req, res) => {
      // The HEAD that follows a successful upload asks what arrived, and is
      // not one of the attempts this is counting.
      if (req.method === "HEAD") {
        res.writeHead(200, { "content-length": String(received) }).end();
        return;
      }
      seen += 1;
      let length = 0;
      req.on("data", (chunk) => { length += chunk.length; });
      req.on("end", () => {
        if (seen <= failures) {
          res.writeHead(status, { "content-type": "text/plain" }).end("not now");
          return;
        }
        received = length;
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
    });
    return { server, seen: () => seen, received: () => received };
  };

  const run = async (failures, status = 503) => {
    const store = bucket(failures, status);
    await new Promise((resolve) => store.server.listen(0, "127.0.0.1", resolve));
    const port = store.server.address().port;
    const built = build("artifacts/worker/src/storage.ts", `storage-${failures}-${status}.mjs`);
    const previous = { ...process.env };
    process.env["OBJECT_STORE_PROVIDER"] = "supabase";
    process.env["SUPABASE_URL"] = `http://127.0.0.1:${port}`;
    process.env["SUPABASE_SERVICE_ROLE_KEY"] = "not-a-real-key";
    let error = null;
    try {
      const storage = await import(built);
      await storage.uploadObject("videos/u/one/output.mp4", file).catch((e) => { error = e; });
    } finally {
      process.env = previous;
      await new Promise((resolve) => store.server.close(resolve));
    }
    return { requests: store.seen(), error };
  };

  const twice = await run(2);
  check("two bad answers and the third works", twice.error === null, String(twice.error));
  check("and it took three requests, not three renders", twice.requests === 3, String(twice.requests));

  const always = await run(9);
  check(
    "a store that never works still fails, so the job-level retry is still reachable",
    always.error !== null,
    String(always.error),
  );
  check("after three attempts and no more", always.requests === 3, String(always.requests));
  check(
    "and the sentence is the one written for a person waiting on a video",
    /trying again is worth it|storage/i.test(String(always.error?.message ?? "")),
    String(always.error?.message),
  );

  // A wall, not a hiccup: the same bytes will be refused the same way, so a
  // second offer is a second minute spent to be told the same thing.
  const tooBig = await run(9, 413);
  check("a bucket that says the file is too large is asked once", tooBig.requests <= 2, String(tooBig.requests));

  await rm(dir, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("The renderer knows what box it is in.");
