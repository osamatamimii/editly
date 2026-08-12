/**
 * Is this deployment actually working?
 *
 * This used to answer `{status: "ok"}` from a constant, which meant it answered
 * "ok" throughout the two days every single query in the product was failing
 * against a database that was five migrations behind. It was not wrong about
 * anything; it had simply never been asked to look.
 *
 * Now it looks. Reachability and schema completeness are reported separately
 * because they send you to different places — one is the connection string or
 * the provider, the other is a migration nobody ran — and a degraded answer
 * carries the missing column names, so the fix is a minute rather than an
 * afternoon of reading stack traces.
 *
 * It answers 503 when the database is unreachable or behind. A monitor that
 * reads 200 while the product serves empty screens is worse than no monitor.
 */
import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { checkSchema, BEHIND_MESSAGE } from "../lib/schema-health";

const router: IRouter = Router();

router.get("/healthz", async (_req, res): Promise<void> => {
  const schema = await checkSchema();

  if (!schema.reachable) {
    res.status(503).json(
      HealthCheckResponse.parse({
        status: "unreachable",
        database: { reachable: false, missingColumns: [] },
        message: "The database could not be reached.",
      }),
    );
    return;
  }

  if (schema.missingColumns.length > 0) {
    res.status(503).json(
      HealthCheckResponse.parse({
        status: "behind",
        database: { reachable: true, missingColumns: schema.missingColumns },
        message: BEHIND_MESSAGE,
      }),
    );
    return;
  }

  res.json(
    HealthCheckResponse.parse({
      status: "ok",
      database: { reachable: true, missingColumns: [] },
    }),
  );
});

export default router;
