import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { bodyParsers } from "./lib/body-parsers";
import { logger } from "./lib/logger";
import { errorHandler } from "./lib/error-handler";
import { isAllowedOrigin } from "./lib/allowed-origins";
import { requestIdFrom, REQUEST_ID_HEADER } from "./lib/request-id";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    /*
      An id that is actually different per request, and that leaves the building.

      pino-http's default is an integer that starts at 1 and increments per
      *process*. On Vercel every invocation is a fresh process, so essentially
      every request in production was request number 1 — including the one in
      the 500 body that `error-handler.ts` tells support to search for. See
      lib/request-id.ts for where the value comes from and why the caller's own
      header is honoured first.
    */
    genReqId(req, res) {
      const id = requestIdFrom(req.headers);
      // Echoed on every response, not only on failures: a customer reporting
      // "it was slow" or "it showed the wrong thing" has no error body to read
      // an id out of, and the browser's network tab has this.
      res.setHeader(REQUEST_ID_HEADER, id);
      return id;
    },
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
