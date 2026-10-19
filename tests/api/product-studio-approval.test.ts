import test from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../../apps/api/src/http.js";
import { config } from "../../apps/api/src/config.js";
import type { AuthContext } from "../../apps/api/src/types.js";
import type { EnhancementApprovalRecord, EnhancementApprovalRepository } from "../../apps/api/src/ai/enhancement-approval-service.js";
import { StudioImageApprovalService, readStudioImageEvidence } from "../../apps/api/src/products/product-studio-approval.js";
import { SupabaseEnhancementApprovalRepository } from "../../apps/api/src/ai/enhancement-approval-repository.js";

const actor: AuthContext = { authUser: { id: "actor" }, profile: { user_id: "reviewer", is_active: true },
  roleCode: "admin_operator_sanpham", roleName: "Sản phẩm", isAdmin: true, allowedModules: ["products"], allowedPages: ["products"], accessToken: "fixture" };
const body = { productId: "30000000-0000-4000-8000-000000000001", expectedVersion: 3,
  imageUrl: "https://storage.test/selected.png", selection: "enhanced", reviewConfirmed: true };
function fixture() {
  const records: EnhancementApprovalRecord[] = [];
  const discarded: string[] = [];
  let reads = 0;
  const repository: EnhancementApprovalRepository = {
    productVersion: async () => 3,
    stage: async id => `https://storage.test/ai-reviewed/${id}.png`,
    discard: async id => { discarded.push(id); },
    record: async record => { records.push(record); },
  };
  const service = new StudioImageApprovalService(repository, async () => {
    reads++;
    return { bytes: Buffer.from("measured immutable png bytes"), mime: "image/png", sourceRevision: "a".repeat(64),
      processingVersion: "studio-measured-v1", qualityScore: 73,
      gate: { valid: true, metrics: { brightness: 120, sharpness: 70, background_score: 90 } } };
  });
  return { service, repository, records, discarded, get reads() { return reads; } };
}
test("Studio Apply returns only the persisted server approval and measured score, never a browser-generated ID", async () => {
  const f = fixture();
  const approval = await f.service.approve(actor, { ...body, qualityScore: 99, approvalId: "forged" }, { ipAddress: "127.0.0.1" });
  assert.equal(approval.qualityScore, 73);
  assert.notEqual(approval.approvalId, "forged");
  assert.equal(f.records.length, 1);
  assert.equal(f.records[0].reviewerId, actor.profile.user_id);
  assert.equal(f.records[0].expectedVersion, 3);
  assert.equal(f.records[0].url, approval.url);
  assert.equal(f.records[0].imageRevision.length, 64);
});
test("unauthorized and stale Studio selections stop before image reads or storage", async () => {
  const f = fixture();
  await assert.rejects(f.service.approve(undefined, body, { ipAddress: "" }), HttpError);
  await assert.rejects(f.service.approve({ ...actor, profile: { ...actor.profile, is_active: false } }, body, { ipAddress: "" }), HttpError);
  await assert.rejects(f.service.approve(actor, { ...body, expectedVersion: 2 }, { ipAddress: "" }), HttpError);
  await assert.rejects(f.service.approve(actor, { ...body, reviewConfirmed: false }, { ipAddress: "" }), HttpError);
  assert.equal(f.reads, 0);
  assert.equal(f.records.length, 0);
});
test("failed database approval cannot become success and discards only its newly staged object", async () => {
  const f = fixture();
  f.repository.record = async () => { throw new Error("schema unavailable"); };
  await assert.rejects(f.service.approve(actor, body, { ipAddress: "" }), /schema unavailable/);
  assert.equal(f.discarded.length, 1);
});
test("Studio approval rejects arbitrary URLs and does not pretend that a missing schema recorded an approval", async () => {
  const saved = { ...config };
  const originalFetch = globalThis.fetch;
  Object.assign(config, { supabaseUrl: "https://project.supabase.co", supabaseServiceRoleKey: "fixture" });
  try {
    await assert.rejects(readStudioImageEvidence("https://attacker.test/ai-studio/image.png"), HttpError);
    await assert.rejects(readStudioImageEvidence("data:image/png;base64,AAAA"), HttpError);
    globalThis.fetch = async () => Response.json({ code: "PGRST202", message: "velura_stage_image_approval missing" }, { status: 404 });
    const f = fixture();
    await f.service.approve(actor, body, { ipAddress: "" });
    await assert.rejects(new SupabaseEnhancementApprovalRepository().record(f.records[0]), error => error instanceof HttpError && error.code === "IMAGE_APPROVAL_SCHEMA_REQUIRED");
  } finally {
    Object.assign(config, saved);
    globalThis.fetch = originalFetch;
  }
});
