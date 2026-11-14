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

