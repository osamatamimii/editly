/**
 * The first email this product has ever been able to send, and the four ways
 * sending one goes wrong.
 *
 * Until now there was no way at all: no SMTP, no provider, no template. Every
 * moment where a decision gets made was silent, and a silently declined card is
 * a subscription already lost by the time anybody notices.
 *
 * What is worth testing is not that a request goes out. It is:
 *
 *   **That it goes out once.** A webhook Freemius redelivers, a process that
 *   restarts mid-loop, a retry after a timeout — each is two identical messages
 *   to somebody who asked for none, on a sending domain with no reputation to
 *   spend. So the same send is performed twice here and the stub counts.
 *
 *   **That unsubscribing from news does not stop a receipt.** Merging the two
 *   is either marketing to people who said no, or account notices withheld from
 *   them. Both directions are asserted.
 *
 *   **That the language is theirs.** Read from their preference, then from the
 *   language they have actually been rendering in, and never from the contents
 *   of the message — which is a circle, and how a product ends up writing to
 *   everybody in whatever the template happened to be in.
 *
 *   **That failing to send fails nothing else.** A provider that is down, a key
 *   that is absent, a body that is not JSON: every one of them comes back as an
 *   outcome, and the caller — mid-payment — carries on.
 *
 * The provider is stubbed and nothing else is. The database is real, because
 * the send-once guarantee is a unique index and a stubbed one proves nothing.
 *
 * Usage: DATABASE_URL=postgres://... node tools/mail-test.mjs
 * Requires: a Postgres carrying the schema (pnpm run migrate). No keys, no network.
 */
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { resolveTestDatabaseUrl } from "./lib/test-db.mjs";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
// Under `lib/db`, because that is the package `pg` is a dependency of and
// esbuild leaves it external.
const buildDir = await mkdtemp(path.join(repoRoot, "lib/db/.mail-"));
process.on("exit", () => {
  try {
    require("node:fs").rmSync(buildDir, { recursive: true, force: true });
  } catch {
    /* nothing to do at exit but leave it */
  }
});

const DATABASE_URL = await resolveTestDatabaseUrl();
process.env.SUPABASE_URL ??= "http://127.0.0.1:1/not-a-real-project";
process.env.SUPABASE_ANON_KEY ??= "anon-key-for-tests";

const { Pool } = require(require.resolve("pg", { paths: ["lib/db"] }));
const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });

const outfile = path.join(buildDir, "mail.mjs");
const built = spawnSync(
  require.resolve("esbuild/bin/esbuild", { paths: ["artifacts/api-server"] }),
  [
    path.join(repoRoot, "artifacts/api-server/src/lib/mail.ts"),
    "--bundle", "--platform=node", "--format=esm", "--target=node22",
    /*
      The workspace packages are bundled, because a directory import of
      `lib/db/src/schema` is not something Node resolves. `pg` is left out
      because bundling a driver that loads its own native bindings turns a
      `require` into a throw, and the logger is swapped for the stub the other
      suites use: this file prints a check list, and pino writing to the same
      stdout in the middle of it is noise about nothing.
    */
    "--external:pg", "--external:pg-native",
    `--alias:pino=${path.join(repoRoot, "tools/fixtures/pino-stub.mjs")}`,
    `--outfile=${outfile}`, "--log-level=error",
  ],
  { stdio: "inherit" },
);
if (built.status !== 0) process.exit(1);
const mail = await import(pathToFileURL(outfile).href);

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
const section = (t) => console.log(`\n${t}`);

const ALICE = "11111111-1111-4111-8111-111111111111";
const BASHIR = "22222222-2222-4222-8222-222222222222";

async function reset() {
  for (const who of [ALICE, BASHIR]) {
    await pool.query("DELETE FROM mail_sends WHERE user_id = $1", [who]);
    await pool.query("DELETE FROM mail_settings WHERE user_id = $1", [who]);
    await pool.query("DELETE FROM jobs WHERE user_id = $1", [who]);
    await pool.query("DELETE FROM projects WHERE user_id = $1", [who]);
  }
}

/** The provider, as far as this module is concerned. */
function provider(reply = () => new Response(JSON.stringify({ id: "msg-1" }), { status: 200 })) {
  const calls = [];
  return {
    calls,
    impl: async (url, init) => {
      calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
      return reply();
    },
  };
}

