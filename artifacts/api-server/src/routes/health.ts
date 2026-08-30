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
import { storageAdminConfigured, verifyStorageAdmin } from "../lib/storage";
import { stockConfigured } from "../lib/stock";
import { adminCount } from "../lib/admin";
import { newestWorkerSeenAt } from "../lib/worker-presence";
import { workerOnline } from "../lib/queue-health";

const router: IRouter = Router();

/**
 * What this deployment can do, as booleans.
 *
 * Read at request time rather than at import, so a redeploy that adds a key is
 * visible here immediately rather than after someone remembers to restart
 * something. No key name and no key value ever appears — the answer is only
 * ever yes or no.
 */
async function capabilities(): Promise<{
  storageAdmin: boolean;
  storageCheck: string;
  planner: boolean;
  stockLibrary: boolean;
  billing: boolean;
  admins: boolean;
}> {
  return {
    // Configured, which is not the same as working — see storageCheck.
    storageAdmin: storageAdminConfigured,
    // Whether the key Storage was given actually authenticates. Cached, so a
    // public endpoint cannot be turned into a load generator against Supabase.
    storageCheck: await verifyStorageAdmin(),
    planner: Boolean(process.env["OPENAI_API_KEY"]?.trim()),
    stockLibrary: stockConfigured,
    billing: Boolean(process.env["FREEMIUS_SECRET_KEY"]?.trim()),
    // Whether anybody at all is on the operations console's allowlist.
    //
    // A boolean, never the count and never the ids: what this has to answer is
    // "did the variable reach this deployment", and the console answering 404
    // to its owner looks exactly the same whether the list is missing, empty,
    // or simply does not include them. That ambiguity cost an evening once, and
    // it is the only question this line exists to settle. Read at request time
    // like the rest, because the failure being diagnosed is precisely a value
    // that was set but never reached a running deployment.
    admins: adminCount() > 0,
  };
}

/**
 * Is a machine that can render listening?
 *
 * Everything else here describes the API. This describes the product: with no
 * worker beating, every render queues and none of them starts, while the API
 * answers 200 to everything because nothing is wrong with the API. That is the
 * shape of the 12 August outage, which ran for two days because the only thing
 * that would have noticed it was somebody choosing to look.
 *
 * `newestWorkerSeenAt` caches for ten seconds, so a public endpoint cannot be
 * turned into load on the database, and the cache is far shorter than the two
 * minutes that separate online from offline — it cannot change the verdict.
 *
 * A null reaches here only as "the table has no rows": this line runs after
 * `checkSchema` has already answered, and a database that could not be read
 * has already been answered 503 above with no worker block at all. So a null
 * is a deployment whose worker has never beaten — a real state, and one worth
 * saying out loud — rather than a read we could not make.
 */
async function worker(): Promise<{ online: boolean; lastSeenAgoSeconds: number | null } | undefined> {
  const lastSeenAt = await newestWorkerSeenAt();
  if (lastSeenAt === null) {
    // Never beaten. `lastSeenAgoSeconds: null` is what says so — offline with
    // an age is a machine that stopped, offline with no age is one that was
    // never there, and they are different problems.
    return { online: false, lastSeenAgoSeconds: null };
  }
  return {
    online: workerOnline(lastSeenAt),
    lastSeenAgoSeconds: Math.max(0, Math.round((Date.now() - lastSeenAt.getTime()) / 1000)),
  };
}

router.get("/healthz", async (_req, res): Promise<void> => {
  const schema = await checkSchema();

  if (!schema.reachable) {
    res.status(503).json(
      HealthCheckResponse.parse({
        status: "unreachable",
        database: { reachable: false, missingColumns: [] },
        capabilities: await capabilities(),
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
        capabilities: await capabilities(),
        message: BEHIND_MESSAGE,
      }),
    );
    return;
  }

  res.json(
    HealthCheckResponse.parse({
      status: "ok",
      database: { reachable: true, missingColumns: [] },
      capabilities: await capabilities(),
      // Deliberately not folded into `status`. A dead worker is not a broken
      // API, and answering 503 here would tell every uptime check and deploy
      // gate something untrue. It means something because something reads it:
      // `.github/workflows/watch.yml`, every fifteen minutes.
      worker: await worker(),
    }),
  );
});

export default router;
