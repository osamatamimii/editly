# When it breaks

What to do, in order, without having to think. Written down because the last
outage lasted two days and every step of the fix was known to somebody — it was
the *looking* that took two days, and then the *deciding* took the rest.

Three things run in production and they fail differently:

| | Where | What its failure looks like |
|---|---|---|
| The app and the API | Vercel | Screens that error, or answer nothing |
| The render worker | Fly.io, `editly-worker` | Everything works, and no render ever starts |
| The database | Supabase | Both of the above, at once |

## First: which one is it

```bash
curl -s https://app.editlyai.io/api/healthz | jq
```

That one call answers all three, and it is the endpoint `watch.yml` polls every
fifteen minutes. Read it in this order:

- **It does not answer at all** → Vercel. Skip to *Rolling back the app*.
- **`"status": "behind"`** with `missingColumns` → the database is missing
  columns this build reads. **This is the 12 August outage.** Every screen is
  empty and nothing logs an error. Go to *Migrations*.
- **`"database": { "reachable": false }`** → Supabase. Check
  <https://status.supabase.com>, then the project's own dashboard: a paused
  project and a network outage look identical from here.
- **`"worker": { "online": false }`** → nothing is rendering. Go to *The
  worker*. `lastSeenAgoSeconds: null` means no worker has *ever* beaten on this
  deployment, which is a different problem from one that stopped: it is usually
  a missing secret or a first deploy that never succeeded.
- **Everything true and customers still report trouble** → get a request id
  from them. Every response carries `x-request-id`, every failure body carries
  `requestId`, and it is the id Vercel's own logs use. Search on it.

## Rolling back the app

Vercel keeps every previous deployment, and rolling back re-points production at
one. It is a routing change, not a rebuild: seconds, not minutes.

```bash
vercel rollback              # to the deployment immediately before this one
vercel rollback status       # is it done
```

On the Hobby plan only the immediately previous production deployment is
reachable this way; going further back needs Pro. Undo it with `vercel promote
<deployment-url>`.

**What a rollback does not undo:**

- **Environment variables.** They belong to the project, not to the deployment.
  A rollback runs old code against whatever the variables say now.
- **Migrations.** The database does not go back. This is the important one: if
  the deploy that broke things also applied a migration, rolling back the code
  gives you *old code against a new schema*, which is the same class of failure
  in the other direction. Read the migration first and decide deliberately.

## The worker

Its failures are quiet by construction: nothing serves a customer, so nothing
returns an error to one. Renders queue and stay queued.

```bash
flyctl status --app editly-worker         # are there machines, are they up
flyctl logs --app editly-worker           # what it says about itself
```

The line to look for at startup is `worker ready`, which names every provider
this copy resolved. A worker with `transcription: unavailable` is running and
cannot caption; that is a missing secret, not an outage.

Rolling it back is two commands:

```bash
flyctl releases --app editly-worker --image
flyctl deploy --image registry.fly.io/editly-worker:deployment-<id>
```

No rebuild and no checkout: Fly boots the older image. Deploys are `rolling`
with a health check on `/healthz`, so a machine that cannot start is not
promoted — which means a *failed* deploy usually needs no rollback at all.

A worker that is up but stuck holds a job lock. Locks older than
`STALE_LOCK_MINUTES` (30) are returned to the queue by the next sweep, so the
answer is usually to wait one sweep rather than to touch anything. If you do
need to force it, restarting the machine is enough — the lock goes stale and the
job is retried:

```bash
flyctl machine restart <id> --app editly-worker
```

## Migrations

**A schema change is a command, not a memory.** On 12 August five committed
migrations had never been applied to production. Every query named a column that
did not exist, the product served empty screens for two days, and nothing
anywhere said so.

```bash
DATABASE_URL=<production> node tools/migrate.mjs --check   # is anything pending
DATABASE_URL=<production> node tools/migrate.mjs           # apply what is
```

`--check` exits non-zero when anything is pending, and `watch.yml` runs it
against production on a schedule for exactly this reason. Migrations are
forward-only: there is no down script, and writing one under pressure is how a
bad hour becomes a bad week. A migration that has to be undone is undone by a
new migration.

## Restoring the database

Supabase keeps point-in-time backups on the paid plans and daily backups
otherwise; the project dashboard is the only place to start one, and it is the
step that has no CLI shortcut and no rollback of its own. `tools/restore-test.mjs`
exists to prove the restore path works before it is needed — run it, do not
learn its output during an incident.

## Telling people

Say something before it is fixed. A status note that says "renders are queued
and not starting, we are on it" costs one message and stops every customer from
independently discovering it, testing it, and writing in.

The one thing to avoid saying is that nothing was lost before it is known: an
unfinished render has already spent the customer's minutes, and the honest
sentence is that the minutes will be returned.

## After

Two things, while it is fresh:

1. **A check that would have caught it.** Every suite in `tools/` exists because
   something got through. If this failure had no check, it now has one, and the
   commit that adds it is the record of what happened.
2. **A line in this file**, if the steps above were not the steps you took.
