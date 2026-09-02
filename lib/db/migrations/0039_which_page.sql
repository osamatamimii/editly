-- Which Page a Meta post goes to, decided once instead of guessed every time.
--
-- Three things were wrong in one place, and all three lived in comments rather
-- than in any list of work.
--
-- **The Page was picked for the person.** `pageFor` took the first entry of
-- whatever `/me/accounts` returned. Somebody who manages two Pages found their
-- video on whichever one Meta happened to order first, and that ordering is not
-- a promise Meta makes. Nothing failed: a post went out, to a real Page, and
-- only its owner could tell it was the wrong one.
--
-- **It was resolved on every send.** The Page and the Instagram business
-- account attached to it are two extra Graph calls per post for a pair of
-- values that do not change between posts. `publish-meta.ts` said so in its own
-- comment: "it could have been stored at connection instead, and one day it
-- should be."
--
-- **And a Meta token has sixty days.** Meta issues no refresh token; a
-- long-lived token is obtained by an exchange and extended by the same exchange
-- again. Nothing did either, so every connection was going to stop working
-- about two months after it was made, with no event and nothing to look at.
-- `expires_at` already existed and was null for these rows, which is the
-- database saying "this does not expire" about the one credential here that
-- does.
--
-- ## Why now, and cheaply
--
-- There are zero connected social accounts in production today. This is a
-- column addition with no backfill and no data migration. In a month it is a
-- data migration against live credentials, run under the pressure of posts that
-- have started failing.
--
-- Every column is nullable on purpose. A row that predates this — or one whose
-- owner has not chosen a Page yet — carries nulls, and `publish-meta.ts` falls
-- back to resolving from the token exactly as it does today. Nothing that works
-- stops working; the stored answer is an improvement on the resolved one, not a
-- replacement for the ability to resolve.
ALTER TABLE social_accounts ADD COLUMN IF NOT EXISTS page_id text;
ALTER TABLE social_accounts ADD COLUMN IF NOT EXISTS page_name text;

-- The Page's own token, which is not the user's.
--
-- A Facebook video is posted with the Page's token and a Reel is created
-- through the Page, so this is the credential that actually does the work. It
-- is derived from the long-lived user token and lives as long as that does. It
-- is in the same table as every other token here for the same reason: this
-- table is the one thing in the schema the browser can never read under any
-- policy, and a second place for credentials would be a second thing to get
-- right.
ALTER TABLE social_accounts ADD COLUMN IF NOT EXISTS page_access_token text;

-- The Instagram business account attached to that Page, when there is one.
ALTER TABLE social_accounts ADD COLUMN IF NOT EXISTS instagram_user_id text;

-- The Pages this account manages, as {id, name} only.
--
-- Stored so the connect screen can ask *which one* without a second round trip
-- to Meta with a token the browser must never see. Deliberately without the
-- Page tokens: this column is read to build a list of choices, and a list of
-- choices does not need credentials in it. The chosen Page's token is fetched
-- again, from Meta, at the moment the choice is made.
ALTER TABLE social_accounts ADD COLUMN IF NOT EXISTS page_choices jsonb;
