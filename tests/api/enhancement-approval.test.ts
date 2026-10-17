import test from "node:test";
import assert from "node:assert/strict";
import { EnhancementApprovalService, type EnhancementApprovalRecord, type EnhancementApprovalRepository, type EnhancementEvidence, type EnhancementSelection } from "../../apps/api/src/ai/enhancement-approval-service.js";
import type { AuthContext } from "../../apps/api/src/types.js";
import { HttpError } from "../../apps/api/src/http.js";

const actor = "40000000-0000-4000-8000-000000000001";
const product = "40000000-0000-4000-8000-000000000002";
const job = "40000000-0000-4000-8000-000000000003";
const context: AuthContext = {
  authUser: { id: actor }, profile: { user_id: actor, role: "admin", is_active: true },
  isAdmin: true, roleCode: "super_admin", roleName: "Super Admin", allowedPages: ["products"],
  allowedModules: ["*"], accessToken: "authenticated-test-token",
};
const body = { productId: product, expectedVersion: 4, jobId: job, selection: "enhanced", reviewConfirmed: true };
const evidence: EnhancementEvidence = {
  bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=", "base64"),
  mime: "image/png", sourceRevision: "a".repeat(64), processingVersion: "test-rembg-measured-quality-v2",
  gate: { valid: true, metrics: { brightness: 120, sharpness: 40, background_score: 0.8 } },
};

function setup(options: { version?: number; evidence?: EnhancementEvidence; recordError?: Error; evidenceError?: Error; storageError?: Error } = {}) {
  const records: EnhancementApprovalRecord[] = [];
  const calls: Array<{ owner: string; jobId: string; selection: EnhancementSelection }> = [];
  let discarded = false;
  let staged = false;
  const repository: EnhancementApprovalRepository = {
    async productVersion() { return options.version ?? 4; },
    async stage(id) { if (options.storageError) throw options.storageError; staged = true; return `https://storage.example/ai-reviewed/${id}.png`; },
    async discard() { discarded = true; },
    async record(value) { if (options.recordError) throw options.recordError; records.push(value); },
  };
  const service = new EnhancementApprovalService({
    async approvalEvidence(owner, jobId, selection) {
      calls.push({ owner, jobId, selection });
      if (options.evidenceError) throw options.evidenceError;
      return options.evidence ?? evidence;
    },
  }, repository);
  return { service, records, calls, wasStaged: () => staged, wasDiscarded: () => discarded };
}

function code(value: string) {
  return (error: unknown) => error instanceof HttpError && error.code === value;
}

test("approval stages only the explicitly selected owner-private result and binds reviewer/version/provenance", async () => {
  const state = setup();
  const result = await state.service.approve(context, body, { ipAddress: "127.0.0.1" });
  assert.equal(state.records.length, 1);
  assert.deepEqual(state.calls, [{ owner: `member:${actor}`, jobId: job, selection: "enhanced" }]);
  const saved = state.records[0];
  assert.equal(saved.url, result.url);
  assert.equal(saved.productId, product);
  assert.equal(saved.expectedVersion, 4);
  assert.equal(saved.reviewerId, actor);
  assert.equal(saved.sourceRevision, evidence.sourceRevision);
  assert.match(saved.imageRevision, /^[a-f0-9]{64}$/);
  assert.equal(saved.processingVersion, evidence.processingVersion);
});

test("explicit human review is required before evidence is retrieved or any bytes are staged", async () => {
  const state = setup();
  await assert.rejects(state.service.approve(context, { ...body, reviewConfirmed: false }, { ipAddress: "127.0.0.1" }), code("VISUAL_REVIEW_REQUIRED"));
  assert.equal(state.wasStaged(), false);
  assert.equal(state.calls.length, 0);
});

test("non-product roles and inactive administrators cannot approve even when they know a job ID", async () => {
  for (const roleCode of ["member", "admin_viewer", "admin_operator_donhang", "admin_operator_gia_km"]) {
    const state = setup();
    await assert.rejects(state.service.approve({ ...context, roleCode, allowedModules: [] }, body, { ipAddress: "127.0.0.1" }));
    assert.equal(state.calls.length, 0);
    assert.equal(state.wasStaged(), false);
  }
  const state = setup();
  await assert.rejects(state.service.approve({ ...context, profile: { ...context.profile!, is_active: false } }, body, { ipAddress: "127.0.0.1" }));
  assert.equal(state.calls.length, 0);
});

test("stale product versions reject before inference evidence or storage work", async () => {
  const state = setup({ version: 5 });
  await assert.rejects(state.service.approve(context, body, { ipAddress: "127.0.0.1" }), code("VERSION_CONFLICT"));
  assert.equal(state.wasStaged(), false);
  assert.equal(state.calls.length, 0);
});

test("another owner's job rejection cannot be turned into an approval", async () => {
  const state = setup({ evidenceError: new HttpError(404, "JOB_NOT_FOUND", "Private job") });
  await assert.rejects(state.service.approve(context, body, { ipAddress: "127.0.0.1" }), code("JOB_NOT_FOUND"));
  assert.equal(state.wasStaged(), false);
  assert.equal(state.records.length, 0);
});

test("a successful worker status without valid and complete selected-output measurements is not approvable", async () => {
  for (const gate of [{ valid: false }, { valid: true }, { valid: true, metrics: { brightness: 120, sharpness: 40 } },
    { valid: true, metrics: { brightness: Number.NaN, sharpness: 40, background_score: 0.9 } }]) {
    const state = setup({ evidence: { ...evidence, gate } });
    await assert.rejects(state.service.approve(context, body, { ipAddress: "127.0.0.1" }));
    assert.equal(state.wasStaged(), false);
  }
});

test("storage failure returns failure and records no usable approval", async () => {
  const state = setup({ storageError: new Error("storage unavailable") });
  await assert.rejects(state.service.approve(context, body, { ipAddress: "127.0.0.1" }), /storage unavailable/);
  assert.equal(state.records.length, 0);
});

test("save of staged evidence failure discards only the unused object and cannot return a successful selection", async () => {
  const state = setup({ recordError: new HttpError(409, "VERSION_CONFLICT", "Concurrent edit") });
  await assert.rejects(state.service.approve(context, body, { ipAddress: "127.0.0.1" }), code("VERSION_CONFLICT"));
  assert.equal(state.wasDiscarded(), true);
  assert.equal(state.records.length, 0);
});

test("new-product original selection uses version zero and never requests enhancement", async () => {
  const state = setup();
  await state.service.approve(context, { ...body, productId: null, expectedVersion: 0, selection: "original" }, { ipAddress: "127.0.0.1" });
  assert.equal(state.calls[0].selection, "original");
  assert.equal(state.records[0].productId, null);
  assert.equal(state.records[0].expectedVersion, 0);
});
