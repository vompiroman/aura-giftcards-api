import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { supabaseAdmin as db, supabaseAuth } from "../lib/supabase";
import { requireAdmin, type AuthedRequest } from "../middleware/requireAdmin";
import { appendAuditLog } from "../lib/auditLog";
import { isTemporaryAuthError } from "../lib/authAvailability";
import { createDeposit, observeDeposit } from "../lib/partnerPayments";
import { computeCart, PRICES } from "../config/prices";
import { buildInvoicePdf } from "../lib/invoicePdf";
import { csvCell } from "../lib/adminOrderExport";
import { AUTO_APPROVE_PARTNERS, MAX_WALLET_DEPOSIT, MIN_UNLOCK_DEPOSIT, PARTNER_ENABLED, PARTNER_SCHEMA_READY, uuidPattern } from "../config/partnerTiers";

const uuid = z.string().regex(uuidPattern);
export const partnerQuestionnaire = z.object({
  monthly_volume:z.enum(["UNDER_5000","5000_15000","15000_50000","OVER_50000"]),
  sales_channel:z.enum(["WEB","MESSAGING","SOCIAL","PHYSICAL","OTHER"]),
  profile:z.enum(["INDEPENDENT","BUSINESS","CREATOR"]),
  products:z.string().trim().min(1).max(250),
  quick_contact:z.string().trim().min(3).max(120),
  additional_info:z.string().trim().max(1000).optional(),
});
const decision = z.object({status:z.enum(["APPROVED","REJECTED"]), note:z.string().trim().max(1000).optional()});
const deposit = z.object({
  amount:z.number().min(1).max(MAX_WALLET_DEPOSIT).refine(n=>Math.abs(Math.round(n*100)-n*100)<0.000001),
  request_key:uuid,
});
const router = Router();
const readLimiter = rateLimit({windowMs:60_000,limit:90,standardHeaders:true,legacyHeaders:false,validate:false});
const writeLimiter = rateLimit({windowMs:60_000,limit:12,standardHeaders:true,legacyHeaders:false,validate:false});

router.get("/partner/config", (_req,res)=>res.json({enabled:PARTNER_ENABLED()}));

function gate(_req: Request,res: Response,next: () => void) {
  if (PARTNER_ENABLED()) next();
  else res.status(404).json({error:"Programme partenaire indisponible.",code:"PARTNER_DISABLED"});
}
function ledgerGate(_req: Request,res: Response,next: () => void) {
  if (PARTNER_SCHEMA_READY()) next();
  else res.status(404).json({error:"Programme partenaire indisponible.",code:"PARTNER_DISABLED"});
}
async function user(req: Request,res: Response) {
  const token = /^Bearer\s+(.+)$/i.exec(req.get("authorization") || "")?.[1]?.trim();
  if (!token) {res.status(401).json({error:"Connecte-toi pour continuer."});return null;}
  const {data,error}=await supabaseAuth.auth.getUser(token);
  if (isTemporaryAuthError(error)) {res.status(503).json({error:"Service de connexion indisponible."});return null;}
  if (error || !data?.user?.id || !data.user.email) {res.status(401).json({error:"Connecte-toi pour continuer."});return null;}
  return {id:data.user.id,email:data.user.email.trim().toLowerCase()};
}
const notAvailable = (res:Response) => res.status(503).json({error:"Le programme partenaire est momentanément indisponible."});
function page(value:unknown) {
  const n=typeof value==="string" && /^\d{1,6}$/.test(value) ? Number(value) : 0;
  return Math.min(n,100_000);
}

async function approved(req: Request, res: Response) {
  res.set("Cache-Control", "private, no-store");
  const actor = await user(req, res);
  if (!actor) return null;
  const { data, error } = await db.from("partner_accounts").select("partner_status")
    .eq("user_id", actor.id).maybeSingle();
  if (error) {
    notAvailable(res);
    return null;
  }
  if (data?.partner_status !== "APPROVED") {
    res.status(403).json({ error: "Candidature partenaire non approuvée." });
    return null;
  }
  return actor;
}

const serviceFilter = z.enum(["netflix", "spotify", "crunchyroll", "snapchat"]);
const orderFilter = z.enum(["pending", "unpaid", "active", "expiring", "expired", "cancelled"]);
const preferences = z.object({
  client_reference: z.string().trim().max(80),
  reminders: z.boolean(),
  language: z.enum(["fr", "en", "ar"]),
});
const orderNumber = /^[A-Za-z0-9_-]{1,72}$/;
const language = z.enum(["fr","en","ar"]);
const ticketStatus = z.enum(["OPEN","IN_PROGRESS","RESOLVED"]);
const resale = z.number().min(0).max(1_000_000_000)
  .refine(n=>Number(n.toFixed(2))===n).nullable();

