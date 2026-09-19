-- Migration: Bổ sung trường trình bày cho chiến dịch khuyến mãi.
-- Target table: public.promotion
--
-- Bối cảnh: trang Ưu đãi phía khách đang hiển thị một mảng banner viết cứng trong mã
-- nguồn (`hot-banner.ts`), không nối cơ sở dữ liệu — admin tạm dừng chiến dịch thì
-- khách vẫn thấy y nguyên. Để trang đó chạy bằng dữ liệu thật, bảng chiến dịch cần
-- mang được nội dung marketing chứ không chỉ mang tham số tính tiền.

alter table public.promotion
  add column if not exists description       text,
  add column if not exists banner_image_url  text,
  add column if not exists highlight_label   varchar(60),
  add column if not exists display_order     integer not null default 0,
  add column if not exists is_featured       boolean not null default false;

comment on column public.promotion.description      is 'Mô tả hiển thị cho khách trên trang Ưu đãi.';
comment on column public.promotion.banner_image_url is 'Ảnh banner của chiến dịch. Rỗng thì giao diện dùng ảnh mặc định theo loại chiến dịch.';
comment on column public.promotion.highlight_label  is 'Nhãn nổi bật, ví dụ "Chỉ còn 2 ngày" hoặc "Dành riêng cho bạn".';
comment on column public.promotion.display_order    is 'Thứ tự hiển thị trên trang Ưu đãi, nhỏ hơn lên trước.';
comment on column public.promotion.is_featured      is 'Đánh dấu chiến dịch được đẩy lên khối nổi bật đầu trang.';

create index if not exists idx_promotion_public_display
  on public.promotion (is_active, display_order)
  where is_active = true;
