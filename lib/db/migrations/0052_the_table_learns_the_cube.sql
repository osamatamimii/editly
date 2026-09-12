-- The one place the colour cube was never let in.
--
-- 0050 taught the *bucket* that a `.cube` is `text/plain`, and the note on it
-- repeats the rule 0043 and 0045 both state: changing what the product accepts
-- means changing the store in the same breath. Both breaths were taken for the
-- object store. Neither was taken for this table.
--
-- So the whole path worked and the last step did not. `POST /projects/:id/assets`
-- validates `kind` against a zod enum that has had `"lut"` since the grading
-- work, the upload door mints a ticket for it, the bucket accepts the bytes,
-- the planner budgets four cubes per project and offers them to the model by
-- label — and the insert that records the file hits
-- `assets_kind_check CHECK (kind IN ('video','image','audio'))`, written in
-- 0018 when those three were all there were. A person uploads a LUT, watches it
-- transfer, and gets a 500 from the endpoint that writes the row.
--
-- It failed loudly and in the one place nothing was watching: no suite created
-- a `lut` asset against a real database. `tools/vocabulary-test.mjs` now does,
-- and it is what found this — the same suite that was already red for a
-- neighbouring reason, which is its own lesson about leaving one red check
-- standing.
--
-- Widening a CHECK cannot invalidate a row that already exists: every value the
-- old constraint allowed the new one allows. Postgres still revalidates the
-- table on ADD, which is a sequential scan of a table with one row per uploaded
-- file — cheap now, and this is the moment it is cheapest.

alter table assets drop constraint if exists assets_kind_check;

alter table assets
  add constraint assets_kind_check
  check (kind in ('video', 'image', 'audio', 'lut'));

comment on column assets.kind is
  'What this file is to an edit: b-roll (video), an overlay or logo (image), a bed (audio), or a colour cube (lut). The list is the zod enum in lib/api-zod and the budget in planner-assets.ts; all three move together.';
