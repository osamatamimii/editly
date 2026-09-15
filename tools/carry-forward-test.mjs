/**
 * A correction changes the edit you have. It does not start a new one.
 *
 * Osama described the loop around a render in three steps: Noah says what he
 * is about to do, the edit runs, and «المستخدم بيصير يطلب منه عدة تعديلات».
 * The first two were built. The third was not, and what stood in for it threw
 * the person's work away on every follow-up.
 *
 * Every message is planned on its own — the model is sent the sentence and
 * nothing else — so this happened, measured before the fix:
 *
 *     «اقصص السكتات وضيف ترجمة وخلّيه عريض ليوتيوب»
 *         → …, formatForPlatform(youtube)
 *     «خلي الترجمة أكبر»
 *         → …, formatForPlatform(reels)
 *
 * The second render is vertical. Nobody asked for that. The sentence said
 * nothing about shape, so the direction filled it in from the project's
 * default — which is set when the project is created and never follows what
 * anybody says.
 *
 * Usage: node tools/carry-forward-test.mjs
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { order } from "./lib/order.mjs";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-carry-"));

async function load(source, name) {
  const outfile = path.join(buildDir, `${name}.mjs`);
  const built = spawnSync(
    require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] }),
    [path.join(repoRoot, source), "--bundle", "--platform=node", "--format=esm", "--target=node22", `--outfile=${outfile}`, "--log-level=error"],
    { stdio: "inherit" },
  );
  if (built.status !== 0) { console.error(`could not bundle ${source}`); process.exit(1); }
  return import(pathToFileURL(outfile).href);
}

const { carryForward } = await load("artifacts/api-server/src/lib/carry-forward.ts", "carry");
const { planFromText, KEEP_WHOLE_WORDS } = await load("artifacts/api-server/src/lib/plan-from-text.ts", "plan");

let checks = 0;
let failures = 0;
const check = (name, ok, detail = "") => {
  checks += 1;
  if (ok) console.log(`  ✓ ${name}`);
  else { failures += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};

/** What `routes/messages.ts` does, without a database in the way. */
function afterCorrection(previousText, correctionText) {
  const first = planFromText(previousText, { assets: [] });
  const previous = { version: 1, operations: first.operations };
  const second = planFromText(correctionText, { assets: [] });
  const out = carryForward(previous, second.operations, second.spoke, KEEP_WHOLE_WORDS.test(correctionText));
  return { previous, second, out, types: out.operations.map((o) => o.type) };
}

console.log("\nThe edit survives the correction");
{
  const { previous, types, out } = afterCorrection(
    "cut the silences and caption it and make it wide for youtube",
    "make the captions bigger",
  );
  check("the first sentence built a real edit", previous.operations.length >= 3, JSON.stringify(previous.operations.map((o) => o.type)));
  check("the silence removal is still there", types.includes("removeSilence"), JSON.stringify(types));
  check("and so is the shape they asked for", types.includes("formatForPlatform"), JSON.stringify(types));
  const shape = out.operations.find((o) => o.type === "formatForPlatform");
  check("and it is still youtube, not the project default", shape?.platform === "youtube", JSON.stringify(shape));
  check("the correction itself is in the plan", types.includes("autoCaptions"), JSON.stringify(types));
  check("and the carried operations are named, so the reply can say them", out.kept.length >= 2, JSON.stringify(out.kept));
}

console.log("\nBut a removal is a removal");
{
  /*
    The worst failure available to this file, and the reason `SpokenSubjects`
    exists. "Drop the captions" produces no caption operation and is
    emphatically not silence about captions. Carrying the old one forward here
    would re-add the thing they had just watched themselves remove.
  */
  const { types } = afterCorrection("cut the silences and caption it", "actually drop the captions");
  check("captions asked away stay away", !types.includes("autoCaptions"), JSON.stringify(types));
  check("and the rest of the edit is untouched", types.includes("removeSilence"), JSON.stringify(types));

  const noMusic = afterCorrection("caption it and put music under it", "no music");
  check("music asked away stays away", !noMusic.types.includes("addMusic"), JSON.stringify(noMusic.types));
  check("and the captions survive", noMusic.types.includes("autoCaptions"), JSON.stringify(noMusic.types));
}