router.get("/partner/toolkit", gate, readLimiter, async (req,res)=>{
  try {
    const actor=await approved(req,res);
    if (!actor) return;
    const {data,error}=await db.rpc("partner_toolkit",{p_user:actor.id});
    if (error) return notAvailable(res);
    return res.json(data);
  } catch { return notAvailable(res); }
});

router.put("/partner/stock/alert", gate, writeLimiter, async (req,res)=>{
  try {
    const actor=await approved(req,res);
    if (!actor) return;
    const parsed=z.object({enabled:z.boolean(),language}).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({error:"Préférence invalide."});
    if (!parsed.data.enabled) {
      const {error}=await db.from("partner_stock_alerts").delete().eq("user_id",actor.id);
      if (error) return notAvailable(res);
      return res.json({subscribed:false});
    }
    const {data,error}=await db.rpc("subscribe_partner_stock",{p_user:actor.id,p_language:parsed.data.language});
    if (error) return notAvailable(res);
    return res.json({subscribed:data===true});
  } catch { return notAvailable(res); }
});

router.get("/partner/orders/:id/margin", gate, readLimiter, async (req,res)=>{
  try {
    const actor=await approved(req,res);
    if (!actor) return;
    if (!orderNumber.test(String(req.params.id))) return res.sendStatus(404);
    const {data,error}=await db.rpc("partner_order_margin",{p_user:actor.id,p_order:req.params.id});
    if (error) return notAvailable(res);
    if (!data) return res.sendStatus(404);
    return res.json(data);
  } catch { return notAvailable(res); }
});

router.put("/partner/orders/:id/margin", gate, writeLimiter, async (req,res)=>{
  try {
    const actor=await approved(req,res);
    if (!actor) return;
    if (!orderNumber.test(String(req.params.id))) return res.sendStatus(404);
    const parsed=resale.safeParse(req.body?.resale_price);
    if (!parsed.success) return res.status(400).json({error:"Prix de revente invalide."});
    const args={p_user:actor.id,p_order:req.params.id};
    const {data,error}=await db.rpc("save_partner_resale",{...args,p_resale:parsed.data});
    if (error) return notAvailable(res);
    if (!data) return res.sendStatus(404);
    const margin=await db.rpc("partner_order_margin",args);
    if (margin.error) return notAvailable(res);
    return res.json(margin.data);
  } catch { return notAvailable(res); }
});

const ticketFields="id,order_id,message,status,reply,created_at,updated_at";
router.get("/partner/support", gate, readLimiter, async (req,res)=>{
  try {
    const actor=await approved(req,res);
    if (!actor) return;
    const offset=page(req.query.offset);
    const {data,error}=await db.from("partner_support_tickets").select(ticketFields)
      .eq("user_id",actor.id).order("created_at",{ascending:false}).order("id",{ascending:false}).range(offset,offset+20);
    if (error) return notAvailable(res);
    return res.json({tickets:data.slice(0,20),has_more:data.length>20});
  } catch { return notAvailable(res); }
});

router.post("/partner/orders/:id/support",gate,writeLimiter,async (req,res)=>{
  try {
    const actor=await approved(req,res);
    if (!actor) return;
    if (!orderNumber.test(String(req.params.id))) return res.sendStatus(404);
    const parsed=z.string().trim().min(10).max(1500).safeParse(req.body?.message);
    if (!parsed.success) return res.status(400).json({error:"Décris le problème en 10 à 1 500 caractères."});
    const {data,error}=await db.rpc("open_partner_ticket",{p_user:actor.id,p_order:req.params.id,p_message:parsed.data});
    if (error?.code==="23505") return res.status(409).json({error:"Une demande est déjà ouverte pour cette commande."});
    if (error) return notAvailable(res);
    if (!data) return res.sendStatus(404);
    return res.status(201).json({id:data});
  } catch { return notAvailable(res); }
});

router.get("/admin/partner-support",gate,readLimiter,requireAdmin,async (req,res)=>{
  const filter=ticketStatus.safeParse(req.query.status);
  const offset=page(req.query.offset);
  let query=db.from("partner_support_tickets").select(ticketFields);
  if (filter.success) query=query.eq("status",filter.data);
  const {data,error}=await query.order("created_at",{ascending:false}).order("id",{ascending:false}).range(offset,offset+20);
  if (error) return notAvailable(res);
  return res.json({tickets:data.slice(0,20),has_more:data.length>20});
});

