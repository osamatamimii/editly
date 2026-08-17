/**
 * Deleting an account, in the order that makes it a deletion.
 *
 * Two things can go wrong here and neither shows up as a failed request.
 *
 * The first is a deletion that is partial and reported as complete. If the
 * credentials that reclaim storage are missing, the rows go and the video stays
 * — and the person is told their account is gone while their footage sits in a
 * bucket. Nothing errors. Nobody finds out.
 *
 * The second is ordering. The rows are what name the stored objects; delete
 * them first and the video becomes unreachable garbage that only a manual sweep
 * will ever find. Again: no error, correct-looking response, the person's video
 * still on our disks.
 *
 * So the checks below are almost entirely about sequence and refusal. The steps
 * are injected, which is why this needs no database, no Supabase and no keys —
 * and which is why the deletion logic lives in its own module rather than
 * inside the route.
 *
 * Usage: node tools/account-test.mjs
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-account-build-"));
const outfile = path.join(buildDir, "account.mjs");

const built = spawnSync(
  require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] }),
  [
    path.join(repoRoot, "artifacts/api-server/src/lib/account-deletion.ts"),
    "--bundle", "--platform=node", "--format=esm", "--target=node22",
    `--outfile=${outfile}`, "--log-level=error",
  ],
  { stdio: "inherit" },
);
if (built.status !== 0) {
  console.error("could not bundle the deletion module");
  process.exit(1);
}

const { deleteAccount, NOT_CONFIGURED_MESSAGE, LOGIN_SURVIVED_NOTE } = await import(
  pathToFileURL(outfile).href
);

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

/** Records every step in the order it actually ran. */
function recorder(over = {}) {
  const log = [];
  return {
    log,
    steps: {
      storageConfigured: true,
      listProjects: async () => {
        log.push("list");
        return ["p1", "p2", "p3"];
      },
      removeObjects: async (id) => {
        log.push(`objects:${id}`);
        return true;
      },
      removeRows: async () => {
        log.push("rows");
      },
      removeLogin: async () => {
        log.push("login");
        return true;
      },
      ...over,
    },
  };
}

// ─── Refusing, rather than half-doing ────────────────────────────────────────

section("Without the credentials to reclaim storage, nothing at all happens");
{
  const { log, steps } = recorder({ storageConfigured: false });
  const result = await deleteAccount(steps);

  check("it refuses", result.deleted === false);
  check("with a status a client can branch on", result.status === 503, String(result.status));
  check("nothing was listed", !log.includes("list"), JSON.stringify(log));
  check("no object was removed", !log.some((s) => s.startsWith("objects")), JSON.stringify(log));
  check("no row was removed", !log.includes("rows"), JSON.stringify(log));
  check("the login survives", !log.includes("login"), JSON.stringify(log));
  check("nothing at all ran", log.length === 0, JSON.stringify(log));

  check("the message says why, not just no", result.error === NOT_CONFIGURED_MESSAGE);
  check(
    "and it admits the videos are still here rather than hiding behind a generic failure",
    /videos are gone while they're still here/.test(result.error),
    result.error,
  );
}

// ─── The order the steps have to happen in ───────────────────────────────────

section("The bytes go before the rows");
{
  const { log, steps } = recorder();
  const result = await deleteAccount(steps);

  check("it completes", result.deleted === true);
  check(
    "the sequence is list, objects, rows, login",
    JSON.stringify(log) === JSON.stringify(["list", "objects:p1", "objects:p2", "objects:p3", "rows", "login"]),
    JSON.stringify(log),
  );
  check("every project's storage is visited", log.filter((s) => s.startsWith("objects")).length === 3);
  check(
    "and none of it happens after the rows naming it are gone",
    log.indexOf("rows") > log.lastIndexOf("objects:p3"),
    JSON.stringify(log),
  );
  check("the count is reported", result.projects === 3, String(result.projects));
}

section("The login goes last");
{
  const { log, steps } = recorder();
  await deleteAccount(steps);
  check(
    "after the rows, so a failed attempt leaves an account the person can retry from",
    log.indexOf("login") > log.indexOf("rows"),
    JSON.stringify(log),
  );
  check("and it is the final step", log[log.length - 1] === "login", JSON.stringify(log));
}

// ─── What the caller is told ─────────────────────────────────────────────────

section("A login that could not be removed is said out loud");
{
  const { steps } = recorder({ removeLogin: async () => false });
  const result = await deleteAccount(steps);

  check("the deletion still counts as done", result.deleted === true);
  check("but the login is reported as surviving", result.loginRemoved === false);
  check("with a note the person can read", result.note === LOGIN_SURVIVED_NOTE);
  check("that says the data is gone", /videos and projects are gone/.test(result.note), result.note);
  check("and that they will not be charged", /not be charged/.test(result.note));
}

section("A clean deletion says nothing extra");
{
  const result = await deleteAccount(recorder().steps);
  check("the login went", result.loginRemoved === true);
  check("and there is no note to explain, because nothing needs explaining", result.note === undefined);
}

section("An account with nothing in it deletes cleanly");
{
  const { log, steps } = recorder({ listProjects: async () => [] });
  const result = await deleteAccount(steps);
  check("it completes", result.deleted === true && result.projects === 0);
  check("no storage call is made for nothing", !log.some((s) => s.startsWith("objects")), JSON.stringify(log));
  check("the rows still go — a subscription row outlives the last project", log.includes("rows"));
  check("and so does the login", log.includes("login"));
}

section("A storage failure stops the deletion before anything irreversible");
{
  // `deleteProjectObjects` is best-effort by contract and swallows its own
  // errors, so in practice this does not throw. If that contract ever changes,
  // the rows must not already be gone — the whole point of doing bytes first.
  const { log, steps } = recorder({
    removeObjects: async (id) => {
      log.push(`objects:${id}`);
      throw new Error("storage is down");
    },
  });
  let threw = false;
  try {
    await deleteAccount(steps);
  } catch {
    threw = true;
  }
  check("the failure propagates rather than being reported as success", threw);
  check("and the rows are untouched", !log.includes("rows"), JSON.stringify(log));
  check("and the login too", !log.includes("login"), JSON.stringify(log));
}

await rm(buildDir, { recursive: true, force: true });

console.log("\nStorage that answers but will not delete is a refusal too");
{
  // The contract used to be `Promise<void>`, described as best effort — which
  // quietly suspended the first rule for the one step the first rule is about.
  // A Storage outage during the loop removed nothing, said nothing, and the
  // rows that name those objects were deleted immediately afterwards. The
  // person's videos stayed on our disks with nothing left pointing at them,
  // and the response said "deleted".
  const { log, steps } = recorder({
    removeObjects: async (id) => {
      log.push(`objects:${id}`);
      return id === "p2" ? false : true;
    },
  });

  const result = await deleteAccount(steps);

  check("the deletion is refused", result.deleted === false, JSON.stringify(result));
  check("with a status that means try again, not a fault of theirs", result.status === 503, String(result.status));
  check(
    "and a message that says nothing was deleted",
    /nothing has been deleted/i.test(result.error ?? ""),
    result.error,
  );
  check("the rows are untouched", !log.includes("rows"), JSON.stringify(log));
  check("and so is the login", !log.includes("login"), JSON.stringify(log));
  check(
    "it stops at the one that would not go rather than carrying on",
    !log.includes("objects:p3"),
    JSON.stringify(log),
  );
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("A deletion either happens or is refused. It is never both.");
