/**
 * Does the spec still describe the API?
 *
 * `lib/api-spec/openapi.yaml` is called the source of truth in the README, and
 * it had drifted badly enough to be describing a different product: seven of
 * the eighteen routes were missing, including every render endpoint and both
 * billing ones, and several documented schemas had lost fields the server had
 * been returning for months.
 *
 * That is not a documentation problem, it is a *detection* problem. Nothing
 * anywhere failed when a route was added and the spec was not touched, so the
 * spec drifted for exactly as long as nobody happened to read it. Writing it
 * back into shape once fixes today and nothing else.
 *
 * So this compares the two mechanically. It reads the route table out of the
 * Express handlers and the schema shapes out of the zod definitions — both of
 * which are the code that actually runs — and asserts the spec matches. From
 * here, forgetting to document a route is a failing check rather than a
 * discovery someone makes a year later.
 *
 * It deliberately does not check descriptions or summaries. Prose that must
 * match prose is a test nobody can keep green, and it would be the reason this
 * file eventually gets deleted.
 *
 * Usage: node tools/contract-test.mjs
 * Requires: nothing. No server, no database, no keys.
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
const buildDir = await mkdtemp(path.join(tmpdir(), "editly-contract-build-"));

const zodBundle = path.join(buildDir, "zod.mjs");
const built = spawnSync(
  require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] }),
  [
    path.join(repoRoot, "lib/api-zod/src/index.ts"),
    "--bundle", "--platform=node", "--format=esm", "--target=node22",
    `--outfile=${zodBundle}`, "--log-level=error",
  ],
  { stdio: "inherit" },
);
if (built.status !== 0) {
  console.error("could not bundle the schemas");
  process.exit(1);
}
const zod = await import(pathToFileURL(zodBundle).href);

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

// ─── What the server actually serves ─────────────────────────────────────────

const routesDir = path.join(repoRoot, "artifacts/api-server/src/routes");
const routes = [];
for (const file of readdirSync(routesDir).filter((f) => f.endsWith(".ts") && f !== "index.ts")) {
  const source = readFileSync(path.join(routesDir, file), "utf8");
  /*
    Every router name a route file mounts, not just the default one.

    Two routes in this product cannot be behind the auth middleware — the
    billing webhook and the OAuth callback — so each lives on a second router
    that `routes/index.ts` mounts before `requireAuth`. Naming only `router`
    here made those invisible: the callback was served, undocumented, and this
    check said the spec was complete. A route that no reader of the spec knows
    exists is the failure this file is for.
  */
  /*
    Every router name a route file exports, not just the default one. A webhook
    router named anything else is a set of public endpoints this checker cannot
    see — which is the opposite of what it is for, and was true of Shopify's
    four compliance webhooks until this name was added.
  */
  const pattern = /\b(?:router|billingWebhookRouter|socialCallbackRouter|shopifyWebhookRouter)\s*\.\s*(get|post|patch|put|delete)\s*\(\s*"([^"]+)"/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    routes.push({ method: match[1], path: match[2], file });
  }
}

/** Express `:id` is OpenAPI `{id}`. */
const asSpecPath = (p) => p.replace(/:([A-Za-z_]+)/g, "{$1}");

// ─── What the spec says ──────────────────────────────────────────────────────

const specText = readFileSync(path.join(repoRoot, "lib/api-spec/openapi.yaml"), "utf8");

/**
 * A deliberately small YAML reader.
 *
 * Only two things are needed — which paths carry which methods, and which
 * properties each component schema declares — and both are two levels of
 * indentation in a file we control. Adding a YAML parser to the repository root
 * to read a file this shape would be a dependency nobody could justify.
 */
