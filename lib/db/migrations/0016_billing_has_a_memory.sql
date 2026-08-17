-- The webhook remembers what it has already been told.
--
-- `planFromEvent` is written as "what should be true now" rather than "apply
-- this change", and the comment above it argues that target-state writes are
-- naturally idempotent. That is true and it is not enough: **idempotence is not
-- order-independence**, and Freemius retries deliveries.
--
-- The case that costs a paying customer their plan:
--
--   1. They upgrade Creator → Pro.
--   2. Freemius emits `license.created` (Pro) and `license.cancelled` for the
--      superseded Creator licence.
--   3. Our first delivery of the cancellation 500s — any transient database
--      blip; there is no error handling on that path.
--   4. Freemius retries it ten minutes later, after the Pro event has landed.
--   5. `setPlan(userId, "free")` — a blind upsert with nothing to compare
--      against — writes free over Pro.
--
-- They are charged $29 a month, see the free plan's watermark and five-minute
-- allowance, and there is no way back: `PATCH /subscription` refuses upgrades
-- with 402 by design, so only manual intervention or the next renewal webhook
-- restores it. The same outcome arrives from a stale `license.expired` landing
-- after a `license.extended`.
--
-- Two columns and one table fix it, and each answers a different question.

-- Which licence granted the plan this person is on, and as of when.
--
-- With these, a cancellation can be recognised as belonging to a *superseded*
-- licence rather than to the live one, and an event that predates the state we
-- already hold can be recognised as stale rather than as news.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS license_id text;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS plan_source_at timestamptz;

COMMENT ON COLUMN subscriptions.license_id IS
  'The Freemius licence that granted the current plan. A cancellation naming a different licence is a superseded one being cleaned up, not this plan ending.';
COMMENT ON COLUMN subscriptions.plan_source_at IS
  'Timestamp of the event that set the current plan. An event older than this is a retry that lost a race, not news.';

-- Every event we have been handed, whether or not we could act on it.
--
-- This is two things at once, and both are worth having.
--
-- It is the **idempotency key**: a redelivered event is recognised by its own
-- id and does nothing a second time.
--
-- And it is where a payment goes when we cannot match it to anybody. That case
-- is not exotic — paying with a different address than the one you signed up
-- with is the single most common billing support ticket there is — and until
-- now the handler answered 200 (so Freemius never retried), wrote a log line
-- that deliberately excluded the email, and persisted nothing at all. The
-- customer was charged, received the free plan, and support had no record to
-- reconcile from. Now the event is kept, and the moment an account with that
-- address appears it can be claimed.
CREATE TABLE IF NOT EXISTS billing_events (
  -- Freemius's own id for the event. Ours only if they sent none, in which case
  -- it is derived from the body so a byte-identical redelivery still collides.
  event_id      text PRIMARY KEY,
  type          text NOT NULL,
  email         text,
  license_id    text,
  -- What the event means for access: a plan key, or NULL for events we
  -- recognise but do not act on.
  plan          text,
  -- When it happened according to Freemius, not when it reached us.
  event_at      timestamptz,
  received_at   timestamptz NOT NULL DEFAULT now(),
  -- The account it was applied to, and when. NULL user_id with a plan set is a
  -- payment waiting for its owner to exist.
  user_id       uuid,
  applied_at    timestamptz,
  -- Why it was not applied, when it was not. Written for whoever is reading
  -- this table because a customer is on the phone.
  outcome       text
);

-- The lookup that claims a payment for an account that did not exist yet.
CREATE INDEX IF NOT EXISTS billing_events_email_idx
  ON billing_events (email)
  WHERE user_id IS NULL AND plan IS NOT NULL;

ALTER TABLE billing_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_events FORCE ROW LEVEL SECURITY;

-- Nobody reads this from a browser. It holds email addresses and what people
-- pay, and the only legitimate readers are the API's own role and whoever is
-- looking at the database directly.
DROP POLICY IF EXISTS billing_events_service_only ON billing_events;
CREATE POLICY billing_events_service_only ON billing_events
  FOR ALL
  USING (current_user = 'postgres' OR pg_has_role(current_user, 'postgres', 'MEMBER'))
  WITH CHECK (current_user = 'postgres' OR pg_has_role(current_user, 'postgres', 'MEMBER'));
