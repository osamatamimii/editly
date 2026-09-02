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
import { readFileSync, readdirSync } from "node:fs";
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

/** The other half of leaving: what goes out with the person. */
const exportFile = path.join(buildDir, "export.mjs");
{
  const madeExport = spawnSync(
    require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] }),
    [
      path.join(repoRoot, "artifacts/api-server/src/lib/account-export.ts"),
      "--bundle", "--platform=node", "--format=esm", "--target=node22",
      `--outfile=${exportFile}`, "--log-level=error",
    ],
    { stdio: "inherit" },
  );
  if (madeExport.status !== 0) {
    console.error("could not bundle the export module");
    process.exit(1);
  }
}
const { redactRow, redactsColumn, REDACTED, NOT_INCLUDED, exportFilename } = await import(
  pathToFileURL(exportFile).href
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
      removeAccountObjects: async () => {
        log.push("account-objects");
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
    "the sequence is list, objects, the account's own objects, rows, login",
    JSON.stringify(log) ===
      JSON.stringify(["list", "objects:p1", "objects:p2", "objects:p3", "account-objects", "rows", "login"]),
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


// ─── What is not inside a project ───────────────────────────────────────────

section("The files that belong to the person rather than to a project");
{
  /*
    Uploaded caption faces live at `${userId}/fonts/…`, outside every project,
    and the sweep walks projects. So a font outlived the account that uploaded
    it — which made three sentences false at once: the privacy page, the account
    screen's "there is no copy kept", and this module's own first rule.
  */
  const { log, steps } = recorder();
  await deleteAccount(steps);
  check("the account's own objects are swept", log.includes("account-objects"));
  // Bytes before rows, the same order every other step here follows: reversing
  // them turns a deletion into an orphaning.
  check(
    "before any row is removed",
    log.indexOf("account-objects") < log.indexOf("rows"),
    log.join(" -> "),
  );
  check(
    "and after the projects, so the cheap sweep is not what fails first",
    log.indexOf("objects:p3") < log.indexOf("account-objects"),
    log.join(" -> "),
  );
}
{
  const { log, steps } = recorder({ removeAccountObjects: async () => { log.push("account-objects"); return false; } });
  const result = await deleteAccount(steps);
  check("a sweep that will not go stops the deletion", result.deleted === false);
  check("with the same 503 the project sweep gives", result.status === 503, String(result.status));
  // The whole argument of this module: no row is touched when any byte could
  // not be. A half-deleted account reported as deleted is the failure it exists
  // to refuse.
  check("and nothing was removed", !log.includes("rows") && !log.includes("login"), log.join(" -> "));
}

section("Every table this person owns is named");
{
  /*
    None of these has a foreign key — ownership is denormalised onto every row
    so no query needs a join — so nothing cascades and every child has to be
    listed. Five were missing, and the one that matters is `social_accounts`:
    it holds live access and refresh tokens for YouTube, Meta, TikTok, X and
    Snapchat. Keeping a platform credential after somebody deleted their account
    breaks every one of those platforms' developer terms, and it is what an app
    review looks for.
  */
  const route = readFileSync(path.join(repoRoot, "artifacts/api-server/src/routes/account.ts"), "utf8");
  for (const table of [
    "jobsTable",
    "exportsTable",
    "messagesTable",
    "projectsTable",
    "subscriptionsTable",
    "scheduledPostsTable",
    "socialAccountsTable",
    "captionFacesTable",
    "renderFollowupsTable",
  ]) {
    check(`${table} is deleted`, new RegExp(`delete\\(${table}\\)`).test(route), "");
  }
  check("and the mail rows with them", /delete from mail_sends/.test(route) && /delete from mail_settings/.test(route));
}

section("Leaving with a copy is the other half, and it cannot take a credential");
{
  /*
    An export containing a live YouTube refresh token is a credential leak
    wearing a compliance feature's clothes. The file gets emailed to a laptop,
    attached to a support ticket, dropped in a shared drive — and it is a
    working key to somebody's channel for as long as it lives there.

    The guard is a rule about column *names* rather than a list of columns,
    because a list is a thing somebody forgets to add to. So the check is the
    rule against the real schema: every column in `lib/db/src/schema` whose name
    says it holds a credential has to be one this module refuses to export.
    A token column added next month is caught by the same line.
  */
  const schemaDir = path.join(repoRoot, "lib/db/src/schema");
  const columns = new Set();
  for (const file of readdirSync(schemaDir).filter((f) => f.endsWith(".ts"))) {
    const source = readFileSync(path.join(schemaDir, file), "utf8");
    for (const m of source.matchAll(/^\s*([A-Za-z][A-Za-z0-9]*):\s*(?:text|varchar|jsonb|uuid)\(/gm)) {
      columns.add(m[1]);
    }
  }
  check("the schema was read", columns.size > 20, String(columns.size));

  const credentials = [...columns].filter((name) => /token|secret|password|key/i.test(name));
  check(
    "the schema has credential columns to protect",
    credentials.length >= 2,
    credentials.join(", "),
  );
  const leaking = credentials.filter((name) => !redactsColumn(name));
  check(
    "and every one of them is refused by name",
    leaking.length === 0,
    `${leaking.join(", ")} would go out in the export as written`,
  );

  // The two that are the reason this exists, named rather than trusted to the
  // regex: a rename that made either of them stop matching would be silent.
  check("a social access token is refused", redactsColumn("accessToken"));
  check("and a refresh token", redactsColumn("refreshToken"));
  check("and the Page token, which is a different account's key again", redactsColumn("pageAccessToken"));
  check("and the unsubscribe token, which is a URL anybody holding it can act on", redactsColumn("token"));

  // An ordinary column is not swept up. A rule broad enough to redact
  // everything is a rule that produces an empty export nobody notices.
  for (const ordinary of ["title", "status", "createdAt", "durationSeconds", "email"]) {
    check(`${ordinary} still comes out`, !redactsColumn(ordinary));
  }

  /*
    Replaced, not dropped.

    "We hold a refresh token for your YouTube connection and are not putting it
    in this file" is a true and useful sentence. Silently omitting the field
    says we hold nothing, which is the same document telling a different lie.
  */
  const row = redactRow({ id: "a", accessToken: "ya29.real-token", title: "My video", refreshToken: null });
  check("the field is still there", "accessToken" in row);
  check("with a marker rather than the value", row.accessToken === REDACTED, String(row.accessToken));
  check("and the marker says what it is", /credential/i.test(REDACTED), REDACTED);
  check("an ordinary field passes through", row.title === "My video");
  check("and a null credential stays null rather than becoming a marker", row.refreshToken === null);

  check(
    "what is left out is said out loud rather than left to be noticed",
    NOT_INCLUDED.length >= 2 && NOT_INCLUDED.every((line) => line.length > 40),
    JSON.stringify(NOT_INCLUDED.map((l) => l.length)),
  );
  check("the file has a name a browser will save", /^editly-data-\d{4}-\d{2}-\d{2}\.json$/.test(exportFilename()));
}

section("What deletion removes, the export has to have shown");
{
  /*
    The two halves of the same fact, and the reason to check them against each
    other rather than each against a list.

    If a table is deleted when somebody leaves, we were holding their rows in
    it. If we were holding their rows in it, an export that answers "what do you
    have on me" has to include it. The failure this catches is the ordinary one:
    a table added next month, wired into deletion because that is the obvious
    half, and quietly missing from the export for a year.
  */
  const route = readFileSync(path.join(repoRoot, "artifacts/api-server/src/routes/account.ts"), "utf8");
  const deleted = [...route.matchAll(/delete\((\w+Table)\)/g)].map((m) => m[1]);
  check("deletion names tables this check can read", deleted.length >= 8, deleted.join(", "));

  const exported = [...route.matchAll(/\.from\((\w+Table)\)/g)].map((m) => m[1]);
  check("and so does the export", exported.length >= 8, exported.join(", "));

  const held = deleted.filter((table) => !exported.includes(table));
  check(
    "everything deleted is also exported",
    held.length === 0,
    `${held.join(", ")} — we hold it, we remove it, and we never told them it was there`,
  );

  // And every read in the export is the caller's own row. One predicate, the
  // same one, every time: no join to a project and no `IN` over ids gathered
  // somewhere else, which is how an export grows a path to a row that is not
  // theirs.
  const exportBlock = route.slice(route.indexOf("/account/export"), route.indexOf("router.delete"));
  const reads = (exportBlock.match(/db\.select\(\)/g) ?? []).length;
  const scoped = (exportBlock.match(/\.userId, userId\)/g) ?? []).length;
  check(
    "and every read in it is scoped to the caller",
    reads > 0 && reads === scoped,
    `${reads} reads, ${scoped} scoped to userId`,
  );
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("A deletion either happens or is refused. It is never both.");
