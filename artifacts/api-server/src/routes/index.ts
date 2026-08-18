import { Router, type IRouter } from "express";
import healthRouter from "./health";
import projectsRouter from "./projects";
import messagesRouter from "./messages";
import exportsRouter from "./exports";
import statsRouter from "./stats";
import subscriptionRouter from "./subscription";
import renderRouter from "./render";
import billingRouter, { billingWebhookRouter } from "./billing";
import accountRouter from "./account";
import assetsRouter from "./assets";
import stockRouter from "./stock";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

// Public: used by uptime checks, must not require a token.
router.use(healthRouter);

// Also public, and deliberately so: Freemius calls this from the open internet
// with no session. Its authentication is the signature over the raw body, not a
// bearer token — see routes/billing.ts. It must stay above requireAuth.
router.use(billingWebhookRouter);

// Everything below this line is per-user data. `requireAuth` populates
// `req.userId`, and each handler filters on it — mounting a data route outside
// this block would silently expose every user's rows.
router.use(requireAuth);

router.use(projectsRouter);
router.use(messagesRouter);
router.use(exportsRouter);
router.use(statsRouter);
router.use(subscriptionRouter);
router.use(renderRouter);
router.use(billingRouter);
router.use(accountRouter);
router.use(assetsRouter);
router.use(stockRouter);

export default router;
