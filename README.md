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
# 55 checks that one user cannot see or touch another's data, against the real
# auth middleware. Needs a local Postgres matching the production schema.
node tools/isolation-test.mjs

# 41 checks on the ffmpeg pipeline — they inspect the output, not the exit code.
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

# 28 checks on the two themes: that every token the dark theme defines is
# answered by the light one, that the two actually differ, and that every
# text-on-surface pair clears WCAG AA — measured from the real stylesheet.
node tools/theme-test.mjs

# 33 checks that nobody gets a render they did not pay for: a request that
# omits the watermark, one that sends an unreadable watermark instead, one
# padded to twelve operations so there is no room for ours, and a four-hour
# file on a ten-minute plan. No keys, no network, no database.
node tools/policy-test.mjs

# Storage policies are enforced by Postgres, not by code in this repo. Paste
# this into the browser console on the deployed app after changing them.
# tools/storage-isolation.browser.js
```

## Local development

```bash
pnpm install

# API server (needs a PostgreSQL DATABASE_URL, see .env.example)
export DATABASE_URL=postgresql://...
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

The schema lives in `lib/db/src/schema/` (Drizzle). The production database is a Supabase project; the initial schema was applied as the `init_editly_schema` migration (tables: `projects`, `messages`, `exports`, `subscriptions`, all with RLS enabled — the API connects as a dedicated `editly_app` role with explicit policies, never the `postgres` superuser).

Connect through Supabase's **transaction pooler** (`aws-0-<region>.pooler.supabase.com:6543`) — serverless functions open many short-lived connections, which the direct database host is not sized for. `lib/db/src/index.ts` enables TLS for any non-localhost host, since the pooler serves a certificate for its own hostname.

## Deployment (Vercel)

`vercel.json` configures everything:

- `pnpm run vercel:build` builds the frontend into `dist/` and bundles the Express app into `api/_bundle.js` (loaded by the committed function stub `api/index.js`).
- `/api/*` is rewritten to the serverless function; everything else falls back to the SPA's `index.html`.
- Set `DATABASE_URL` as an environment variable in the Vercel project (Settings → Environment Variables). When it is present at build time it is inlined into the bundle; otherwise the function reads it at runtime.

To link this repo for automatic deploys: Vercel dashboard → Add New Project → Import this GitHub repository (the settings above are picked up from `vercel.json`).
