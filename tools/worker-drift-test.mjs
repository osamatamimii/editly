/**
 * Does the drift watcher fire on the day it was written for, and stay quiet on
 * the days that only look like it?
 *
 * The day: 15 September, a production worker whose image predated the column
 * that records a build, while `main` carried dozens of commits to that worker.
 * Renders failed, a listen job sat queued for hours, and the fix for all of it
 * was in the repository. Two hundred and forty-seven runs of "Deploy worker",
 * not one longer than eleven seconds, because the job is gated on Checks and
 * Checks was red -- and a skipped job is not a failed one, so the only signal
 * anybody had was the absence of one.
 *
 * The days that only look like it are what make this watcher survivable: a
 * healthy deployment is behind main most of the time, because most commits are
 * not to the worker.
 *
 * Usage: node tools/worker-drift-test.mjs
 * Requires: nothing. No database, no network, no git.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { drift, deployPaths, DRIFT_COMMITS_ALLOWED } from "./worker-drift.mjs";

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

console.log("The day it was written for");
{
  const real = drift({ build: null, behind: null, workerCommits: 0 });
  check("a worker reporting no build at all is a fault", real.state === "unknown-build", real.state);
  check(
    "and the sentence sends somebody to the deploy rather than to the machine",
    /deploy workflow has ever succeeded/.test(real.sentence),
    real.sentence,
  );

  const behind = drift({ build: "abc1234", behind: 28, workerCommits: 9 });
  check("nine unshipped worker commits is a fault", behind.state === "behind", behind.state);
  check(
    "and it says both numbers, because one of them is the one that matters",
    /28 commit\(s\) behind/.test(behind.sentence) && /9 of those change the worker/.test(behind.sentence),
    behind.sentence,
  );
}

console.log("\nThe days that only look like it");
{
  /*
    The false positive that would get this muted inside a week. A deployment is
    behind main from the moment anybody commits anything, and most commits are
    to the landing page, the copy tables, the API. None of those reach this
    machine and none of them are drift.
  */
  const marketing = drift({ build: "abc1234", behind: 40, workerCommits: 0 });
  check("forty commits that do not touch the worker are not drift", marketing.state === "current", marketing.state);
  check(
    "and it says so out loud rather than staying silent",
    /none of which touch the worker/.test(marketing.sentence),
    marketing.sentence,
  );

  const head = drift({ build: "abc1234", behind: 0, workerCommits: 0 });
  check("and the head of main is the quiet answer", head.state === "current" && /head of main/.test(head.sentence), head.sentence);

  /*
    A build this checkout has never heard of. That is a shallow clone or a
    deploy from somewhere else, and it is a warning rather than an error: "I
    cannot tell" and "it is wrong" are different answers and only one should
    fail a run.
  */
  const foreign = drift({ build: "deadbee", behind: null, workerCommits: 0 });
  check("an unknown commit is reported, not alarmed on", foreign.state === "unknown-commit", foreign.state);
  check("and it names both explanations", /somewhere else|shallow/.test(foreign.sentence), foreign.sentence);
}

console.log("\nIt watches the paths the deploy actually watches");
{
  /*
    Read out of the workflow rather than copied into this file. A copy is wrong
    the first time somebody adds a package to the deploy's list, and wrong
    silently: this would report "no drift" about a worker that had quietly
    stopped being redeployed.
  */
  const paths = deployPaths();
  check("there are paths to watch", paths.length > 0, JSON.stringify(paths));
  check("the worker's own source is one of them", paths.includes("artifacts/worker/"), JSON.stringify(paths));
  check(
    "and every one of them is a real path in this repository",
    paths.every((p) => {
      try {
        readFileSync(path.join(process.cwd(), p.replace(/\/$/, "")), "utf8");
        return true;
      } catch (error) {
        // A directory throws EISDIR, which is the answer "it exists".
        return String(error).includes("EISDIR");
      }
    }),
    JSON.stringify(paths),
  );
  check(
    "it reads them from the workflow, so a list that grows there grows here",
    deployPaths('          PATHS="one/ two/"').join(",") === "one/,two/",
    JSON.stringify(deployPaths('          PATHS="one/ two/"')),
  );
}

console.log("\nOne unshipped worker fix is enough");
{
  /*
    There is no such thing as a worker fix that is fine to leave undeployed:
    the reason it was written is that something was wrong with the machine.
    The constant exists so it can be argued with, not raised quietly.
  */
  check("the threshold is zero", DRIFT_COMMITS_ALLOWED === 0, String(DRIFT_COMMITS_ALLOWED));
  check("so one is already too many", drift({ build: "a", behind: 1, workerCommits: 1 }).state === "behind");
}

console.log("\nThe watcher is wired into the thing that runs hourly");
{
  const watch = readFileSync(path.join(process.cwd(), ".github/workflows/watch.yml"), "utf8");
  check("watch.yml runs it", /node tools\/worker-drift\.mjs/.test(watch), "a watcher nobody runs is a file");
  check(
    "with history, because it compares two commits",
    /fetch-depth:\s*0/.test(watch),
    "a shallow checkout answers 'unknown commit' every time",
  );
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log("The drift watcher does not watch what this says it watches.");
  process.exit(1);
}
console.log("An undeployed worker fix is a thing somebody is told about.");
