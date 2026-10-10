import test from "node:test";
import assert from "node:assert/strict";
import { CheckoutOtpService } from "../../apps/api/src/user/checkout-service.js";
import { issueGuestPhoneAccess, issueGuestOrderAccess, hasGuestOrderAccess } from "../../apps/api/src/user/order-access.js";
import { customerPaymentFacts } from "../../apps/api/src/user/order-payment-presentation.js";
import { createReturnService } from "../../apps/api/src/returns/return-service.js";
import type { ReturnRepository } from "../../apps/api/src/returns/return-repository.js";
import { HttpError, sendError } from "../../apps/api/src/http.js";
import type { AuthContext, HttpResponse } from "../../apps/api/src/types.js";

test("checkout code expires after 60 seconds while its verified proof permits a 15-minute checkout", () => {
  let now = Date.now();
  const otp = new CheckoutOtpService();
  const session = otp.issue({fullName:"Nguyen Van An",phone:"0912345678",email:null,ip:"local"},now);
  const token = otp.prove("0912345678",session.otpCode);
  now += 61_000;
  assert.throws(()=>otp.verify("0912345678",session.otpCode,now),error=>error instanceof HttpError && error.code === "EXPIRED_OTP");
  assert.equal(otp.verifyForCheckout("0912345678",null,token).contact.phone,"0912345678");
  assert.throws(()=>otp.verifyForCheckout("0987654321",null,token),error=>error instanceof HttpError && error.status === 401);
  otp.consume("0912345678");
  assert.throws(()=>otp.verifyForCheckout("0912345678",null,token),error=>error instanceof HttpError && error.status === 401);
});

test("a phone session authorizes its phone's orders and a checkout token authorizes only its own order",()=>{
  const samePhone={order_id:"order-a",shipping_phone:"0912345678"};
  const otherPhone={order_id:"order-b",shipping_phone:"0987654321"};
  const phoneToken=issueGuestPhoneAccess("0912345678");
  assert.equal(hasGuestOrderAccess(samePhone,{guest_access_token:phoneToken}),true);
  assert.equal(hasGuestOrderAccess(otherPhone,{guest_access_token:phoneToken}),false);
  const scoped=issueGuestOrderAccess("order-a");
  assert.equal(hasGuestOrderAccess(samePhone,{order_access_token:scoped}),true);
  assert.equal(hasGuestOrderAccess({...samePhone,order_id:"order-c"},{guest_access_token:scoped}),false);
  assert.equal(hasGuestOrderAccess(samePhone,{guest_access_token:phoneToken.slice(0,-1)+"x"}),false);
  assert.equal(hasGuestOrderAccess(samePhone,{phone:"0912345678"}),false);
});

test("a failed retry does not erase capture or partial refund facts",()=>{
  const facts=customerPaymentFacts([
    {payment_status:"failed",created_at:"2026-10-03T12:00:00Z"},
    {payment_status:"paid",refunded_amount:200000,created_at:"2026-10-03T11:00:00Z"}
  ]);
  assert.equal(facts.payment_status,"paid");
  assert.equal(facts.refund_status,"completed");
  assert.equal(facts.refunded_amount,200000);
  assert.equal(customerPaymentFacts([]).payment_status,"pending");
});

const context={authUser:{id:"operator"},roleCode:"admin_operator_cskh_dt",accessToken:"jwt"} as AuthContext;
test("warehouse QA confirms every individual line and persists the exact receipt facts",async()=>{
  let receipt:unknown;
  const service=createReturnService({repository:{
    getReturn:async()=>({status:"RETURN_IN_TRANSIT",version:3}),
    listReturnLines:async()=>({rows:[{order_item_id:"line-a",quantity:1},{order_item_id:"line-b",quantity:2}]}),
    updateReturnStatus:async(_id,input)=>{receipt=input.receipts;return {status:input.status};}
  } as unknown as ReturnRepository});
  const base={status:"RECEIVED",expectedVersion:3,conditionCheckResult:"qa_pass",imageProof:"https://proof.example/warehouse.jpg"};
  await assert.rejects(()=>service.updateReturnStatus(context,"return",{...base,confirmedItemId:"line-a",receivedQuantity:3}),error=>error instanceof HttpError && error.code === "ITEM_ID_MISMATCH");
  await assert.rejects(()=>service.updateReturnStatus(context,"return",{...base,items:[{orderItemId:"line-a",receivedQuantity:1,matchesProduct:true},{orderItemId:"line-b",receivedQuantity:1,matchesProduct:true}]}),error=>error instanceof HttpError && error.code === "QTY_MISMATCH");
  const items=[{orderItemId:"line-a",receivedQuantity:1,matchesProduct:true},{orderItemId:"line-b",receivedQuantity:2,matchesProduct:true}];
  assert.equal((await service.updateReturnStatus(context,"return",{...base,items})).status,"RECEIVED");
  assert.deepEqual(receipt,items);
});

test("a stale return version and missing QA never invoke the payment gateway",async()=>{
  let calls=0;
  const service=createReturnService({repository:{getReturn:async()=>({order_id:"order",status:"WAITING_RETURN",version:4,return_type:"refund"})} as unknown as ReturnRepository,refunds:{refund:async()=>{calls++;return {status:"refunded"};}}});
  await assert.rejects(()=>service.triggerStripeRefund(context,"return",{expectedVersion:3}),error=>error instanceof HttpError && error.code === "VERSION_CONFLICT");
  await assert.rejects(()=>service.triggerStripeRefund(context,"return",{expectedVersion:4}),error=>error instanceof HttpError && error.code === "WAREHOUSE_QA_REQUIRED");
  assert.equal(calls,0);
});

test("HTTP errors never expose raw database query or UUID diagnostics",()=>{
  let body="";
  const response={writeHead(){},end(value:string){body=value;}} as unknown as HttpResponse;
  sendError(response,new HttpError(400,"SUPABASE_ERROR","invalid input syntax for type uuid: secret-value",{query:"orders.order_id",code:"22P02"}));
  assert.doesNotMatch(body,/secret-value|orders\.order_id|22P02/);
  assert.equal(JSON.parse(body).error.details,undefined);
});
