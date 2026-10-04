import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { config } from "../../apps/api/src/config.js";
import { localGatewayConfigured, momoSignature, verifyMomoNotification, verifyVnpayNotification, vnpaySigningData } from "../../apps/api/src/payments/local-gateways.js";
import { classifyStripeEvent } from "../../apps/api/src/payments/stripe.js";
import { validateCheckoutExtras } from "../../apps/api/src/user/order-router.js";

test("VNPay signed IPN rejects amount changes and ambiguous duplicate fields", () => {
  const fields = {vnp_TxnRef:"attempt01",vnp_Amount:"15000000",vnp_TmnCode:"MERCHANT",vnp_ResponseCode:"00",vnp_TransactionStatus:"00",vnp_OrderInfo:"Thanh toan & don hang"};
  const expected = "vnp_Amount=15000000&vnp_OrderInfo=Thanh+toan+%26+don+hang&vnp_ResponseCode=00&vnp_TmnCode=MERCHANT&vnp_TransactionStatus=00&vnp_TxnRef=attempt01";
  assert.equal(vnpaySigningData(fields),expected);
  const signature = createHmac("sha512","fixture-secret").update(expected).digest("hex");
  const params = new URLSearchParams({...fields,vnp_SecureHash:signature});
  assert.equal(verifyVnpayNotification(params,"fixture-secret"),true);
  params.set("vnp_Amount","10000");
  assert.equal(verifyVnpayNotification(params,"fixture-secret"),false);
  params.set("vnp_Amount",fields.vnp_Amount);
  params.append("vnp_Amount",fields.vnp_Amount);
  assert.equal(verifyVnpayNotification(params,"fixture-secret"),false);
});

test("MoMo IPN signs capture identity and result; tampered merchant transaction cannot pass", () => {
  const fields = {amount:150000,extraData:"",message:"Successful.",orderId:"attempt01",orderInfo:"Order 1",orderType:"momo_wallet",partnerCode:"PARTNER",payType:"qr",requestId:"attempt01",responseTime:1750000000000,resultCode:0,transId:123456};
  const raw = "accessKey=access&amount=150000&extraData=&message=Successful.&orderId=attempt01&orderInfo=Order 1&orderType=momo_wallet&partnerCode=PARTNER&payType=qr&requestId=attempt01&responseTime=1750000000000&resultCode=0&transId=123456";
  const body = {...fields,signature:createHmac("sha256","secret").update(raw).digest("hex")};
  assert.equal(verifyMomoNotification(body,"access","secret"),true);
  assert.equal(verifyMomoNotification({...body,resultCode:9000},"access","secret"),false);
  assert.equal(verifyMomoNotification({...body,orderId:"another-order"},"access","secret"),false);
  assert.equal(verifyMomoNotification({...body,amount:1},"access","secret"),false);
  assert.equal(verifyMomoNotification(body,"another-merchant","secret"),false);
  assert.equal(momoSignature({a:1,b:2},["a","b"],"secret"),createHmac("sha256","secret").update("a=1&b=2").digest("hex"));
});

test("unconfigured wallets remain unavailable even with a public callback origin", () => {
  const before = {apiPublicOrigin:config.apiPublicOrigin,vnpayTmnCode:config.vnpayTmnCode,vnpayHashSecret:config.vnpayHashSecret,momoPartnerCode:config.momoPartnerCode};
  try {
    config.apiPublicOrigin="https://api.example.test";config.vnpayTmnCode="";config.vnpayHashSecret="";config.momoPartnerCode="";
    assert.equal(localGatewayConfigured("VNPAY"),false);assert.equal(localGatewayConfigured("MOMO"),false);
    config.vnpayTmnCode="merchant";config.vnpayHashSecret="secret";config.apiPublicOrigin="http://localhost";
    assert.equal(localGatewayConfigured("VNPAY"),false);
  } finally {Object.assign(config,before);}
});

test("Stripe asynchronous authorization waits for capture and failure closes only the matching session", () => {
  const object={id:"cs_delayed",payment_intent:"pi_delayed",payment_status:"unpaid",metadata:{order_id:"order-1"}};
  assert.deepEqual(classifyStripeEvent({type:"checkout.session.completed",data:{object}}),{kind:"ignore",reason:"capture_pending"});
  assert.deepEqual(classifyStripeEvent({type:"checkout.session.async_payment_succeeded",data:{object:{...object,payment_status:"paid"}}}),{kind:"paid",orderId:"order-1",paymentIntentId:"pi_delayed",sessionId:"cs_delayed"});
  assert.deepEqual(classifyStripeEvent({type:"checkout.session.async_payment_failed",data:{object}}),{kind:"closed",orderId:"order-1",reason:"checkout.session.async_payment_failed",sessionId:"cs_delayed"});
});

test("fulfillment extras require real booleans and complete enabled recipient/invoice data", () => {
  assert.doesNotThrow(()=>validateCheckoutExtras({shipping_method:"express",is_gift:true,gift_message:"Happy birthday"}));
  assert.doesNotThrow(()=>validateCheckoutExtras({is_other_recipient:true,other_name:"Nguyen Van An",other_phone:"+84912345678"}));
  assert.doesNotThrow(()=>validateCheckoutExtras({is_vat_invoice:true,vat_company_name:"Company",vat_tax_code:"0123456789-001",vat_company_address:"Street 1",vat_email:"invoice@example.test"}));
  assert.throws(()=>validateCheckoutExtras({is_gift:"false"}));
  assert.throws(()=>validateCheckoutExtras({is_other_recipient:true,other_name:"An",other_phone:"abc"}));
  assert.throws(()=>validateCheckoutExtras({is_vat_invoice:true,vat_tax_code:"0123456789"}));
  assert.throws(()=>validateCheckoutExtras({gift_message:"x".repeat(501)}));
});
