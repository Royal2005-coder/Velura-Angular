-- UC Chatbot/Content production hardening.
-- Extends the existing chat tables, routes handoff into support tickets, and
-- adds public content tables for blog/about/policy pages.

begin;

do $$
begin
  if to_regclass('public.chat_session') is null then
    raise exception 'UC chatbot requires public.chat_session';
  end if;
  if to_regclass('public.chat_message') is null then
    raise exception 'UC chatbot requires public.chat_message';
  end if;
  if to_regclass('public.product') is null then
    raise exception 'UC chatbot requires public.product';
  end if;
  if to_regclass('public.support_ticket') is null then
    raise exception 'UC chatbot requires public.support_ticket';
  end if;
  if to_regclass('public.ai_log') is null then
    raise exception 'UC chatbot requires public.ai_log';
  end if;
end $$;

alter table public.chat_session
  add column if not exists profile_user_id uuid references public.users(user_id) on delete set null,
  add column if not exists source text not null default 'chatbot',
  add column if not exists handoff_status text not null default 'ai'
    check (handoff_status in ('ai', 'requested', 'assigned', 'closed')),
  add column if not exists support_ticket_id uuid references public.support_ticket(ticket_id) on delete set null,
  add column if not exists last_message_preview text,
  add column if not exists last_message_at timestamptz,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table public.chat_message
  add column if not exists product_ids uuid[] not null default '{}'::uuid[];

create index if not exists idx_chat_session_profile_updated
  on public.chat_session(profile_user_id, updated_at desc);
create index if not exists idx_chat_session_guest_updated
  on public.chat_session(guest_id, updated_at desc);
create index if not exists idx_chat_session_handoff
  on public.chat_session(handoff_status, updated_at desc)
  where handoff_status in ('requested', 'assigned');
create index if not exists idx_chat_session_support_ticket
  on public.chat_session(support_ticket_id);
create index if not exists idx_chat_message_created
  on public.chat_message(session_id, created_at asc);
create index if not exists idx_chat_message_product_ids
  on public.chat_message using gin(product_ids);

drop trigger if exists trg_chat_session_touch_updated_at on public.chat_session;
create trigger trg_chat_session_touch_updated_at
before update on public.chat_session
for each row execute function public.velura_touch_updated_at();

-- Chat data is accessed through the API gateway. The older anonymous policies
-- exposed all guest sessions to anon users, so revoke direct access here.
drop policy if exists chat_session_select_policy on public.chat_session;
drop policy if exists chat_session_insert_policy on public.chat_session;
drop policy if exists chat_session_update_policy on public.chat_session;
drop policy if exists chat_session_delete_policy on public.chat_session;
drop policy if exists chat_message_select_policy on public.chat_message;
drop policy if exists chat_message_insert_policy on public.chat_message;

alter table public.chat_session enable row level security;
alter table public.chat_message enable row level security;

drop policy if exists chat_session_admin_select on public.chat_session;
create policy chat_session_admin_select on public.chat_session
for select to authenticated
using ((select public.velura_has_admin_role(array['super_admin','admin_operator_cskh_dt'])));

drop policy if exists chat_message_admin_select on public.chat_message;
create policy chat_message_admin_select on public.chat_message
for select to authenticated
using (
  exists (
    select 1
    from public.chat_session s
    where s.session_id = chat_message.session_id
      and (select public.velura_has_admin_role(array['super_admin','admin_operator_cskh_dt']))
  )
);

revoke all on public.chat_session, public.chat_message from anon, authenticated;
grant select on public.chat_session, public.chat_message to authenticated;
grant all on public.chat_session, public.chat_message to service_role;

create table if not exists public.content_category (
  content_category_id uuid primary key default gen_random_uuid(),
  content_type text not null check (content_type in ('blog', 'policy', 'page')),
  slug text not null,
  name text not null,
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (content_type, slug)
);

