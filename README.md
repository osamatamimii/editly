# Editly

**Stop editing. Start describing.**

Upload a raw take, say what you want in plain language ("cut the dead air and make it vertical for TikTok"), and get back something ready to post.

**What actually works today:** silence removal, reframing to 9:16, and the free-plan watermark — all real ffmpeg, run on a dedicated worker. Requests are parsed by keyword matching, not a language model, and the assistant says plainly when it cannot do something rather than promising it. Burned-in captions are implemented and waiting on transcription. See `ROADMAP.md` for what is next and what it will cost.

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

# 18 checks on the ffmpeg pipeline — they inspect the output, not the exit code.
# Needs ffmpeg and ffprobe on PATH.
node tools/render-test.mjs

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
