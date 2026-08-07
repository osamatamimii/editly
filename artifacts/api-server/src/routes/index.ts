import { Router, type IRouter } from "express";
import healthRouter from "./health";
import projectsRouter from "./projects";
import messagesRouter from "./messages";
import exportsRouter from "./exports";
import statsRouter from "./stats";
import subscriptionRouter from "./subscription";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

// Public: used by uptime checks, must not require a token.
router.use(healthRouter);

// Everything below this line is per-user data. `requireAuth` populates
// `req.userId`, and each handler filters on it — mounting a data route outside
// this block would silently expose every user's rows.
router.use(requireAuth);

router.use(projectsRouter);
router.use(messagesRouter);
router.use(exportsRouter);
router.use(statsRouter);
router.use(subscriptionRouter);

export default router;
