import test from "node:test";
import assert from "node:assert/strict";
import { handleReviewsRoute } from "../../apps/api/src/user/reviews.js";
import { HttpError } from "../../apps/api/src/http.js";
import { config } from "../../apps/api/src/config.js";
import type { AuthContext, HttpRequest, HttpResponse } from "../../apps/api/src/types.js";

const context={profile:{user_id:"owner",full_name:"Nguyen Van An"}} as unknown as AuthContext;
const response={writeHead(){},end(){}} as unknown as HttpResponse;
function request(body:unknown):HttpRequest {return {method:"POST",body,headers:{}} as unknown as HttpRequest;}

test("a customer cannot reply inside another customer's review",async()=>{
  const original=globalThis.fetch;const origin=config.supabaseUrl;const key=config.supabaseServiceRoleKey;config.supabaseUrl="https://db.example.test";config.supabaseServiceRoleKey="fixture";
  let writes=0;
  globalThis.fetch=async(_input,init)=>{
    if(init?.method === "PATCH")writes++;
    return new Response(JSON.stringify([{review_id:"review-1",user_id:"another-owner"}]),{status:200});
  };
  try {
    await assert.rejects(()=>handleReviewsRoute(request({reply_text:"Forged reply"}),response,"review-1",["api","user","reviews","review-1","reply"],{},context),error=>error instanceof HttpError && error.status===404);
    assert.equal(writes,0);
  } finally {globalThis.fetch=original;config.supabaseUrl=origin;config.supabaseServiceRoleKey=key;}
});

test("a delivered order does not authorize reviewing an unrelated product",async()=>{
  const original=globalThis.fetch;const origin=config.supabaseUrl;const key=config.supabaseServiceRoleKey;config.supabaseUrl="https://db.example.test";config.supabaseServiceRoleKey="fixture";
  let writes=0;
  globalThis.fetch=async(input,init)=>{
    if(init?.method === "POST")writes++;
    const path=new URL(String(input)).pathname;
    const rows=path.endsWith("/orders")?[{order_id:"order-1",user_id:"owner",status:"delivered"}]
      :path.endsWith("/order_item")?[{variant_id:"variant-owned"}]
      :path.endsWith("/variant")?[{product_id:"product-owned"}]:[];
    return new Response(JSON.stringify(rows),{status:200});
  };
  try {
    await assert.rejects(()=>handleReviewsRoute(request({order_id:"order-1",product_id:"product-not-purchased",rating:5}),response,undefined,["api","user","reviews"],{},context),error=>error instanceof HttpError && error.code==="PRODUCT_NOT_PURCHASED");
    assert.equal(writes,0);
  } finally {globalThis.fetch=original;config.supabaseUrl=origin;config.supabaseServiceRoleKey=key;}
});
