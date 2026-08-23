-- The pieces a long video was cut into.
--
-- Until this table, a render produced exactly one file and the project row
-- pointed at it. "Give me three clips from this talk" therefore had nowhere
-- to put its answer: the second clip would overwrite the pointer to the
-- first. A clip is its own artifact — someone posts each one separately, on
-- different days, to different platforms — so each gets a row with its own
-- storage path and its own stretch of the source, and the project keeps
-- pointing at whatever the latest whole-video render made.
--
-- `job_id` records which render produced the clip but carries no foreign
-- key on purpose. The FK allowlist in schema-test exists because every
-- cascade is a policy decision: jobs rows are the billing record and nothing
-- may cascade onto them, and a clip should not vanish because some future
-- cleanup pruned old job rows — the file it names still exists and still
-- belongs to the person. The one cascade that is right is the project's:
-- delete the project and its clips go with it, exactly as its messages and
-- its library do (the storage objects are removed by the same sweep that
-- removes the project's other objects).
CREATE TABLE IF NOT EXISTS clips (
  id             text PRIMARY KEY,
  project_id     text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL,

  -- Which render produced it. A record, not a reference — see above.
  job_id         text NOT NULL,

  -- 1-based position in the set the render produced, in source order.
  idx            integer NOT NULL,

  -- The stretch of the *source* this clip came from, seconds on the source
  -- clock. What a person needs to answer "which part is this one?".
  start_seconds  real NOT NULL,
  end_seconds    real NOT NULL,

  -- `<userId>/<projectId>/...` — the same folder shape as every other object,
  -- so the browser signs its own playback URL with its own session.
  output_path    text NOT NULL,

  -- Measured from the finished file, like jobs.output_seconds.
  output_seconds real,

  -- The one line the worker wrote about this clip ("the speech runs densest
  -- here"), shown under it in the list.
  note           text,

  created_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE clips IS
  'Individual pieces cut from one source by a clips render. Each is its own storage object with its own stretch of the source; the project row keeps pointing at whole-video renders only.';

-- The cascade must not be a table scan when a project with many clips goes.
CREATE INDEX IF NOT EXISTS clips_project_id_idx ON clips (project_id);

-- The same access shape as every other application table (see 0019/0022):
-- RLS on, not forced, a policy naming the role the app actually connects as,
-- and the grants that make the policy reachable. The worker connects as the
-- table owner and is not forced, so its inserts pass without a policy.
ALTER TABLE public.clips ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS clips_app_role ON public.clips;
CREATE POLICY clips_app_role ON public.clips
  FOR ALL TO editly_app USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.clips TO editly_app;
