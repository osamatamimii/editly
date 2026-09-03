/**
 * Everything this product can do, read out of the product.
 *
 * Osama asked for a table of what the tool does, so that each thing can be
 * measured, reviewed, improved, and searched for holes. The table below is
 * that — but it is **generated**, and the reason is the whole design.
 *
 * A hand-written capability list is a document that was true on the day it was
 * written. It drifts silently: an operation gets added and nobody edits the
 * list; a planner stops emitting one and the list still promises it; a suite is
 * deleted and the list still says "covered". Within a month it is a document
 * that has to be checked against the code, which is exactly the work it existed
 * to save.
 *
 * So this reads the code. Every column below is a fact about a file:
 *
 *   contract    the operation exists in `lib/api-zod/src/index.ts`
 *   renderer    the worker has a branch that executes it
 *   keywords    `plan-from-text.ts` can produce it from a sentence
 *   model       it is in the JSON schema the planner hands the model
 *   templates   which one-click looks use it
 *   suites      which test files name it
 *   ui          the browser has a control that reaches it
 *
 * ## What it is for
 *
 * Four holes are worth naming, and each is a real failure this product has
 * already had at least once:
 *
 * **Built and unreachable.** `zoomPunch.at` was honoured by the renderer for
 * weeks while both planners sent an empty list — a capability with tests,
 * shipped, that no sentence could ask for.
 *
 * **Promised and unbuilt.** An operation in the contract with no renderer
 * branch validates, queues, renders, and does nothing. Nothing fails.
 *
 * **Two heads that disagree.** The keyword matcher and the model are separate
 * paths to the same plan. An operation one can emit and the other cannot is a
 * product that behaves differently depending on whether a key is set.
 *
 * **Untested.** A capability no suite names is one nobody would notice
 * breaking.
 *
 * Usage:
 *   node tools/inventory.mjs            print the table
 *   node tools/inventory.mjs --json     the same as data
 *   node tools/inventory.mjs --check    exit non-zero if a hole is found
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const read = async (p) => readFile(path.join(repoRoot, p), "utf8").catch(() => "");

// ── What exists ─────────────────────────────────────────────────────────────

const contract = await read("lib/api-zod/src/index.ts");

/**
 * The operations, in the order the contract declares them.
 *
 * From `z.literal(...)` rather than from a list somebody keeps beside it: the
 * literal is what the API actually validates against, and any second copy is a
 * copy that can be wrong.
 */
const OPERATIONS = [...contract.matchAll(/type:\s*z\.literal\("([A-Za-z]+)"\)/g)].map((m) => m[1]);

/**
 * The operations no sentence may ask for, and why.
 *
 * Both are deliberate, and writing them down is the point: without this map
 * the hole detector below flags them every run, and a checker that cries wolf
 * twice a run is a checker people stop reading. With it, the exception is a
 * decision recorded in a file rather than a silent pass — and adding a third
 * one means writing the reason.
 */
const IMPOSED = {
  watermark:
    "the server puts it on free-plan renders. A person asking for it, or asking to remove it, is not how it is decided.",
  burnCaptions:
    "for a caller that already holds the cues — the clips branch hands them down. A sentence asks for autoCaptions, which transcribes first.",
};

/** One line each, and these are the only hand-written words in the table. */
const PURPOSE = {
  removeSilence: "يقصّ الصمت والوقفات",
  formatForPlatform: "يعيد التأطير لشكل المنصّة",
  burnCaptions: "يحرق كابشنز جاهزة سُلّمت له",
  autoCaptions: "يفرّغ الكلام ويحرقه كابشنز",
  watermark: "يضع «Edited with Editly» على المجاني",
  kenBurns: "دفعة بطيئة كي لا تبقى الصورة ساكنة",
  zoomPunch: "تشديد على لحظات مختارة",
  grade: "لوك لوني مسمّى",
  normalizeLoudness: "يسوّي الصوت إلى ‎-14 LUFS",
  insertBRoll: "يقحم مقطعًا آخر من مكتبة المشروع",
  addMusic: "سرير موسيقي تحت التعديل",
  overlayImage: "شعار أو صورة فوق الكادر",
  motionTitle: "عنوان متحرّك",
  extractHighlight: "أقوى N ثانية، العامل يختارها",
  extractRange: "المدى الذي سمّيته أنت بالضبط",
  extractClips: "تسجيلة طويلة إلى عدّة مقاطع",
  fade: "فتح من الأسود وإغلاق إليه",
  transition: "وصلة بين القصّات، بعشرة أشكال",
  coldOpen: "يفتح الفيديو على أقوى لحظة فيه",
  soundEffects: "طبقة صوت: هواء على القصّات وثقل تحت التقريبات",
  alternateFraming: "يقطع بين حجمين للكادر، فتبدو كاميرا واحدة كاميرتين",
  stillsReel: "يبني الفيديو من صور المنتج، لمشروع بلا فيديو",
};

