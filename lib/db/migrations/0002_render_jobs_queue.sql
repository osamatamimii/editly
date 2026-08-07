-- Phase 3: the render queue.
--
-- Applied to the Supabase project on 2026-08-07.
--
-- Postgres is the queue rather than Redis or SQS. The database already exists,
-- FOR UPDATE SKIP LOCKED gives exactly the claim semantics a worker pool needs,
-- and one fewer provider is one fewer bill and one fewer thing to reason about.
create table if not exists public.jobs (
  id text primary key,
  user_id uuid not null,
  project_id text not null references public.projects(id) on delete cascade,

  status text not null default 'queued',
  plan jsonb not null,

  input_path text not null,
  output_path text,

  progress integer not null default 0,
  stage text,
  error text,

  attempts integer not null default 0,
  max_attempts integer not null default 3,

  locked_at timestamptz,
  locked_by text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create index if not exists jobs_user_project_idx on public.jobs (user_id, project_id, created_at);
-- The claim query scans queued rows oldest-first; this is the index it uses.
create index if not exists jobs_queue_idx on public.jobs (status, created_at);

-- Same posture as every other table: rows are reachable only through the API,
-- which filters on user_id, and nothing is readable anonymously.
alter table public.jobs enable row level security;

drop policy if exists "jobs_app_role" on public.jobs;
create policy "jobs_app_role" on public.jobs
  for all to editly_app
  using (true) with check (true);

grant select, insert, update, delete on public.jobs to editly_app;
