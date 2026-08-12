# Editly — AI Video Editing SaaS

## Overview

Editly turns a landscape recording into a vertical clip you can post. You upload a video, describe the edit you want in your own words, and a dedicated ffmpeg worker performs it — cutting silence between words rather than through them, framing on the speaker rather than on the middle, burning captions from a transcript two speech models agreed on, and levelling the audio to what the platforms normalise to.

This sentence used to say "the AI simulates processing and returns an edited version". It has not been true since the render worker was built, and it sat here for months describing the product as a mock — which is the most expensive kind of stale documentation, because it is the first thing anybody new reads.

Both light and dark themes ship.

pnpm workspace monorepo using TypeScript.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **Frontend**: React + Vite + Tailwind CSS + shadcn/ui
- **Routing**: Wouter (frontend)
- **State**: TanStack React Query

## Architecture

- `artifacts/editly/` — React frontend (landing page, dashboard, project editor, export)
- `artifacts/api-server/` — Express backend with routes for projects, messages, exports, stats
- `lib/db/` — Drizzle ORM schema (projects, messages, exports tables)
- `lib/api-spec/openapi.yaml` — OpenAPI spec (source of truth)
- `lib/api-client-react/` — Generated React Query hooks
- `lib/api-zod/` — Generated Zod validation schemas

## Pages

- `/` — Landing page with hero, how-it-works, feature grid
- `/dashboard` — Projects list with stats summary
- `/project/:id` — Editor: video upload/preview (left) + AI chat (right) + timeline (bottom)
- `/export/:id` — Export page with platform selector (TikTok/Reels/Shorts) and download

## API Routes

- `GET/POST /api/projects` — List/create projects
- `GET/PATCH/DELETE /api/projects/:id` — Get/update/delete project
- `GET/POST /api/projects/:id/messages` — Chat messages with AI simulation
- `POST /api/projects/:id/export` — Start export job (simulated, 5s delay)
- `GET /api/projects/:id/export/status` — Poll export status
- `GET /api/stats/dashboard` — Dashboard summary stats

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

## Design

- Dark mode only
- Primary: Deep Purple #6C3BFF
- Secondary: Neon Purple Glow #9B6BFF
- Glassmorphism cards, glow effects, smooth animations
- Inter font
- AI chat simulation with contextual responses
