/**
 * Is the machine that renders video running the code we think it is?
 *
 * On 15 September the production worker was an image old enough to predate
 * `worker_heartbeats.build` -- the column that exists to answer this exact
 * question -- while `main` had moved on by dozens of commits, most of them
 * fixes to the worker. Renders failed, a listen job sat queued for hours, and
 * every fix for all of it was sitting in the repository.
 *
 * Nothing said so, and the reason is worth writing down because it is the same
 * reason three times over. `/healthz` is about the API. `watch.yml`'s first
 * question is whether a machine is listening. Its second, added the same day,
 * is whether the queue is moving. All three are about *production*, and the
 * fault was not in production: it was that a deploy had never run. The deploy
 * workflow is gated on Checks, Checks had been red, and a skipped job is not a
 * failed one -- so the only signal anybody had was the absence of a signal.
 *
 * Two hundred and forty-seven runs of "Deploy worker", not one of them longer
 * than eleven seconds. A real Fly deploy takes minutes.
 *
 * ## What this asks, and why not the obvious thing
 *
 * "Does the deployed build equal HEAD" is the obvious question and it is the
 * wrong one: it is false for a perfectly healthy deployment the moment anybody
 * commits a landing-page change, and an alert that is true most of the time is
 * an alert somebody mutes.
 *
 * What is actually wrong is narrower and is what this measures: **commits that
 * change the worker, sitting on main, that the running machine does not have.**
 * A hundred commits to the marketing site are not drift. One commit to
 * `artifacts/worker/` that has not shipped is.
 *
 * The path list is the deploy workflow's own, read out of that file rather
 * than copied, so a list that grows there cannot be missed here.
 *
 * Usage: DATABASE_URL=postgres://... node tools/worker-drift.mjs
 * Requires: a git checkout with history (CI uses fetch-depth 0 for this step).
 * Exit 1 when the worker is behind on its own code; 0 otherwise.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();

/**
 * How many unshipped worker commits are worth waking somebody for.
 *
 * One, because there is no such thing as a worker fix that is fine to leave
 * undeployed -- the whole reason it was written is that something was wrong
 * with the machine. The number exists so it can be argued with, not so it can
 * be raised quietly.
 */
export const DRIFT_COMMITS_ALLOWED = 0;

/**
 * The paths the deploy workflow watches, read from the workflow.
 *
 * Copied once and it would be wrong the first time somebody adds a package,
 * and wrong silently: this would report "no drift" about a worker that had
 * stopped being redeployed.
 */
export function deployPaths(
  workflow = readFileSync(path.join(repoRoot, ".github/workflows/deploy-worker.yml"), "utf8"),
) {
  const line = workflow.split("\n").find((l) => l.trim().startsWith("PATHS="));
  if (!line) return [];
  const value = line.slice(line.indexOf("=") + 1).trim().replace(/^"|"$/g, "");
  return value.split(/\s+/).filter(Boolean);
}

/**
 * The verdict, as a pure function of facts, so it can be tested without a
 * database and without a deploy.
 *
 * `build` null is its own answer and the loudest one: the column has existed
 * since the commit that added it, so a worker with no build is a worker whose
 * image predates that commit, which is a deploy that has not happened since.
 */
export function drift({ build, behind, workerCommits }) {
  if (!build) {
    return {
      state: "unknown-build",
      sentence:
        "The running worker reports no build. Its image predates the column that records one, " +
        "so it has not been deployed since that commit -- check whether the deploy workflow has ever succeeded.",
    };
  }
  if (behind === null) {
    return {
      state: "unknown-commit",
      sentence: `The running worker reports build ${build.slice(0, 8)}, which is not a commit in this history. Either the deploy came from somewhere else or the checkout is shallow.`,
    };
  }
  if (workerCommits > DRIFT_COMMITS_ALLOWED) {
    return {
      state: "behind",
      sentence:
        `The running worker is ${behind} commit(s) behind main, and ${workerCommits} of those change the worker itself. ` +
        `Those fixes are in the repository and not on the machine.`,
    };
  }
  return {
    state: "current",
    sentence:
      behind === 0
        ? "The running worker is the head of main."
        : `The running worker is ${behind} commit(s) behind main, none of which touch the worker.`,
  };
}

// ── Everything below only runs when this file is the command ────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const DATABASE_URL = process.env["DATABASE_URL"];
  if (!DATABASE_URL) {
    // Skipped rather than failed, for the reason watch.yml gives about its own
    // secret: a job that goes red for a missing secret is a job somebody turns
    // off, and then nothing is watching anything.
    console.log("DATABASE_URL is not set, so the deployed build cannot be read.");
    console.log("::warning::Set PRODUCTION_DATABASE_URL to have an undeployed worker fix caught before a customer finds it.");
    process.exit(0);
  }

  const { Pool } = require(require.resolve("pg", { paths: ["lib/db"] }));
  const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(DATABASE_URL);
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ...(isLocal ? {} : { ssl: { rejectUnauthorized: false } }),
    max: 1,
  });

  let build = null;
  try {
    const result = await pool.query(
      `select build from worker_heartbeats order by last_seen_at desc limit 1`,
    );
    build = result.rows[0]?.build ?? null;
  } finally {
    await pool.end().catch(() => undefined);
  }

  const git = (...args) => {
    const r = spawnSync("git", args, { encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : null;
  };

  let behind = null;
  let workerCommits = 0;
  if (build) {
    const known = git("cat-file", "-e", `${build}^{commit}`) !== null;
    if (known) {
      behind = Number(git("rev-list", "--count", `${build}..HEAD`) ?? "0");
      const paths = deployPaths();
      const touching = git("rev-list", "--count", `${build}..HEAD`, "--", ...paths);
      workerCommits = Number(touching ?? "0");
    }
  }

  const v = drift({ build, behind, workerCommits });
  console.log(`deployed build: ${build ?? "(none reported)"} | behind: ${behind ?? "?"} | of those touching the worker: ${workerCommits}`);
  console.log(v.sentence);

  if (v.state === "behind" || v.state === "unknown-build") {
    console.log(`::error::${v.sentence}`);
    process.exit(1);
  }
  if (v.state === "unknown-commit") {
    console.log(`::warning::${v.sentence}`);
  }
  process.exit(0);
}
