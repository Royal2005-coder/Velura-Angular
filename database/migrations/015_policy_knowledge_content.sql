begin;

create table if not exists public.policy (
  policy_id uuid primary key default gen_random_uuid(),
  slug text,
  title text,
  summary text not null default '',
  content jsonb not null default '[]'::jsonb,
  display_order integer not null default 0,
  status text not null default 'published',
  updated_at timestamptz not null default now()
);

alter table public.policy
  add column if not exists slug text,
  add column if not exists title text,
  add column if not exists summary text not null default '',
  add column if not exists content jsonb not null default '[]'::jsonb,
  add column if not exists display_order integer not null default 0,
  add column if not exists status text not null default 'published',
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists policy_slug_unique
  on public.policy (slug);

-- Policy categories are intentionally not seeded here. Some existing Supabase
-- databases have an older content_category shape without content_type, while
-- the frontend can derive policy tabs directly from public.policy.
/*
insert into public.content_category (content_type, slug, name, display_order)
values
  ('policy', 'returns', 'Chính sách đổi trả', 10),
  ('policy', 'privacy', 'Chính sách bảo mật', 20),
  ('policy', 'shipping', 'Chính sách vận chuyển', 30),
  ('policy', 'terms', 'Điều khoản sử dụng', 40),
  ('policy', 'faq', 'Câu hỏi thường gặp', 50),
  ('policy', 'member', 'Chính sách thành viên', 60)
on conflict (content_type, slug) do update
set name = excluded.name,
    display_order = excluded.display_order,
    updated_at = now();
*/

