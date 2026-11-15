import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import request from "supertest";
const mocks=vi.hoisted(()=>({rpc:vi.fn(),from:vi.fn(),getUser:vi.fn(),getInvoice:vi.fn()}));
vi.mock("../../src/lib/supabase",()=>({
  supabaseAdmin:{rpc:mocks.rpc,from:mocks.from},
  supabaseAuth:{auth:{getUser:mocks.getUser}},
}));
vi.mock("../../src/lib/slickpay",()=>({fetchSlickPayInvoice:mocks.getInvoice,createSlickPayDepositInvoice:vi.fn()}));
import { Router } from "express";
import express from "express";
import router from "../../src/routes/partners";
import webhook from "../../src/routes/webhook";
const app=express();
const routes=Router();
routes.use(router,webhook);
app.use(express.json(),routes);
const customer="0422d228-1727-4f44-99ef-e6e1da59b912";
const tx="f13e03cf-be01-4bc6-a302-07a1be983e22";
const valid={monthly_volume:"UNDER_5000",sales_channel:"WEB",profile:"INDEPENDENT",products:"Netflix",quick_contact:"@seller"};
const chain=(result:unknown)=>{
  const builder:any={select:()=>builder,eq:vi.fn(()=>builder),maybeSingle:async()=>result};
  return builder;
};
describe("partner boundaries",()=>{
  beforeEach(()=>{
    vi.resetAllMocks();
    vi.stubEnv("PARTNER_PROGRAM_ENABLED","true");
    vi.stubEnv("AUTO_APPROVE_PARTNERS","false");
    mocks.getUser.mockResolvedValue({data:{user:{id:customer,email:"customer@example.invalid",app_metadata:{}}},error:null});
  });
  afterEach(()=>vi.unstubAllEnvs());
  it("rejects unauthenticated or incomplete applications",async()=>{
    await request(app).post("/partner/applications").send(valid).expect(401);
    await request(app).post("/partner/applications").set("Authorization","Bearer test").send({}).expect(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("uses the authenticated identity and server-only auto approval policy",async()=>{
    mocks.rpc.mockResolvedValue({data:"PENDING",error:null});
    await request(app).post("/partner/applications").set("Authorization","Bearer test")
      .send({...valid,user_id:tx,partner_status:"APPROVED"}).expect(201);
    expect(mocks.rpc).toHaveBeenCalledWith("submit_partner_application",{p_user:customer,p_email:"customer@example.invalid",p_answers:valid,p_auto:false});
    vi.stubEnv("AUTO_APPROVE_PARTNERS","true");
    mocks.rpc.mockResolvedValue({data:"APPROVED",error:null});
    const response=await request(app).post("/partner/applications").set("Authorization","Bearer test").send(valid).expect(201);
    expect(response.body.partner_status).toBe("APPROVED");
    expect(mocks.rpc.mock.lastCall?.[1].p_auto).toBe(true);
  });
  it("prevents customers from reviewing applications",async()=>{
    await request(app).post(`/admin/partner-applications/${tx}/review`).set("Authorization","Bearer test").send({status:"APPROVED"}).expect(404);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("restricts deposit verification to the owner",async()=>{
    const select=chain({data:null,error:null});mocks.from.mockReturnValue(select);
    await request(app).post(`/partner/wallet/deposits/${tx}/verify`).set("Authorization","Bearer test").send({status:"paid",amount:3000}).expect(404);
    expect(select.eq).toHaveBeenCalledWith("user_id",customer);
    expect(mocks.getInvoice).not.toHaveBeenCalled();
  });
  it("returns only current Netflix stock to approved partners",async()=>{
    await request(app).get("/partner/stock").expect(401);
    mocks.from.mockReturnValueOnce(chain({data:{partner_status:"PENDING"},error:null}));
    await request(app).get("/partner/stock").set("Authorization","Bearer test").expect(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
    mocks.from.mockReturnValueOnce(chain({data:{partner_status:"APPROVED"},error:null}));
    mocks.rpc.mockResolvedValueOnce({data:{profiles:5,accounts:2},error:null});
    const response=await request(app).get("/partner/stock").set("Authorization","Bearer test").expect(200);
    expect(response.body).toEqual({profiles:5,accounts:2,checked_at:expect.any(String)});
    expect(response.headers["cache-control"]).toContain("no-store");
  });
  it("queries only the signed-in partner's orders and omits credential fields",async()=>{
    mocks.from.mockReturnValue(chain({data:{partner_status:"APPROVED"},error:null}));
    mocks.rpc.mockResolvedValue({data:[{order_id:"ORD-own",items:[{name:"Netflix Premium 1 mois",quantity:1,pin:"fake"}]}],error:null});
    const response=await request(app).get(`/partner/orders?service=netflix&status=expiring&user_id=${tx}`)
      .set("Authorization","Bearer test").expect(200);
    expect(mocks.rpc).toHaveBeenCalledWith("partner_order_page",{p_user:customer,p_service:"netflix",p_status:"expiring",p_offset:0});
    expect(response.body.orders[0].items).toEqual([{name:"Netflix Premium 1 mois",quantity:1}]);
    mocks.rpc.mockResolvedValue({data:false,error:null});
    await request(app).put("/partner/orders/ORD-other/preferences").set("Authorization","Bearer test")
      .send({client_reference:"Ref", reminders:true, language:"fr", user_id:tx}).expect(404);
    expect(mocks.rpc).toHaveBeenLastCalledWith("save_partner_order_settings",{
      p_user:customer,p_order:"ORD-other",p_reference:"Ref",p_reminders:true,p_language:"fr",
    });
  });
  it("checks ownership and paid status for a downloadable invoice",async()=>{
    const orders=chain({data:null,error:null});
    mocks.from.mockReturnValueOnce(chain({data:{partner_status:"APPROVED"},error:null})).mockReturnValueOnce(orders);
    await request(app).get("/partner/orders/ORD-other/invoice.pdf").set("Authorization","Bearer test").expect(404);
    expect(orders.eq).toHaveBeenCalledWith("partner_user_id",customer);
    expect(orders.eq).toHaveBeenCalledWith("payment_status","paid");
  });
  it("uses the Algeria calendar and neutralizes spreadsheet formulas in the export",async()=>{
    mocks.from.mockReturnValue(chain({data:{partner_status:"APPROVED"},error:null}));
    mocks.rpc.mockResolvedValue({data:[{order_id:"ORD-own",amount:600,client_reference:"=1+2"}],error:null});
    const response=await request(app).get("/partner/monthly.csv?month=2026-11")
      .set("Authorization","Bearer test").expect(200);
    expect(mocks.rpc).toHaveBeenCalledWith("partner_monthly_entries",{
      p_user:customer,p_from:"2026-10-31T23:00:00.000Z",p_to:"2026-11-30T23:00:00.000Z",p_offset:0,
    });
    expect(response.text).toContain(`"'=1+2"`);
  });
  it("subscribes only the approved actor, with the requested supported language",async()=>{
    mocks.from.mockReturnValue(chain({data:{partner_status:"APPROVED"},error:null}));
    mocks.rpc.mockResolvedValue({data:true,error:null});
    const response=await request(app).put("/partner/stock/alert").set("Authorization","Bearer test")
      .send({enabled:true,language:"ar",user_id:tx,email:"other@example.invalid"}).expect(200);
    expect(response.body.subscribed).toBe(true);
    expect(mocks.rpc).toHaveBeenCalledWith("subscribe_partner_stock",{p_user:customer,p_language:"ar"});
  });
  it("does not allow another order's margin or support request to be changed",async()=>{
    mocks.from.mockReturnValue(chain({data:{partner_status:"APPROVED"},error:null}));
    mocks.rpc.mockResolvedValue({data:null,error:null});
    await request(app).put("/partner/orders/ORD-other/margin").set("Authorization","Bearer test")
      .send({resale_price:1200.5,amount:1}).expect(404);
    expect(mocks.rpc).toHaveBeenLastCalledWith("save_partner_resale",{p_user:customer,p_order:"ORD-other",p_resale:1200.5});
    await request(app).post("/partner/orders/ORD-other/support").set("Authorization","Bearer test")
      .send({message:"La commande est en attente."}).expect(404);
    expect(mocks.rpc).toHaveBeenLastCalledWith("open_partner_ticket",{
      p_user:customer,p_order:"ORD-other",p_message:"La commande est en attente.",
    });
    await request(app).get("/admin/partner-support").set("Authorization","Bearer test").expect(404);
  });
  it("never trusts webhook money or payment status; existing deposits work during suspension",async()=>{
    vi.stubEnv("PARTNER_PROGRAM_ENABLED","false");
    mocks.from.mockReturnValue(chain({data:{id:tx,status:"PENDING",provider_invoice_id:"invoice-1"},error:null}));
    mocks.getInvoice.mockResolvedValue({state:"unpaid",amount:3000});
    mocks.rpc.mockResolvedValue({data:"PENDING",error:null});
    await request(app).post("/webhook").send({invoice_id:"invoice-1",status:"paid",amount:90000}).expect(200);
    expect(mocks.getInvoice).toHaveBeenCalledWith("invoice-1",8000);
    expect(mocks.rpc).toHaveBeenCalledWith("observe_wallet_deposit",{p_id:tx,p_invoice:"invoice-1",p_provider_state:"unpaid",p_amount:3000});
  });
});
