-- Somewhere for the serverless functions to agree on how often somebody asked.
--
-- There was no rate limiting anywhere in the API, and the gap is not about
-- traffic. The quota system caps **minutes of finished video**, which is the
-- expensive thing — but it caps nothing else, and two endpoints spend money
-- without producing a minute:
--
--   POST /projects/:id/messages   turns a sentence into an edit plan with a
--                                 paid model call. Nothing limited it. A free
--                                 account could send ten thousand.
--   POST /projects/:id/render     is guarded to one active job per project,
--                                 which a loop that creates ten thousand
--                                 projects walks straight past.
--
-- A limiter has to be shared, and in-process state is not: Vercel runs many
-- short-lived copies of this app, each with its own memory, so a counter in a
-- module variable is a counter per instance and therefore no counter at all.
-- Redis would work and would be a new provider, a new bill, and a new thing to
-- be down. We already talk to Postgres on every authenticated request, and one
-- upsert is cheaper than the model call it is protecting.
--
-- Fixed windows rather than sliding, deliberately. A sliding window needs a
-- row per request; a fixed one needs a row per (person, endpoint) forever. The
-- cost is that somebody can send a full window's worth at the end of one and
-- again at the start of the next — so the limits are set with that doubling
-- already assumed, which is cheaper than the accuracy.
CREATE TABLE IF NOT EXISTS rate_limits (
  -- "<userId>:<name>". One row per person per endpoint, reused forever, so this
  -- table is bounded by users × limited endpoints rather than by requests.
  bucket       text PRIMARY KEY,
  window_start timestamptz NOT NULL DEFAULT now(),
  count        integer NOT NULL DEFAULT 0
);

-- For the sweep that removes rows nobody has touched in a long time. Not
-- required for correctness — a stale row is reset on its next use — but a table
-- that only ever grows is a table somebody discovers in a year.
CREATE INDEX IF NOT EXISTS rate_limits_window_idx ON rate_limits (window_start);

ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limits FORCE ROW LEVEL SECURITY;

-- Nothing reads this from a browser, and knowing how close somebody else is to
-- their limit is not information a client should be able to ask for.
DROP POLICY IF EXISTS rate_limits_service_only ON rate_limits;
CREATE POLICY rate_limits_service_only ON rate_limits
  FOR ALL
  USING (current_user = 'postgres' OR pg_has_role(current_user, 'postgres', 'MEMBER'))
  WITH CHECK (current_user = 'postgres' OR pg_has_role(current_user, 'postgres', 'MEMBER'));
