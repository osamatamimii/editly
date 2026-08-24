-- The console can act, and every act leaves a row.
--
-- This table is not bookkeeping around the actions; for one of them it *is*
-- the action. Granting somebody minutes is stored here and nowhere else, and
-- the meter reads it — so there is no code path that can grant minutes without
-- also writing down who granted them, to whom, and why. A design where the
-- grant lives in one table and the reason in another is a design where the
-- reason eventually stops being written.
--
-- No foreign keys, deliberately. An audit row has to outlive its subject: a
-- job gets swept, an account gets deleted, and the record of what was done to
-- them is exactly the thing that must survive that. A cascade here would erase
-- the history at the moment it becomes most worth having.
CREATE TABLE IF NOT EXISTS admin_actions (
  id uuid PRIMARY KEY,
  -- Who did it. Not nullable: an action with no actor is not an audit row.
  actor_user_id uuid NOT NULL,
  -- What was done: requeue_job, grant_minutes, set_plan, set_suspended.
  action text NOT NULL,
  -- Who or what it was done to. One of these is set, never both.
  subject_user_id uuid,
  subject_job_id text,
  -- Why, in words, required by the API for every action that changes what
  -- somebody is entitled to. "Because I could" is at least honest; an empty
  -- string is not an explanation and the route refuses it.
  reason text NOT NULL,
  -- The action's own numbers — seconds granted, the plan set, and so on.
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The meter reads grants for the current month, per user. Without this it is
-- a sequential scan on every render start for every customer.
CREATE INDEX IF NOT EXISTS admin_actions_grants_idx
  ON admin_actions (subject_user_id, created_at)
  WHERE action = 'grant_minutes';

-- Every table in `public` is reachable by PostgREST with the anon key that
-- ships in the browser bundle, so this one gets row-level security like the
-- rest — and then a policy naming the role the server actually connects as.
--
-- The first version of this migration enabled RLS and stopped there, on the
-- theory that "no policy" means "only the application gets in". It does not:
-- `editly_app` is not the table's owner and does not bypass RLS, so a table
-- with RLS and no policy is a table the *application* cannot read either —
-- and a SELECT under a policy that matches nothing is not an error, it is
-- zero rows. The audit log would have looked permanently empty. The schema
-- suite caught it, which is exactly the rule it was written for after four
-- migrations shipped policies naming the wrong role.
--
-- The policy is unconditional for that role on purpose: these rows are not
-- per-user data with an owner to compare against. What decides who may read
-- them is the ADMIN_USER_IDS allowlist in the application, one layer up, and
-- pretending otherwise here would be a second gate that looks like security
-- and enforces nothing.
ALTER TABLE admin_actions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'admin_actions' AND policyname = 'admin_actions_app'
  ) THEN
    EXECUTE 'CREATE POLICY admin_actions_app ON admin_actions FOR ALL TO editly_app USING (true) WITH CHECK (true)';
  END IF;
END $$;

GRANT SELECT, INSERT ON admin_actions TO editly_app;

-- Suspension: stops new renders, deletes nothing.
--
-- A suspended account keeps every byte, every project and every clip, and can
-- still sign in and look at them. The only thing it cannot do is start work
-- that costs us money. Deleting somebody's footage is not a moderation action,
-- it is destruction of their property, and the console is not allowed to do
-- it — see admin-console.md.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS suspended_at timestamptz;
