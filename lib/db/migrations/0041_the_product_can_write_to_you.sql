-- Two tables so the product can send an email, and send it exactly once.
--
-- Until now it could not send one at all: no SMTP, no provider, no template,
-- nothing. Every moment where a decision gets made was silent — a card
-- declined, a plan changed, a month's minutes used up — and a silent card
-- failure is a subscription that has already been lost by the time anybody
-- notices.
--
-- ## `mail_sends` is a lock, not a history
--
-- An email cannot be taken back. A webhook Freemius redelivers, a process that
-- restarts halfway through a loop, a retry after a timeout: each of those is
-- two identical messages to somebody who asked for none, on a sending domain
-- with no reputation to spend. So the send is *claimed* here before the request
-- is made, under a unique key of (user, event, reference), and the insert is
-- the lock. Reading first and writing after leaves a window that two processes
-- walk through together, which is the failure this table exists to prevent.
--
-- `sent_at` stays null between the claim and the answer. A row with a null
-- `sent_at` still stops a second copy, which is the property that matters; the
-- column is there so that "we tried and the provider refused" can be told from
-- "it went".
--
-- ## `mail_settings` separates two things that must never be merged
--
-- A receipt is not an advertisement. Somebody who unsubscribes from news has
-- not asked to stop being told their card was declined, and a product that
-- treats one flag as covering both is either sending marketing to people who
-- said no or withholding account notices from them. Separating the two later
-- is a migration and an apology; separating them now is one column.
--
-- `token` is what an unsubscribe link carries, so the link identifies a
-- preference and not a person: it cannot be turned back into an account id, an
-- email or a session, which matters because that URL is going to sit in
-- somebody's inbox and in every mail scanner between here and there.
--
-- `language` is the person's own choice and is deliberately nullable. Null does
-- not mean English: it means nobody has asked them, and the code then reads the
-- language they have actually been rendering in. A default of 'en' here would
-- turn "unknown" into "English" in the one place where the difference is the
-- whole feature.

CREATE TABLE IF NOT EXISTS mail_sends (
  user_id     uuid        NOT NULL,
  -- Stable names, because they are half of a uniqueness key. Renaming one is
  -- not a refactor: it is a promise that everybody gets the old message again.
  event       text        NOT NULL,
  reference   text        NOT NULL,
  kind        text        NOT NULL DEFAULT 'account',
  claimed_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz,
  PRIMARY KEY (user_id, event, reference)
);

CREATE TABLE IF NOT EXISTS mail_settings (
  user_id      uuid        PRIMARY KEY,
  -- Null is "not asked", not "English". See above.
  language     text,
  news_opt_out boolean     NOT NULL DEFAULT false,
  -- `gen_random_uuid` rather than `gen_random_bytes`: the first is in Postgres
  -- itself and the second needs pgcrypto, which the managed database happens to
  -- have and a plain one does not. A migration that only runs on one of the two
  -- makes the test database and production different schemas.
  token        text        NOT NULL DEFAULT replace(gen_random_uuid()::text, '-', ''),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- The link has to find the row from the token alone, and only ever one row.
CREATE UNIQUE INDEX IF NOT EXISTS mail_settings_token_key ON mail_settings (token);

-- What has been sent to one person, which is the only question anybody asks of
-- this table other than the uniqueness check the primary key already answers.
CREATE INDEX IF NOT EXISTS mail_sends_user_idx ON mail_sends (user_id, claimed_at DESC);

-- Every table in `public` is reachable through PostgREST with the anon key that
-- ships inside the browser bundle. Both of these hold a mapping from a person
-- to what they have been told, and one of them holds a token that turns off
-- their mail, so neither may be readable by that key.
--
-- And the policy names `editly_app`, which is the role the API actually
-- connects as. Four migrations in a row once shipped a policy naming `postgres`
-- instead, and the result was not a loud failure: writes returned 500 and
-- *reads returned an empty list*, because a SELECT under a policy that does not
-- match is not an error, it is no rows. A mail ledger that reads as empty is a
-- ledger that permits a second copy of every message.
alter table public.mail_sends enable row level security;
drop policy if exists "mail_sends_app_role" on public.mail_sends;
create policy "mail_sends_app_role" on public.mail_sends
  for all to editly_app
  using (true) with check (true);
grant select, insert, update, delete on public.mail_sends to editly_app;

alter table public.mail_settings enable row level security;
drop policy if exists "mail_settings_app_role" on public.mail_settings;
create policy "mail_settings_app_role" on public.mail_settings
  for all to editly_app
  using (true) with check (true);
grant select, insert, update, delete on public.mail_settings to editly_app;