console.log("\nAnd the matcher has to hear a removal in the first place");
{
  /*
    Found while testing the line above, and worse than the thing it was found
    under: «شيل الترجمة» produced `autoCaptions`. The negation list covered the
    ways somebody says it *before* there are any — "no captions", «بدون ترجمة» —
    and none of the ways somebody says it *after*. A removal names the thing,
    so the caption pattern matched it, and the product's answer to "remove the
    captions" was to add captions.

    Nobody reported it because of where it happens. The first message on a
    project asks for things; a removal is a correction, the third or fourth
    sentence in, and by then the person is looking at a video rather than
    re-reading a reply.
  */
  const gone = (typed) => !planFromText(typed, { assets: [] }).operations.some((o) => o.type === "autoCaptions");
  for (const typed of [
    "remove the captions",
    "drop the captions",
    "take out the subtitles",
    "get rid of the captions",
    "شيل الترجمة",
    "احذف الكابشن",
    "الغي الترجمة",
  ]) {
    check(`«${typed}» removes them`, gone(typed), JSON.stringify(planFromText(typed, { assets: [] }).operations.map((o) => o.type)));
  }
  check("and the old spellings still work", gone("no captions") && gone("بدون ترجمة"));

  /*
    And the other direction, which is what makes the pattern narrow: a removal
    that reached across the whole sentence would eat the half that is a request.
  */
  const has = (typed, type) => planFromText(typed, { assets: [] }).operations.some((o) => o.type === type);
  check("removing the music still captions it", has("remove the music and caption it", "autoCaptions"));
  check("and in Arabic too", has("شيل الموسيقى وضيف ترجمة", "autoCaptions"));
  check("while removing the captions still adds the music", has("remove the captions and add music", "addMusic"));
  check("and does not caption it anyway", gone("remove the captions and add music"));
  check("a plain ask is untouched", has("caption it", "autoCaptions") && has("ضيف ترجمة", "autoCaptions"));
}

console.log("\nThe sentence always wins where it has an opinion");
{
  const { out } = afterCorrection("make it vertical for tiktok", "actually make it wide for youtube");
  const shape = out.operations.find((o) => o.type === "formatForPlatform");
  check("the newer shape replaces the older one", shape?.platform === "youtube", JSON.stringify(shape));
  check("and there is only one of it", out.operations.filter((o) => o.type === "formatForPlatform").length === 1, JSON.stringify(out.operations.map((o) => o.type)));
}

console.log("\nAsking for the whole thing back is an opinion about shape");
{
  /*
    The one way to speak about shape without producing an operation, and it has
    no flag in SpokenSubjects. Without naming the shape operations, «خليه كامل»
    after "the strongest 30 seconds" would hand back thirty seconds again.
  */
  const { types } = afterCorrection("give me the strongest 30 seconds, captioned", "actually keep the whole thing");
  check("the highlight is dropped", !types.includes("extractHighlight"), JSON.stringify(types));
  check("and the captions are kept", types.includes("autoCaptions"), JSON.stringify(types));

  // And without that sentence, the highlight is part of the edit like anything else.
  const quiet = afterCorrection("give me the strongest 30 seconds, captioned", "make the captions bigger");
  check("a correction that says nothing about shape keeps it", quiet.types.includes("extractHighlight"), JSON.stringify(quiet.types));
}

console.log("\nNothing to carry is not an error");
{
  const first = planFromText("caption it", { assets: [] });
  const none = carryForward(null, first.operations, first.spoke, false);
  check("a first message carries nothing", none.kept.length === 0 && none.operations.length === first.operations.length);
  const empty = carryForward({ version: 1, operations: [] }, first.operations, first.spoke, false);
  check("and neither does an empty previous plan", empty.kept.length === 0);
}

console.log("\nThe route uses it, and uses it in the right place");
{
  const { readFileSync } = await import("node:fs");
  const route = readFileSync(path.join(repoRoot, "artifacts/api-server/src/routes/messages.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  check("the route carries the previous plan forward", /carryForward\(/.test(route));
  check("read from the last render of this project", /lastPlanFor\(/.test(route));
  /*
    Before the direction, so the direction fills what is still missing rather
    than competing with what they already have. Asked the other way round, the
    default platform is chosen before the carried one can object.
  */
  /*
    `order` rather than two `indexOf` calls, which is a trap this repository has
    a file about: `indexOf` answers -1 for something that is not there, and -1
    is before every real position, so the comparison passes most loudly in the
    case it was written to catch. `deploy-test` refuses the bare shape, and it
    caught this line.
  */
  const before = order(route, "carryForward(", "const decided = wantsAnEdit");
  check(
    "before the auto-direction, not after",
    before.ok,
    `${before.why} — the direction must fill gaps the carried edit left, not overrule it`,
  );
  check(
    "and every carried operation is said out loud",
    /describeAll\(intent\.operations\.filter/.test(route),
    "a render that builds nine things after a reply promising one is the failure this codebase is written against",
  );
}

await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log("A follow-up still throws away the edit it was correcting.");
  process.exit(1);
}
console.log("A correction changes the edit; it does not replace it.");
