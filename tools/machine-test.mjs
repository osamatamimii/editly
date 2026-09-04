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

  const branch = worker.slice(
    worker.indexOf("if (error instanceof NoRoomHereError)"),
    worker.indexOf("if (error instanceof NoRoomHereError)") + 900,
  );
  check("there is a branch for it at all", branch.length > 100);
  check('the row goes back to "queued", not "failed"', /status: "queued"/.test(branch), branch.slice(0, 120));
  check("the attempt is given back", /attempts: Math\.max\(0, job\.attempts - 1\)/.test(branch), branch.slice(0, 200));
  check("and this machine stops asking for a while", /sleep\(NO_ROOM_PAUSE_MS\)/.test(branch));
  check(
    "nothing is written for the customer to read, because nothing happened to them",
    !/error:/.test(branch),
    branch.slice(0, 200),
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

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("The renderer knows what box it is in.");
