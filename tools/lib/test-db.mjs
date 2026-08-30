/**
 * Where the test database is, decided once for every suite that needs one.
 *
 * Four suites each carried their own default and they had drifted into two
 * different answers: isolation-test said port 5432 with a password, and
 * queue-, worker- and schema-test said 5433 without one. CI sets DATABASE_URL
 * explicitly, so the drift was invisible there and only bit someone running a
 * suite by hand — which is exactly when a test is least likely to be trusted
 * and most likely to be deleted.
 *
 * Worse, one of those defaults could never have worked. schema-test computed a
 * `DATABASE_URL` const with a fallback and then imported the module under test,
 * which reads `process.env.DATABASE_URL` itself, at import time. The suite's
 * fallback was never visible to the thing being tested: the line looked like a
 * default and was decoration, and the suite could only ever run where the
 * environment already had the variable set.
 *
 * So this resolves the URL and *publishes it into the environment*, which is
 * the only form a default can take when the code under test reads the
 * environment directly. When DATABASE_URL is already set it is left exactly
 * alone — CI stays in charge of its own database.
 */
import { createConnection } from "node:net";

/**
 * The candidates, in order. Both are "a local postgres holding editly_test";
 * they differ only in how a given machine happened to bring it up. Probing is
 * better than picking one, because the failure it prevents — "connection
 * refused" from a suite that is otherwise correct — reads as a broken test.
 */
const CANDIDATES = [
  "postgresql://postgres:postgres@127.0.0.1:5432/editly_test",
  "postgresql://postgres@127.0.0.1:5433/editly_test",
];

/** Whether something is listening, which is all we can ask before connecting. */
function listening(port, host, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    const done = (answer) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/**
 * Resolves the test database URL, sets `process.env.DATABASE_URL` to it, and
 * returns it. Safe to call more than once.
 */
export async function resolveTestDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const candidate of CANDIDATES) {
    const { port, hostname } = new URL(candidate);
    if (await listening(Number(port), hostname)) {
      process.env.DATABASE_URL = candidate;
      return candidate;
    }
  }
  // Nothing answered. Return the first candidate so the caller fails with
  // postgres's own connection error, which names a port and is actionable,
  // rather than with an undefined-variable error, which is not.
  process.env.DATABASE_URL = CANDIDATES[0];
  return CANDIDATES[0];
}
