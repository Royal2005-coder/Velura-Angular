-- Migration 118: auth session revocation + OTP attempt limit (UAT #742, #747).
--
-- 1) Đăng xuất chỉ xoá localStorage; JWT HS256 tự ký 24 giờ không có danh sách thu hồi nên
--    token bị lộ vẫn gọi API được tới khi hết hạn. Mỗi hàng users giữ `token_epoch`, JWT mang
--    claim `tv`; token có `tv` nhỏ hơn epoch hiện tại bị coi là đã thu hồi. Đăng xuất tăng epoch
--    nên mọi token phát trước đó chết ngay, không cần quét bảng thu hồi theo từng request.
-- 2) Mã OTP 6 số sống 5 phút nhưng không đếm số lần nhập sai, nên có thể dò hết không gian mã.
--    `otp_attempt_count` đếm lần sai trên mã đang lưu; chạm trần thì mã bị huỷ và người dùng
--    phải yêu cầu mã mới (trần nằm ở apps/api/src/user/otp-policy.ts).

alter table public.users
  add column if not exists token_epoch integer not null default 0;

alter table public.users
  add column if not exists otp_attempt_count integer not null default 0;

comment on column public.users.token_epoch is
  'Tăng mỗi lần đăng xuất; JWT có claim tv nhỏ hơn epoch bị coi là đã thu hồi.';
comment on column public.users.otp_attempt_count is
  'Số lần nhập sai OTP của mã đang lưu; chạm trần thì mã bị huỷ.';