// ── Where each one is answered ──────────────────────────────────────────────

const rendererFiles = ["ffmpeg.ts", "index.ts", "captions.ts", "motion.ts", "framing.ts", "enrich.ts", "critic.ts"];
const renderer = (
  await Promise.all(rendererFiles.map((f) => read(`artifacts/worker/src/${f}`)))
).join("\n");

const keywords = await read("artifacts/api-server/src/lib/plan-from-text.ts");
const model = await read("artifacts/api-server/src/lib/planner.ts");
const templates = await read("artifacts/api-server/src/lib/templates.ts");

const uiFiles = (await readdir(path.join(repoRoot, "artifacts/editly/src/pages")).catch(() => []))
  .filter((f) => f.endsWith(".tsx"));
const uiComponents = (await readdir(path.join(repoRoot, "artifacts/editly/src/components")).catch(() => []))
  .filter((f) => f.endsWith(".tsx"));
const ui = (
  await Promise.all([
    ...uiFiles.map((f) => read(`artifacts/editly/src/pages/${f}`)),
    ...uiComponents.map((f) => read(`artifacts/editly/src/components/${f}`)),
  ])
).join("\n");
void ui;

const suiteNames = (await readdir(path.join(repoRoot, "tools"))).filter(
  (f) => f.endsWith("-test.mjs"),
);
const suites = Object.fromEntries(
  await Promise.all(suiteNames.map(async (f) => [f, await read(`tools/${f}`)])),
);

/**
 * The model's vocabulary, read out of the array it is built from.
 *
 * Three of them are conditional — b-roll, overlays and music appear only when
 * the project holds a file of that kind — and that is a real property worth
 * showing rather than flattening: an operation nobody can name because their
 * library is empty is a different state from one that does not exist.
 */
const modelBlock = model.slice(model.indexOf("const types = ["), model.indexOf("];", model.indexOf("const types = [")));
const modelTypes = new Set([...modelBlock.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]));
const conditional = new Set(
  [...modelBlock.matchAll(/length > 0 \? \["([A-Za-z]+)"\]/g)].map((m) => m[1]),
);

/** Which templates name an operation, by the `type:` they write. */
const templateNames = [...templates.matchAll(/id:\s*"([a-z0-9-]+)"/g)].map((m) => m[1]);

function templatesUsing(op) {
  // Each template is a block between its own id and the next; an operation
  // counts for the block it appears in.
  const used = [];
  for (let i = 0; i < templateNames.length; i += 1) {
    const start = templates.indexOf(`id: "${templateNames[i]}"`);
    const end =
      i + 1 < templateNames.length ? templates.indexOf(`id: "${templateNames[i + 1]}"`) : templates.length;
    if (templates.slice(start, end).includes(`"${op}"`)) used.push(templateNames[i]);
  }
  return used;
}

