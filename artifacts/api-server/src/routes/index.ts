import { Router, type IRouter } from "express";
import healthRouter from "./health";
import giftCardsRouter from "./gift-cards";
import invoiceRouter from "./invoice";
import webhookRouter from "./webhook";
import authRouter from "./auth";

const router: IRouter = Router();

router.use(healthRouter);
router.use(giftCardsRouter);
router.use(invoiceRouter);
router.use(webhookRouter);
router.use(authRouter);

export default router;