const letter = {
  en: { subject: "Something happened", body: "A thing occurred." },
  ar: { subject: "حدث شيء", body: "وقع أمر ما." },
};

const KEY = "re_test_key_not_a_real_one";
process.env.RESEND_API_KEY = KEY;

await reset();

// ── Once ────────────────────────────────────────────────────────────────────

section("The same message is never sent twice");
{
  const first = provider();
  const one = await mail.send({ userId: ALICE, to: "a@example.test", kind: "account", event: "plan-changed", reference: "evt-1", letter }, first.impl);
  check("the first send goes", one.sent === true, JSON.stringify(one));
  check("as one request", first.calls.length === 1, String(first.calls.length));

  /*
    The redelivery. Freemius resends events, and this handler is built to absorb
    that everywhere else; an email that did not absorb it would be the one part
    of the flow a customer could see going wrong twice.
  */
  const again = provider();
  const two = await mail.send({ userId: ALICE, to: "a@example.test", kind: "account", event: "plan-changed", reference: "evt-1", letter }, again.impl);
  check("the same event and reference sends nothing", two.sent === false, JSON.stringify(two));
  check("and says why, rather than reporting success", two.because === "already-sent", two.because);
  check("no second request left this process", again.calls.length === 0, String(again.calls.length));

  const other = provider();
  await mail.send({ userId: ALICE, to: "a@example.test", kind: "account", event: "plan-changed", reference: "evt-2", letter }, other.impl);
  check("a different instance of the same event does send", other.calls.length === 1);

  const someoneElse = provider();
  await mail.send({ userId: BASHIR, to: "b@example.test", kind: "account", event: "plan-changed", reference: "evt-1", letter }, someoneElse.impl);
  check("and one person's claim is not another's", someoneElse.calls.length === 1);
}

// ── Account against news ────────────────────────────────────────────────────

section("Unsubscribing from news does not switch off a receipt");
{
  await pool.query(
    "INSERT INTO mail_settings (user_id, news_opt_out) VALUES ($1, true) ON CONFLICT (user_id) DO UPDATE SET news_opt_out = true",
    [ALICE],
  );

  const account = provider();
  const receipt = await mail.send({ userId: ALICE, to: "a@example.test", kind: "account", event: "payment-failed", reference: "evt-9", letter }, account.impl);
  check("an account message reaches somebody who unsubscribed from news", receipt.sent === true, JSON.stringify(receipt));

  const news = provider();
  const marketing = await mail.send({ userId: ALICE, to: "a@example.test", kind: "news", event: "newsletter", reference: "2026-09", letter }, news.impl);
  check("and a news message does not", marketing.sent === false, JSON.stringify(marketing));
  check("with no request made", news.calls.length === 0);

  /*
    Somebody who never unsubscribed does get it, and that is the change.

    For the whole life of this module `UNSUBSCRIBE_ROUTE_EXISTS` was `false`
    and marketing was refused for everybody — not as a preference but as a
    refusal to send a newsletter before its own unsubscribe link existed, which
    is unlawful in most of the places this product will be read. The split
    between the two kinds was built on day one so that turning it on could be
    one line, and this is the check that says the line was earned.
  */
  const fresh = provider();
  const toSomebodyNew = await mail.send({ userId: BASHIR, to: "b@example.test", kind: "news", event: "newsletter", reference: "2026-09", letter }, fresh.impl);
  check("news reaches somebody who never unsubscribed", toSomebodyNew.sent === true, JSON.stringify(toSomebodyNew));
}