const rows = OPERATIONS.map((op) => {
  const quoted = `"${op}"`;
  return {
    operation: op,
    purpose: PURPOSE[op] ?? "",
    /*
      The renderer's own branch, not a mention. `find("op")` and
      `op.type === "op"` are how this file dispatches; a name appearing only in
      a comment is not an implementation.
    */
    renderer:
      renderer.includes(`find(${quoted})`) ||
      renderer.includes(`type === ${quoted}`) ||
      renderer.includes(`type: ${quoted}`),
    keywords: keywords.includes(`type: ${quoted}`),
    model: modelTypes.has(op),
    conditional: conditional.has(op),
    templates: templatesUsing(op),
    suites: suiteNames.filter((f) => suites[f].includes(quoted)),
    /*
      How a person reaches it, which is not the same question as whether the
      string appears in the browser bundle. Almost nothing in this product is
      named by a control: a plan is made by pressing a template, by typing a
      sentence, or by the server deciding. An `includes` on the UI source said
      "no" for eighteen of nineteen operations and meant nothing.
    */
    door: IMPOSED[op]
      ? "server"
      : templatesUsing(op).length > 0
        ? "button"
        : keywords.includes(`type: ${quoted}`) || modelTypes.has(op)
          ? "sentence"
          : "none",
    imposed: IMPOSED[op] ?? null,
  };
});

// ── The rest of the product ─────────────────────────────────────────────────

/*
  Editing operations are the craft, and they are not the whole tool. A person
  also signs in, uploads, pays, schedules, uploads a font, opens a clip as its
  own project, and — if it is Osama — reads the admin console. Each of those is
  a route file, and a route file with no suite is a part of the product nobody
  would notice breaking.

  Grouped by file rather than by URL because that is how the code is organised
  and therefore where a gap actually sits.
*/
const AREA_PURPOSE = {
  "projects.ts": "المشاريع: إنشاء وقراءة وحذف، والحذف يستعيد البايتات",
  "messages.ts": "المحادثة: جملة تصير خطّة ويبدأ التصيير من نفس النداء",
  "render.ts": "بدء تصيير من خطّة أو قالب، خلف سياسة واحدة",
  "exports.ts": "الناتج النهائي وروابطه",
  "clips.ts": "القصاصات: قائمة وحذف وفتح قطعة مشروعًا مستقلًّا",
  "assets.ts": "مكتبة المشروع: ما يمكن وضعه على الشاشة",
  "uploads.ts": "إذن الرفع: الملكية والحصّة والنوع والحجم قبل التوقيع",
  "fonts.ts": "خطوط العميل: تسجيل ما رُفع، وقياسه في العامل",
  "social.ts": "الجدولة: المنصّات والحسابات والمنشورات وربط الحساب",
  "stock.ts": "مكتبة Pexels: بحث ومعاينة ووسيط تحميل",
  "billing.ts": "Freemius: ويبهوك موقّع، ومطالبة الأحداث",
  "subscription.ts": "الخطة والدقائق المتبقّية",
  "account.ts": "الحساب: البريد والمزوّدون والتصدير والحذف",
  "mail.ts": "الباب الخارج من قائمة الأخبار: رمز في الرسالة، لا جلسة",
  "stats.ts": "أرقام اللوحة",
  "admin.ts": "لوحة التشغيل: قراءة، وأربعة أفعال موقَّعة",
  "waitlist.ts": "قائمة الانتظار — الكتابة العامّة الوحيدة في المنتج",
  "health.ts": "‏/healthz: هل هذه النشرة تعرف ما تحتاجه",
  "client-errors.ts": "انهيار في المتصفّح: السطر الوحيد عندنا عن شاشة بيضاء عند غيرنا",
  "csp-report.ts": "ما منعته سياسة المحتوى: كانت تُبلِغ لا أحد، فصار لها عنوان",
};

/*
  The worker is not a route file and is half the product.

  Listing it by hand here would be the drift this whole tool exists against, so
  it is read the same way: every module beside the renderer, with the suites
  that name it. A module nobody tests is the same hole whether it answers HTTP
  or not.
*/
const workerModules = (await readdir(path.join(repoRoot, "artifacts/worker/src")))
  .filter((f) => f.endsWith(".ts"));

const routeFiles = (await readdir(path.join(repoRoot, "artifacts/api-server/src/routes")))
  .filter((f) => f.endsWith(".ts") && f !== "index.ts");

