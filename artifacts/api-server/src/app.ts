import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { bodyParsers } from "./lib/body-parsers";
import { logger } from "./lib/logger";
import { errorHandler } from "./lib/error-handler";

const app: Express = express();

/**
 * Allowed browser origins. The API is only ever called by our own frontend, so
 * a wildcard would just hand any site the ability to make authenticated calls
 * on a visitor's behalf.
 *
 * Vercel gives every deployment a unique preview hostname, so those are matched
 * by pattern rather than listed.
 *
 * `APP_ORIGIN` is read **per request**, not once at import. That is not
 * fussiness: `build-vercel.mjs` used to hand esbuild a `define` for it, and
 * esbuild substitutes `process.env["APP_ORIGIN"]` too, so whatever origin sat
 * in the build machine's `.env.production.local` was frozen into the bundle as
 * a string literal. The value on the hosting dashboard then had no effect at
 * all — the read it was meant to satisfy no longer existed. Reading it here,
 * at call time, means the allowlist can never be older than the process.
 */
const CONSTANT_ORIGINS = new Set([
  "http://localhost:5173",
  "http://localhost:3000",
  // The waiting-list page. A different domain and a different deployment, so
  // it has to be named here or the browser refuses the one call it makes.
  // Listing it costs nothing extra: what an origin is allowed to *do* is
  // decided by the bearer token, and the waiting-list page has none — the
  // single route it can reach is the single route that needs none.
  "https://editlyai.io",
  "https://www.editlyai.io",
]);

const VERCEL_PREVIEW = /^https:\/\/editly-[a-z0-9-]+\.vercel\.app$/;

export function isAllowedOrigin(origin: string): boolean {
  if (CONSTANT_ORIGINS.has(origin)) return true;
  // Read fresh. `env["APP_ORIGIN"]` through a variable, so a bundler cannot
  // quietly turn this lookup into the literal it was at build time.
  const env = process.env;
  const configured = env["APP_ORIGIN"];
  if (configured && origin === configured) return true;
  return VERCEL_PREVIEW.test(origin);
}

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(
  cors({
    origin(origin, callback) {
      // A missing Origin header means a non-browser client (curl, a server, a
      // health check). Those are not subject to the same-origin policy, so CORS
      // has nothing to protect against — the bearer token is what guards them.
      if (!origin) return callback(null, true);

      if (isAllowedOrigin(origin)) return callback(null, true);

      return callback(new Error(`Origin not allowed: ${origin}`));
    },
    credentials: true,
  }),
);

// Every route wants parsed JSON; the billing webhook must not have its body
// touched, or the signature over the raw bytes cannot be checked. See
// lib/body-parsers.ts — it lives there because it is testable there.
for (const parser of bodyParsers()) app.use(parser);

app.use("/api", router);

// Last, and after the routes, because that is how Express finds it. Without one
// mounted, every throw fell through to Express's default handler: HTML, which
// the generated client cannot parse, carrying a stack outside production.
app.use(errorHandler);

export default app;
