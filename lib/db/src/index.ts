import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

const connectionString = process.env.DATABASE_URL;

// Managed Postgres providers (Supabase, Neon, …) terminate TLS at a pooler that
// presents a certificate for its own hostname, so the default `pg` behaviour of
// verifying against the connection host fails. Enable TLS without hostname
// verification for those hosts; keep plain connections for local development.
const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString);

export const pool = new Pool({
  connectionString,
  ...(isLocal ? {} : { ssl: { rejectUnauthorized: false } }),
  // Serverless functions are short-lived: keep the pool small and fail fast
  // instead of holding idle connections against the pooler's client limit.
  max: 3,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
});

/*
  A pool with no error listener takes the process down.

  `pg` attaches an idle listener to every connection it is holding, and that
  listener re-emits on the pool. `Pool` is an `EventEmitter`, so an `'error'`
  event with nothing listening *throws* — verified against this exact version
  of `pg` — and it is thrown from inside `pg`'s own idle-client handler, where
  no `try` of ours is on the stack. That is an uncaught exception, which ends
  the process. The event is not exotic: it is what a pooler restart, an
  idle-session timeout or a TCP reset looks like from here, and this pool
  churns connections continuously while a render is running.

  So the worker died mid-encode for a connection it was not even using, the job
  sat `running` for half an hour, and it came back with an attempt spent. Node
  postgres' own documentation says this listener is mandatory; it was the one
  thing missing.

  Logged rather than swallowed, and to stderr rather than through a logger this
  package does not have: `lib/db` is imported by the API, the worker and the
  test suites, and a dependency on any one of their loggers would be a cycle.
*/
pool.on("error", (error) => {
  console.error("[db] idle client error", error);
});

export const db = drizzle(pool, { schema });

export * from "./schema";
