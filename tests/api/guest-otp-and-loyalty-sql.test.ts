import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const source = (relative: string) => readFile(path.join(ROOT, relative), "utf8");

/**
 * OTP tra cứu đơn và điều kiện tích điểm là hai quy tắc mà UI và SQL phải nói cùng một
 * điều. Test này khoá cả hai phía để lần sửa sau không lại lệch 1 phút hay quên khách vãng lai.
 */
test("guest tracking OTP lives five minutes and matches the phone in any stored format", async () => {
  const sql = await source("database/migrations/110_guest_tracking_otp_five_minutes.sql");
  assert.match(sql, /now\(\)\+interval '5 minutes'/, "hạn phải khớp countdown 05:00 của UI (AUTH-08)");
  assert.doesNotMatch(sql, /interval '1 minute'/, "060 từng rút xuống 1 phút — không được quay lại");
  assert.match(sql, /regexp_replace\(coalesce\(shipping_phone,''\), '\[\^0-9\]', '', 'g'\)/, "so sánh số điện thoại đã chuẩn hoá");
  assert.match(sql, /right\(regexp_replace\(coalesce\(shipping_phone,''\), '\[\^0-9\]', '', 'g'\), 9\)/);
  assert.match(sql, /OTP_PHONE_RATE_LIMIT/);
  assert.match(sql, /OTP_IP_RATE_LIMIT/);
  assert.match(sql, /grant execute on function public\.velura_issue_guest_tracking_otp\(text,text,uuid,text,uuid\) to service_role/);

  const session = await source("apps/api/src/user/guest-order-session.ts");
  assert.match(session, /GUEST_OTP_TTL_SECONDS = Math\.floor\(OTP_TTL_MS \/ 1000\)/, "TS đọc đúng một nguồn hạn");
  assert.match(session, /expires_in: GUEST_OTP_TTL_SECONDS/);
  assert.doesNotMatch(session, /expires_in: 60/);
});

test("the OTP answer never hides behind a 5xx that the CDN rewrites", async () => {
  const session = await source("apps/api/src/user/guest-order-session.ts");
  assert.doesNotMatch(session, /OTP_SEND_FAILED/, "502 này khiến UI chỉ còn 'hệ thống chưa xử lý được'");
  assert.match(session, /OTP_CHANNEL_UNAVAILABLE/);
  assert.match(session, /new HttpError\(\s*422,\s*"OTP_CHANNEL_UNAVAILABLE"/);
  assert.match(session, /emailSent/, "email liên kết của đơn là kênh dự phòng có thật");
  assert.match(session, /smsSent \? \[\] : recipientEmails\.slice\(0, 4\)/, "không gửi email khi SMS đã giao");

  const sms = await source("apps/api/src/sms/twilio.ts");
  assert.doesNotMatch(sms, /60 giay/, "tin nhắn không được hứa hạn ngắn hơn chính sách");
  assert.match(sms, /5 phut/);
});

test("loyalty accrual is limited to active members and keeps every other 087 rule", async () => {
  const sql = await source("database/migrations/111_loyalty_members_only.sql");
  assert.match(sql, /v_order\.is_guest is distinct from false/, "khách vãng lai chưa phải thành viên");
  assert.match(sql, /role::text = 'member' and is_active/, "chỉ thành viên đã kích hoạt, không phải admin hay tài khoản chưa OTP");

  // 087 là định nghĩa production đang chạy — giữ nguyên phần tiền.
  assert.match(sql, /v_earned := floor\(v_merchandise\*5\/100\);/);
  assert.match(sql, /v_order\.delivered_at\+interval '6 months'/);
  assert.match(sql, /'Thưởng 5% khi đơn đã thanh toán và giao thành công'/);
  assert.match(sql, /insert into public\.loyalty_point_lot/);
  assert.match(sql, /'debt_repayment'/);
  assert.match(sql, /perform public\.velura_complete_referral\(v_order\.user_id,p_order_id\);/);
  assert.match(sql, /coalesce\(v_order\.order_kind::text,'sale'\)='exchange'/, "đơn đổi hàng không tự tích điểm");
  assert.doesNotMatch(sql, /delete from public\.loyalty_ledger/i, "ledger là lịch sử tiền, không xoá bằng migration");

  const previous = await source("database/migrations/087_loyalty_spend.sql");
  const body = (text: string) => text.split("create or replace function public.velura_award_order_loyalty")[1];
  assert.ok(body(sql).length > 500, "111 phải là bản thay thế đầy đủ, không phải bản cắt ngắn");
  for (const line of ["v_merchandise := greatest(0,coalesce(v_order.subtotal,0)", "v_debt_paid := least(v_earned,greatest(0,v_account.debt_milli_points));"]) {
    assert.ok(body(sql).includes(line), `thiếu dòng tiền của 087: ${line}`);
    assert.ok(body(previous).includes(line));
  }
});