create table if not exists public.blog (
  blog_id uuid primary key default gen_random_uuid(),
  category_slug text not null,
  slug text not null unique,
  title text not null,
  excerpt text not null default '',
  content text not null default '',
  image_url text,
  author text not null default 'Velura Editorial',
  read_minutes integer not null default 5 check (read_minutes between 1 and 60),
  is_featured boolean not null default false,
  status text not null default 'published' check (status in ('draft', 'published', 'archived')),
  published_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.policy (
  policy_id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  summary text not null default '',
  content jsonb not null default '[]'::jsonb,
  display_order integer not null default 0,
  status text not null default 'published' check (status in ('draft', 'published', 'archived')),
  updated_at timestamptz not null default now()
);

create table if not exists public.static_page (
  static_page_id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  subtitle text,
  content jsonb not null default '{}'::jsonb,
  status text not null default 'published' check (status in ('draft', 'published', 'archived')),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_content_category_touch_updated_at on public.content_category;
create trigger trg_content_category_touch_updated_at
before update on public.content_category
for each row execute function public.velura_touch_updated_at();

drop trigger if exists trg_blog_touch_updated_at on public.blog;
create trigger trg_blog_touch_updated_at
before update on public.blog
for each row execute function public.velura_touch_updated_at();

drop trigger if exists trg_policy_touch_updated_at on public.policy;
create trigger trg_policy_touch_updated_at
before update on public.policy
for each row execute function public.velura_touch_updated_at();

drop trigger if exists trg_static_page_touch_updated_at on public.static_page;
create trigger trg_static_page_touch_updated_at
before update on public.static_page
for each row execute function public.velura_touch_updated_at();

create index if not exists idx_blog_status_published
  on public.blog(status, published_at desc);
create index if not exists idx_blog_category
  on public.blog(category_slug, published_at desc);
create index if not exists idx_policy_display
  on public.policy(status, display_order asc);
create index if not exists idx_static_page_slug
  on public.static_page(slug);

alter table public.content_category enable row level security;
alter table public.blog enable row level security;
alter table public.policy enable row level security;
alter table public.static_page enable row level security;

drop policy if exists content_category_public_select on public.content_category;
create policy content_category_public_select on public.content_category
for select to anon, authenticated
using (true);

drop policy if exists blog_public_select on public.blog;
create policy blog_public_select on public.blog
for select to anon, authenticated
using (status = 'published');

drop policy if exists policy_public_select on public.policy;
create policy policy_public_select on public.policy
for select to anon, authenticated
using (status = 'published');

drop policy if exists static_page_public_select on public.static_page;
create policy static_page_public_select on public.static_page
for select to anon, authenticated
using (status = 'published');

revoke insert, update, delete, truncate on public.content_category, public.blog, public.policy, public.static_page from anon, authenticated;
grant select on public.content_category, public.blog, public.policy, public.static_page to anon, authenticated;
grant all on public.content_category, public.blog, public.policy, public.static_page to service_role;

insert into public.content_category (content_type, slug, name, display_order)
values
  ('blog', 'trend', 'Xu hướng', 10),
  ('blog', 'style', 'Phối đồ', 20),
  ('blog', 'interview', 'Phỏng vấn', 30),
  ('blog', 'sustainable', 'Bền vững', 40),
  ('blog', 'event', 'Sự kiện', 50),
  ('policy', 'returns', 'Chính sách đổi trả', 10),
  ('policy', 'privacy', 'Chính sách bảo mật', 20),
  ('policy', 'shipping', 'Chính sách vận chuyển', 30),
  ('policy', 'terms', 'Điều khoản sử dụng', 40),
  ('policy', 'faq', 'Câu hỏi thường gặp', 50),
  ('policy', 'member', 'Chính sách thành viên', 60),
  ('page', 'about', 'Giới thiệu', 10)
on conflict (content_type, slug) do update
set name = excluded.name,
    display_order = excluded.display_order,
    updated_at = now();

insert into public.blog (slug, category_slug, title, excerpt, content, image_url, author, read_minutes, is_featured, published_at)
values
  (
    'bang-mau-mua-thu-2026',
    'trend',
    'Bảng màu mùa thu 2026: sắc nâu cognac và hồng phấn lên ngôi',
    'Velura gợi ý cách phối các sắc nâu cognac, hồng phấn và xanh sage cho tủ đồ mùa thu.',
    'Các gam màu ấm giúp trang phục tối giản có chiều sâu hơn. Hãy bắt đầu bằng một món chủ đạo màu cognac, sau đó thêm phụ kiện hồng phấn hoặc xanh sage để tổng thể mềm mại mà vẫn hiện đại.',
    '/src/assets/images/phu-kien_bom-toc-ban-to-theu-hoa-vintage_03.jpg',
    'Nguyễn Thu Hà',
    8,
    true,
    '2026-06-02 09:00:00+07'
  ),
  (
    'phoi-blazer-linen-mua-he',
    'style',
    'Cách phối blazer linen cho mùa hè nhiệt đới',
    'Bốn công thức phối blazer linen thoáng mát, thanh lịch và dễ ứng dụng hằng ngày.',
    'Blazer linen hợp với quần ống suông, chân váy midi và đầm hai dây. Chìa khóa là giữ bảng màu nhẹ, chọn lớp trong mỏng và ưu tiên phom dáng rộng vừa phải.',
    '/src/assets/images/image-8.png',
    'Lê Minh Châu',
    5,
    false,
    '2026-05-14 09:00:00+07'
  ),
  (
    'tu-do-capsule-it-hon-dep-hon',
    'sustainable',
    'Tủ đồ capsule: ít hơn để mặc đẹp hơn',
    'Cách xây dựng tủ đồ gọn, bền và dễ phối mà vẫn giữ được cá tính riêng.',
    'Một tủ đồ capsule hiệu quả bắt đầu bằng các món nền trung tính, chất liệu tốt và phom dáng phù hợp. Mỗi món nên phối được tối thiểu ba hoàn cảnh khác nhau.',
    '/src/assets/images/phu-kien_khan-lua-twilly-cham-bi_01.jpg',
    'Phạm Hoàng Linh',
    11,
    false,
    '2026-05-02 09:00:00+07'
  ),
  (
    'dich-le-nhiet-ba-couture-viet',
    'event',
    'Thiết kế couture Việt trên bìa tạp chí thời trang châu Á',
    'Câu chuyện về kỹ thuật thủ công và phom dạ hội được đón nhận trong những bộ hình mới.',
    'Những thiết kế dành cho sự kiện không chỉ cần nổi bật trước ống kính. Điểm khó là giữ được độ rơi, độ ôm và sự thoải mái khi di chuyển. Velura nhìn về xu hướng này như một cách tinh tế tiếp cận với thời trang cao cấp.',
    'https://images.unsplash.com/photo-1595777457583-95e059d581b8?auto=format&fit=crop&w=1200&q=80',
    'Trần Bảo Ngọc',
    6,
    false,
    '2026-05-28 09:00:00+07'
  ),
  (
    'he-mong-dao-vay-cuoi-local-brand',
    'event',
    'Váy cưới local brand và xu hướng cô dâu tối giản',
    'Những bộ váy ren mềm, đường cắt sạch và phụ kiện tinh gọn đang được yêu thích.',
    'Thời trang cưới đang rời xa những chi tiết quá nặng. Một chiếc váy đẹp cần sự vừa vặn, một chất liệu bắt sáng và cảm giác được là chính mình trong ngày quan trọng.',
    'https://images.unsplash.com/photo-1523438885200-e635ba2c371e?auto=format&fit=crop&w=1200&q=80',
    'Lê Minh Châu',
    7,
    false,
    '2026-05-25 09:00:00+07'
  ),
  (
    'london-fashion-week-thuong-hieu-viet',
    'sustainable',
    'Thương hiệu Việt và câu chuyện bền vững tại tuần lễ thời trang',
    'Chất liệu tự nhiên, sản xuất có trách nhiệm và phom dáng lâu bền là trọng tâm mới.',
    'Bền vững không còn là một nhãn dán truyền thông. Người mặc muốn biết sản phẩm được tạo ra như thế nào, có thể đi cùng họ bao lâu và có thể chăm sóc lại ra sao.',
    'https://images.unsplash.com/photo-1509631179647-0177331693ae?auto=format&fit=crop&w=1200&q=80',
    'Phạm Hoàng Linh',
    10,
    false,
    '2026-05-20 09:00:00+07'
  ),
  (
    'quiet-luxury-velura',
    'trend',
    'Quiet luxury: vẻ sang đến từ phom dáng và chất liệu',
    'Tối giản không có nghĩa là thiếu điểm nhấn. Chìa khóa là tỉ lệ, chất vải và cách phối.',
    'Mốt quiet luxury đặt trọng tâm vào chi tiết khó nhìn thấy ngay: độ đứng của vai áo, độ rủ của lụa, đường lai váy và cách một màu trung tính làm sáng làn da.',
    'https://images.unsplash.com/photo-1434389677669-e08b4cac3105?auto=format&fit=crop&w=1200&q=80',
    'Nguyễn Thu Hà',
    7,
    false,
    '2026-05-18 09:00:00+07'
  ),
  (
    'dang-my-linh-phong-cach',
    'interview',
    'Đặng Mỹ Linh: thời trang là cách tôi ghi nhớ mỗi một giai đoạn',
    'Một cuộc trò chuyện về tủ đồ, công việc và những mẫu thiết kế giúp phụ nữ tự tin hơn.',
    'Phong cách cá nhân không cần phải gắn với quá nhiều quy tắc. Cô chia sẻ rằng những món đồ hay được mặc lại luôn có chung một điểm: vừa vặn với nhịp sống và giúp mình thả lỏng hơn.',
    'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=1200&q=80',
    'Nguyễn Thu Hà',
    9,
    false,
    '2026-05-06 09:00:00+07'
  ),
  (
    'ao-dai-ren-tet-2026',
    'interview',
    'Áo dài ren và cách làm mới trang phục truyền thống',
    'Ren mềm, tỉ lệ cổ áo gọn và gam màu sạch giúp áo dài có cảm giác hiện đại.',
    'Những phiên bản áo dài đương đại không gắng đổi mới bằng cách thêm nhiều chi tiết. Chúng đẹp nhờ cấu trúc và chất liệu có độ trong vừa phải.',
    'https://images.unsplash.com/photo-1558769132-cb1aea458c5e?auto=format&fit=crop&w=1200&q=80',
    'Nguyễn Thu Hà',
    9,
    false,
    '2026-05-06 10:00:00+07'
  ),
  (
    'phu-kien-vang-nhe-mua-le-hoi',
    'trend',
    'Phụ kiện vàng nhẹ cho mùa lễ hội',
    'Một đôi khuyên tai mảnh hoặc chiếc kẹp tóc ánh kim có thể làm trang phục sắc nét hơn.',
    'Thay vì chọn những mẫu phụ kiện quá lớn, hãy thử ánh kim với bề mặt mờ, dáng mảnh và tỉ lệ gọn. Cách này giữ được vẻ sạch, đắt giá mà không lấn át trang phục.',
    'https://images.unsplash.com/photo-1535632066927-ab7c9ab60908?auto=format&fit=crop&w=1200&q=80',
    'Trần Bảo Ngọc',
    6,
    false,
    '2026-04-28 09:00:00+07'
  )
on conflict (slug) do update
set category_slug = excluded.category_slug,
    title = excluded.title,
    excerpt = excluded.excerpt,
    content = excluded.content,
    image_url = excluded.image_url,
    author = excluded.author,
    read_minutes = excluded.read_minutes,
    is_featured = excluded.is_featured,
    status = 'published',
    updated_at = now();

update public.blog as b
set image_url = v.image_url,
    updated_at = now()
from (
  values
    ('bang-mau-mua-thu-2026', 'https://images.unsplash.com/photo-1525507119028-ed4c629a60a3?auto=format&fit=crop&w=1200&q=80'),
    ('phoi-blazer-linen-mua-he', 'https://images.unsplash.com/photo-1591047139829-d91aecb6caea?auto=format&fit=crop&w=1200&q=80'),
    ('tu-do-capsule-it-hon-dep-hon', 'https://images.unsplash.com/photo-1509319117193-57bab727e09d?auto=format&fit=crop&w=1200&q=80'),
    ('dich-le-nhiet-ba-couture-viet', 'https://images.unsplash.com/photo-1595777457583-95e059d581b8?auto=format&fit=crop&w=1200&q=80'),
    ('he-mong-dao-vay-cuoi-local-brand', 'https://images.unsplash.com/photo-1523438885200-e635ba2c371e?auto=format&fit=crop&w=1200&q=80'),
    ('london-fashion-week-thuong-hieu-viet', 'https://images.unsplash.com/photo-1509631179647-0177331693ae?auto=format&fit=crop&w=1200&q=80'),
    ('quiet-luxury-velura', 'https://images.unsplash.com/photo-1434389677669-e08b4cac3105?auto=format&fit=crop&w=1200&q=80'),
    ('dang-my-linh-phong-cach', 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=1200&q=80'),
    ('ao-dai-ren-tet-2026', 'https://images.unsplash.com/photo-1558769132-cb1aea458c5e?auto=format&fit=crop&w=1200&q=80'),
    ('phu-kien-vang-nhe-mua-le-hoi', 'https://images.unsplash.com/photo-1535632066927-ab7c9ab60908?auto=format&fit=crop&w=1200&q=80')
) as v(slug, image_url)
where b.slug = v.slug;

insert into public.policy (slug, title, summary, content, display_order)
values
  ('returns', 'Chính sách đổi trả', 'Khách hàng gửi yêu cầu đổi trả trong vòng 48 giờ kể từ khi đơn hàng được giao thành công.', '[{"heading":"Thời hạn nghiêm ngặt","items":["Khách hàng phải gửi yêu cầu trong vòng tối đa 2 ngày (48 giờ) kể từ lúc trạng thái đơn hàng cập nhật thành Đã giao thành công.","Mốc thời gian được tính dựa trên trường delivered_at từ API vận chuyển.","Sau 48 giờ, hệ thống tự động khóa tính năng gửi yêu cầu đổi trả cho đơn hàng đó."]},{"heading":"Điều kiện sản phẩm","items":["Sản phẩm chưa qua sử dụng.","Sản phẩm còn nguyên tem mác và nhãn barcode.","Sản phẩm được đặt trong bao bì đóng gói gốc của Velura."]},{"heading":"Quy trình hoàn tiền","items":["Hoàn tiền được xử lý trong vòng 4 - 5 ngày làm việc sau khi hàng về kho và đạt tiêu chuẩn kiểm tra.","Khoản hoàn được chuyển về ví điện tử hoặc chuyển khoản ngân hàng trực tiếp đối với đơn COD."]}]'::jsonb, 10),
  ('privacy', 'Chính sách bảo mật', 'Velura bảo vệ dữ liệu cá nhân, dữ liệu Style Quiz và hình ảnh khách hàng theo nguyên tắc sử dụng khép kín.', '[{"heading":"Bảo mật thông tin sinh trắc học và Style Quiz","items":["Dữ liệu Style Quiz gồm số đo ba vòng, chiều cao, cân nặng, dáng người và tông da.","Dữ liệu này được sử dụng khép kín để đề xuất size động.","Thông tin Style Quiz được dùng làm ngữ cảnh nền cho AI Stylist Chatbot nhằm cá nhân hóa tư vấn."]},{"heading":"Quy tắc ngày sinh","text":"Ngày sinh được dùng để gửi ưu đãi sinh nhật độc quyền. Hệ thống chỉ cho phép chỉnh sửa ngày sinh tối đa 2 lần để ngăn chặn hành vi gian lận voucher."},{"heading":"Bảo mật hình ảnh","items":["Ảnh chân dung hoặc ảnh trang phục khách hàng tải lên Chatbot được xử lý theo thời gian thực.","Đối với khách vãng lai (Guest), hình ảnh không được lưu trữ dài hạn.","Velura không chia sẻ hình ảnh khách hàng cho bên thứ ba."]},{"heading":"Lưu trữ Guest Session","text":"Dữ liệu ẩn danh của Guest như giỏ hàng tạm thời và Style Profile tạm được lưu trữ trên server tối đa 3 tháng. Khi Guest đăng ký tài khoản thành công, dữ liệu này được tự động đồng bộ và hợp nhất sang tài khoản thành viên mới."}]'::jsonb, 20),
  ('shipping', 'Chính sách vận chuyển', 'Đồng giá vận chuyển toàn quốc 30.000 VNĐ và miễn phí vận chuyển cho đơn hàng từ 500.000 VNĐ.', '[{"heading":"Phí vận chuyển","items":["Đồng giá tiêu chuẩn toàn quốc: 30.000 VNĐ.","Tự động áp dụng miễn phí vận chuyển cho mọi đơn hàng từ 500.000 VNĐ trở lên."]},{"heading":"Thời gian dự kiến","items":["Nội thành TP.HCM và Hà Nội: 1 - 3 ngày làm việc.","Các tỉnh thành khác: 3 - 5 ngày làm việc."]},{"heading":"Quy tắc 3 lần giao","items":["Shipper giao tối đa 3 lần cho mỗi đơn hàng.","Nếu giao thất bại sau 3 lần, đơn hàng chuyển sang trạng thái Hủy.","Đối với đơn thanh toán trước qua VNPay, hệ thống hoàn tiền sau khi khấu trừ chi phí vận chuyển 2 chiều phát sinh."]}]'::jsonb, 30),
  ('terms', 'Điều khoản sử dụng', 'Các quy tắc vận hành khi khách hàng sử dụng website, AI Stylist Chatbot và tính năng đánh giá sản phẩm.', '[{"heading":"Giới hạn AI Stylist Chatbot","items":["Để chống spam, Chatbot giới hạn tối đa 20 tin nhắn/phút.","Nếu vượt quá giới hạn, hệ thống tự động khóa tính năng chat trong vòng 5 phút.","Chatbot hỗ trợ tải ảnh dưới 5MB.","Định dạng ảnh được hỗ trợ: JPG, JPEG, PNG."]},{"heading":"Quy chuẩn đánh giá sản phẩm","items":["Chỉ khách hàng đã mua sản phẩm với đơn hàng ở trạng thái Hoàn thành mới được gửi đánh giá.","Mỗi khách hàng chỉ được đánh giá 1 lần duy nhất cho mỗi sản phẩm.","Đánh giá tiêu cực từ 1 - 3 sao hoặc chứa từ cấm sẽ nhận nhãn Cần xử lý gấp để Admin duyệt thủ công."]}]'::jsonb, 40),
  ('faq', 'Câu hỏi thường gặp', 'Các câu hỏi phổ biến được tổng hợp từ chính sách vận hành hiện tại của Velura.', '[{"heading":"Sau khi nhận hàng bao lâu tôi còn được gửi yêu cầu đổi trả?","text":"Bạn cần gửi yêu cầu trong vòng tối đa 48 giờ kể từ khi đơn hàng cập nhật trạng thái Đã giao thành công. Sau thời hạn này, hệ thống tự động khóa tính năng gửi yêu cầu."},{"heading":"Đơn hàng từ bao nhiêu tiền thì được miễn phí vận chuyển?","text":"Velura miễn phí vận chuyển cho mọi đơn hàng từ 500.000 VNĐ trở lên. Đơn dưới mức này áp dụng phí đồng giá 30.000 VNĐ toàn quốc."},{"heading":"Guest đăng ký tài khoản thì dữ liệu cũ có bị mất không?","text":"Không. Giỏ hàng tạm thời và Style Profile tạm của Guest được lưu tối đa 3 tháng và sẽ tự động hợp nhất sang tài khoản thành viên mới khi đăng ký thành công."},{"heading":"Chatbot có giới hạn gửi tin nhắn hoặc tải ảnh không?","text":"Có. Chatbot giới hạn tối đa 20 tin nhắn/phút. Nếu vượt quá, tính năng chat bị khóa 5 phút. Ảnh tải lên cần dưới 5MB và thuộc định dạng JPG, JPEG hoặc PNG."}]'::jsonb, 50),
  ('member', 'Chính sách thành viên', 'Tài khoản Member giúp đồng bộ Style Profile, lưu outfit yêu thích và mở khóa trải nghiệm cá nhân hóa.', '[{"heading":"Đặc quyền Member","items":["Đồng bộ đám mây Style Profile vĩnh viễn.","Kích hoạt feed gợi ý siêu cá nhân hóa For You Feed.","Lưu outfits yêu thích từ AI Stylist.","Tích điểm thăng hạng.","Nhận quà tặng trong tháng sinh nhật."]},{"heading":"Tạo tài khoản tự động","text":"Guest đặt hàng bằng số điện thoại và xác thực OTP SMS thành công sẽ được hệ thống tự động khởi tạo tài khoản Member. Mật khẩu tạm thời được gửi qua SMS để khách hàng đăng nhập và quản lý đơn hàng."}]'::jsonb, 60)
on conflict (slug) do update
set title = excluded.title,
    summary = excluded.summary,
    content = excluded.content,
    display_order = excluded.display_order,
    status = 'published',
    updated_at = now();

insert into public.static_page (slug, title, subtitle, content)
values (
  'about',
  'Về Velura',
  'Từ một xưởng may nhỏ đến thương hiệu thời trang được yêu mến',
  '{"story":["Velura ra đời với niềm tin rằng vẻ đẹp đích thực nằm ở sự thanh lịch có thể đồng hành qua nhiều mùa.","Chúng tôi ưu tiên chất liệu tự nhiên, phom dáng tinh tế và trải nghiệm tư vấn cá nhân hóa."],"values":[{"title":"Bền vững","text":"Ưu tiên chất liệu tự nhiên và bao bì có thể tái chế."},{"title":"Cá nhân hóa","text":"Mỗi khách hàng là một câu chuyện phong cách riêng."},{"title":"Thanh lịch","text":"Thiết kế vượt thời gian, mềm mại và tinh tế."}]}'::jsonb
)
on conflict (slug) do update
set title = excluded.title,
    subtitle = excluded.subtitle,
    content = excluded.content,
    status = 'published',
    updated_at = now();

commit;