section("The way out is real, and it is in the letter and in the headers");
{
  /*
    The flag is a claim about the world, so it is checked against the world.

    `UNSUBSCRIBE_ROUTE_EXISTS = true` unblocks every marketing message this
    product will ever send. If it were set while the route or the screen did not
    exist, the result would be a newsletter with a link to a 404 — worse than
    the refusal it replaced, because it looks like compliance.
  */
  check("the flag is on", mail.UNSUBSCRIBE_ROUTE_EXISTS === true);

  const route = readFileSync(path.join(repoRoot, "artifacts/api-server/src/routes/mail.ts"), "utf8");
  check("there is a route behind it", /router\.post\("\/mail\/unsubscribe\/:token"/.test(route));
  check("that reads without acting, because scanners follow links", /router\.get\("\/mail\/unsubscribe\/:token"/.test(route));
  check(
    "and the GET really does not change anything",
    !/update mail_settings[\s\S]{0,400}?\}\);\s*\n\s*\/\*\*[\s\S]{0,200}Stop the news/.test(route) &&
      route.indexOf("update mail_settings") > route.indexOf('router.post("/mail/unsubscribe'),
    "a GET that unsubscribes is a GET that unsubscribes everybody whose mail passes a scanner",
  );

  const mounted = readFileSync(path.join(repoRoot, "artifacts/api-server/src/routes/index.ts"), "utf8");
  const aboveAuth = mounted.slice(0, mounted.indexOf("router.use(requireAuth)"));
  check(
    "mounted where somebody with no session can reach it",
    aboveAuth.includes("router.use(mailRouter)"),
    "the person clicking is in an email client, not signed in",
  );

  const screen = readFileSync(path.join(repoRoot, "artifacts/editly/src/pages/unsubscribe.tsx"), "utf8");
  const app = readFileSync(path.join(repoRoot, "artifacts/editly/src/App.tsx"), "utf8");
  check("there is a screen for the link to land on", screen.length > 500);
  check("declared as a route", /path="\/unsubscribe\/:token"/.test(app));
  check("in both languages, because leaving is the wrong moment to meet English", /useLanguage\(/.test(screen));
  check("and it offers the way back, since a mis-tap is the commonest reason to be there", /button-resubscribe/.test(screen));

  // The letter points at the screen and the header points at the API, and they
  // are deliberately different URLs.
  // Bashir, not Alice: the section above set Alice's `news_opt_out`, and a
  // check that quietly asserted nothing because the recipient had opted out
  // would be the same silence this whole file is about.
  const sent = provider();
  await mail.send({ userId: BASHIR, to: "b@example.test", kind: "news", event: "newsletter", reference: "2026-10", letter }, sent.impl);
  const body = sent.calls[0]?.body;
  check("a news message went out", Boolean(body), JSON.stringify(sent.calls.length));
  check(
    "the link in the letter is the page, not the endpoint",
    /\/unsubscribe\//.test(body?.text ?? "") && !/\/api\/mail\/unsubscribe\//.test(body?.text ?? ""),
    body?.text?.slice(-160),
  );
  check(
    "and the one-click header is the endpoint, because nobody is watching that one",
    /\/api\/mail\/unsubscribe\//.test(body?.headers?.["List-Unsubscribe"] ?? ""),
    JSON.stringify(body?.headers),
  );
  check(
    "declared one-click, which is what Gmail and Yahoo ask of bulk senders",
    body?.headers?.["List-Unsubscribe-Post"] === "List-Unsubscribe=One-Click",
    JSON.stringify(body?.headers),
  );

  /*
    And not on an account message. An unsubscribe header on a receipt tells the
    client the message is marketing, which is the wrong answer for a letter
    saying a payment failed — and the client may then file it accordingly.
  */
  const receiptCalls = provider();
  await mail.send({ userId: BASHIR, to: "b@example.test", kind: "account", event: "payment-failed", reference: "evt-11", letter }, receiptCalls.impl);
  check(
    "a receipt carries no unsubscribe header",
    receiptCalls.calls[0]?.body?.headers === undefined,
    JSON.stringify(receiptCalls.calls[0]?.body?.headers),
  );
  check(
    "and no unsubscribe line either",
    !/unsubscribe|إيقاف رسائل/i.test(receiptCalls.calls[0]?.body?.text ?? ""),
    receiptCalls.calls[0]?.body?.text?.slice(-120),
  );
}

// ── Their language ──────────────────────────────────────────────────────────

section("It is written in their language, decided by them and not by the template");
{
  await reset();
  const noHistory = provider();
  await mail.send({ userId: ALICE, to: "a@example.test", kind: "account", event: "e", reference: "1", letter }, noHistory.impl);
  check("with nothing to go on, English", noHistory.calls[0]?.body?.subject === letter.en.subject, noHistory.calls[0]?.body?.subject);

  /*
    Then what they actually do. Somebody who has asked this product for things
    in Arabic does not want an English receipt, and that signal is already in
    the database — it is the language every render's notes are written in.
  */
  await pool.query(
    `INSERT INTO projects (id, user_id, title, status) VALUES ('mail-p', $1, 'p', 'ready') ON CONFLICT (id) DO NOTHING`,
    [ALICE],
  );
  await pool.query(
    `INSERT INTO jobs (id, user_id, project_id, status, plan, input_path, language)
     VALUES ('mail-j', $1, 'mail-p', 'done', '{}'::jsonb, 'u/p/source.mp4', 'ar')`,
    [ALICE],
  );
  const fromHistory = provider();
  await mail.send({ userId: ALICE, to: "a@example.test", kind: "account", event: "e", reference: "2", letter }, fromHistory.impl);
  check("the language of their last render decides it", fromHistory.calls[0]?.body?.subject === letter.ar.subject, fromHistory.calls[0]?.body?.subject);

  // And a preference they set beats what they happen to have been doing.
  await pool.query(
    "INSERT INTO mail_settings (user_id, language) VALUES ($1, 'en') ON CONFLICT (user_id) DO UPDATE SET language = 'en'",
    [ALICE],
  );
  const chosen = provider();
  await mail.send({ userId: ALICE, to: "a@example.test", kind: "account", event: "e", reference: "3", letter }, chosen.impl);
  check("a preference they set wins over what they have been doing", chosen.calls[0]?.body?.subject === letter.en.subject, chosen.calls[0]?.body?.subject);

  check("every letter this file ships exists in both", [mail.planChanged("Creator"), mail.paymentFailed(), mail.minutesRunOut("free")].every((l) => l.en.subject && l.ar.subject && l.en.body && l.ar.body));
  check(
    "and the Arabic half is Arabic rather than English with a label on it",
    [mail.planChanged("Creator"), mail.paymentFailed(), mail.minutesRunOut("free")].every((l) => /[؀-ۿ]/.test(l.ar.subject) && /[؀-ۿ]/.test(l.ar.body)),
  );
}

// ── Nothing it does can fail the thing that called it ───────────────────────

section("A message that cannot be sent fails nothing else");
{
  await reset();

  const broken = provider(() => new Response("upstream is unwell", { status: 503 }));
  const refused = await mail.send({ userId: ALICE, to: "a@example.test", kind: "account", event: "e", reference: "x", letter }, broken.impl);
  check("a provider that is down comes back as an outcome, not a throw", refused.sent === false && refused.because === "refused", JSON.stringify(refused));
  /*
    And the claim is released. A claim left behind after a failure is a message
    that can never be sent: the retry finds the row, believes it was already
    told, and the customer is never told at all.
  */
  const retry = provider();
  const second = await mail.send({ userId: ALICE, to: "a@example.test", kind: "account", event: "e", reference: "x", letter }, retry.impl);
  check("and the claim is released so it can be tried again", second.sent === true, JSON.stringify(second));

  const exploding = provider(() => {
    throw new TypeError("fetch failed");
  });
  let threw = null;
  let outcome = null;
  try {
    outcome = await mail.send({ userId: BASHIR, to: "b@example.test", kind: "account", event: "e", reference: "y", letter }, exploding.impl);
  } catch (error) {
    threw = error;
  }
  check("a socket that dies does not throw into the caller", threw === null, String(threw));
  check("it is an outcome like every other failure", outcome?.sent === false, JSON.stringify(outcome));

  const noAddress = await mail.send({ userId: ALICE, to: "", kind: "account", event: "e", reference: "z", letter }, provider().impl);
  check("a person with no address is not a crash", noAddress.sent === false && noAddress.because === "no-address");

  const key = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  const unkeyed = provider();
  const quiet = await mail.send({ userId: ALICE, to: "a@example.test", kind: "account", event: "e", reference: "w", letter }, unkeyed.impl);
  process.env.RESEND_API_KEY = key;
  check("a deployment with no key sends nothing", quiet.sent === false && quiet.because === "not-configured", JSON.stringify(quiet));
  check("and makes no request at all", unkeyed.calls.length === 0);
  /*
    And claims nothing. A claim written before the key was checked would mean
    that the day somebody sets the key, every message this deployment has ever
    declined to send is already marked as told.
  */
  const claimed = await pool.query("SELECT 1 FROM mail_sends WHERE user_id = $1 AND reference = 'w'", [ALICE]);
  check("nor claims a send it did not make", claimed.rows.length === 0, `${claimed.rows.length} rows`);
}

// ── What is on the wire ─────────────────────────────────────────────────────

section("What actually goes to the provider");
{
  await reset();
  const seen = provider();
  await mail.send({ userId: ALICE, to: "a@example.test", kind: "account", event: "e", reference: "1", letter }, seen.impl);
  const call = seen.calls[0];
  check("it goes to the provider's own endpoint over https", call.url.startsWith("https://api.resend.com/"), call.url);
  check("with the key in a header rather than a query string", String(call.headers.Authorization ?? "").includes(KEY) && !call.url.includes(KEY));
  check("one recipient, and only the one asked for", JSON.stringify(call.body.to) === JSON.stringify(["a@example.test"]));
  check("plain text, because a receipt does not need a designer", typeof call.body.text === "string" && !("html" in call.body));
  check("and no unsubscribe line on an account message", !/unsubscribe|إيقاف رسائل/i.test(call.body.text), call.body.text);
}

// ── The wiring ──────────────────────────────────────────────────────────────

section("And the one place that sends today actually calls it");
{
  const billing = readFileSync(path.join(repoRoot, "artifacts/api-server/src/routes/billing.ts"), "utf8");
  check("a payment that changed a plan tells the person", /send\(\{/.test(billing) && /planChanged/.test(billing));
  check("and a declined card gets its own letter", /paymentFailed/.test(billing));
  /*
    Keyed on the event id, which is the same key the rest of this handler uses
    to absorb a redelivery. Anything else — the plan, the user — and a second
    delivery of the same event is a second email.
  */
  check(
    "keyed on the event, so a redelivered webhook does not send a second copy",
    /reference:\s*eventId/.test(billing),
    "a redelivery is the ordinary case for this endpoint, not the exotic one",
  );
  /*
    Order, not presence, and measured from the *call* rather than the import at
    the top of the file. A message sent before the plan is written is a customer
    told about a change that a later failure then undoes.
  */
  check(
    "and it is sent after the plan is applied, not instead of applying it",
    billing.indexOf("await setPlan(") < billing.lastIndexOf("planChanged("),
  );
}


// ── The one somebody is actually waiting for ────────────────────────────────

section("A render finishes, and the person who asked for it is somewhere else");

{
  /*
    This is the letter the mail layer was missing, and the reason it moved out
    of the API server. A render takes minutes, so whoever asked for it is — by
    design, not by accident — not looking when it lands. Until now the only way
    to find out was to have left the tab open, which is the opposite of what a
    queue is for.
  */
  const ready = mail.renderFinished("Thursday show", "p-1", 92);
  check("it names the project, so a person with three knows which", ready.en.subject.includes("Thursday show") && ready.ar.subject.includes("Thursday show"));
  check("and carries one link to it", ready.en.body.includes("/project/p-1") && ready.ar.body.includes("/project/p-1"));
  check("and says how long the result is", /92/.test(ready.en.body) && /92/.test(ready.ar.body));
  // Not the render notes: those are long, they are in the conversation, and an
  // email that reproduces them is an email nobody finishes.
  check("and does not try to be the conversation", ready.en.body.length < 420 && ready.ar.body.length < 420);
  const unmeasured = mail.renderFinished("A raw take", "p-2", null);
  check("a render whose length was never measured still sends", unmeasured.en.subject.length > 0);
  check("without inventing one", !/\bnull\b|NaN|undefined/.test(unmeasured.en.body + unmeasured.ar.body));

  const failed = mail.renderFailed("Thursday show", "p-1", "ffmpeg ran out of memory");
  // The first question anybody has, answered before they ask it — this is the
  // sentence that stops a support conversation being opened.
  check("a failure says outright that nothing was charged", /not been charged/i.test(failed.en.body) && /لم يُحتسب/.test(failed.ar.body));
  check("and that their video is untouched", /untouched/i.test(failed.en.body) && /كما هو/.test(failed.ar.body));
  // Quoted rather than paraphrased: it comes from ffmpeg or from
  // infrastructure, in English, and inventing an Arabic reason we did not write
  // would be a different claim about what went wrong.
  check("and quotes the reason it was given", failed.en.body.includes("ffmpeg ran out of memory") && failed.ar.body.includes("ffmpeg ran out of memory"));
  check("both letters exist in both languages", [ready, failed, unmeasured].every((l) => l.en.subject && l.ar.subject && l.en.body && l.ar.body));
  check("and the Arabic is Arabic", [ready, failed].every((l) => /[؀-ۿ]/.test(l.ar.subject) && /[؀-ۿ]/.test(l.ar.body)));
}

section("And the worker is what sends it, because it is what knows");

{
  const worker = readFileSync(path.join(repoRoot, "artifacts/worker/src/mail.ts"), "utf8");
  const index = readFileSync(path.join(repoRoot, "artifacts/worker/src/index.ts"), "utf8");

  // One deduplication table, one provider, one language rule. A second sender
  // in the worker would be two copies of "have we already told them", which is
  // the one question `mail_sends` exists to answer.
  check("it sends through the shared package rather than its own copy", /from "@workspace\/mail"/.test(worker) && !/api\.resend\.com/.test(worker));
  check("as an account message, not as news", /kind: "account"/.test(worker));
  // Somebody who unsubscribed from updates has not asked to stop being told
  // that the thing they paid for is finished.
  check("so an unsubscribe cannot silence it", !/kind: "news"/.test(worker));
  // The job id, so a worker that restarts mid-loop finds the claim taken.
  check("keyed on the job, so a restart does not send it twice", /reference: string/.test(worker) && /jobId/.test(worker));

  check("the finished render is reported", /tellThemTheEditIsReady\(\{/.test(index));
  // Source order: the job is marked done before anybody is told, so a crash
  // between the two loses the letter and not the render.
  check("after the job is written, never before", index.indexOf('status: "done"') < index.indexOf("tellThemTheEditIsReady({"));
  check("and a failure only once it is final", index.indexOf("if (!willRetry) {") < index.indexOf("tellThemItDidNotFinish({"));
  // A mail provider having a bad minute must not turn a completed render into a
  // retried one. Three other things on this same path are written under that
  // rule already.
  check("and neither can throw out of the render path", /catch \(error\) \{[\s\S]{0,200}could not tell them about a render/.test(worker));
  check("the package is told where to log, once, at startup", /mailLogsTo\(logger\);/.test(index));

  // The address, which is the thing the billing webhook never needed: Freemius
  // hands the email over, and the worker has a user id and nothing else.
  const migration = readFileSync(path.join(repoRoot, "lib/db/migrations/0042_a_way_to_reach_them.sql"), "utf8");
  check("there is a way to turn a user id into an address", /create or replace function public\.email_for_user/.test(migration));
  check("with its owner's rights and a fixed search path", /security definer[\s\S]{0,60}set search_path = ''/.test(migration));
  // Supabase grants EXECUTE on every new public function to the PostgREST roles
  // through ALTER DEFAULT PRIVILEGES, and that grant survives a revoke from
  // PUBLIC. Without these two lines this is an email-address oracle behind the
  // anon key.
  check("revoked from the PostgREST roles by name", /from anon/.test(migration) && /from authenticated/.test(migration));
  check("and granted only to the role the server connects as", /grant execute on function public\.email_for_user\(uuid\) to editly_app/.test(migration));
}

section("And the deploy knows the worker sends mail now");

{
  const workflow = readFileSync(path.join(repoRoot, ".github/workflows/deploy-worker.yml"), "utf8");
  check("the mail key reaches the worker", /RESEND_API_KEY: \$\{\{ secrets\.RESEND_API_KEY \}\}/.test(workflow));
  check("and the sender address with it", /MAIL_FROM/.test(workflow));
  // The paths filter moved out of the trigger and into a step when the deploy
  // started waiting for Checks — `workflow_run` is the only trigger that waits
  // for another workflow, and it cannot filter on paths. Same list, read from
  // where it now lives.
  check("and a change in the mail package redeploys it", /PATHS="[^"]*lib\/mail\//.test(workflow));
  const fly = readFileSync(path.join(repoRoot, "artifacts/worker/fly.toml"), "utf8");
  check("and the links point at the app", /APP_ORIGIN = "https:\/\/app\.editlyai\.io"/.test(fly));
}

await pool.end();
await rm(buildDir, { recursive: true, force: true });
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("The product can write to the people using it, once, in their language.");
