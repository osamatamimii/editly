-- What a job is, when it is not a render.
--
-- `transcript-surface.tsx` tells a person, in their own language, that "the
-- transcription follows the upload by a minute or two, and this panel fills in
-- on its own the moment it is ready". Nothing in this repository was trying to
-- keep that sentence. The `transcripts` table is written in exactly one place —
-- `transcriptStoreFor` in the worker — and only as a side effect of a render
-- whose plan needed the words for something else. A person who uploads a video
-- and opens the transcript panel waits forever, in front of a spinner and a
-- promise, and the production table has never held a single row.
--
-- The worker's own note explains why it does not simply transcribe everything:
--
--     paying a speech model on its behalf so that a *later* request might be
--     better planned would be charging somebody for a feature they did not ask
--     for.
--
-- That is right, and it is the argument for asking rather than for the silence
-- we had. So the words are bought when somebody opens the panel to read them,
-- which is the moment they have asked.
--
-- A job today is a render: it parses a plan, checks for disk, spends minutes,
-- and produces a file. A transcription is none of those things — no plan, no
-- output, nothing billed, because the meter charges for video that exists and
-- this produces none. It still wants everything else a job has: one queue, one
-- worker, the lock, the attempts, the heartbeat, the requeue on a machine that
-- died. So it is a job with a kind rather than a second queue nobody watches.
--
-- Defaulting to 'render' is what makes this safe to deploy in either order: a
-- row written by the current API before the worker learns the word is a render,
-- which is what it is. The worker reads the column and branches; a worker that
-- has not been updated sees a `kind` it does not select on and behaves exactly
-- as it does today.

alter table jobs add column if not exists kind text not null default 'render';

alter table jobs drop constraint if exists jobs_kind_check;

alter table jobs
  add constraint jobs_kind_check
  check (kind in ('render', 'transcribe'));

comment on column jobs.kind is
  'What this job is for. "render" produces a video and is billed at what it produced; "transcribe" buys the words for the transcript panel, produces no file and is billed nothing. The list is the kind union in lib/db/src/schema/jobs.ts; both move together.';

-- The queue is claimed by priority and age across every kind, so the index that
-- serves the claim needs no column added. What is new is "is this project
-- already having its words bought", asked by the door before it queues another.
create index if not exists jobs_project_kind_idx on jobs (project_id, kind, status);
