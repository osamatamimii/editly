-- The tokens in this table are not ours, and they are no longer readable here.
--
-- `social_accounts` holds OAuth credentials for somebody's YouTube channel,
-- TikTok account, Instagram, Facebook Page and X. They were stored as plain
-- text. The shape of that risk is worth writing where the columns are: a
-- leaked backup of this database is not an incident about this service, it is
-- somebody else's channel — and a refresh token keeps working until its owner
-- thinks to revoke it, which they will not, because nobody will have told them.
--
-- From now on every write seals the value with AES-256-GCM under a key that
-- lives in the environment and never in this database. See `lib/secrets`.
--
-- ## Why this migration changes no data
--
-- The sealed form carries its own key version — `v1.<nonce>.<tag>.<body>` —
-- so a column can hold either a sealed value or a legacy plaintext one and the
-- reader can tell them apart without being told. That is deliberate: a
-- migration that has to rewrite every credential correctly on its first and
-- only attempt, using a key it has to be handed, is a worse risk than the one
-- it closes. Instead every write seals, and the plaintext disappears as
-- connections refresh.
--
-- It is safe to migrate this way for a reason that will not last: no platform
-- app has finished review, so there is no live connection to rewrite. If that
-- stops being true before the columns are all sealed, the sweep to finish it
-- is a separate migration that can be written when there is something to sweep.
--
-- What this file does is put the fact in the schema, so the next person to
-- read these columns learns it from the database rather than from a module
-- three deployments away.

COMMENT ON COLUMN social_accounts.access_token IS
  'Sealed at rest (AES-256-GCM, see lib/secrets). Format: v<key>.<nonce>.<tag>.<body>. Rows written before 2026-09 may still hold plaintext; the reader tells them apart.';
COMMENT ON COLUMN social_accounts.refresh_token IS
  'Sealed at rest, like access_token. This is the one that matters: it keeps working until its owner revokes it.';
COMMENT ON COLUMN social_accounts.page_access_token IS
  'Sealed at rest, like access_token. Meta Page token, fixed when the connection was made.';
