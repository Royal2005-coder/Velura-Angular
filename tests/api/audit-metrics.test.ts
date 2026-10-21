import test from "node:test";
import assert from "node:assert/strict";
import {
  recordAuditWrite,
  renderAuditMetrics,
  resetAuditMetricsForTest
} from "../../apps/api/src/audit-metrics.js";

test("audit write metrics render module/result counters and sanitize unknown modules", () => {
  resetAuditMetricsForTest();
  recordAuditWrite("auth", "success");
  recordAuditWrite("auth", "failure");
  recordAuditWrite("Bad Module!", "success");

  const lines = renderAuditMetrics();
  assert.ok(lines.includes("# TYPE velura_audit_writes_total counter"));
  assert.ok(lines.some((line) => line.includes('module="auth",result="success"} 1')));
  assert.ok(lines.some((line) => line.includes('module="auth",result="failure"} 1')));
  assert.ok(lines.some((line) => line.includes('module="other",result="success"} 1')));
  resetAuditMetricsForTest();
});
