-- The record of our own decisions being corrected.
--
-- Not a dataset of videos. Three places in the product tell a customer, in
-- their own words, that we do not use their videos to train models, and that
-- sentence is not being edited — it is being built toward. It is a sentence
-- about their footage, not about what they told us to do with it: the title
-- they typed and the font they chose are kept as written, because a rewrite is
-- only a lesson if both sets of words are there. The one thing in a plan that
-- came out of the recording is the burnt caption cues, and
-- `artifacts/api-server/src/lib/edit-pairs.ts` turns those into a count of
-- words before either plan is written here.
--
-- What makes it worth having is that it cannot be bought or scraped. A million
-- rows of "we held the title for 2.5s and they made it 4" only exists where an
-- editor and a customer disagree, which is a place only this product stands.
create table if not exists public.edit_pairs (
  id          text primary key,

  -- Kept so a deletion request can reach these rows. Nothing else reads it:
  -- the pairs are about the craft, not about the person.
  user_id     uuid not null,
  project_id  text not null constraint edit_pairs_project_fk references public.projects(id) on delete cascade,

  -- The two plans, redacted. Both, because a change means nothing without what
  -- it was a change to: a title lengthened on a plan with eleven of them is a
  -- different correction from the same edit on a plan with one.
  before      jsonb not null,
  after       jsonb not null,

  -- And the change itself, already computed. Two documents side by side are a
  -- thing a person can read; "they made the title 1.5 seconds longer" is the
  -- lesson.
  changes     jsonb not null default '[]'::jsonb,
  structure   jsonb not null default '[]'::jsonb,

  created_at  timestamptz not null default now()
);

-- The read this table exists for is "every correction, oldest first", which is
-- how a training set is assembled. Ownership is the other read, and it is the
-- one a deletion uses.
create index if not exists edit_pairs_created_idx on public.edit_pairs (created_at);
create index if not exists edit_pairs_user_idx on public.edit_pairs (user_id, created_at);

-- Same posture as every other table: reachable only through the API.
alter table public.edit_pairs enable row level security;

drop policy if exists "edit_pairs_app_role" on public.edit_pairs;
create policy "edit_pairs_app_role" on public.edit_pairs
  for all to editly_app
  using (true) with check (true);

grant select, insert, update, delete on public.edit_pairs to editly_app;
