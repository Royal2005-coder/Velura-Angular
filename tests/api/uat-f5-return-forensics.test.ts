/**
 * Feature Spec F5 — Return Parcel Visual Forensics, Anti-Swap Ownership Guard & Server-Side Refund Freeze.
 *
 * Independently runnable:
 *   node --import tsx --test tests/api/uat-f5-return-forensics.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import { UnifiedDecisionService } from "../../apps/api/src/decision/decision-service.js";
import { HttpError } from "../../apps/api/src/http.js";
import { accessForRole } from "../../apps/api/src/rbac.js";
import { executeReturnBoxForensics } from "../../apps/api/src/returns/return-forensics.js";
import type { ReturnRepository } from "../../apps/api/src/returns/return-repository.js";
import { createReturnService } from "../../apps/api/src/returns/return-service.js";
import { assertReturnEvidenceOwnership } from "../../apps/api/src/security/safe-media-fetch.js";
import type { AuthContext, JsonObject } from "../../apps/api/src/types.js";
import { choice, getCachedSyntheticImage, mockDecisionResult, noul, withScrubbedAiEnv } from "./helpers/decision-test-kit.js";

const BOX_CONDITIONS = ["INTACT", "MINOR_DENT", "SEVERE_CRUSH", "TORN_WET"] as const;
const MATCH_VERDICTS = ["MATCHED", "SUSPICIOUS_DIFF", "MISMATCHED"] as const;

test("F5.1: decideReturnBoxForensics evaluates 2-axis parcel damage & anti-swap, recommends carrier claim on MISMATCHED, and freezes refund on SEVERE_CRUSH/TORN_WET", async () => {
  const [pickupImg, warehouseImg] = await Promise.all([
    getCachedSyntheticImage("f5-pickup", { bg: [215, 195, 165], subject: [180, 150, 110] }),
    getCachedSyntheticImage("f5-warehouse", { bg: [210, 190, 160], subject: [175, 145, 105] }),
  ]);

  // 1. Grey-zone [40, 75] SUSPICIOUS_DIFF -> requires_human_review === true & freeze_auto_refund === true
  const greySvc = new UnifiedDecisionService(async () =>
    mockDecisionResult({
      box_condition: choice("INTACT", BOX_CONDITIONS, 0.90),
      seal_broken: noul(0.64),
      diff_tape_color: noul(0.72),
      diff_label_pos: noul(0.15),
      diff_box_ratio: noul(0.10),
      identity_match: choice("SUSPICIOUS_DIFF", MATCH_VERDICTS, 0.84),
    }),
  );
  const grey = await greySvc.decideReturnBoxForensics({
    returnId: "55555555-0000-4000-8000-000000000001",
    returnCode: "RMA-501",
    trackingCode: "GHN-501",
    carrierName: "GHN",
    pickupImage: { bytes: pickupImg, mime: "image/jpeg" },
    warehouseImage: { bytes: warehouseImg, mime: "image/jpeg" },
  });
  assert.equal(grey.match_verdict, "SUSPICIOUS_DIFF");
  assert.ok(grey.tampering_risk_score >= 40 && grey.tampering_risk_score <= 75);
  assert.equal(grey.requires_human_review, true);
  assert.equal(grey.freeze_auto_refund, true);

  // 2. High-risk swap (> 75) on an INTACT outer box -> carrier_claim_recommended MUST be true + DSP-* report generated (`P0-07`)
  const swapSvc = new UnifiedDecisionService(async () =>
    mockDecisionResult({
      box_condition: choice("INTACT", BOX_CONDITIONS, 0.94),
      seal_broken: noul(0.90),
      diff_tape_color: noul(0.93),
      diff_label_pos: noul(0.89),
      diff_box_ratio: noul(0.95),
      identity_match: choice("MISMATCHED", MATCH_VERDICTS, 0.95),
    }),
  );
  const swapped = await swapSvc.decideReturnBoxForensics({
    returnId: "55555555-0000-4000-8000-000000000002",
    returnCode: "RMA-502",
    trackingCode: "GHTK-502",
    carrierName: "GHTK",
    pickupImage: { bytes: pickupImg, mime: "image/jpeg" },
    warehouseImage: { bytes: warehouseImg, mime: "image/jpeg" },
  });
  assert.equal(swapped.match_verdict, "MISMATCHED");
  assert.ok(swapped.tampering_risk_score > 75);
  assert.equal(swapped.carrier_claim_recommended, true);
  assert.equal(swapped.freeze_auto_refund, true);
  assert.ok(swapped.carrier_claim_report?.report_code.startsWith("DSP-"));
  assert.ok(swapped.suggested_qa_failed_codes.includes("package_mismatch"));

  // 3. SEVERE_CRUSH even when MATCHED -> freeze_auto_refund === true & suggested_qa_failed_codes includes "condition_bad" (`P0-07`)
  const crushSvc = new UnifiedDecisionService(async () =>
    mockDecisionResult({
      box_condition: choice("SEVERE_CRUSH", BOX_CONDITIONS, 0.93),
      seal_broken: noul(0.10),
      diff_tape_color: noul(0.05),
      diff_label_pos: noul(0.05),
      diff_box_ratio: noul(0.08),
      identity_match: choice("MATCHED", MATCH_VERDICTS, 0.92),
    }),
  );
  const crushed = await crushSvc.decideReturnBoxForensics({
    returnId: "55555555-0000-4000-8000-000000000003",
    returnCode: "RMA-503",
    pickupImage: { bytes: pickupImg, mime: "image/jpeg" },
    warehouseImage: { bytes: warehouseImg, mime: "image/jpeg" },
  });
  assert.equal(crushed.box_condition, "SEVERE_CRUSH");
  assert.equal(crushed.freeze_auto_refund, true);
  assert.ok(crushed.suggested_qa_failed_codes.includes("condition_bad"));
  assert.equal(crushed.suggested_disposition, "repair");
});

test("F5.2: executeReturnBoxForensics blocks cross-return storage:// IDOR and raw SSRF URLs, and reports single_image_mode accurately", async () => {
  const returnId = "55555555-0000-4000-8000-000000000099";
  const otherReturnId = "55555555-0000-4000-8000-999999999999";

  // Ownership unit assertions
  assert.throws(
    () => assertReturnEvidenceOwnership(`storage://return-evidence-private/returns/${otherReturnId}/qa.jpg`, returnId),
    (err: unknown) => err instanceof HttpError && err.status === 422 && err.code === "EVIDENCE_OWNERSHIP_VIOLATION",
  );
  assert.throws(
    () => assertReturnEvidenceOwnership("https://169.254.169.254/latest/meta-data", returnId),
    (err: unknown) => err instanceof HttpError && err.status === 422 && err.code === "EVIDENCE_OWNERSHIP_VIOLATION",
  );

  // Cross-return warehouseEvidenceRef rejected before any signed URL resolution
  await assert.rejects(
    () =>
      executeReturnBoxForensics({
        returnRow: { return_id: returnId, return_code: "RMA-99" },
        shipments: [],
        body: { warehouseEvidenceRef: `storage://return-evidence-private/returns/${otherReturnId}/stolen.jpg` },
        actorId: null,
      }),
    (err: unknown) => err instanceof HttpError && err.code === "EVIDENCE_OWNERSHIP_VIOLATION",
  );

  // Single-image mode (`pickupImage === null`): clears phantom `pickup_evidence_ref` and sets `single_image_mode: true`
  const warehouseImg = await getCachedSyntheticImage("f5-single-wh", { bg: [210, 190, 160], subject: [175, 145, 105] });
  const insertedRows: JsonObject[] = [];
  await withScrubbedAiEnv({ AI_DECISION_ROLLOUT_MODE: "active" }, async () => {
    const singleOut = await executeReturnBoxForensics(
      {
        returnRow: { return_id: returnId, return_code: "RMA-99" },
        shipments: [],
        body: {
          warehouseImageBase64: warehouseImg.toString("base64"),
          pickupEvidenceRef: `storage://return-evidence-private/returns/${returnId}/missing-pickup.jpg`,
        },
        actorId: "00000000-0000-4000-8000-000000000001",
      },
      {
        resolveRef: async () => "https://cdn.velura.vn/missing-pickup.jpg",
        fetchBytes: async () => {
          throw new Error("404 not found");
        },
        insertForensics: async (row) => {
          insertedRows.push(row);
          return { forensics_id: "fx-single-1" };
        },
        decisionService: {
          decideReturnBoxForensics: async (input) => {
            assert.equal(input.pickupImage, null);
            return {
              box_condition: "INTACT",
              seal_intact: true,
              carrier_claim_recommended: false,
              match_verdict: "MATCHED",
              diff_factors: [],
              tampering_risk_score: 5,
              confidence_score: 0.91,
              requires_human_review: false,
              freeze_auto_refund: false,
              suggested_qa_failed_codes: [],
              suggested_disposition: "restock",
              discrepancy_evidence: [],
              factor_probabilities: {},
              carrier_claim_report: null,
            };
          },
        },
      },
    );

    assert.equal(singleOut.single_image_mode, true);
    assert.equal(singleOut.forensics_id, "fx-single-1");
    assert.equal(insertedRows[0]?.pickup_evidence_ref, null, "Phantom pickup ref must be cleared when pickup bytes fail to load");
  });
});

test("F5.3: ReturnService enforces server-side 409 RETURN_REFUND_FROZEN_BY_FORENSICS on both Stripe & Manual refunds unless super_admin supplies override reason", async () => {
  const returnId = "55555555-0000-4000-8000-000000000777";
  const returnItemId = "55555555-1111-4000-8000-000000000777";

  const cskhAccess = accessForRole("admin_operator_cskh_dt");
  const cskhCtx: AuthContext = {
    authUser: { id: "cskh-op", email: "cskh@velura.test" },
    profile: { user_id: "cskh-op", email: "cskh@velura.test", role: "admin", admin_role: "admin_operator_cskh_dt", is_active: true },
    roleCode: "admin_operator_cskh_dt",
    roleName: "admin_operator_cskh_dt",
    isAdmin: true,
    allowedPages: cskhAccess.allowedPages,
    allowedModules: cskhAccess.allowedModules,
    capabilities: cskhAccess.capabilities,
    accessToken: "cskh-jwt",
  } as AuthContext;

  const superAccess = accessForRole("super_admin");
  const superCtx: AuthContext = {
    authUser: { id: "super-op", email: "super@velura.test" },
    profile: { user_id: "super-op", email: "super@velura.test", role: "admin", admin_role: "super_admin", is_active: true },
    roleCode: "super_admin",
    roleName: "super_admin",
    isAdmin: true,
    allowedPages: superAccess.allowedPages,
    allowedModules: superAccess.allowedModules,
    capabilities: superAccess.capabilities,
    accessToken: "super-jwt",
  } as AuthContext;

  let gatewayRefundCalls = 0;
  let manualRefundCalls = 0;

  const repo = {
    getReturn: async () => ({
      return_id: returnId,
      order_id: "order-777",
      return_type: "refund",
      payment_method: "stripe",
      version: 3,
      status: "IN_PROGRESS",
    }),
    listReturnLines: async () => ({
      rows: [
        {
          return_item_id: returnItemId,
          version: 4,
          quantity: 1,
          received_quantity: 1,
          resolution_type: "refund",
          decision_status: "approved",
          item_status: "RECEIVED",
          matches_product: true,
          tags_intact: true,
          condition_acceptable: true,
          package_match: true,
        },
      ],
    }),
    getRefundOperation: async () => null,
    getItemRefundableAmount: async () => 850_000,
    getPaymentByOrderId: async () => ({ payment_provider: "stripe", payment_method: "stripe" }),
    getOrderPaymentMethod: async () => "cod",
    getManualRefund: async () => null,
    getRefundReceiver: async () => ({
      bank_name: "Vietcombank",
      account_number: "0123456789",
      account_holder: "NGUYEN VAN A",
    }),
    recordManualRefund: async () => {
      manualRefundCalls += 1;
      return { return_id: returnId, status: "COMPLETED" };
    },
  } as unknown as ReturnRepository;

  const service = createReturnService({
    repository: repo,
    refunds: {
      refund: async () => {
        gatewayRefundCalls += 1;
        return { status: "refunded", providerRef: "re_123" };
      },
    },
    listForensics: async () => [
      {
        forensics_id: "fx-frozen-1",
        return_id: returnId,
        return_item_id: returnItemId,
        freeze_auto_refund: true,
        tampering_risk_score: 84,
      },
    ],
  });

  // 1. CSKH operator blocked on Stripe refund with 409 RETURN_REFUND_FROZEN_BY_FORENSICS (even if trying to pass override!)
  await assert.rejects(
    () =>
      service.triggerStripeRefund(cskhCtx, returnId, {
        returnItemId,
        expectedVersion: 4,
        forensicsOverrideReason: "Cố tình vượt quyền khi chưa phải super_admin",
      }),
    (err: unknown) => err instanceof HttpError && err.status === 409 && err.code === "RETURN_REFUND_FROZEN_BY_FORENSICS",
  );

  // 2. Super admin ALSO blocked on Manual COD refund when forensicsOverrideReason is missing/short
  await assert.rejects(
    () =>
      service.recordManualRefund(superCtx, returnId, {
        returnItemId,
        expectedVersion: 4,
        transferReference: "FT20261118001",
        amount: 850_000,
        transferredAt: new Date().toISOString(),
        imageProof: `storage://return-evidence-private/returns/${returnId}/proof.jpg`,
      }),
    (err: unknown) => err instanceof HttpError && err.status === 409 && err.code === "RETURN_REFUND_FROZEN_BY_FORENSICS",
  );
  assert.equal(gatewayRefundCalls, 0);
  assert.equal(manualRefundCalls, 0);

  // 3. Super admin WITH explicit >= 15-char forensicsOverrideReason succeeds cleanly!
  const overridden = await service.triggerStripeRefund(superCtx, returnId, {
    returnItemId,
    expectedVersion: 4,
    forensicsOverrideReason: "Đã kiểm tra biên bản đồng kiểm video kho, sản phẩm bên trong nguyên vẹn đúng SKU.",
  });
  assert.equal(overridden.success, true);
  assert.equal(gatewayRefundCalls, 1);
});
