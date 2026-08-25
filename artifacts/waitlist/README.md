# The waiting-list page

One static file. No build step, no framework, no dependencies — it has one job
and it has to still work on a phone on a bad connection in a year's time.

## What it is

`index.html` is the whole page: the Editly mark inlined as SVG (so it inherits
`currentColor` and needs no second asset), the product's own palette tokens
copied verbatim from `artifacts/editly/src/index.css`, and Inter from Google
Fonts. It posts one request to `POST /api/waitlist` on the main deployment.

## Deploying it

It is a **separate Vercel project from the same repository**, so that the
waiting-list domain and the product deploy independently of each other and a
push to one cannot take the other down.

1. Vercel → Add New → Project → import `osamatamimii/editly` again.
2. Root Directory: `artifacts/waitlist`.
3. Framework Preset: **Other**. No build command, no install command; the
   output directory is the root directory itself.
4. Domains → add `editlyai.io` and `www.editlyai.io`.

Nothing else. There are no environment variables: the page holds no secrets,
because the only endpoint it calls is the only endpoint in the product that
needs none.

## The one thing to keep in sync

`API` at the top of the script points at the main deployment. If the API ever
moves to its own hostname, that constant is the single line to change — and
`artifacts/api-server/src/app.ts` has to name the new origin in `STATIC_ORIGINS`
or the browser will refuse the call.
