-- Connected accounts, and posts scheduled to them.
--
-- A finished edit is not the end of the job. The person still has to download
-- it, open five apps, upload it five times and write the caption five times,
-- which is most of the work they were trying to avoid and all of the reason a
-- good clip sits in a folder for a week.
--
-- Two tables, and the split is the design. An *account* is a standing
-- connection and there can be several per platform, because people run more
-- than one. A *post* is one edit going to one account at one time — so a
-- single "publish to four places" is four rows. They succeed and fail
-- independently: a token expires on one platform, a file is too long for
-- another, a third rejects the caption. One row with a list inside it has one
-- status column and would have to lie about at least one of them.

CREATE TABLE IF NOT EXISTS social_accounts (
  id            text PRIMARY KEY,
  user_id       uuid NOT NULL,

  -- instagram | facebook | tiktok | x | snapchat
  platform      text NOT NULL,

  -- The account's id on that platform. The handle changes and this does not,
  -- which is what makes reconnecting the same account an update rather than a
  -- second copy of it.
  external_id   text NOT NULL,

  handle        text NOT NULL,
  display_name  text,
  avatar_url    text,

  -- The credential. This column is the entire reason the table is not readable
  -- by anything but the application role, and the reason no endpoint returns
  -- `select *` from it.
  access_token  text NOT NULL,
  refresh_token text,
  expires_at    timestamptz,

  -- What the platform said last time we used it. A revoked token looks exactly
  -- like a working one until something is posted with it, and finding out when
  -- a scheduled post was due is finding out too late.
  status        text NOT NULL DEFAULT 'ok',
  status_detail text,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE social_accounts IS
  'Standing connections to a person''s social accounts. Holds the access token, so no endpoint may select * from it.';
COMMENT ON COLUMN social_accounts.status IS
  'ok | expired | revoked — what the platform said the last time this token was used, so "reconnect" can be shown before the post that needed it rather than after.';

CREATE INDEX IF NOT EXISTS social_accounts_user_idx ON social_accounts (user_id);

-- Reconnecting the same account replaces it. Without this, pressing "connect"
-- twice gives two rows for one account and a post scheduled to "both" goes out
-- twice.
CREATE UNIQUE INDEX IF NOT EXISTS social_accounts_identity_idx
  ON social_accounts (user_id, platform, external_id);


CREATE TABLE IF NOT EXISTS scheduled_posts (
  id               text PRIMARY KEY,
  user_id          uuid NOT NULL,

  project_id       text NOT NULL,
  export_id        text,

  -- Where it is going. Deliberately not a foreign key onto social_accounts:
  -- disconnecting an account must not delete the record that something was
  -- posted from it. See the note on jobs.project_id in 0018 — a cascade there
  -- reset the billing meter, and this is the same shape of mistake.
  account_id       text NOT NULL,
  platform         text NOT NULL,

  caption          text NOT NULL DEFAULT '',
  hashtags         jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- UTC. The browser renders it in local time; storing local time is how a
  -- post scheduled at 9pm goes out at 9pm in a timezone nobody chose.
  scheduled_for    timestamptz NOT NULL,

  -- scheduled → publishing → published | failed | cancelled | missed
  status           text NOT NULL DEFAULT 'scheduled',

  external_post_id text,
  external_url     text,

  -- Why it did not go out, in words a person can act on. Same rule as
  -- jobs.error: a platform's raw refusal is a slug and a request id.
  error            text,
  attempts         integer NOT NULL DEFAULT 0,

  published_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE scheduled_posts IS
  'One edit, going to one account, at one time. Four destinations is four rows, because they fail independently.';

CREATE INDEX IF NOT EXISTS scheduled_posts_user_idx ON scheduled_posts (user_id);
CREATE INDEX IF NOT EXISTS scheduled_posts_project_idx ON scheduled_posts (project_id);

-- The publisher's claim query: everything due, oldest first.
CREATE INDEX IF NOT EXISTS scheduled_posts_due_idx ON scheduled_posts (status, scheduled_for);


-- RLS, with the policy naming the role the application actually connects as.
--
-- A table with RLS enabled and no policy is a table the *application* cannot
-- read either, and a SELECT under a policy that matches nothing is not an
-- error — it is zero rows. Four migrations shipped policies naming the wrong
-- role before the schema suite started checking; these two are checked the
-- same way.
--
-- Unconditional for that role, because the row's owner is compared against the
-- caller one layer up, in `routes/social.ts`, where the bearer token is. A
-- second gate here that looks like security and enforces nothing is worse than
-- no gate, because somebody will trust it.
ALTER TABLE social_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_posts ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'social_accounts' AND policyname = 'social_accounts_app'
  ) THEN
    EXECUTE 'CREATE POLICY social_accounts_app ON social_accounts FOR ALL TO editly_app USING (true) WITH CHECK (true)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'scheduled_posts' AND policyname = 'scheduled_posts_app'
  ) THEN
    EXECUTE 'CREATE POLICY scheduled_posts_app ON scheduled_posts FOR ALL TO editly_app USING (true) WITH CHECK (true)';
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON social_accounts TO editly_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON scheduled_posts TO editly_app;
