# Editly

**Stop editing. Start describing.**

Editly is an AI video editing SaaS: upload a video, describe the edit you want in plain language ("Add captions, remove silence, make it TikTok-ready"), and let the AI director do the rest.

## Stack

- **Monorepo**: pnpm workspaces, TypeScript 5.9, Node 22
- **Frontend** (`artifacts/editly`): React 19 + Vite + Tailwind CSS 4 + shadcn/ui, Wouter routing, TanStack Query
- **API** (`artifacts/api-server`): Express 5, Zod validation, Pino logging
- **Database** (`lib/db`): PostgreSQL (Supabase) + Drizzle ORM
- **API contract** (`lib/api-spec/openapi.yaml`): OpenAPI source of truth; `lib/api-zod` + `lib/api-client-react` implement it
- **Hosting**: Vercel — static frontend + the Express app as a single serverless function

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
