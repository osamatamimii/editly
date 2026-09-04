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
import { order } from "./lib/order.mjs";

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
    order(log, "objects:p3", "rows").ok,
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
    order(log, "rows", "login").ok,
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
    order(log, "account-objects", "rows").ok,
    log.join(" -> "),
  );
  check(
    "and after the projects, so the cheap sweep is not what fails first",
    order(log, "objects:p3", "account-objects").ok,
    log.join(" -> "),
  );
}
{
  /*
    And a font deleted one at a time takes its bytes with it.

    `DELETE /fonts/:id` removed the row and left three objects behind — the
    upload, the repaired face and the woff2 the picker draws — with a comment
    saying they "stay until the storage sweep takes them". There is no such
    sweep: the retention sweep's `owned()` predicate requires the key to start
    with `${userId}/${projectId}/`, and a font is at `${userId}/fonts/…`,
    outside every project. So nothing but account deletion ever reclaimed them,
    on a path a person can repeat as often as they like — twenty-four fonts
    per account, delete and re-upload without limit.
  */
  const route = readFileSync(path.join(repoRoot, "artifacts/api-server/src/routes/fonts.ts"), "utf8");
  const del = route.slice(route.indexOf("delete(captionFacesTable)"));
  check(
    "the delete reads the keys it is about to orphan",
    /sourcePath: captionFacesTable\.sourcePath/.test(del) &&
      /facePath: captionFacesTable\.facePath/.test(del) &&
      /previewPath: captionFacesTable\.previewPath/.test(del),
    "the returning clause does not name the three objects",
  );
  check(
    "and removes them",
    /await deleteObjects\(keys\)/.test(del),
    "the row still goes without its bytes",
  );
  check(
    "the row goes first, because a picker entry nobody can remove is worse than an orphan",
    order(del, "delete(captionFacesTable)", "deleteObjects(keys)").ok,
    "",
  );
  check(
    "and a sweep that will not go is written down rather than reported to the person",
    /could not be removed and nothing else will reclaim them/.test(del) &&
      !/res\.status\(5\d\d\)[\s\S]{0,200}deleteObjects/.test(del),
    "",
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
  /*
    Read from `lib/user-erasure.ts`, not from the route.

    The list moved there the day a second caller appeared: Shopify's
    `shop/redact` webhook is a legal obligation with a thirty-day clock and
    asks for exactly this. Two lists of tables to delete from is a list that
    eventually gets a table added to one of them, and the half that was
    forgotten is the half nobody notices — what is left behind is invisible by
    definition. So there is one list, and this reads it where it lives.
  */
  const route = readFileSync(path.join(repoRoot, "artifacts/api-server/src/lib/user-erasure.ts"), "utf8");
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

  /*
    And the table with no `user_id` column, which is why it was missed.

    Every check above is a table with the account id in a column, so every
    review of this list found the same shape and stopped there. `rate_limits`
    is keyed on a text bucket instead, and the per-account buckets are
    `${userId}:${endpoint}` — the account id, in a primary key, in a table
    nobody thinks of as personal data, under a screen that promises no copy is
    kept. The sweep in `rate-limit.ts` does clear closed windows eventually,
    but "eventually, if somebody else keeps using that endpoint" is not
    erasure, and the thirty-day Shopify clock does not accept it.

    Both halves are read, because the bug this would have caught is the two
    drifting apart: a bucket format changed in one file and a `LIKE` pattern
    left behind in the other deletes nothing at all, silently.
  */
  check(
    "the counters keyed on the account id go too",
    /delete from rate_limits where bucket like/.test(route),
    "rate_limits holds the account id in its primary key",
  );
  const limiter = readFileSync(path.join(repoRoot, "artifacts/api-server/src/lib/rate-limit.ts"), "utf8");
  check(
    "and the pattern still matches the bucket the limiter writes",
    /consume\(`\$\{userId\}:\$\{options\.name\}`/.test(limiter) && /\$\{userId \+ ":"\}/.test(route),
    "a bucket format changed on one side deletes nothing on the other",
  );
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
  // Two files now, and the cross-check is the whole point of the section: the
  // deletion list lives in `lib/user-erasure.ts` because two callers share it,
  // and the export is still the route's own. Reading each where it is means a
  // table added to one of them and not the other still fails here.
  const erasure = readFileSync(path.join(repoRoot, "artifacts/api-server/src/lib/user-erasure.ts"), "utf8");
  const route = readFileSync(path.join(repoRoot, "artifacts/api-server/src/routes/account.ts"), "utf8");
  const deleted = [...erasure.matchAll(/delete\((\w+Table)\)/g)].map((m) => m[1]);
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