router.put("/admin/partner-support/:id",gate,writeLimiter,requireAdmin,async (req:AuthedRequest,res)=>{
  const parsed=z.object({status:ticketStatus,reply:z.string().trim().max(1500)}).safeParse(req.body);
  if (!uuid.safeParse(req.params.id).success) return res.sendStatus(404);
  if (!parsed.success) return res.status(400).json({error:"Vérifie les informations de la demande."});
  const {data,error}=await db.from("partner_support_tickets").update({
    status:parsed.data.status,reply:parsed.data.reply||null,updated_at:new Date().toISOString(),
  }).eq("id",req.params.id).select("id,order_id").maybeSingle();
  if (error?.code==="23505") return res.status(409).json({error:"Une demande est déjà ouverte pour cette commande."});
  if (error) return notAvailable(res);
  if (!data) return res.sendStatus(404);
  void appendAuditLog({action:"partner_support_update",actorUserId:req.adminUserId,targetType:"partner_support_ticket",
    targetId:data.id,details:{status:parsed.data.status,order_id:data.order_id}});
  return res.json({saved:true});
});

router.get("/partner/stock", gate, readLimiter, async (req, res) => {
  try {
    if (!await approved(req,res)) return;
    const delivery = await db.from("inventory").select("assigned_at")
      .ilike("service","netflix").eq("is_used",true)
      .not("assigned_order_id","is",null).not("assigned_at","is",null)
      .order("assigned_at",{ascending:false}).limit(1).maybeSingle();
    if (delivery.error) return notAvailable(res);
    const { data, error } = await db.rpc("partner_netflix_stock");
    if (error) return notAvailable(res);
    return res.json({ profiles:data.profiles,accounts:data.accounts,last_delivery_at:delivery.data?.assigned_at ?? null,
      checked_at: new Date().toISOString() });
  } catch { return notAvailable(res); }
});

router.get("/partner/basket", gate, readLimiter, async (req, res) => {
  try {
    const actor = await approved(req,res);
    if (!actor) return;
    const { data, error } = await db.from("partner_accounts").select("saved_basket")
      .eq("user_id", actor.id).single();
    if (error) return notAvailable(res);
    return res.json({ catalog: PRICES, items: data.saved_basket });
  } catch { return notAvailable(res); }
});

router.put("/partner/basket", gate, writeLimiter, async (req, res) => {
  try {
    const actor = await approved(req,res);
    if (!actor) return;
    const raw = req.body?.items;
    const result = computeCart(raw);
    const empty = Array.isArray(raw) && raw.length === 0;
    const totalQuantity = result.cleanItems.reduce((sum,item) => sum + item.quantity, 0);
    if (!empty && (!result.ok || totalQuantity > 20)) return res.status(400).json({ error: "Panier invalide." });
    const items = empty ? [] : result.cleanItems;
    const { error } = await db.from("partner_accounts").update({ saved_basket: items }).eq("user_id", actor.id);
    if (error) return notAvailable(res);
    return res.json({ items });
  } catch { return notAvailable(res); }
});

router.get("/partner/orders", gate, readLimiter, async (req, res) => {
  try {
    const actor = await approved(req,res);
    if (!actor) return;
    const service = serviceFilter.safeParse(req.query.service);
    const status = orderFilter.safeParse(req.query.status);
    const { data, error } = await db.rpc("partner_order_page", {
      p_user: actor.id, p_service: service.data ?? null, p_status: status.data ?? null, p_offset: page(req.query.offset),
    });
    if (error) return notAvailable(res);
    const orders = data || [];
    return res.json({
      orders: orders.slice(0,20).map((order: { items: unknown }) => ({
        ...order,
        items: Array.isArray(order.items) ? order.items.map(item => ({
          name: String(item?.name || item?.service || ""), quantity: Number(item?.quantity || 1),
        })) : [],
      })),
      has_more: orders.length > 20,
    });
  } catch { return notAvailable(res); }
});

router.put("/partner/orders/:id/preferences", gate, writeLimiter, async (req, res) => {
  try {
    const actor = await approved(req,res);
    if (!actor) return;
    const parsed = preferences.safeParse(req.body);
    if (!orderNumber.test(String(req.params.id))) return res.sendStatus(404);
    if (!parsed.success) return res.status(400).json({ error: "Vérifie les informations de la commande." });
    const { data, error } = await db.rpc("save_partner_order_settings", {
      p_user: actor.id, p_order: req.params.id, p_reference: parsed.data.client_reference || null,
      p_reminders: parsed.data.reminders, p_language: parsed.data.language,
    });
    if (error) return notAvailable(res);
    if (!data) return res.sendStatus(404);
    return res.json({ saved: true });
  } catch { return notAvailable(res); }
});

