export interface HotBanner {
  id: string;
  eyebrow: string;
  title: string;
  description: string;
  ctaText: string;
  href: string;
  imageSrc: string;
  imageAlt: string;
  benefit: string;
  condition: string;
}

export const HOT_BANNERS: HotBanner[] = [
  {
    id: 'A1',
    eyebrow: 'ƯU ĐÃI CÁ NHÂN',
    title: 'Tháng sinh nhật của bạn',
    description: 'Voucher BDAY15 giảm 15% và quà bất ngờ trong tháng sinh nhật',
    ctaText: 'Nhận quà ngay',
    href: '/offers?offer=A1',
    imageSrc: '/assets/images/banners/hot-banner-a1-birthday.png',
    imageAlt: 'Tháng sinh nhật của bạn - Velura có quà nhỏ dành riêng',
    benefit: 'Giảm 15%, tối đa 300.000đ trong tháng sinh nhật.',
    condition: 'Cần ngày sinh hợp lệ để kích hoạt ưu đãi.',
  },
  {
    id: 'A2',
    eyebrow: 'CHỈ CÒN 2 NGÀY',
    title: 'Chỉ còn 2 ngày',
    description: 'Flash Sale ngắn hạn, giảm trực tiếp trên các sản phẩm được chọn',
    ctaText: 'Xem ngay',
    href: '/products?sale=true&campaign=flash-sale',
    imageSrc: '/assets/images/banners/hot-banner-a2-last-days.png',
    imageAlt: 'Chỉ còn 2 ngày - ưu đãi Flash Sale tháng này',
    benefit: 'Giá sản phẩm đã giảm trực tiếp trong thời gian Flash Sale.',
    condition: 'Chỉ áp dụng cho sản phẩm còn hàng trong chương trình.',
  },
  {
    id: 'A3',
    eyebrow: 'PHỐI ĐỒ THÔNG MINH',
    title: 'Combo Phối Đồ Tiết Kiệm',
    description: 'Mua trọn set phối sẵn - tiết kiệm thêm 10%',
    ctaText: 'Thêm vào giỏ trọn set',
    href: '/collections?type=combo&offer=monthly-combo',
    imageSrc: '/assets/images/banners/hot-banner-a3-combo.png',
    imageAlt: 'Combo phối đồ tiết kiệm - mua trọn set tiết kiệm thêm 10%',
    benefit: 'Mua đủ set được giảm thêm 10%.',
    condition: 'Cần mua đủ các sản phẩm bắt buộc trong set.',
  },
  {
    id: 'A4',
    eyebrow: 'DÀNH CHO MEMBER',
    title: 'Khách hàng thân thiết',
    description: 'Quyền lợi tự động theo tổng chi tiêu tích lũy',
    ctaText: 'Xem quyền lợi',
    href: '/offers?offer=A4',
    imageSrc: '/assets/images/banners/hot-banner-a4-loyal.png',
    imageAlt: 'Khách hàng thân thiết - quyền lợi theo tổng chi tiêu tích lũy',
    benefit: 'Mở khóa quyền lợi theo tổng chi tiêu tích lũy.',
    condition: 'Dành cho thành viên có lịch sử mua sắm tại Velura.',
  },
  {
    id: 'A5',
    eyebrow: 'CHIA SẺ CÙNG BẠN',
    title: 'Một mình vui không bằng cả hai',
    description: 'Bạn nhận 50.000đ, người mới nhận 30.000đ khi giới thiệu thành công',
    ctaText: 'Chia sẻ ngay',
    href: '/offers?offer=A5',
    imageSrc: '/assets/images/banners/hot-banner-a5-friend.png',
    imageAlt: 'Rủ bạn bè - chia sẻ voucher cho bạn',
    benefit: 'Bạn nhận 50.000đ, người mới nhận 30.000đ khi đủ điều kiện.',
    condition: 'Thưởng được cấp sau khi người được giới thiệu hoàn tất đơn đầu tiên.',
  },
  {
    id: 'A6',
    eyebrow: 'MIỄN PHÍ VẬN CHUYỂN',
    title: 'FreeShip cho đơn từ 500k',
    description: 'Miễn phí vận chuyển tiêu chuẩn toàn quốc cho đơn từ 500.000đ',
    ctaText: 'Xem ngay',
    href: '/offers?offer=A6',
    imageSrc: '/assets/images/banners/hot-banner-a6-freeship.png',
    imageAlt: 'FreeShip cho đơn từ 500k - áp dụng toàn quốc',
    benefit: 'Miễn phí vận chuyển cho đơn từ 500.000đ.',
    condition: 'Áp dụng tự động khi tổng đơn đạt ngưỡng.',
  },
];