insert into public.policy (slug, title, summary, content, display_order, status)
values
  (
    'returns',
    'Chính sách đổi trả',
    'Khách hàng gửi yêu cầu đổi trả trong vòng 48 giờ kể từ khi đơn hàng được giao thành công.',
    $$[
      {
        "heading": "Thời hạn nghiêm ngặt",
        "items": [
          "Khách hàng phải gửi yêu cầu trong vòng tối đa 2 ngày (48 giờ) kể từ lúc trạng thái đơn hàng cập nhật thành Đã giao thành công.",
          "Mốc thời gian được tính dựa trên trường delivered_at từ API vận chuyển.",
          "Sau 48 giờ, hệ thống tự động khóa tính năng gửi yêu cầu đổi trả cho đơn hàng đó."
        ]
      },
      {
        "heading": "Điều kiện sản phẩm",
        "items": [
          "Sản phẩm chưa qua sử dụng.",
          "Sản phẩm còn nguyên tem mác và nhãn barcode.",
          "Sản phẩm được đặt trong bao bì đóng gói gốc của Velura."
        ]
      },
      {
        "heading": "Quy trình hoàn tiền",
        "items": [
          "Hoàn tiền được xử lý trong vòng 4 - 5 ngày làm việc sau khi hàng về kho và đạt tiêu chuẩn kiểm tra.",
          "Khoản hoàn được chuyển về ví điện tử hoặc chuyển khoản ngân hàng trực tiếp đối với đơn COD."
        ]
      },
      {
        "heading": "Bù trừ chênh lệch",
        "text": "Khi đổi sang sản phẩm khác, hệ thống tự động tính chênh lệch giá trị. Nếu sản phẩm mới đắt hơn, khách hàng thanh toán phần chênh lệch. Nếu sản phẩm mới rẻ hơn, hệ thống hoàn lại phần tiền thừa."
      }
    ]$$::jsonb,
    10,
    'published'
  ),
  (
    'privacy',
    'Chính sách bảo mật',
    'Velura bảo vệ dữ liệu cá nhân, dữ liệu Style Quiz và hình ảnh khách hàng theo nguyên tắc sử dụng khép kín.',
    $$[
      {
        "heading": "Bảo mật thông tin sinh trắc học và Style Quiz",
        "items": [
          "Dữ liệu Style Quiz gồm số đo ba vòng, chiều cao, cân nặng, dáng người và tông da.",
          "Dữ liệu này được sử dụng khép kín để đề xuất size động.",
          "Thông tin Style Quiz được dùng làm ngữ cảnh nền cho AI Stylist Chatbot nhằm cá nhân hóa tư vấn."
        ]
      },
      {
        "heading": "Quy tắc ngày sinh",
        "text": "Ngày sinh được dùng để gửi ưu đãi sinh nhật độc quyền. Hệ thống chỉ cho phép chỉnh sửa ngày sinh tối đa 2 lần để ngăn chặn hành vi gian lận voucher."
      },
      {
        "heading": "Bảo mật hình ảnh",
        "items": [
          "Ảnh chân dung hoặc ảnh trang phục khách hàng tải lên Chatbot được xử lý theo thời gian thực.",
          "Đối với khách vãng lai (Guest), hình ảnh không được lưu trữ dài hạn.",
          "Velura không chia sẻ hình ảnh khách hàng cho bên thứ ba."
        ]
      },
      {
        "heading": "Lưu trữ Guest Session",
        "text": "Dữ liệu ẩn danh của Guest như giỏ hàng tạm thời và Style Profile tạm được lưu trữ trên server tối đa 3 tháng. Khi Guest đăng ký tài khoản thành công, dữ liệu này được tự động đồng bộ và hợp nhất sang tài khoản thành viên mới."
      }
    ]$$::jsonb,
    20,
    'published'
  ),
  (
    'shipping',
    'Chính sách vận chuyển',
    'Đồng giá vận chuyển toàn quốc 30.000 VNĐ và miễn phí vận chuyển cho đơn hàng từ 500.000 VNĐ.',
    $$[
      {
        "heading": "Phí vận chuyển",
        "items": [
          "Đồng giá tiêu chuẩn toàn quốc: 30.000 VNĐ.",
          "Tự động áp dụng miễn phí vận chuyển cho mọi đơn hàng từ 500.000 VNĐ trở lên."
        ]
      },
      {
        "heading": "Thời gian dự kiến",
        "items": [
          "Nội thành TP.HCM và Hà Nội: 1 - 3 ngày làm việc.",
          "Các tỉnh thành khác: 3 - 5 ngày làm việc."
        ]
      },
      {
        "heading": "Quy tắc 3 lần giao",
        "items": [
          "Shipper giao tối đa 3 lần cho mỗi đơn hàng.",
          "Nếu giao thất bại sau 3 lần, đơn hàng chuyển sang trạng thái Hủy.",
          "Đối với đơn thanh toán trước qua VNPay, hệ thống hoàn tiền sau khi khấu trừ chi phí vận chuyển 2 chiều phát sinh."
        ]
      }
    ]$$::jsonb,
    30,
    'published'
  ),
  (
    'terms',
    'Điều khoản sử dụng',
    'Các quy tắc vận hành khi khách hàng sử dụng website, AI Stylist Chatbot và tính năng đánh giá sản phẩm.',
    $$[
      {
        "heading": "Giới hạn AI Stylist Chatbot",
        "items": [
          "Để chống spam, Chatbot giới hạn tối đa 20 tin nhắn/phút.",
          "Nếu vượt quá giới hạn, hệ thống tự động khóa tính năng chat trong vòng 5 phút.",
          "Chatbot hỗ trợ tải ảnh dưới 5MB.",
          "Định dạng ảnh được hỗ trợ: JPG, JPEG, PNG."
        ]
      },
      {
        "heading": "Quy chuẩn đánh giá sản phẩm",
        "items": [
          "Chỉ khách hàng đã mua sản phẩm với đơn hàng ở trạng thái Hoàn thành mới được gửi đánh giá.",
          "Mỗi khách hàng chỉ được đánh giá 1 lần duy nhất cho mỗi sản phẩm.",
          "Đánh giá tiêu cực từ 1 - 3 sao hoặc chứa từ cấm sẽ nhận nhãn Cần xử lý gấp để Admin duyệt thủ công."
        ]
      }
    ]$$::jsonb,
    40,
    'published'
  ),
  (
    'faq',
    'Câu hỏi thường gặp',
    'Các câu hỏi phổ biến được tổng hợp từ chính sách vận hành hiện tại của Velura.',
    $$[
      {
        "heading": "Sau khi nhận hàng bao lâu tôi còn được gửi yêu cầu đổi trả?",
        "text": "Bạn cần gửi yêu cầu trong vòng tối đa 48 giờ kể từ khi đơn hàng cập nhật trạng thái Đã giao thành công. Sau thời hạn này, hệ thống tự động khóa tính năng gửi yêu cầu."
      },
      {
        "heading": "Đơn hàng từ bao nhiêu tiền thì được miễn phí vận chuyển?",
        "text": "Velura miễn phí vận chuyển cho mọi đơn hàng từ 500.000 VNĐ trở lên. Đơn dưới mức này áp dụng phí đồng giá 30.000 VNĐ toàn quốc."
      },
      {
        "heading": "Guest đăng ký tài khoản thì dữ liệu cũ có bị mất không?",
        "text": "Không. Giỏ hàng tạm thời và Style Profile tạm của Guest được lưu tối đa 3 tháng và sẽ tự động hợp nhất sang tài khoản thành viên mới khi đăng ký thành công."
      },
      {
        "heading": "Chatbot có giới hạn gửi tin nhắn hoặc tải ảnh không?",
        "text": "Có. Chatbot giới hạn tối đa 20 tin nhắn/phút. Nếu vượt quá, tính năng chat bị khóa 5 phút. Ảnh tải lên cần dưới 5MB và thuộc định dạng JPG, JPEG hoặc PNG."
      }
    ]$$::jsonb,
    50,
    'published'
  ),
  (
    'member',
    'Chính sách thành viên',
    'Tài khoản Member giúp đồng bộ Style Profile, lưu outfit yêu thích và mở khóa trải nghiệm cá nhân hóa.',
    $$[
      {
        "heading": "Đặc quyền Member",
        "items": [
          "Đồng bộ đám mây Style Profile vĩnh viễn.",
          "Kích hoạt feed gợi ý siêu cá nhân hóa For You Feed.",
          "Lưu outfits yêu thích từ AI Stylist.",
          "Tích điểm thăng hạng.",
          "Nhận quà tặng trong tháng sinh nhật."
        ]
      },
      {
        "heading": "Tạo tài khoản tự động",
        "text": "Guest đặt hàng bằng số điện thoại và xác thực OTP SMS thành công sẽ được hệ thống tự động khởi tạo tài khoản Member. Mật khẩu tạm thời được gửi qua SMS để khách hàng đăng nhập và quản lý đơn hàng."
      }
    ]$$::jsonb,
    60,
    'published'
  )
on conflict (slug) do update
set title = excluded.title,
    summary = excluded.summary,
    content = excluded.content,
    display_order = excluded.display_order,
    status = excluded.status,
    updated_at = now();

commit;
