export interface BlogPost {
  slug: string;
  category: 'trend' | 'style' | 'interview' | 'sustainable' | 'event';
  badge: string;
  title: string;
  excerpt: string;
  image: string;
  author: string;
  date: string;
  readMinutes: number;
  featured?: boolean;
}

export const BLOG_POSTS: BlogPost[] = [
  {
    slug: 'xu-huong-mau-sac-he-2026',
    category: 'trend',
    badge: 'Xu hướng',
    title: 'Xu hướng màu sắc hè 2026: Bảng màu cho tủ đồ mới',
    excerpt:
      'Sage, cocoa, ivory và hồng phấn - những gam màu đang chiếm lĩnh mùa hè năm nay. Khám phá cách phối chúng trong tủ đồ Velura.',
    image: 'https://images.unsplash.com/photo-1496747611176-843222e1e57c?q=80&w=1400&auto=format&fit=crop',
    author: 'Nguyễn Thu Hà',
    date: '05 tháng 07, 2026',
    readMinutes: 8,
    featured: true,
  },
  {
    slug: 'cong-thuc-phoi-do-resort-he-2026',
    category: 'style',
    badge: 'Phối đồ',
    title: 'Công thức phối đồ resort hè 2026',
    excerpt: 'Vali 3 ngày với 5 món đồ linh hoạt từ sân bay đến bữa tối ven biển.',
    image: 'https://images.unsplash.com/photo-1529139574466-a303027c1d8b?q=80&w=600&auto=format&fit=crop',
    author: 'Lê Minh Châu',
    date: '03/07/2026',
    readMinutes: 7,
  },
  {
    slug: 'phong-cach-toi-gian-stylist-mai-anh',
    category: 'interview',
    badge: 'Phỏng vấn',
    title: 'Phỏng vấn stylist Mai Anh: Tối giản là biết đủ',
    excerpt: 'Một cuộc trò chuyện về chiếc áo mặc lại nhiều lần và cách mua ít hơn mà vẫn đẹp.',
    image: 'https://images.unsplash.com/photo-1487412720507-e7ab37603c6f?q=80&w=600&auto=format&fit=crop',
    author: 'Trần Bảo Ngọc',
    date: '01/07/2026',
    readMinutes: 9,
  },
  {
    slug: 'chat-lieu-tu-nhien-mua-he',
    category: 'sustainable',
    badge: 'Bền vững',
    title: 'Chất liệu tự nhiên mùa hè: Linen, lụa và cotton pha',
    excerpt: 'Bền vững bắt đầu từ câu hỏi: Món đồ này có được mặc lại không và có còn đẹp sau nhiều lần sử dụng?',
    image: 'https://images.unsplash.com/photo-1523381210434-271e8be1f52b?q=80&w=600&auto=format&fit=crop',
    author: 'Phạm Hoàng Linh',
    date: '29/06/2026',
    readMinutes: 10,
  },
  {
    slug: 'velura-summer-salon-2026',
    category: 'event',
    badge: 'Sự kiện',
    title: 'Velura Summer Salon 2026: Buổi thử đồ riêng tư',
    excerpt: 'Sự kiện giới thiệu các set resort, dạ tiệc nhẹ và phụ kiện cho mùa du lịch mới.',
    image: 'https://images.unsplash.com/photo-1519741497674-611481863552?q=80&w=600&auto=format&fit=crop',
    author: 'Minh Anh',
    date: '27/06/2026',
    readMinutes: 6,
  },
  {
    slug: 'dich-le-nhiet-ba-phan-huy',
    category: 'event',
    badge: 'Sự kiện',
    title: 'Địch Lệ Nhiệt Ba mặc thiết kế Phan Huy trên bìa tạp chí',
    excerpt:
      "Mỹ nữ Tân Cương Địch Lệ Nhiệt Ba diện đầm Haute Couture 'Cành vàng lá ngọc' của NTK trẻ Phan Huy trên bìa ấn phẩm Marie Claire Trung Quốc.",
    image: 'https://images.unsplash.com/photo-1566174053879-31528523f8ae?q=80&w=600&auto=format&fit=crop',
    author: 'Lê Minh Châu',
    date: '28/05/2026',
    readMinutes: 6,
  },
  {
    slug: 'he-mong-dao-dam-viet',
    category: 'event',
    badge: 'Sự kiện',
    title: 'Hề Mộng Dao diện đầm của nhà mốt Việt trong ảnh cưới',
    excerpt:
      'Siêu mẫu Hề Mộng Dao chọn đầm ren thêu tinh xảo của local brand Việt trong loạt ảnh pre-wedding cùng doanh nhân Hà Du Quân.',
    image: 'https://images.unsplash.com/photo-1595777457583-95e059d581b8?q=80&w=600&auto=format&fit=crop',
    author: 'Trần Bảo Ngọc',
    date: '25/05/2026',
    readMinutes: 12,
  },
  {
    slug: 'ba-thuong-hieu-viet-london-fw',
    category: 'sustainable',
    badge: 'Bền vững',
    title: 'Ba thương hiệu Việt tại London Fashion Week Spring 2026',
    excerpt: 'Lần đầu tiên, ba thương hiệu Việt cùng xuất hiện trong lịch trình chính thức tại London Fashion Week.',
    image: 'https://images.unsplash.com/photo-1509631179647-0177331693ae?q=80&w=600&auto=format&fit=crop',
    author: 'Phạm Hoàng Linh',
    date: '20/05/2026',
    readMinutes: 10,
  },
  {
    slug: 'quiet-luxury-viet-nam',
    category: 'trend',
    badge: 'Xu hướng',
    title: 'Quiet luxury: Vì sao phái đẹp Việt đang chuộng vẻ đẹp sang',
    excerpt: 'Sự trở lại của những thiết kế tối giản, chất liệu cao cấp không logo đang định nghĩa lại khái niệm sang trọng.',
    image: 'https://images.unsplash.com/photo-1434389677669-e08b4cac3105?q=80&w=600&auto=format&fit=crop',
    author: 'Nguyễn Thu Hà',
    date: '18/05/2026',
    readMinutes: 7,
  },
  {
    slug: 'phoi-blazer-linen-mua-he',
    category: 'style',
    badge: 'Phối đồ',
    title: 'Cách phối blazer linen cho mùa hè nhiệt đới',
    excerpt: 'Blazer không còn là độc quyền của mùa thu. Khám phá 4 công thức phối đồ thoáng mát mà vẫn thanh lịch.',
    image: 'https://images.unsplash.com/photo-1591047139829-d91aecb6caea?q=80&w=600&auto=format&fit=crop',
    author: 'Lê Minh Châu',
    date: '14/05/2026',
    readMinutes: 5,
  },
];
