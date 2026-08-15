# Editly

**Stop editing. Start describing.**

Upload a raw take, say what you want in plain language ("cut the dead air and make it vertical for TikTok"), and get back something ready to post.

**What actually works today:** silence removal, reframing to 9:16, motion, loudness levelling, and the free-plan watermark — all real ffmpeg, run on a dedicated worker. What a plan allows is decided on the server, in one place, and the browser has no vote in it: the mark, the month's allowance and the upload ceiling are applied to every render regardless of what the request asked for. Captions are burned from a real transcript, broken onto lines we choose, and placed clear of each platform's own on-screen furniture; punch-ins land where the speaker leaned on a word rather than on a metronome, and the 9:16 crop is placed where the picture's detail and movement actually are rather than blindly at the centre. Speech recognition and scene understanding are wired but optional — without their keys the worker still edits, and the render notes say what it could not do instead of dropping it silently. Requests are turned into plans by a model when `OPENAI_API_KEY` is set and by keyword matching when it is not — either way the model chooses only from operations that exist, and the reply the user reads is generated from those operations rather than by the model, so the assistant cannot promise work the worker will not do. See `ROADMAP.md` for what is next and what it will cost.

## Stack

- **Monorepo**: pnpm workspaces, TypeScript 5.9, Node 22
- **Frontend** (`artifacts/editly`): React 19 + Vite + Tailwind CSS 4 + shadcn/ui, Wouter routing, TanStack Query
- **API** (`artifacts/api-server`): Express 5, Zod validation, Pino logging
- **Database** (`lib/db`): PostgreSQL (Supabase) + Drizzle ORM
- **API contract** (`lib/api-spec/openapi.yaml`): OpenAPI source of truth; `lib/api-zod` + `lib/api-client-react` implement it
- **Render worker** (`artifacts/worker`): ffmpeg in a container, claiming jobs from a Postgres queue
- **Hosting**: Vercel — static frontend + the Express app as a single serverless function. The worker runs on Fly.io, because ffmpeg cannot run on Vercel.

## Tests

```bash
# 94 checks that one user cannot see or touch another's data, against the real
# auth middleware. Needs a local Postgres built by `pnpm run migrate` — built
# any other way it is a different database from production, which is how a
# cascade that reset the meter passed here for weeks.
node tools/isolation-test.mjs

# 43 checks that run the worker itself — the loop that ties every tested piece
# together, and the one thing here that had never once been executed. The built
# bundle, as a real process, against a real Postgres, real ffmpeg and an HTTP
# server standing in for Storage: it claims a job, renders it, uploads the file,
# and the file is fetched back and probed. Needs ffmpeg and the same Postgres.
node tools/worker-test.mjs

# 42 checks on the things that only fail on deploy day, none of which need
# Docker, Fly or a credential: a secret named one thing in the workflow and read
# as another in the worker, a path in the Dockerfile that no longer matches what
# the build writes, an app name off by a hyphen. It also runs the secrets step
# with no optional keys — the configuration everybody starts with.
node tools/deploy-test.mjs

# 40 checks on the job queue against a real Postgres: ten workers over five
# jobs, a worker that dies mid-render, and the order people were promised. None
# of this can be checked by reading the code — two workers claiming one row
# produces no error at all, just a render that happens twice and is billed
# twice. Needs the same local Postgres.
node tools/queue-test.mjs

# 62 checks on the ffmpeg pipeline — they inspect the output, not the exit code.
# Needs ffmpeg and ffprobe on PATH.
node tools/render-test.mjs

# 50 checks on the edit a customer actually receives: cuts that land between
# words, captions that stay with the voice after the cuts and sit clear of each
# platform's own on-screen furniture, punches on emphasis rather than on filler,
# and a vertical crop that keeps the subject in frame instead of delivering
# their shoulder. This is the suite that stops quality drifting quietly.
node tools/quality-test.mjs

# 61 checks on the model layer — the requests we send, the shapes we expect
# back, and what happens with no keys at all. No keys and no network needed.
node tools/models-test.mjs

# 25 checks that a reference clip's look is measured, not guessed: fast cuts
# against slow, breathy against tight, graded against flat.
node tools/style-test.mjs

# 33 checks that nobody can forge a payment: an unsigned webhook, a real
# signature on a tampered body, a refund that must drop access to free, and a
# retried event that must not compound. The last section drives a real HTTP
# request through the real middleware, because a body parser upstream would
# make every genuine payment fail while every other check here still passed.
node tools/billing-test.mjs

# 24 checks that a model cannot make the product lie: invented operations are
# discarded, out-of-range values rejected rather than clamped, and a timeout or
# a 500 falls back to keywords instead of reaching the user.
node tools/planner-test.mjs

# 40 checks on the two themes: that every token the dark theme defines is
# answered by the light one, that the two actually differ, and that every
# text-on-surface pair clears WCAG AA — measured from the real stylesheet.
node tools/theme-test.mjs

# 62 checks that nobody gets a render they did not pay for: a request that
# omits the watermark, one that sends an unreadable watermark instead, one
# padded to twelve operations so there is no room for ours, and a four-hour
# file on a ten-minute plan. No keys, no network, no database.
node tools/policy-test.mjs

# 83 checks that a plan is reviewed against the cut before ffmpeg runs it: a
# punch remapped through the silence that was removed, one dropped because the
# word it was going to emphasise is gone, and a cut moved off the middle of a
# word — which sounds like the speaker stumbled, so nobody reports it.
node tools/critic-test.mjs

# 89 checks on asking two speech models the same question: where they agree the
# word is corroborated, where they differ the more accurate one wins on the
# other's clock, and where both are unsure the caption shows an ellipsis rather
# than a guess.
node tools/transcript-test.mjs

# 54 checks on editing to match a video you like — mostly on what a reference is
# *not* allowed to decide.
node tools/reference-test.mjs

# 58 checks that the 9:16 window goes where the person is and then stays there.
# The last section renders a real clip of a face crossing frame and finds the
# face in the output.
node tools/framing-test.mjs

# 70 checks written from the position of someone who wants the render for
# nothing: make the probe fail, send no duration, claim a four-hour file is one
# second long. The last 17 run the real month-to-date query against Postgres.
node tools/meter-test.mjs

# 30 checks that deleting an account is never partial and reported as complete,
# and that the bytes go before the rows that name them.
node tools/account-test.mjs

# 85 checks on the code that runs on a phone, in a real Chromium against a real
# HTTP server that speaks tus and misbehaves the way networks do: an upload the
# server has forgotten, an offset that is not where the client thought it was, a
# connection dropped mid-chunk. The poster checks decode a clip whose first
# second is black, because that is the file that code exists for. The last two
# sections are about the other half of the August outage: "you have nothing" and
# "we could not read your things" are different sentences, and no screen here
# could tell them apart. Needs ffmpeg.
node tools/browser-test.mjs

# 28 checks that the OpenAPI file above still describes this API. It reads the
# routes out of the Express handlers and the shapes out of the zod schemas —
# both of which are the code that actually runs — so forgetting to document a
# route is a failing check rather than a discovery someone makes a year later.
node tools/contract-test.mjs

# 49 checks that the database can be rebuilt from this repository and that one
# which is behind says so. It creates an empty Postgres, runs every migration
# into it, and diffs the result against what the code declares — columns *and*
# constraints, because `jobs.project_id` once carried ON DELETE CASCADE and
# deleting a project refunded the minutes it had produced. Then it puts a
# database into the exact state production was in on 12 August and asks the
# health check what it sees. Needs a Postgres it may create and drop databases
# on.
node tools/schema-test.mjs

# Storage policies are enforced by Postgres, not by code in this repo. Paste
# this into the browser console on the deployed app after changing them.
# tools/storage-isolation.browser.js
```

