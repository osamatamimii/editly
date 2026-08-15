-- Is a worker running at all?
--
-- Until now the product answered this by inference: a job that has sat queued
-- for five minutes with nobody holding a lock means nobody is listening. That
-- is a good heuristic and it has two holes that matter.
--
-- It cannot say anything for five minutes, and it cannot say anything at all
-- when the queue is empty. Which is exactly the moment somebody needs an
-- answer: you have just deployed the worker for the first time, there is
-- nothing queued, and the only way to find out whether it worked is to upload a
-- video and wait. A deployment you cannot verify from the product is a
-- deployment you verify by guessing.
--
-- So the worker says so. One row per running copy, refreshed as it polls, and
-- the two provider names it resolved at startup — because "why are my captions
-- missing" is otherwise a question only a log line can answer, and only for
-- whoever has access to the logs.
--
-- No foreign keys and no history: this table is a fact about right now. A
-- worker that stops writing stops being online, and the row it leaves behind is
-- the timestamp that says when it went.

CREATE TABLE IF NOT EXISTS public.worker_heartbeats (
  worker_id      text PRIMARY KEY,
  started_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  -- The name of the model, never a key. Null means the worker came up without
  -- one and will say so in the render notes rather than silently doing less.
  transcription  text,
  vision         text
);

COMMENT ON TABLE public.worker_heartbeats IS
  'One row per running worker, refreshed as it polls. Presence answers "is anything listening", which the queue alone cannot when it is empty.';

CREATE INDEX IF NOT EXISTS worker_heartbeats_last_seen_idx
  ON public.worker_heartbeats (last_seen_at DESC);

ALTER TABLE public.worker_heartbeats ENABLE ROW LEVEL SECURITY;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'editly_app') then
    create role editly_app nologin;
  end if;
end $$;

DROP POLICY IF EXISTS worker_heartbeats_app_role ON public.worker_heartbeats;
CREATE POLICY worker_heartbeats_app_role ON public.worker_heartbeats
  FOR ALL TO editly_app USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.worker_heartbeats TO editly_app;
