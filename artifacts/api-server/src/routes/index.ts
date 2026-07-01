import { Router, type IRouter } from "express";
import healthRouter from "./health";
import giftCardsRouter from "./gift-cards";
import invoiceRouter from "./invoice";
// import webhookRouter from "./webhook"; // Legacy SlickPay webhook disabled
import authRouter from "./auth";
import netflixCodeRouter from "./netflix-code";
import ordersRouter from "./orders";

const router: IRouter = Router();

router.use(healthRouter);
router.use(giftCardsRouter);
router.use(invoiceRouter);
// router.use(webhookRouter); // Legacy SlickPay webhook disabled
router.use(authRouter);
router.use(netflixCodeRouter);
router.use(ordersRouter);

export default router;
