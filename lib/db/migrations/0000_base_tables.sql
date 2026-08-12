-- The tables everything else here is a change to.
--
-- Written after the fact, on 12 August, and that is the point of it.
--
-- These four tables were created with `drizzle-kit push` and then given their
-- ownership columns and row-level security through the Supabase console. Both
-- are reasonable ways to start, and both left the repository unable to answer
-- the only question that matters when a database goes wrong: what is this
-- supposed to look like? Migration 0001 opened with `alter table
-- public.projects` against a table no file in this repository had ever created.
--
-- The cost of that arrived on 12 August. Five migrations had been written and
-- committed and never applied to production; the schema drifted for two days
-- while every query failed, and there was no single place that said what the
-- schema was, so there was nothing to compare against and nothing to run. This
-- file closes that: from here, an empty Postgres plus every file in this
-- directory, in order, is the database — and `tools/schema-test.mjs` proves it
-- by building one and diffing it against what the code declares.
--
-- It is a reconstruction, not a record. What it creates is the shape as it
-- stood immediately before 0001, so that every later file still applies on top
-- of it and still means what it meant. That includes `subscriptions.plan`
-- defaulting to 'starter', which is a mistake — 0007 is the migration that
-- corrects it, and writing 'free' here would quietly turn that file into a
-- no-op and lose the reason it exists.

-- ── projects ────────────────────────────────────────────────────────────────
create table if not exists public.projects (
  id                text primary key,
  user_id           uuid not null,
  title             text not null,
  status            text not null default 'ready',
  thumbnail_url     text,
  video_url         text,
  edited_video_url  text,
  duration          real,
  platform          text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists projects_user_id_created_idx
  on public.projects (user_id, created_at);

-- ── messages ────────────────────────────────────────────────────────────────
create table if not exists public.messages (
  id          text primary key,
  user_id     uuid not null,
  project_id  text not null references public.projects(id) on delete cascade,
  role        text not null,
  content     text not null,
  created_at  timestamptz not null default now()
);

create index if not exists messages_user_project_idx
  on public.messages (user_id, project_id, created_at);

-- ── exports ─────────────────────────────────────────────────────────────────
create table if not exists public.exports (
  id            text primary key,
  user_id       uuid not null,
  project_id    text not null references public.projects(id) on delete cascade,
  status        text not null default 'pending',
  platform      text not null,
  download_url  text,
  steps         jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists exports_user_project_idx
  on public.exports (user_id, project_id, created_at);

-- ── subscriptions ───────────────────────────────────────────────────────────
-- One row per user. See the note above about the default.
create table if not exists public.subscriptions (
  user_id     uuid primary key,
  plan        text not null default 'starter',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ── Ownership ───────────────────────────────────────────────────────────────
-- Nothing is reachable except through the API, which filters every query on
-- user_id. Row-level security is the backstop for the day a query forgets:
-- with no policy granting anything, a leak requires a deliberate act rather
-- than an omission. The API connects as a role that is allowed through.
alter table public.projects      enable row level security;
alter table public.messages      enable row level security;
alter table public.exports       enable row level security;
alter table public.subscriptions enable row level security;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'editly_app') then
    -- NOLOGIN: this is a privilege bundle the connecting role inherits, never
    -- an account anyone signs in as.
    create role editly_app nologin;
  end if;
end $$;

do $$
declare
  t text;
begin
  foreach t in array array['projects', 'messages', 'exports', 'subscriptions'] loop
    execute format('drop policy if exists %I on public.%I', t || '_app_role', t);
    execute format(
      'create policy %I on public.%I for all to editly_app using (true) with check (true)',
      t || '_app_role', t);
    execute format('grant select, insert, update, delete on public.%I to editly_app', t);
  end loop;
end $$;