router.get("/partner/orders/:id/invoice.pdf", gate, readLimiter, async (req, res) => {
  try {
    const actor = await approved(req,res);
    if (!actor) return;
    if (!orderNumber.test(String(req.params.id))) return res.sendStatus(404);
    const { data, error } = await db.from("orders")
      .select("order_id,assigned_email,amount,subtotal_amount,discount_amount,items,created_at,payment_confirmed_at")
      .eq("partner_user_id", actor.id).eq("order_id", req.params.id).eq("payment_status", "paid").maybeSingle();
    if (error) return notAvailable(res);
    if (!data) return res.sendStatus(404);
    return res.attachment(`aura-${data.order_id}.pdf`).type("application/pdf").send(buildInvoicePdf({
      job_order_id: data.order_id, customer_email: data.assigned_email || actor.email,
      total_amount: data.amount, subtotal_amount: data.subtotal_amount, discount_amount: data.discount_amount,
      order_items: data.items, ordered_at: data.created_at, paid_at: data.payment_confirmed_at || data.created_at,
    }));
  } catch { return notAvailable(res); }
});

function monthRange(value: unknown) {
  if (typeof value !== "string" || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(value)) return null;
  const [year, month] = value.split("-").map(Number);
  // Algeria uses UTC+01:00 year-round.
  return { p_from: new Date(Date.UTC(year,month - 1,1,-1)).toISOString(),
    p_to: new Date(Date.UTC(year,month,1,-1)).toISOString() };
}

router.get("/partner/monthly", gate, readLimiter, async (req, res) => {
  try {
    const actor = await approved(req,res);
    if (!actor) return;
    const range = monthRange(req.query.month);
    if (!range) return res.status(400).json({ error: "Mois invalide." });
    const { data, error } = await db.rpc("partner_monthly_summary", { p_user: actor.id, ...range });
    if (error) return notAvailable(res);
    return res.json(data);
  } catch { return notAvailable(res); }
});

router.get("/partner/monthly.csv", gate, readLimiter, async (req, res) => {
  try {
    const actor = await approved(req,res);
    if (!actor) return;
    const range = monthRange(req.query.month);
    if (!range) return res.status(400).json({ error: "Mois invalide." });
    const rows: unknown[][] = [["Date (UTC)","Type","Commande","Montant (DZD)","Remise (DZD)","Solde (DZD)","Référence client"]];
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await db.rpc("partner_monthly_entries", {
        p_user: actor.id, ...range, p_offset: offset,
      });
      if (error) return notAvailable(res);
      for (const row of data || []) rows.push([row.occurred_at,row.kind,row.order_id,row.amount,row.discount,row.balance_after,row.client_reference]);
      if (!data || data.length < 500) break;
      if (offset >= 10_000) return res.status(413).json({ error: "Ce bilan contient trop de lignes pour être exporté." });
    }
    return res.attachment(`aura-partenaire-${req.query.month}.csv`).type("text/csv")
      .send("\uFEFF" + rows.map(row => row.map(csvCell).join(";")).join("\r\n"));
  } catch { return notAvailable(res); }
});

router.get("/partner",gate,readLimiter,async (req,res)=>{
  try {
    const actor=await user(req,res); if(!actor) return;
    const [account,tiers]=await Promise.all([
      db.from("partner_accounts").select("partner_status,wallet_balance,has_unlocked_tiers,total_spent,partner_tier").eq("user_id",actor.id).maybeSingle(),
      db.from("partner_tiers").select("tier,threshold,discount_percent").order("threshold"),
    ]);
    if(account.error || tiers.error) return notAvailable(res);
    const state=account.data ?? {partner_status:"NONE",wallet_balance:0,has_unlocked_tiers:false,total_spent:0,partner_tier:"LOCKED"};
    const current=tiers.data?.find(t=>t.tier===state.partner_tier);
    const next=tiers.data?.find(t=>Number(t.threshold)>Number(state.total_spent));
    return res.json({ ...state,currency:"DZD",minimum_unlock_deposit:MIN_UNLOCK_DEPOSIT,tiers:tiers.data,
      discount_percent:state.partner_status==="APPROVED" && state.has_unlocked_tiers ? current?.discount_percent || 0 : 0,
      next_tier:state.has_unlocked_tiers && next ? {...next,remaining:Math.round((Number(next.threshold)-Number(state.total_spent))*100)/100} : null,
    });
  } catch {return notAvailable(res);}
});

