import test from "node:test";
import assert from "node:assert/strict";
import {
  auditActionLabel,
  auditChangeSummary,
  auditRoleLabel,
  enrichAuditLogs,
  formatAuditScalar,
  RETURN_AUDIT,
  shortId
} from "../../apps/api/src/audit-enrichment.js";

test("role codes become Vietnamese labels instead of raw enum values", () => {
  assert.equal(auditRoleLabel("admin_operator_donhang"), "Quản lý đơn hàng");
  assert.equal(auditRoleLabel("super_admin"), "Super Admin");
  assert.equal(auditRoleLabel(""), "—");
  // Vai trò chưa có trong từ điển thì hiện nguyên mã, không nuốt mất thông tin.
  assert.equal(auditRoleLabel("admin_operator_moi"), "admin_operator_moi");
});

test("a status change is summarised as a transition, not as raw JSON", () => {
  const summary = auditChangeSummary(
    { status: "pending", version: 1 },
    { status: "approved", version: 2 },
    "update",
    RETURN_AUDIT
  );

  assert.equal(summary, "Chờ xử lý → Đã duyệt");
});

test("a change outside the status field falls back to the whitelisted fields", () => {
  const summary = auditChangeSummary(
    { refund_amount: 100000 },
    { refund_amount: 250000 },
    "update",
    RETURN_AUDIT
  );

  assert.equal(summary, "refund_amount: 100000 → 250000");
});

test("an is_active flip reads as on/off instead of 'Đã cập nhật'", () => {
  assert.equal(auditChangeSummary({ is_active: true }, { is_active: false }, "update"), "Bật → Tắt");
  assert.equal(auditChangeSummary({ is_active: false }, { is_active: true }, "update"), "Tắt → Bật");
});

test("empty payloads never render as [object Object] or an empty cell", () => {
  assert.equal(auditChangeSummary({}, {}, "update"), "—");
  assert.equal(auditChangeSummary({}, { anything: 1 }, "update"), "— → có dữ liệu mới");
  assert.equal(auditChangeSummary({ status: "pending" }, {}, "update"), "có → —");
});

test("action codes become Vietnamese verbs, and a status change wins over the verb", () => {
  assert.equal(auditActionLabel("create", {}, {}), "Tạo mới");
  assert.equal(auditActionLabel("lock", {}, {}), "Khoá tài khoản");
  assert.equal(
    auditActionLabel("update", { status: "pending" }, { status: "approved" }),
    "Đổi trạng thái"
  );
});

test("scalars render readably and UUIDs are shortened rather than dumped", () => {
  assert.equal(formatAuditScalar(null), "—");
  assert.equal(formatAuditScalar(""), "—");
  assert.equal(formatAuditScalar(true), "có");
  assert.equal(formatAuditScalar(false), "không");
  assert.equal(formatAuditScalar(12000), "12000");
  assert.equal(shortId("9da1d004-ef22-4357-bc45-720fdc7d486c"), "#9da1d004");
  assert.equal(shortId(""), "—");
});

test("an empty log page short-circuits without touching the database", async () => {
  const result = await enrichAuditLogs({ rows: [], count: 0 }, RETURN_AUDIT);

  assert.deepEqual(result, { rows: [], count: 0 });
});