## Local development

```bash
pnpm install

# Bring a database up to date. Safe to run repeatedly; prints what it did.
# An empty Postgres plus every file in lib/db/migrations *is* the schema —
# nothing else creates a table, and tools/schema-test.mjs proves it.
export DATABASE_URL=postgresql://...
pnpm run migrate          # pnpm run migrate:dry to see what would happen first

# API server
export PORT=3001
pnpm --filter @workspace/api-server run dev

# Frontend
pnpm --filter @workspace/editly run dev
```

Other useful commands:

```bash
pnpm run typecheck      # typecheck everything
pnpm run build          # typecheck + build all packages
pnpm run vercel:build   # build the exact artifacts Vercel deploys (dist/ + api/_bundle.js)
```

## Live

- **App**: https://editly-eta.vercel.app
- Every push to `main` deploys automatically.

## Database

The schema lives in `lib/db/src/schema/` (Drizzle) and is created by `lib/db/migrations/*.sql`. An empty Postgres plus every file in that directory, in order, is the database — nothing else creates a table, and `tools/schema-test.mjs` proves it by building one and diffing it against what the code declares. All four base tables have RLS enabled; the API connects as a dedicated `editly_app` role with explicit policies, never the `postgres` superuser.

**Build your local database the same way — `pnpm run migrate`, never `drizzle-kit push`.** The Drizzle schema declares no foreign keys and the SQL declares three, so a pushed database is a different database from production: `jobs.project_id` carried `ON DELETE CASCADE` in production only, deleting a project deleted the jobs that record the minutes it produced, and the isolation check written to catch exactly that passed locally for weeks.

**Deploying a schema change is a command, not a memory: `pnpm run migrate`.** On 12 August five committed migrations had never been applied to production. Every query in the app named a column that did not exist, the product served empty screens for two days with no error anywhere a user could see, and `/healthz` answered `ok` throughout because it returned a constant. `/healthz` now asks the database what columns it has, compares them to what the build reads, and answers 503 with the missing names when it is behind.

Connect through Supabase's **transaction pooler** (`aws-0-<region>.pooler.supabase.com:6543`) — serverless functions open many short-lived connections, which the direct database host is not sized for. `lib/db/src/index.ts` enables TLS for any non-localhost host, since the pooler serves a certificate for its own hostname.

## Deployment (Vercel)

`vercel.json` configures everything:

- `pnpm run vercel:build` builds the frontend into `dist/` and bundles the Express app into `api/_bundle.js` (loaded by the committed function stub `api/index.js`).
- `/api/*` is rewritten to the serverless function; everything else falls back to the SPA's `index.html`.
- Set `DATABASE_URL` as an environment variable in the Vercel project (Settings → Environment Variables). When it is present at build time it is inlined into the bundle; otherwise the function reads it at runtime.

To link this repo for automatic deploys: Vercel dashboard → Add New Project → Import this GitHub repository (the settings above are picked up from `vercel.json`).
