-- A project can hold more than one file.
--
-- Until now a job carried exactly two paths: `input_path`, the one video being
-- edited, and an optional `reference_path` whose only job was to be *looked at*
-- for style. Neither of them can be composited into the output, and there was
-- nowhere at all to put a logo, a photo, a b-roll clip, or the six screenshots
-- somebody wants cut into the middle of their talking head.
--
-- The upload field said so out loud: it accepted `video/mp4, video/quicktime,
-- video/webm` and one file at a time.
--
-- This table is the project's library. It is deliberately *not* on the job:
-- assets outlive any single render, and the same logo is used by every export
-- of that project rather than re-uploaded per attempt.

-- `id` and `project_id` are text, not uuid, because `projects.id` and
-- `jobs.id` are text: the ids are generated in the API and stored as strings.
-- A uuid column here would look tidier and would refuse to reference the table
-- it belongs to.
CREATE TABLE IF NOT EXISTS assets (
  id          text PRIMARY KEY,
  project_id  text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL,

  -- The storage object, in the same `<userId>/<projectId>/<name>` shape every
  -- other object uses, so `isOwnedObjectPath` validates it unchanged and a
  -- traversal attempt is unrepresentable rather than merely rejected.
  path        text NOT NULL,

  -- What it is, decided on the server from the bytes, never from the filename
  -- the browser sent. A file called `logo.png` that is really a 4 GB video is
  -- the cheapest way to turn an image overlay into an out-of-memory kill.
  kind        text NOT NULL CHECK (kind IN ('video', 'image', 'audio')),

  -- What the user called it. Shown in the library, never used as a path.
  label       text,

  bytes            bigint  NOT NULL DEFAULT 0,
  duration_seconds real,
  width            integer,
  height           integer,

  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE assets IS
  'Files a project can composite into its output: b-roll, images, logos, music. Distinct from jobs.input_path (the video being edited) and jobs.reference_path (a video only looked at, never shown).';
COMMENT ON COLUMN assets.kind IS
  'Decided server-side from the bytes, not from the filename. Trusting the extension turns an image overlay into an OOM kill.';

-- One object cannot be registered twice. Without this a retried upload leaves
-- two rows pointing at the same bytes, and deleting one orphans the other.
CREATE UNIQUE INDEX IF NOT EXISTS assets_path_key ON assets (path);

-- The library is always read per project, newest first.
CREATE INDEX IF NOT EXISTS assets_project_created_idx ON assets (project_id, created_at DESC);

ALTER TABLE assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE assets FORCE ROW LEVEL SECURITY;

-- Nothing reads this straight from a browser: the API is the only door, and it
-- scopes every query by the signed-in user itself.
DROP POLICY IF EXISTS assets_service_only ON assets;
CREATE POLICY assets_service_only ON assets
  FOR ALL
  USING (current_user = 'postgres' OR pg_has_role(current_user, 'postgres', 'MEMBER'))
  WITH CHECK (current_user = 'postgres' OR pg_has_role(current_user, 'postgres', 'MEMBER'));
