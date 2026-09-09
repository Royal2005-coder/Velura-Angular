import test from "node:test";
import assert from "node:assert/strict";
import { createReviewService } from "../../apps/api/src/reviews/review-service.js";

const REVIEW_ID = "40000000-0000-4000-8000-000000000001";

test("review operator reads and mutates through the caller token", async () => {
  let received;
  const service = createReviewService({ repository: {
    list: async (filters, token) => { received = { filters, token }; return { rows: [], count: 0 }; },
    approve: async (_id, input, token) => ({ ...input, token })
  } });
  await service.list(context("admin_operator_danhgia_review"), new URLSearchParams("rating=5&limit=20"));
  assert.equal(received.filters.rating, "5");
  assert.equal(received.token, "jwt-token");
  const result = await service.approve(context("admin_operator_danhgia_review"), REVIEW_ID, { expectedVersion: 2 });
  assert.equal(result.expectedVersion, 2);
});

test("unrelated role cannot read reviews and hide requires a reason", async () => {
  const service = createReviewService({ repository: { list: async () => ({}), hide: async () => ({}) } });
  await assert.rejects(() => service.list(context("admin_operator_sanpham"), new URLSearchParams()), (error) => error.status === 403);
  await assert.rejects(() => service.hide(context("admin_operator_danhgia_review"), REVIEW_ID, { reason: "short", expectedVersion: 1 }), (error) => error.status === 422);
});

function context(roleCode) { return { authUser: { id: "auth-1" }, roleCode, accessToken: "jwt-token" }; }
