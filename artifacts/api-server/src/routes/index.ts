import { Router, type IRouter } from "express";
import healthRouter from "./health";
import giftCardsRouter from "./gift-cards";
import invoiceRouter from "./invoice";
import webhookRouter from "./webhook";
import authRouter from "./auth";
import ordersRouter from "./orders";
import adminRouter from "./admin";

const router: IRouter = Router();

router.use(healthRouter);
router.use(giftCardsRouter);
router.use(invoiceRouter);
router.use(webhookRouter);
router.use(authRouter);
router.use(ordersRouter);
router.use(adminRouter);

export default router;
