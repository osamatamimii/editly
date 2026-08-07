import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

/**
 * Allowed browser origins. The API is only ever called by our own frontend, so
 * a wildcard would just hand any site the ability to make authenticated calls
 * on a visitor's behalf.
 *
 * Vercel gives every deployment a unique preview hostname, so those are matched
 * by pattern rather than listed.
 */
const STATIC_ORIGINS = new Set(
  [
    "http://localhost:5173",
    "http://localhost:3000",
    process.env["APP_ORIGIN"],
  ].filter((o): o is string => Boolean(o)),
);

const VERCEL_PREVIEW = /^https:\/\/editly-[a-z0-9-]+\.vercel\.app$/;

function isAllowedOrigin(origin: string): boolean {
  return STATIC_ORIGINS.has(origin) || VERCEL_PREVIEW.test(origin);
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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;
