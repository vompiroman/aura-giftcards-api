import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { supabaseAdmin as db, supabaseAuth } from "../lib/supabase";
import { requireAdmin, type AuthedRequest } from "../middleware/requireAdmin";
import { appendAuditLog } from "../lib/auditLog";
import { isTemporaryAuthError } from "../lib/authAvailability";
import { createDeposit, observeDeposit } from "../lib/partnerPayments";
import { AUTO_APPROVE_PARTNERS, MAX_WALLET_DEPOSIT, MIN_UNLOCK_DEPOSIT, PARTNER_ENABLED, uuidPattern } from "../config/partnerTiers";

const uuid = z.string().regex(uuidPattern);
const questionnaire = z.object({
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
    const parsed=questionnaire.safeParse(req.body);
    if(!parsed.success) return res.status(400).json({error:"Vérifie les réponses au questionnaire."});
    const {data,error}=await db.rpc("submit_partner_application",{p_user:actor.id,p_email:actor.email,p_answers:parsed.data,p_auto:AUTO_APPROVE_PARTNERS()});
    if(error?.message==="PARTNER_ALREADY_APPLIED") return res.status(409).json({error:"Une candidature existe déjà."});
    if(error) return notAvailable(res);
    return res.status(201).json({partner_status:data});
  } catch {return notAvailable(res);}
});

router.get("/partner/wallet",gate,readLimiter,async (req,res)=>{
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

router.post("/partner/wallet/deposits/:id/verify",gate,writeLimiter,async (req,res)=>{
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

