import { Router, type IRouter } from "express";
import axios from "axios";

const router: IRouter = Router();

const SLICKPAY_SECRET_KEY = process.env["SLICKPAY_SECRET_KEY"];
const SLICKPAY_ACCOUNT_UUID = process.env["SLICKPAY_ACCOUNT_UUID"];

router.post("/create-invoice", async (req, res) => {
  try {
    const { amount, customer_name, customer_email, description, gift_card_id } = req.body;

    if (!amount || !customer_name || !customer_email) {
      res.status(400).json({ error: "amount, customer_name et customer_email sont requis." });
      return;
    }

    const payload = {
      amount,
      customer_name,
      customer_email,
      description: description ?? "Achat carte cadeau",
      account_uuid: SLICKPAY_ACCOUNT_UUID,
      metadata: { gift_card_id: gift_card_id ?? null },
    };

    const response = await axios.post(
      "https://api.slickpay.dz/v1/invoices",
      payload,
      {
        headers: {
          Authorization: `Bearer ${SLICKPAY_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    res.status(201).json(response.data);
  } catch (err: unknown) {
    if (axios.isAxiosError(err)) {
      req.log.error({ status: err.response?.status, data: err.response?.data }, "SlickPay API error");
      res.status(err.response?.status ?? 502).json({
        error: "Erreur SlickPay",
        details: err.response?.data,
      });
      return;
    }
    req.log.error({ err }, "Unexpected error in POST /create-invoice");
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

export default router;
