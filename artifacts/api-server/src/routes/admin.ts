import { Router } from "express";
import rateLimit from "express-rate-limit";
import { requireAdmin, AuthedRequest } from "../middleware/requireAdmin";
import { notifyAdmin } from "../lib/notifyAdmin";

const router = Router();

const testAlertLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de tests d'alerte, patientez une minute." },
});

router.get("/admin/test-alert", testAlertLimiter, requireAdmin, async (req: AuthedRequest, res) => {
  const sent = await notifyAdmin(
    `Test d'alerte déclenché par ${req.adminEmail}. Si tu vois cette notification sur ton téléphone, la chaîne d'alerte fonctionne. ✅`,
    {
      level: "critical",
      orderId: "TEST-" + Date.now(),
      service: "Test",
      email: req.adminEmail,
      dedupeKey: "test-alert-" + Date.now(),
    }
  );

  if (sent) {
    res.json({
      ok: true,
      message: "Alerte envoyée à Discord. Vérifie la notification push sur ton mobile.",
    });
  } else {
    res.status(502).json({
      ok: false,
      message:
        "L'alerte n'a pas pu être envoyée. Vérifie DISCORD_ADMIN_WEBHOOK_URL, la connectivité, ou les logs serveur.",
    });
  }
});

export default router;