function specPaths(text) {
  const found = new Map();
  const lines = text.split("\n");
  let inPaths = false;
  let current = null;

  for (const line of lines) {
    if (/^paths:\s*$/.test(line)) {
      inPaths = true;
      continue;
    }
    if (inPaths && /^[A-Za-z]/.test(line)) break;
    if (!inPaths) continue;

    const route = line.match(/^ {2}(\/\S*):\s*$/);
    if (route) {
      current = route[1];
      found.set(current, new Set());
      continue;
    }
    const method = line.match(/^ {4}(get|post|patch|put|delete):\s*$/);
    if (method && current) found.get(current).add(method[1]);
  }
  return found;
}

function specSchemas(text) {
  const found = new Map();
  const lines = text.split("\n");
  let inSchemas = false;
  let current = null;
  let inProperties = false;

  for (const line of lines) {
    if (/^ {2}schemas:\s*$/.test(line)) {
      inSchemas = true;
      continue;
    }
    if (!inSchemas) continue;
    if (/^[A-Za-z]/.test(line)) break;

    const name = line.match(/^ {4}([A-Za-z][A-Za-z0-9]*):\s*$/);
    if (name) {
      current = name[1];
      found.set(current, new Set());
      inProperties = false;
      continue;
    }
    if (/^ {6}properties:\s*$/.test(line)) {
      inProperties = true;
      continue;
    }
    if (/^ {6}[a-zA-Z]/.test(line)) inProperties = false;
    const property = line.match(/^ {8}([A-Za-z][A-Za-z0-9_]*):\s*$/);
    if (property && current && inProperties) found.get(current).add(property[1]);
  }
  return found;
}

const documented = specPaths(specText);
const schemas = specSchemas(specText);

// ─── Every route is described ────────────────────────────────────────────────

section("The spec knows about every route the server serves");
{
  check("routes were found in the handlers at all", routes.length >= 15, `${routes.length} found`);
  check("and schemas were found in the spec", schemas.size >= 8, `${schemas.size} found`);

  const missing = routes.filter((r) => {
    const methods = documented.get(asSpecPath(r.path));
    return !methods || !methods.has(r.method);
  });

  check(
    "no route is undocumented",
    missing.length === 0,
    missing.map((r) => `${r.method.toUpperCase()} ${r.path} (${r.file})`).join(", "),
  );

  // The other direction matters too: a documented endpoint that does not exist
  // sends people to a 404 and is worse than an omission, because it looks
  // authoritative.
  const served = new Set(routes.map((r) => `${r.method} ${asSpecPath(r.path)}`));
  const phantom = [];
  for (const [p, methods] of documented) {
    for (const method of methods) {
      if (!served.has(`${method} ${p}`)) phantom.push(`${method.toUpperCase()} ${p}`);
    }
  }
  check("and nothing is documented that does not exist", phantom.length === 0, phantom.join(", "));
}

// ─── Every field is described ────────────────────────────────────────────────

/**
 * The properties a zod object declares, read from the schema rather than from a
 * list somebody has to remember to update.
 */
function fieldsOf(schema) {
  const shape = schema?._zod?.def?.shape ?? schema?.shape ?? schema?.def?.shape;
  return shape ? new Set(Object.keys(shape)) : null;
}

section("The documented shapes still match the schemas that validate");
{
  const pairs = [
    ["Project", zod.Project],
    ["Message", zod.Message],
    ["ExportJob", zod.ExportJob],
    ["SubscriptionUsage", zod.SubscriptionUsage],
  ];

  for (const [name, schema] of pairs) {
    const actual = fieldsOf(schema);
    const spec = schemas.get(name);

    if (!actual) {
      check(`${name} could be read from the schemas`, false, "shape not found");
      continue;
    }
    if (!spec) {
      check(`${name} appears in the spec`, false, "missing from components");
      continue;
    }

    const undocumented = [...actual].filter((f) => !spec.has(f));
    const invented = [...spec].filter((f) => !actual.has(f));

    check(`${name}: every field the server returns is documented`, undocumented.length === 0, undocumented.join(", "));
    check(`${name}: nothing is documented that the server does not return`, invented.length === 0, invented.join(", "));
  }
}

