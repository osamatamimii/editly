-- People who asked to be told when it opens.
--
-- Keyed by the address rather than a generated id, because the only question
-- this table answers is "is this person on the list" and a surrogate key would
-- let the same person be on it four times. Signing up twice is therefore not
-- an error and not a duplicate: it is the same row, and the route says so
-- rather than failing at somebody who clicked twice.
--
-- Three columns on purpose. A waiting list that asks for a name, a company and
-- a use-case converts worse and gives us nothing we can act on before there is
-- a product to show; the address is the whole ask.
CREATE TABLE IF NOT EXISTS waitlist (
  -- Already lowercased and trimmed by the route. Normalising on read means
  -- every reader has to remember to, and the one that forgets makes a
  -- duplicate that the primary key was supposed to prevent.
  email      text PRIMARY KEY,

  -- Which page they came from. The landing page and the waiting-list domain
  -- are two different promises; if one converts and the other does not, this
  -- column is the only place that will show.
  source     text,

  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE waitlist IS
  'Addresses that asked to be told when Editly opens. Keyed by the address itself, so signing up twice is the same row rather than an error.';

-- The console reads this newest-first, and only ever newest-first.
CREATE INDEX IF NOT EXISTS waitlist_created_at_idx ON waitlist (created_at);

-- The same access shape as every other application table (see 0019/0022/0024):
-- RLS on, not forced, a policy naming the role the app connects as, and the
-- grants that make the policy reachable.
--
-- No SELECT for anon or authenticated, and this table matters more than most:
-- it is a list of email addresses, and the endpoint that writes to it is the
-- only public one in the product. Writing is public; reading is the console's
-- alone.
ALTER TABLE public.waitlist ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS waitlist_app_role ON public.waitlist;
CREATE POLICY waitlist_app_role ON public.waitlist
  FOR ALL TO editly_app USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON public.waitlist TO editly_app;