router.post("/partner/applications",gate,writeLimiter,async (req,res)=>{
  try {
    const actor=await user(req,res); if(!actor) return;
    const parsed=partnerQuestionnaire.safeParse(req.body);
    if(!parsed.success) return res.status(400).json({error:"Vérifie les réponses au questionnaire."});
    const {data,error}=await db.rpc("submit_partner_application",{p_user:actor.id,p_email:actor.email,p_answers:parsed.data,p_auto:AUTO_APPROVE_PARTNERS()});
    if(error?.message==="PARTNER_ALREADY_APPLIED") return res.status(409).json({error:"Une candidature existe déjà."});
    if(error) return notAvailable(res);
    return res.status(201).json({partner_status:data});
  } catch {return notAvailable(res);}
});

router.get("/partner/wallet",ledgerGate,readLimiter,async (req,res)=>{
  try {
    const actor=await user(req,res); if(!actor) return;
    const offset=page(req.query.offset);
    const {data,error}=await db.from("wallet_transactions")
      .select("id,kind,status,amount,balance_after,currency,order_id,created_at,confirmed_at,payment_url")
      .eq("user_id",actor.id).order("created_at",{ascending:false}).order("id",{ascending:false}).range(offset,offset+24);
    if(error) return notAvailable(res);
    return res.json({transactions:(data || []).map(tx=>({...tx,payment_url:tx.status==="PENDING" ? tx.payment_url : null})),has_more:data?.length===25});
  } catch {return notAvailable(res);}
});

router.post("/partner/wallet/deposits",gate,writeLimiter,async (req,res)=>{
  try {
    const actor=await user(req,res); if(!actor) return;
    const parsed=deposit.safeParse(req.body);
    if(!parsed.success) return res.status(400).json({error:"Montant de recharge invalide."});
    const result=await createDeposit(actor.id,actor.email,parsed.data.request_key,parsed.data.amount);
    return res.status(201).json(result);
  } catch(error) {
    const code=(error as {message?:string})?.message || "";
    if(code==="PARTNER_NOT_APPROVED") return res.status(403).json({error:"Candidature partenaire non approuvée."});
    if(code==="WALLET_DEPOSIT_LIMIT") return res.status(429).json({error:"Trop de recharges en attente."});
    if(["WALLET_REQUEST_CONFLICT","WALLET_INVOICE_IN_PROGRESS"].includes(code)) return res.status(409).json({error:"Une recharge est déjà en cours."});
    return notAvailable(res);
  }
});

router.post("/partner/wallet/deposits/:id/verify",ledgerGate,writeLimiter,async (req,res)=>{
  try {
    const actor=await user(req,res); if(!actor) return;
    if(!uuid.safeParse(req.params.id).success) return res.sendStatus(404);
    const {data,error}=await db.from("wallet_transactions").select("id,status,provider_invoice_id")
      .eq("user_id",actor.id).eq("id",req.params.id).eq("kind","DEPOSIT").maybeSingle();
    if(error) return notAvailable(res);
    if(!data) return res.sendStatus(404);
    return res.json({status:await observeDeposit(data)});
  } catch {return notAvailable(res);}
});

router.get("/admin/partner-applications",gate,readLimiter,requireAdmin,async (req,res)=>{
  const offset=page(req.query.offset);
  const {data,error}=await db.from("partner_applications").select("*")
    .order("submitted_at",{ascending:false}).order("id",{ascending:false}).range(offset,offset+24);
  if(error) return notAvailable(res);
  return res.json({applications:data,has_more:data?.length===25});
});

router.post("/admin/partner-applications/:id/review",gate,writeLimiter,requireAdmin,async (req:AuthedRequest,res)=>{
  const parsed=decision.safeParse(req.body);
  if(!parsed.success || !uuid.safeParse(req.params.id).success) return res.status(400).json({error:"Décision invalide."});
  const {data,error}=await db.rpc("review_partner_application",{
    p_id:req.params.id,p_admin:req.adminUserId,p_status:parsed.data.status,p_note:parsed.data.note ?? null,
  });
  if(error) return notAvailable(res);
  if(data!==true) return res.status(409).json({error:"La candidature a déjà été traitée."});
  void appendAuditLog({action:"partner_application_review",actorUserId:req.adminUserId,targetType:"partner_application",
    targetId:String(req.params.id),details:{status:parsed.data.status}});
  return res.json({partner_status:parsed.data.status});
});

export default router;