const areas = [];
for (const file of routeFiles) {
  const source = await read(`artifacts/api-server/src/routes/${file}`);
  const endpoints = [
    ...source.matchAll(/\b(?:router|billingWebhookRouter|socialCallbackRouter)\s*\.\s*(get|post|patch|put|delete)\s*\(\s*"([^"]+)"/g),
  ].map((m) => `${m[1].toUpperCase()} ${m[2]}`);
  const stem = file.replace(/\.ts$/, "");
  /*
    A suite belongs to an area if it calls one of its paths.

    Matched as a pattern, not as a string, and the first version got this
    wrong in a way worth keeping the note for: it stripped `:id` out of
    `/projects/:id/export` and looked for the literal `/projects//export`,
    which no suite contains — so it reported `exports.ts` as covered by
    nothing while `isolation-test` was calling both of its endpoints. A
    checker's own false alarm is the fastest way to teach people to ignore it.

    A suite writes these paths with a value interpolated in, so each `:param`
    becomes "one segment of anything".
  */
  const patterns = endpoints.map((e) => {
    const route = e.split(" ")[1];
    const source = route
      .split("/")
      .map((seg) => (seg.startsWith(":") ? "[^/\"'`\\s]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
      .join("/");
    return new RegExp(source);
  });
  const covering = suiteNames.filter((suite) => patterns.some((re) => re.test(suites[suite])));
  areas.push({ file, purpose: AREA_PURPOSE[file] ?? "", endpoints, suites: covering });
}

/*
  Which worker module imports which, so coverage can be claimed one hop out.

  Needed because most of these are never bundled by a suite directly and are
  still exercised thoroughly: `render-test` bundles `ffmpeg.ts`, which imports
  `highlight.ts` and `say.ts` and calls into both on every assertion in the
  file. Counting only direct bundling reported those two as untested, which is
  false — and a checker that is false in the *alarming* direction gets muted,
  which is how the true alarms get missed too.

  One hop and no further. Two would make everything downstream of `index.ts`
  "covered" and the floor would stop meaning anything.
*/
const workerSource = Object.fromEntries(
  await Promise.all(workerModules.map(async (f) => [f, await read(`artifacts/worker/src/${f}`)])),
);
const importersOf = (file) => {
  const stem = file.replace(/\.ts$/, "");
  return workerModules.filter(
    (other) =>
      other !== file &&
      new RegExp(`from "\\./${stem}(\\.js)?"`).test(workerSource[other]),
  );
};

const bundledBy = (file) => suiteNames.filter((suite) => suites[suite].includes(`worker/src/${file}`));

const workerParts = workerModules.map((file) => {
  /*
    Named by path, not by stem.

    The first version matched the bare name and reported `say.ts` as covered by
    forty-three suites — every file containing the word "say". A coverage floor
    that over-counts is worse than no floor: it would call a genuinely untested
    module covered the moment its name was an ordinary English word, which is
    most of them here (`review`, `preview`, `duration`, `subject`, `motion`).
  */
  const direct = bundledBy(file);
  const through = direct.length > 0 ? [] : importersOf(file).filter((imp) => bundledBy(imp).length > 0);
  return { file, suites: direct, through };
});

// ── The holes ───────────────────────────────────────────────────────────────

const holes = [];
for (const row of rows) {
  if (!row.renderer) {
    holes.push({
      operation: row.operation,
      kind: "promised, not built",
      why: "the contract accepts it, so a plan naming it validates, queues, renders and does nothing at all",
    });
  }
  if (row.renderer && !row.keywords && !row.model && row.templates.length === 0 && !IMPOSED[row.operation]) {
    holes.push({
      operation: row.operation,
      kind: "built, unreachable",
      why: "no sentence, no model choice and no template can ask for it — this is what zoomPunch.at was for weeks",
    });
  }
  if (row.keywords !== row.model && !row.conditional && !IMPOSED[row.operation]) {
    holes.push({
      operation: row.operation,
      kind: "the two planners disagree",
      why: `${row.keywords ? "the keyword matcher" : "the model"} can produce it and ${row.keywords ? "the model" : "the keyword matcher"} cannot, so the product behaves differently depending on whether a key is set`,
    });
  }
  if (row.suites.length === 0) {
    holes.push({
      operation: row.operation,
      kind: "untested",
      why: "no suite names it, so nobody would notice it breaking",
    });
  }
}

for (const part of workerParts) {
  if (part.suites.length === 0 && part.through.length === 0) {
    holes.push({
      operation: `worker/${part.file}`,
      kind: "a worker module with no suite",
      why: "nothing names it, so it could stop working and the only symptom would be a render that is quietly worse",
    });
  }
}

for (const area of areas) {
  if (area.endpoints.length > 0 && area.suites.length === 0) {
    holes.push({
      operation: area.file,
      kind: "an area with no suite",
      why: `${area.endpoints.length} endpoint${area.endpoints.length === 1 ? "" : "s"} that no test names — this part of the product could stop working and nothing would say so`,
    });
  }
  if (!AREA_PURPOSE[area.file]) {
    holes.push({
      operation: area.file,
      kind: "an area nobody described",
      why: "a route file with no line in AREA_PURPOSE: somebody added a part of the product and the table does not know what it is for",
    });
  }
}

// ── Output ──────────────────────────────────────────────────────────────────

const mark = (b) => (b ? "✓" : "·");

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ operations: rows, areas, worker: workerParts, holes, templates: templateNames, suites: suiteNames }, null, 2));
} else {
  const width = Math.max(...OPERATIONS.map((o) => o.length));
  console.log(`\nWhat this product can do — ${rows.length} operations, read out of the code\n`);
  console.log(
    `${"operation".padEnd(width)}  built  words  model  looks  suites  door`,
  );
  console.log("-".repeat(width + 42));
  for (const row of rows) {
    console.log(
      `${row.operation.padEnd(width)}    ${mark(row.renderer)}      ${mark(row.keywords)}` +
        `      ${row.conditional ? "~" : mark(row.model)}      ${String(row.templates.length).padStart(1)}` +
        `      ${String(row.suites.length).padStart(2)}    ${row.door}`,
    );
  }
  console.log(`\n~ = in the model's vocabulary only when the project holds a file of that kind.`);
  console.log(`door = how a person reaches it: a template button, a typed sentence, or the server deciding.\n`);

  const imposed = rows.filter((r) => r.imposed);
  if (imposed.length > 0) {
    console.log("Not reachable by a sentence, on purpose:\n");
    for (const row of imposed) console.log(`  ${row.operation} — ${row.imposed}\n`);
  }

  const areaWidth = Math.max(...areas.map((a) => a.file.length));
  console.log(`The rest of the product — ${areas.length} areas, ${areas.reduce((n, a) => n + a.endpoints.length, 0)} endpoints\n`);
  console.log(`${"area".padEnd(areaWidth)}  ends  suites`);
  console.log("-".repeat(areaWidth + 16));
  for (const area of areas.slice().sort((a, b) => b.endpoints.length - a.endpoints.length)) {
    console.log(
      `${area.file.padEnd(areaWidth)}   ${String(area.endpoints.length).padStart(2)}     ${String(area.suites.length).padStart(2)}`,
    );
  }
  console.log("");
  console.log(`The worker — ${workerParts.length} modules\n`);
  const partWidth = Math.max(...workerParts.map((p) => p.file.length));
  console.log(`${"module".padEnd(partWidth)}  suites`);
  console.log("-".repeat(partWidth + 8));
  for (const part of workerParts.slice().sort((a, b) => b.suites.length - a.suites.length)) {
    const how =
      part.suites.length > 0
        ? String(part.suites.length).padStart(2)
        : part.through.length > 0
          ? ` through ${part.through.join(", ")}`
          : " —";
    console.log(`${part.file.padEnd(partWidth)}    ${how}`);
  }
  console.log("");

  if (holes.length === 0) {
    console.log("No holes: every operation is built, reachable, agreed on by both planners, and covered.\n");
  } else {
    console.log(`${holes.length} hole${holes.length === 1 ? "" : "s"}:\n`);
    for (const hole of holes) console.log(`  ${hole.operation} — ${hole.kind}\n    ${hole.why}\n`);
  }
}

if (process.argv.includes("--check") && holes.length > 0) process.exit(1);
