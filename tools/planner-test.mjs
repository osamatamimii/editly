/**
 * Checks the planner without an OpenAI key.
 *
 * The property under test is not "does the model choose well" — that is a
 * judgement, and it belongs in the quality harness once there is a key. It is
 * the harder guarantee: that a model cannot make this product lie. Whatever the
 * model returns, the plan that reaches the worker is one the worker can execute,
 * and the sentence the user reads describes that plan and nothing else.
 *
 * So every check here feeds the planner a deliberately hostile answer — an
 * operation that does not exist, a zoom of 3.0, prose where JSON was promised,
 * a timeout, a 500 — and asserts the product stays honest.
 *
 * Usage: node tools/planner-test.mjs
 * Requires: nothing. No keys, no network, no ffmpeg.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-planner-build-"));
const outfile = path.join(buildDir, "planner.mjs");

const built = spawnSync(
  require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] }),
  [
    path.join(repoRoot, "artifacts/api-server/src/lib/planner.ts"),
    "--bundle", "--platform=node", "--format=esm", "--target=node22",
    `--outfile=${outfile}`, "--log-level=error",
  ],
  { stdio: "inherit" },
);
if (built.status !== 0) {
  console.error("could not bundle the planner");
  process.exit(1);
}

const { createPlanner, replyFor } = await import(pathToFileURL(outfile).href);

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

/** A stub that answers with whatever operations a test wants to inject. */
const answering = (operations, extra = {}) => async () =>
  new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify({ operations, ...extra }) } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

console.log("\nWith no key at all");
{
  const planner = createPlanner({ apiKey: "" });
  check("it reports itself unavailable rather than pretending", planner.available === false, "");

  const result = await planner.plan("cut the dead air and make it vertical for tiktok", {});
  check("the keyword matcher still produces a plan", result.operations.length >= 2, JSON.stringify(result.operations.map((o) => o.type)));
  check("and says which path produced it", result.source === "keywords", result.source);
}

console.log("\nWhen the model answers well");
{
  const planner = createPlanner({
    apiKey: "test-key",
    fetchImpl: answering([
      { type: "removeSilence", minSilenceMs: 400 },
      { type: "autoCaptions", captionStyle: "karaoke-box", captionAnimation: "karaoke" },
      { type: "formatForPlatform", platform: "reels" },
    ]),
  });
  const result = await planner.plan("tighten it up, karaoke captions, for reels", {});

  check("the plan is the model's", result.source === "model", result.source);
  check(
    "and carries exactly what it chose",
    result.operations.map((o) => o.type).join(",") === "removeSilence,autoCaptions,formatForPlatform",
    JSON.stringify(result.operations.map((o) => o.type)),
  );
  check("its parameters survive", result.operations[0].minSilenceMs === 400 && result.operations[1].style === "karaoke-box", JSON.stringify(result.operations[0]));

  const reply = replyFor(result, { hasVideo: true });
  check("the reply names the captions", /caption it/.test(reply), reply);
  check("and the reframe", /reels/.test(reply), reply);
  check("and promises nothing else", !/music|b-roll|emoji|colou?r/i.test(reply), reply);
}

console.log("\nWhen the model answers badly");
{
  const invented = createPlanner({
    apiKey: "k",
    fetchImpl: answering([{ type: "addBRoll" }, { type: "syncToBeat" }]),
  });
  const result = await invented.plan("add b-roll and sync it to the beat", {});
  check(
    "an operation the worker does not have is discarded, not attempted",
    result.operations.every((o) => o.type !== "addBRoll" && o.type !== "syncToBeat"),
    JSON.stringify(result.operations.map((o) => o.type)),
  );
  check("and we say the model gave us nothing usable", /nothing we could execute/.test(result.degraded ?? ""), result.degraded);
  check("falling back rather than failing", result.source === "keywords", result.source);

  const outOfRange = createPlanner({
    apiKey: "k",
    fetchImpl: answering([{ type: "kenBurns", zoomTo: 3.0 }, { type: "removeSilence" }]),
  });
  const clamped = await outOfRange.plan("push in hard", {});
  check(
    "a zoom the schema forbids is rejected outright, not quietly clamped",
    !clamped.operations.some((o) => o.type === "kenBurns"),
    JSON.stringify(clamped.operations),
  );
  check("while the valid operation beside it survives", clamped.operations.some((o) => o.type === "removeSilence"), "");

  const prose = createPlanner({
    apiKey: "k",
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: "Sure! I'd love to help." } }] }), { status: 200 }),
  });
  const proseResult = await prose.plan("caption it", {});
  check("prose where JSON was promised falls back", proseResult.source === "keywords", proseResult.source);
  check("and the fallback still captions it", proseResult.operations.some((o) => o.type === "autoCaptions"), JSON.stringify(proseResult.operations.map((o) => o.type)));
}

console.log("\nWhen the model is not there");
{
  const broken = createPlanner({ apiKey: "k", fetchImpl: async () => new Response("nope", { status: 500 }) });
  const result = await broken.plan("cut the silences", {});
  check("a 500 does not reach the user", result.operations.length > 0, "");
  check("it is recorded as a degradation", /500/.test(result.degraded ?? ""), result.degraded);

  const hanging = createPlanner({
    apiKey: "k",
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
  });
  const slow = await hanging.plan("cut the silences", {});
  check("and neither does an unreachable one", slow.source === "keywords", slow.source);
  check("reported as such", /unreachable|timed out/.test(slow.degraded ?? ""), slow.degraded);
}

console.log("\nThe key never leaves the request");
{
  let seen = null;
  const planner = createPlanner({
    apiKey: "sk-secret-value",
    fetchImpl: async (_url, init) => {
      seen = init;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ operations: [{ type: "removeSilence" }] }) } }] }), { status: 200 });
    },
  });
  const result = await planner.plan("tighten it", {});

  check("it is sent as a bearer token", String(seen.headers.Authorization).startsWith("Bearer "), "");
  check(
    "and appears nowhere in what we return",
    !JSON.stringify(result).includes("sk-secret-value"),
    "",
  );
  check(
    "including in a degradation message",
    !String(result.degraded ?? "").includes("sk-"),
    "",
  );
}

console.log("\nThe project's platform is respected");
{
  const planner = createPlanner({ apiKey: "k", fetchImpl: answering([{ type: "formatForPlatform" }]) });
  const result = await planner.plan("make it vertical", { defaultPlatform: "shorts" });
  check(
    "a reframe with no platform named takes the project's",
    result.operations[0]?.platform === "shorts",
    JSON.stringify(result.operations[0]),
  );
}

await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("A model can choose the edit; it cannot make the product lie.");
