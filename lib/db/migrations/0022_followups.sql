-- The request that arrived while a render was running.
--
-- The chat's reply to that situation has said, from the day the one-prompt
-- door opened: "there's a render already going for this project — I'll fold
-- this in once it finishes." Until this table, nothing folded anything in.
-- The sentence was accepted, the refusal was worded warmly, and the request
-- was gone. A promise the product speaks and does not keep is worse than a
-- refusal, because the person waits for something that was never going to
-- happen.
--
-- One row per project, last request wins. Someone who asks for three changes
-- while a render runs is describing what they want *now*, three times, with
-- increasing precision — the planner turns each sentence into a complete
-- plan, so the newest plan is the whole current wish, not an increment to
-- stack on the earlier ones. Replacing is honest; queuing three renders
-- behind one would spend their minutes on drafts they already superseded.
--
-- The follow-up is started lazily, by the render-status poll, the moment it
-- sees the active job settle. The worker never reads this table: deciding
-- whether a render may start is plan policy (allowance, watermark, ceilings),
-- and that lives in the API beside the other two doors.
CREATE TABLE IF NOT EXISTS render_followups (
  -- One pending wish per project. Text, matching projects.id.
  project_id  text PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL,

  -- The operations the planner produced from the sentence, verbatim. Policy
  -- is applied when the follow-up *starts*, not when it is stored — the
  -- month's balance at start time is the truth that matters.
  operations  jsonb NOT NULL,

  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE render_followups IS
  'A plan requested while a render was already running, started automatically when that render settles. One per project; the newest request replaces the older, because each sentence is the whole current wish.';

-- The same access shape as every other application table (see 0019): RLS on,
-- not forced, a policy naming the role the app actually connects as, and the
-- four grants that make the policy reachable.
ALTER TABLE public.render_followups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS render_followups_app_role ON public.render_followups;
CREATE POLICY render_followups_app_role ON public.render_followups
  FOR ALL TO editly_app USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.render_followups TO editly_app;
