-- The parts of Supabase the migrations lean on, for a Postgres that is not one.
--
-- Three migrations touch things a managed Supabase project provides and a plain
-- Postgres does not: `storage.buckets` and `storage.objects`, `auth.uid()`, and
-- the roles Supabase defines. Running the migrations anywhere else — a laptop,
-- a CI runner, the scratch database `tools/schema-test.mjs` builds — fails on
-- the first of them without these.
--
-- **This is not a Supabase.** It creates the names, not the behaviour: a bucket
-- row here enforces nothing, and `auth.uid()` returns null because there is no
-- session to ask. Nothing that depends on what these *do* can be tested against
-- them, and nothing tries: the storage policies are checked against the real
-- thing by `tools/storage-isolation.browser.js`, pasted into a browser on the
-- deployed app. What this makes possible is testing the shape of the public
-- tables, which is the part that lives in this repository.
--
-- It lives here rather than inside a test file because two things need it —
-- the schema suite and CI — and a copy in each is how they drift apart.
--
-- Applied *before* the migrations, and never against a real Supabase project,
-- where every one of these already exists and is not a stub.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'editly_app') THEN CREATE ROLE editly_app; END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS storage;

-- Null, because there is no request and therefore nobody to be. Every policy
-- that calls this evaluates to false here, which is the honest answer.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;

CREATE TABLE IF NOT EXISTS storage.buckets (
  id                 text PRIMARY KEY,
  name               text,
  public             boolean,
  file_size_limit    bigint,
  allowed_mime_types text[]
);

CREATE TABLE IF NOT EXISTS storage.objects (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text,
  name      text,
  owner     uuid
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[]
  LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;

-- `auth.users`, because one query in the API reads it directly.
--
-- The billing webhook maps a payment to an account by the address it was paid
-- with, and Supabase owns the identity table — so `billing.ts` runs one narrow
-- `select id from auth.users where lower(email) = $1`. Without a table of that
-- name every webhook check here would fail on a missing relation rather than on
-- anything about billing. Two columns is all that query touches.
CREATE TABLE IF NOT EXISTS auth.users (
  id    uuid PRIMARY KEY,
  email text
);

-- Two more columns, added when the admin console started asking auth.users
-- when an account was made and when it was last used. Written as ALTERs rather
-- than folded into the CREATE above so a database standing since before this
-- line gains them too — a shim that only helps a fresh database is a shim that
-- passes locally and fails in CI's cache.
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS last_sign_in_at timestamptz;
