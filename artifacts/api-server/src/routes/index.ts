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
import clipsRouter from "./clips";
import stockRouter from "./stock";
import adminRouter from "./admin";
import waitlistRouter from "./waitlist";
import socialRouter, { socialCallbackRouter } from "./social";
import fontsRouter from "./fonts";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

// Public: used by uptime checks, must not require a token.
router.use(healthRouter);

// Also public, and deliberately so: Freemius calls this from the open internet
// with no session. Its authentication is the signature over the raw body, not a
// bearer token — see routes/billing.ts. It must stay above requireAuth.
router.use(billingWebhookRouter);

// Also public, and the only public *write* in the product: somebody joining the
// waiting list has no account yet, which is the whole point of a waiting list.
// It is rate limited by address instead of by user — see routes/waitlist.ts.
router.use(waitlistRouter);

// The OAuth callback, before the auth middleware for the same reason the
// billing webhook is: it is a browser navigation from a platform and carries no
// bearer token. Who it belongs to comes from the signed state on the URL.
router.use(socialCallbackRouter);

// Everything below this line is per-user data. `requireAuth` populates
// `req.userId`, and each handler filters on it — mounting a data route outside
// this block would silently expose every user's rows.
router.use(requireAuth);

router.use(projectsRouter);
router.use(socialRouter);
router.use(fontsRouter);
router.use(messagesRouter);
router.use(exportsRouter);
router.use(statsRouter);
router.use(subscriptionRouter);
router.use(renderRouter);
router.use(billingRouter);
router.use(accountRouter);
router.use(assetsRouter);
router.use(clipsRouter);
router.use(stockRouter);

// The operations console. Its own gate on top of requireAuth: every path under
// /admin answers 404 to anyone not on the allowlist, which is a list in the
// environment and not a column anything can write. See lib/admin.ts.
router.use(adminRouter);

export default router;
