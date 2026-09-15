-- Which commit the worker on the other end was built from.
--
-- `fly status` names a deployment id. That says the image changed and never
-- what is in it, so "is production running the code we think it is" has been
-- answerable only by reading that id against somebody's memory of when it was
-- cut. One morning the answer was no: three fixes had been on main for hours,
-- the running image predated all of them, and every symptom read as a fresh
-- bug rather than an undeployed one. Two of those fixes were re-investigated
-- from scratch before anybody thought to doubt the deploy.
--
-- Nullable, and it stays nullable. A worker built without the build argument,
-- or run from a laptop, is a legitimate thing to have running; the column says
-- so by being empty rather than by carrying a lie. The worker falls back to
-- Fly's own image reference when no commit was passed, which at least
-- identifies the deploy.
alter table public.worker_heartbeats
  add column if not exists build text;
