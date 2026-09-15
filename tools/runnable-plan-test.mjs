/**
 * A plan is accepted at the door or it is not accepted at all.
 *
 * The API writes `plan` as an object literal and the worker reads it back
 * through `EditPlan.parse`. For the first five weeks nothing between those two
 * lines checked that they agreed, and the failure that produced had a
 * particularly bad shape: the plan was accepted, the month's minutes were held
 * against it, the row queued, and a `ZodError` killed it in the worker some
 * minutes later, in a column no customer can see.
 *
 * Ten renders in one week, all on a caption animation the planner could emit
 * and the schema had never been taught. Every one of them was our defect,
 * shown to the person who asked as their render failing.
 *
 * This suite is the schema half of the fix -- that the values which actually
 * killed those rows are refused, and that the ones a working product produces
 * every day are not. `deploy-test` holds the other half: that both doors ask
 * before they insert.
 *
 * Usage: node tools/runnable-plan-test.mjs
 */
import { mkdtemp } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-runnable-plan-"));

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

const build = (source, name, paths = "artifacts/api-server") => {
  const outfile = path.join(buildDir, name);
  const built = spawnSync(
    require.resolve("esbuild/bin/esbuild", { paths: [paths] }),
    [
      path.join(repoRoot, source),
      "--bundle", "--platform=node", "--format=esm", "--target=node22",
      `--outfile=${outfile}`, "--log-level=error",
    ],
    { stdio: "inherit" },
  );
  if (built.status !== 0) {
    console.error(`could not bundle ${source}`);
    process.exit(1);
  }
  return pathToFileURL(outfile).href;
};

const { EditPlan } = await import(build("lib/api-zod/src/index.ts", "zod.mjs"));
const runnable = (operations) => EditPlan.safeParse({ version: 1, operations }).success;

section("The plans a working day produces are runnable");
{
  /*
    Taken from rows that rendered in production, not invented here. A suite
    that only ever proves refusals will happily pass against a schema that
    refuses everything.
  */
  check(
    "the plan from the render that finished on 15 September",
    runnable([
      { type: "removeSilence", paddingMs: 80, thresholdDb: -32, minSilenceMs: 500 },
      { type: "formatForPlatform", platform: "tiktok", maxHeight: 2160 },
      { type: "autoCaptions", font: "montserrat-black", fontArabic: "noto-kufi-black", dropFillers: true },
      { type: "grade", look: "cinematic", saturation: 1 },
      { type: "normalizeLoudness", voice: true, denoise: true, targetLufs: -14 },
      { type: "transition", style: "dissolve", where: "scenes", durationMs: 250 },
    ]),
  );
  check("a single operation is a plan", runnable([{ type: "grade", look: "cinematic", saturation: 1 }]));
}

section("The values that actually killed rows in production are refused");
{
  /*
    A caption animation outside the three the schema knows. This is the exact
    shape of the ZodError on ten failed rows: `values: ["none","pop","karaoke"]`
    with a fourth word on the row.
  */
  check(
    "a caption animation the schema was never taught",
    !runnable([{ type: "autoCaptions", animation: "bounce" }]),
  );
  check("a style that does not exist", !runnable([{ type: "transition", style: "swoosh", where: "scenes" }]));
  check("an operation type nobody wrote", !runnable([{ type: "deblur" }]));
}

section("And the two empty shapes, which mean different things");
{
  /*
    `{}` is what a listen job carries, and it must never be mistaken for a
    render: a reader that accepted it would be reading "do nothing" off a row
    that was never asked to do anything.

    An empty operations list is the other one. It is reachable -- policy can
    strip every operation from a plan -- and it must be refused rather than
    queued, because a render that does nothing still costs the person minutes
    and returns them their own file back.
  */
  check("a listen job's plan is not a render plan", !EditPlan.safeParse({}).success);
  check("and neither is a render with nothing in it", !runnable([]));
}

section("The refusal both doors give says the same thing");
{
  /*
    Two spellings of one defect is how a support reply ends up matching half
    the cases, and how the panel ends up with two strings to translate.
  */
  const doors = ["artifacts/api-server/src/lib/start-render.ts", "artifacts/api-server/src/routes/exports.ts"];
  const texts = doors.map((d) => {
    const source = readFileSync(path.join(repoRoot, d), "utf8");
    return source.match(/"([^"]*nothing was started and no minutes were used[^"]*)"/)?.[1] ?? null;
  });
  check("both doors carry the sentence", texts.every(Boolean), JSON.stringify(texts));
  check("and it is the same sentence", texts[0] === texts[1]);
  /*
    Written for somebody who did nothing wrong, because they did not. It says
    the two things they need -- nothing was charged, and what to try -- and it
    does not show them a parser.
  */
  const sentence = texts[0] ?? "";
  check("it says no minutes were spent", /no minutes were used/.test(sentence));
  check("it does not blame the person who asked", !/invalid|error|failed to parse/i.test(sentence));
  check("it says what to do next", /try asking/i.test(sentence));
  check("and it has no em dash in it", !sentence.includes("—"));
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("A plan that cannot run is refused before anybody is charged for it.");
