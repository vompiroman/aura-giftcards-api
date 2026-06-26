import { Router, type IRouter } from "express";
import axios from "axios";

const router: IRouter = Router();

const SLICKPAY_PUBLIC_KEY = process.env["SLICKPAY_PUBLIC_KEY"];
const SLICKPAY_ACCOUNT_UUID = process.env["SLICKPAY_ACCOUNT_UUID"];

router.post("/create-invoice", async (req, res) => {
  try {
    const { amount, customer_name, customer_email, description, items, order_id, return_url } = req.body;

    if (!amount || !customer_name || !customer_email || !order_id) {
      res.status(400).json({ error: "amount, customer_name, customer_email et order_id sont requis." });
      return;
    }

    const payload = {
      amount,
      firstname: customer_name,
      lastname: "Client",
      email: customer_email,
      note: description ?? `Commande #${order_id}`,
      items: items && items.length > 0 ? items : [
        {
          name: description ?? "Carte Cadeau",
          price: amount,
          quantity: 1
        }
      ],
      returnUrl: return_url || "http://localhost:3000/?payment=success&order_id=" + order_id
    };

    const response = await axios.post(
      "https://prodapi.slick-pay.com/api/v2/users/invoices",
      payload,
      {
        headers: {
          Authorization: `Bearer ${SLICKPAY_PUBLIC_KEY}`,
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