// ─── And the third copy, which the browser actually imports ──────────────────

section("The generated client describes the same API as the schemas");
{
  // There are three descriptions of every response: the OpenAPI file, the zod
  // schemas the server validates with, and the TypeScript the frontend imports.
  // The third is marked "Do not edit manually" and generated by a tool that is
  // not installed here, which means in practice it is edited by hand — and it
  // had already drifted: `HealthStatus` still had a single `status` field long
  // after the endpoint started reporting which columns were missing.
  //
  // A type the browser compiles against and nothing checks is the same problem
  // as a spec nobody reads, with a compiler in front of it giving false comfort.
  const generated = readFileSync(
    path.join(repoRoot, "lib/api-client-react/src/generated/api.schemas.ts"),
    "utf8",
  );

  /** The property names of one `export interface X { … }` block. */
  const interfaceFields = (name) => {
    const match = generated.match(new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`));
    if (!match) return null;
    return new Set(
      [...match[1].matchAll(/^\s{2}([A-Za-z_][A-Za-z0-9_]*)\??:/gm)].map((m) => m[1]),
    );
  };

  const pairs = [
    ["Project", zod.Project],
    ["Message", zod.Message],
    ["ExportJob", zod.ExportJob],
    ["SubscriptionUsage", zod.SubscriptionUsage],
    ["DashboardStats", zod.DashboardStats],
    ["WorkerStatus", zod.WorkerStatus],
    ["HealthStatus", zod.HealthCheckResponse],
  ];

  for (const [name, schema] of pairs) {
    const actual = fieldsOf(schema);
    const client = interfaceFields(name);

    if (!client) {
      check(`${name} exists in the generated client`, false, "no such interface");
      continue;
    }
    const missing = [...(actual ?? [])].filter((f) => !client.has(f));
    const extra = [...client].filter((f) => !actual?.has(f));
    check(`${name}: the browser's type has every field the server sends`, missing.length === 0, missing.join(", "));
    check(`${name}: and none the server does not`, extra.length === 0, extra.join(", "));
  }
}

section("The plan names in the spec are the ones the code accepts");
{
  const planNames = zod.SubscriptionPlan?.options ?? zod.SubscriptionPlan?._zod?.def?.entries;
  const plans = Array.isArray(planNames) ? planNames : Object.keys(planNames ?? {});
  check("the schema lists four tiers", plans.length === 4, JSON.stringify(plans));
  for (const plan of plans) {
    check(`the spec mentions "${plan}"`, specText.includes(plan), plan);
  }
  // The rename left `starter` and `scale` behind in more than one place, and a
  // spec still naming them would send an integrator to a 400.
  //
  // Property *names* are excluded before the search. `scale` is also a real
  // property — how wide an image overlay sits on the frame — and a guard that
  // cannot tell a plan tier from a field name is a guard that stops anyone
  // adding a field. An abandoned tier name would appear as an enum value or in
  // prose, never as a YAML key, so dropping the keys keeps the check honest.
  const specValues = specText.replace(/^(\s*)[A-Za-z][A-Za-z0-9]*:/gm, "$1:");
  check("and no longer mentions the pre-rename names", !/\bstarter\b|\bscale\b/.test(specValues));
}

section("Every edit operation the worker can run is in the spec");
{
  const operations = (zod.EditOperation?._zod?.def?.options ?? zod.EditOperation?.options ?? [])
    .map((option) => {
      const shape = option?._zod?.def?.shape ?? option?.shape;
      const literal = shape?.type?._zod?.def?.values ?? shape?.type?._zod?.def?.entries;
      return Array.isArray(literal) ? literal[0] : Object.keys(literal ?? {})[0];
    })
    .filter(Boolean);

  check("the union could be read", operations.length >= 8, JSON.stringify(operations));
  for (const operation of operations) {
    check(`"${operation}" is documented`, specText.includes(operation), operation);
  }
}

await rm(buildDir, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("The spec describes the API that exists.");
