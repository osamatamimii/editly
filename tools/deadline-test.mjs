/**
 * Nothing this worker starts may run forever.
 *
 * The bug this file guards against does not fail. Every child process in the
 * worker was spawned with no ceiling, and one that hangs takes the whole
 * platform down while every instrument reads green:
 *
 *   `run()` awaits `close`, which never comes, so the job never returns; the
 *   lock keeper goes on renewing the row's lock *and the worker's heartbeat*
 *   on a timer, so nothing ever requeues the job and `/api/healthz` keeps
 *   answering `worker.online: true`; so the hourly watch — the monitor written
 *   because of the two-day outage in August — reports the platform healthy,
 *   while every render in the queue waits behind one wedged ffmpeg. Forever.
 *
 * So the property under test is not "does the timer fire". It is the three
 * things that have to be true together for a ceiling to be worth having:
 *
 *   1. A hung child is actually killed — proved on a real ffmpeg blocked on a
 *      real pipe, not on `sleep`, because SIGKILL against a process sitting in
 *      a blocking read is the case that has to work.
 *   2. A working child is never killed for working. A ceiling that cuts off a
 *      Pro customer's ninety-minute render turns their bug into ours and bills
 *      them for it. This is why the render limit is stall-led.
 *   3. The caller can *tell*. Killing a child makes it emit `close`, the same
 *      event a finished child emits, so any wrapper that resolves on `close`
 *      without asking would hand back half a video, a beat grid read from a
 *      fragment, or an interest profile from the first four seconds of a
 *      ninety-second clip — and call it a success.
 *
 * The third is the one worth a suite. The first two are timers; the third is
 * the bug moved one layer down.
 *
 * Usage: node tools/deadline-test.mjs
 * Requires: ffmpeg and mkfifo. No database, no keys, no network.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-deadline-"));
const outfile = path.join(buildDir, "deadline.mjs");

const built = spawnSync(
  require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] }),
  [
    path.join(repoRoot, "artifacts/worker/src/deadline.ts"),
    "--bundle", "--platform=node", "--format=esm", "--target=node22",
    `--outfile=${outfile}`, "--log-level=error",
  ],
  { stdio: "inherit" },
);
if (built.status !== 0) {
  console.error("could not bundle deadline.ts");
  process.exit(1);
}
const { guard, TimedOutError, LIMITS, ENCODE_SECONDS_PER_SOURCE_SECOND, deliverableSourceMinutes } =
  await import(pathToFileURL(outfile).href);

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

const closed = (child) => new Promise((resolve) => child.on("close", (code) => resolve(code)));

// ── A real hang, not a simulated one ────────────────────────────────────────
section("An ffmpeg that has stopped moving is stopped");

{
  // A FIFO nobody writes to. ffmpeg opens it and blocks in the kernel waiting
  // for bytes that never come — no progress, no error, no exit. This is the
  // shape of the production hang: a source that neither delivers nor fails.
  const fifo = path.join(buildDir, "never.mkv");
  const made = spawnSync("mkfifo", [fifo]);
  check("a pipe that never delivers can be made", made.status === 0, String(made.stderr));

  // Something must hold the write end open, or ffmpeg's open() returns
  // immediately at EOF and it exits cleanly — which would make this a test of
  // nothing at all.
  const holder = spawn("sh", ["-c", `exec 3>${fifo}; sleep 60`]);

  const child = spawn("ffmpeg", ["-hide_banner", "-nostdin", "-i", fifo, "-f", "null", "-"]);
  const started = Date.now();
  const deadline = guard(child, { stallMs: 2000, what: "reading the video" });
  child.stdout.on("data", () => deadline.touch());
  child.stderr.on("data", () => deadline.touch());

  const code = await closed(child);
  const took = Date.now() - started;
  deadline.clear();
  holder.kill("SIGKILL");

  check("it is killed rather than waited on", deadline.expired, `exit ${code} after ${took}ms`);
  check(
    "and promptly — within twice the limit, not on some later sweep",
    took < 8000,
    `${took}ms`,
  );
  check("the reason survives as something throwable", deadline.error instanceof TimedOutError, "");
  check(
    "and reads as a sentence, because it reaches a person",
    / /.test(deadline.error?.message ?? "") && (deadline.error?.message ?? "").length > 40,
    deadline.error?.message ?? "",
  );
  check(
    "which says what was being done, not which binary was running",
    (deadline.error?.message ?? "").includes("reading the video"),
    deadline.error?.message ?? "",
  );
}

// ── The half of it that is easy to get wrong ────────────────────────────────
section("A child that is working is left alone");

{
  // Talks every 200ms for two seconds, against a stall limit of one second.
  // Under a *total* limit this would be killed; under a stall limit it must
  // not be, and that difference is the whole reason there are two.
  const child = spawn("sh", ["-c", "for i in 1 2 3 4 5 6 7 8 9 10; do echo working; sleep 0.2; done"]);
  const deadline = guard(child, { stallMs: 1000, what: "a long render" });
  child.stdout.on("data", () => deadline.touch());

  const code = await closed(child);
  deadline.clear();
  check("ten seconds of steady output is not a hang", !deadline.expired, `exit ${code}`);
  check("and it finishes normally", code === 0, String(code));
}

{
  // The backstop. Chattering forever is still not progress, so the total limit
  // has to bite even while the stall limit is being satisfied.
  const child = spawn("sh", ["-c", "while true; do echo busy; sleep 0.1; done"]);
  const deadline = guard(child, { stallMs: 60_000, totalMs: 1500, what: "a render" });
  child.stdout.on("data", () => deadline.touch());
  await closed(child);
  deadline.clear();
  check("a child that talks forever still meets the total ceiling", deadline.expired, "");
  check("and is reported as having overrun, not stalled", deadline.error?.kind === "overran", String(deadline.error?.kind));
}

{
  const child = spawn("sh", ["-c", "sleep 5"]);
  const deadline = guard(child, { stallMs: 500, what: "something" });
  deadline.clear();
  const code = await closed(child).catch(() => null);
  check(
    "a cleared deadline never fires, so a finished child is never killed late",
    !deadline.expired,
    String(code),
  );
  child.kill("SIGKILL");
}

// ── The bug, one layer down ─────────────────────────────────────────────────
section("Every wrapper asks whether its child was killed");

{
  /*
    A killed child emits `close` with a code, exactly like a finished one. So a
    wrapper that resolves on `close` and only inspects the exit code cannot see
    the difference — it returns whatever partial output it collected as though
    the work were done.

    That is not hypothetical: three of the wrappers in this worker resolve on
    *any* exit code by design, because they run ffmpeg for what it says rather
    than for what it writes. Those are precisely the ones where a timeout would
    otherwise pass silently.

    Read out of the source, because the property is "nobody forgot", and the
    only way to check that is to look at all of them.
  */
  const sources = readdirSync(path.join(repoRoot, "artifacts/worker/src"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => ({ file: f, text: readFileSync(path.join(repoRoot, "artifacts/worker/src", f), "utf8") }));

  check("there is worker source to read", sources.length > 5, String(sources.length));

  const spawners = sources.filter((s) => s.file !== "deadline.ts" && /\bspawn\(/.test(s.text));
  check("and it spawns things", spawners.length > 0, "");

  const unguarded = spawners.filter((s) => !/\bguard\(/.test(s.text));
  check(
    "every file that starts a process puts a ceiling on it",
    unguarded.length === 0,
    unguarded.map((s) => s.file).join(", "),
  );

  const spawnCount = spawners.reduce((n, s) => n + (s.text.match(/\bspawn\(/g) ?? []).length, 0);
  const guardCount = spawners.reduce((n, s) => n + (s.text.match(/\bguard\(/g) ?? []).length, 0);
  check(
    "one ceiling per process, so the eleventh one added is not the exception",
    guardCount >= spawnCount,
    `${spawnCount} spawned, ${guardCount} guarded`,
  );

  const notConsulted = spawners.filter((s) => !/deadline\.expired|Deadline\.error|deadline\.error|timedOut/.test(s.text));
  check(
    "and every one of them checks the flag before reporting success",
    notConsulted.length === 0,
    // Without this the ceiling makes things worse: the render is cut short and
    // then handed on as finished.
    notConsulted.map((s) => s.file).join(", "),
  );
}

// ── The numbers themselves ──────────────────────────────────────────────────
section("The ceilings are the right way round");

{
  check(
    "a probe is judged in minutes and a render in hours",
    LIMITS.probe.totalMs < LIMITS.render.totalMs,
    `${LIMITS.probe.totalMs} vs ${LIMITS.render.totalMs}`,
  );
  check(
    "the render's ceiling is stall-led, so a slow honest render is never cut off",
    LIMITS.render.stallMs > 0 && LIMITS.render.stallMs < LIMITS.render.totalMs,
    JSON.stringify(LIMITS.render),
  );
  check(
    "and it clears the longest thing anyone can upload by a wide margin",
    // The heaviest plan allows a two-hour source; nothing here encodes slower
    // than about half realtime, so four hours is a backstop and not a budget.
    LIMITS.render.totalMs >= 4 * 60 * 60_000,
    String(LIMITS.render.totalMs),
  );
  check(
    "the silent encode has no stall limit, because silence is what it does",
    LIMITS.preview.stallMs === undefined,
    JSON.stringify(LIMITS.preview),
  );
}

await rm(buildDir, { recursive: true, force: true });

console.log("\nWhat the deadline can actually finish, against what is sold");
{
  /*
    The comment above `LIMITS.render` used to assert two things: that "the
    longest upload any plan allows is well under four hours of output", and
    that "nothing here encodes slower than realtime by a factor of two".

    Both are now measured rather than assumed, on a 1080p source with a
    vertical reframe and four punches — one of the simpler plans this product
    renders. Two cores: 1153 ms per source second. One core: 2073 ms.
    `fly.toml` is one shared CPU, so the factor of two is not a bound, it is
    the number.

    This does not assert that every plan fits. It asserts that the arithmetic
    is written down where the deadline is, and that the gap is named — because
    the gap is a decision about what to sell and what machine to buy, and a
    check that quietly picked one of those would be making it.
  */
  check(
    "the encode factor is measured, not a round number somebody liked",
    ENCODE_SECONDS_PER_SOURCE_SECOND > 2 && ENCODE_SECONDS_PER_SOURCE_SECOND < 2.2,
    String(ENCODE_SECONDS_PER_SOURCE_SECOND),
  );
  const deliverable = deliverableSourceMinutes();
  check(
    "and it turns the deadline into a number of minutes",
    deliverable > 60 && deliverable < 240,
    `${deliverable} minutes of source fit inside ${LIMITS.render.totalMs / 3600000}h`,
  );
  check(
    "the deadline itself is still the four-hour backstop",
    LIMITS.render.totalMs === 4 * 60 * 60_000,
    String(LIMITS.render.totalMs),
  );

  // And the sold lengths, read from the plans rather than repeated here.
  const planLimits = readFileSync(path.join(repoRoot, "artifacts/api-server/src/lib/plan-limits.ts"), "utf8");
  const sold = [...planLimits.matchAll(/maxUploadMinutes: (\d+)/g)].map((m) => Number(m[1]));
  check("there are plans to compare against", sold.length === 4, JSON.stringify(sold));
  const beyond = sold.filter((minutes) => minutes > deliverable);

  /*
    The property worth holding is not "every plan fits" — whether Pro sells
    240 minutes is a pricing decision and a check that quietly picked one
    would be making it. It is that **the ceiling which actually gates uploads
    never exceeds what the machine can finish.**

    That ceiling is the `videos` bucket's own `file_size_limit`, read live, and
    `FALLBACK_UPLOAD_BYTES` is what answers when Storage will not. So the
    constant in the repository is the one thing here that can be checked, and
    it is the one that turns this from latent into live: raise it past what a
    render can finish and a customer uploads a file, waits four hours, and
    watches it be killed.
  */
  const storageLimits = readFileSync(
    path.join(repoRoot, "artifacts/api-server/src/lib/storage-limits.ts"),
    "utf8",
  );
  const fallbackExpr = /FALLBACK_UPLOAD_BYTES =\s*[\s\S]{0,80}?(\d+) \* 1024 \* 1024/.exec(storageLimits);
  const fallbackMb = Number(fallbackExpr?.[1] ?? 0);
  check("the upload fallback names a real size", fallbackMb > 0, String(fallbackMb));

  // The product's own assumption about what a minute of video weighs.
  const deliverableMb = deliverable * 60;
  check(
    "and it is inside what a render can finish before the deadline kills it",
    fallbackMb <= deliverableMb,
    `${fallbackMb} MB of fallback against ${deliverableMb} MB (${deliverable} minutes) that one shared CPU finishes inside ${LIMITS.render.totalMs / 3600000}h`,
  );

  if (beyond.length > 0) {
    console.log(
      `    · ${JSON.stringify(beyond)}-minute uploads are sold and ${deliverable} is what the deployed machine ` +
        `finishes inside the deadline. Unreachable while the bucket ceiling is below it; a decision the day it is raised.`,
    );
  }

  /*
    And the part that was missing: somebody reads the number.

    Everything above this point was true before the fix and the product was
    still wrong, which is the whole shape of the defect. The factor was
    measured, the function existed, the doc comment named 115 minutes and the
    gap against the pricing page — and no line of code called it. A constant
    with a paragraph about what it prevents, preventing nothing.

    The check has to be that a *third* refusal exists, distinct from the two
    that were already there: the plan ceiling is what the customer bought and
    the allowance is what is left of their month, and a file can be inside both
    and still be one this machine cannot finish. That third case is the one
    whose failure mode is four hours of paid compute followed by "Rendering
    failed. We are looking into it."
  */
  const worker = readFileSync(path.join(repoRoot, "artifacts/worker/src/index.ts"), "utf8");
  check(
    "the worker actually asks how long a render it can deliver",
    /deliverableSourceMinutes\(\)/.test(worker),
    "a measured constant nothing reads is a comment",
  );
  check(
    "and refuses against it, beside the two ceilings that were already checked",
    /exceedsDeliverable\(sourceSeconds, deliverable\)/.test(worker),
    "the plan ceiling and the allowance are different questions from what the hardware can finish",
  );

  const duration = readFileSync(path.join(repoRoot, "artifacts/worker/src/duration.ts"), "utf8");
  const sentence = /notDeliverableMessage[\s\S]*?return \(([\s\S]*?)\);/.exec(duration)?.[1] ?? "";
  /*
    Three properties of the sentence, because this refusal is the only one of
    the three that is our fault, and a message that reads like the other two
    sends the customer to the pricing page to buy something that would not
    help.
  */
  check("the refusal says nothing was charged", /Nothing has been charged/.test(sentence), sentence.slice(0, 120));
  check(
    "and does not blame the plan for a limit that is ours",
    /[Tt]hat is our limit, not your plan's/.test(sentence),
    sentence.slice(0, 200),
  );
  check(
    "and names a length that does work, so the person has something to do",
    /\$\{deliverableMinutes\} minutes/.test(sentence),
    sentence.slice(0, 200),
  );
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("A hung subprocess is a failed render, not a stopped platform.");
