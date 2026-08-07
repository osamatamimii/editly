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

export const db = drizzle(pool, { schema });

export * from "./schema";
