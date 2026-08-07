import { Router, type IRouter } from "express";
import healthRouter from "./health";
import projectsRouter from "./projects";
import messagesRouter from "./messages";
import exportsRouter from "./exports";
import statsRouter from "./stats";
import subscriptionRouter from "./subscription";

const router: IRouter = Router();

router.use(healthRouter);
router.use(projectsRouter);
router.use(messagesRouter);
router.use(exportsRouter);
router.use(statsRouter);
router.use(subscriptionRouter);

export default router;
