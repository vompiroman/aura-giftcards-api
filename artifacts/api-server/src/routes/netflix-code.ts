import { Router, type IRouter } from "express";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { Readable } from "stream";
import { supabase } from "../lib/supabase";

const router: IRouter = Router();

const NETFLIX_CODE_REGEX = /\b(\d{6})\b/;

async function fetchNetflixCode(
  host: string,
  port: number,
  user: string,
  password: string,
  secure: boolean
): Promise<string | null> {
  const client = new ImapFlow({
    host,
    port,
    secure,
    auth: { user, pass: password },
    logger: false,
  });

  await client.connect();

  try {
    await client.mailboxOpen("INBOX");

    const messages = await client.search({
      from: "@netflix.com",
      subject: "",
    });

    if (!messages || messages.length === 0) {
      return null;
    }

    const latestUid = messages[messages.length - 1];
    if (latestUid === undefined) return null;

    for await (const msg of client.fetch([latestUid], { source: true })) {
      if (!msg.source) continue;
      const parsed = await simpleParser(Readable.from(msg.source));

      const bodyText = parsed.text ?? "";
      const bodyHtml = parsed.html ?? "";
      const combined = bodyText + " " + bodyHtml;

      const match = NETFLIX_CODE_REGEX.exec(combined);
      if (match) {
        return match[1] ?? null;
      }
    }

    return null;
  } finally {
    await client.logout();
  }
}

router.get("/get-netflix-code", async (req, res) => {
  try {
    const { order_id } = req.query;

    if (!order_id || typeof order_id !== "string") {
      res.status(400).json({ error: "Le paramètre order_id est requis." });
      return;
    }

    const { data: order, error: orderError } = await supabase
      .from("orders")
      .select("assigned_email, gift_card_id, status")
      .eq("order_id", order_id)
      .single();

    if (orderError || !order) {
      req.log.error({ orderError }, "Commande introuvable");
      res.status(404).json({ error: "Commande introuvable." });
      return;
    }

    if (order.status !== "completed") {
      res.status(402).json({ error: "La commande n'est pas encore payée." });
      return;
    }

    if (!order.assigned_email) {
      res.status(422).json({ error: "Aucun email assigné à cette commande." });
      return;
    }

    const { data: account, error: accountError } = await supabase
      .from("email_accounts")
      .select("imap_host, imap_port, imap_user, imap_password, imap_secure")
      .eq("email", order.assigned_email)
      .single();

    if (accountError || !account) {
      req.log.error({ accountError, email: order.assigned_email }, "Compte email IMAP introuvable");
      res.status(404).json({ error: "Compte email IMAP introuvable pour cet email assigné." });
      return;
    }

    const code = await fetchNetflixCode(
      account.imap_host,
      account.imap_port ?? 993,
      account.imap_user,
      account.imap_password,
      account.imap_secure ?? true
    );

    if (!code) {
      res.status(404).json({ error: "Aucun code Netflix trouvé dans la boîte mail." });
      return;
    }

    if (order.gift_card_id) {
      const { error: updateError } = await supabase
        .from("gift_cards")
        .update({ status: "used" })
        .eq("id", order.gift_card_id);

      if (updateError) {
        req.log.error({ updateError }, "Erreur lors du marquage de la carte cadeau comme utilisée");
      }
    }

    req.log.info({ order_id, email: order.assigned_email }, "Code Netflix extrait avec succès");

    res.json({ code });
  } catch (err) {
    req.log.error({ err }, "Unexpected error in GET /get-netflix-code");
    res.status(500).json({ error: "Erreur interne du serveur." });
  }
});

export default router;
