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
    And the reason it does not, today, is stronger than the preference: there is
    no unsubscribe endpoint yet, so marketing is refused for everybody. That
    flag is the point of the split existing on day one — the alternative is a
    newsletter that ships before its own unsubscribe link, which is unlawful in
    most of the places this product will be read.
  */
  check("marketing is refused outright until there is a way out of it", mail.UNSUBSCRIBE_ROUTE_EXISTS === false);
  const fresh = provider();
  const toSomebodyNew = await mail.send({ userId: BASHIR, to: "b@example.test", kind: "news", event: "newsletter", reference: "2026-09", letter }, fresh.impl);
  check("even for somebody who never unsubscribed", toSomebodyNew.sent === false && fresh.calls.length === 0, JSON.stringify(toSomebodyNew));
  check("and the reason names the missing door, not a preference they never set", toSomebodyNew.because === "no-way-out", toSomebodyNew.because);
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
  const { readFileSync } = await import("node:fs");
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

await pool.end();
await rm(buildDir, { recursive: true, force: true });
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("The product can write to the people using it, once, in their language.");
