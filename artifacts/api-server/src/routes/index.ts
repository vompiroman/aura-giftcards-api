import { Router, type IRouter } from "express";
import healthRouter from "./health";
import invoiceRouter from "./invoice";
import webhookRouter from "./webhook";
import authRouter from "./auth";
import ordersRouter from "./orders";
import adminRouter from "./admin";
import promosRouter from "./promos";
import adminDashboardRouter from "./adminDashboard";

const router: IRouter = Router();

router.use(healthRouter);
router.use(invoiceRouter);
router.use(webhookRouter);
router.use(authRouter);
router.use(ordersRouter);
router.use(adminRouter);
router.use(promosRouter);
router.use(adminDashboardRouter);

export default router;
