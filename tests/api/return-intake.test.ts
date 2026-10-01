import test from "node:test";
import assert from "node:assert/strict";
import { normalizeReturnIntake, RETURN_STATUS_LABELS_VI } from "../../apps/api/src/returns/return-constants.ts";

test("đổi trả bắt buộc lý do trong dropdown và ít nhất một ảnh", () => {
  const missingReason = normalizeReturnIntake("", ["data:image/png;base64,aaa"], "");
  assert.equal(missingReason.ok, false);
  if (!missingReason.ok) assert.equal(missingReason.error, "RETURN_REASON_REQUIRED");

  const missingImage = normalizeReturnIntake("size", [], "áo rộng");
  assert.equal(missingImage.ok, false);
  if (!missingImage.ok) assert.equal(missingImage.error, "RETURN_EVIDENCE_REQUIRED");

  const other = normalizeReturnIntake("other", ["data:image/jpeg;base64,abc"], "");
  assert.equal(other.ok, false);
  if (!other.ok) assert.equal(other.error, "RETURN_NOTE_REQUIRED");

  const ok = normalizeReturnIntake("size", ["data:image/jpeg;base64,abc"], "muốn size M");
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.intake.code, "size");
    assert.equal(ok.intake.label, "Không vừa kích cỡ");
    assert.equal(ok.intake.images.length, 1);
  }
});

test("nhãn khách của received là nhận hàng hoàn trả thành công", () => {
  assert.equal(RETURN_STATUS_LABELS_VI.received, "Nhận hàng hoàn trả thành công");
  assert.equal(RETURN_STATUS_LABELS_VI.pending, "Chờ xử lý");
});
