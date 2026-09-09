export interface CollectionLookbook {
  id: string;
  name: string;
  label: string;
  quote: string;
  banner: string;
  decor: string;
  story: string[];
  badge: string;
  homeStory: string;
}

export const COLLECTION_LOOKBOOKS: CollectionLookbook[] = [
  {
    id: 'soft-ceremony',
    name: 'Soft Ceremony',
    label: 'Thanh lịch & Kiêu sa',
    quote: 'Thanh lịch không phải là nổi bật, mà là biết cách tôn lên chính mình.',
    banner:
      'https://cdn.jsdelivr.net/gh/khai0335814880-create/Velura-Images@main/categories/set-do/velura_Soft-Ceremony_cover.png',
    decor: '/assets/images/collections/soft-ceremony-decor.png',
    badge: 'ELEGANT',
    homeStory:
      'Những thiết kế mềm mại, tinh tế cho những dịp tiệc nhẹ, hẹn hò và các buổi gặp gỡ đặc biệt — sang trọng, hiện đại, dễ ứng dụng.',
    story: [
      'Soft Ceremony là bộ sưu tập dành cho những dịp cần sự chỉn chu hơn thường ngày như tiệc nhẹ, hẹn hò, chụp ảnh hay những buổi gặp gỡ đặc biệt.',
      'Lấy cảm hứng từ vẻ đẹp nữ tính và thanh lịch, các thiết kế được xây dựng với phom dáng mềm mại, đường cắt tinh tế cùng những điểm nhấn vừa đủ.',
      'Với bảng màu trung tính, ấm và dịu, bộ sưu tập mang đến cảm giác sang trọng, hiện đại và dễ ứng dụng trong nhiều hoàn cảnh.',
    ],
  },
  {
    id: 'the-urban-rhythm',
    name: 'The Urban Rhythm',
    label: 'Năng động & Thời thượng',
    quote: 'Nhịp sống hiện đại đẹp nhất khi sự tự tin luôn vừa vặn với từng chuyển động.',
    banner:
      'https://cdn.jsdelivr.net/gh/khai0335814880-create/Velura-Images@main/categories/set-do/Velura_urban-rythm_cover.png',
    decor: '/assets/images/collections/the-urban-rhythm-decor.png',
    badge: 'CASUAL',
    homeStory:
      'Phom dáng hiện đại, đường cắt sắc sảo — bảng màu beige, charcoal, olive dễ mix-and-match cho cả ngày làm việc bận rộn lẫn buổi dạo phố cuối tuần.',
    story: [
      'The Urban Rhythm dành cho những quý cô hiện đại yêu thích sự linh hoạt giữa môi trường công sở và nhịp sống phố thị.',
      'Các thiết kế tập trung vào phom dáng hiện đại, đường cắt sắc sảo và tính ứng dụng cao để tôn lên thần thái độc lập.',
      'Bảng màu beige ấm, xám charcoal, trắng kem và xanh olive giúp từng set đồ dễ mix-match nhưng vẫn giữ nét sang trọng.',
    ],
  },
  {
    id: 'weekend-escape',
    name: 'Weekend Escape',
    label: 'Tự do & Phóng khoáng',
    quote: 'Một cuối tuần đẹp bắt đầu từ cảm giác nhẹ nhàng trong chính bộ đồ mình chọn.',
    banner:
      'https://cdn.jsdelivr.net/gh/khai0335814880-create/Velura-Images@main/categories/set-do/velura_Weekend-Escape_cover.png',
    decor: '/assets/images/collections/weekend-escape-decor.png',
    badge: 'TRAVEL',
    homeStory:
      'Phom dáng nhẹ nhàng, chất liệu thoáng mát — dạo phố, cà phê hay du lịch đều thoải mái, thanh lịch trong mọi hành trình.',
    story: [
      'Weekend Escape lấy cảm hứng từ những chuyến đi cuối tuần và những ngày thư giãn trọn vẹn.',
      'Bộ sưu tập đề cao sự thoải mái nhưng vẫn giữ vẻ thanh lịch với phom dáng nhẹ nhàng và chất liệu thoáng mát.',
      'Dù là dạo phố, cà phê cuối tuần hay du lịch ngắn ngày, các set đồ đều hướng tới sự tự tin và linh hoạt.',
    ],
  },
  {
    id: 'midnight-mirage',
    name: 'Midnight Mirage',
    label: 'Cá tính & Đường phố',
    quote: 'Cá tính không cần ồn ào, chỉ cần đủ rõ để người mặc thấy mình trong đó.',
    banner:
      'https://cdn.jsdelivr.net/gh/khai0335814880-create/Velura-Images@main/categories/set-do/velura_Midnight-Mirage_cover.png',
    decor: '/assets/images/collections/midnight-mirage-decor.png',
    badge: 'STREET',
    homeStory:
      'Street style Hàn Quốc — Grunge, Campus Girl, Y2K Minimal. Bảng màu trung tính pha pastel, trẻ trung và dễ phối đồ mọi ngày.',
    story: [
      'Midnight Mirage lấy cảm hứng từ thời trang đường phố Hàn Quốc, kết hợp nét cá tính, tối giản và hiện đại.',
      'Các outfit mang nhiều sắc thái như Grunge, Soft Neutral, Campus Girl, Street Prep và Y2K Minimal.',
      'Tổng thể bộ sưu tập trẻ trung, linh hoạt, dễ phối và phù hợp cho đi học, đi làm, dạo phố hoặc cà phê cuối tuần.',
    ],
  },
  {
    id: 'the-afterglow',
    name: 'The Afterglow',
    label: 'Dư âm Vương giả',
    quote: 'Có những khoảnh khắc không cần phô diễn, chỉ cần lưu lại như một vệt sáng rất riêng.',
    banner:
      'https://cdn.jsdelivr.net/gh/khai0335814880-create/Velura-Images@main/categories/set-do/velura_The-Afterglow_cover.png',
    decor: '/assets/images/collections/the-afterglow-decor.png',
    badge: 'COUTURE',
    homeStory:
      'Dư âm vương giả — lụa satin, corset tinh tế và sắc hồng tulle cùng xanh Sapphire tôn vinh vẻ đẹp kiêu sa, lộng lẫy như một tiểu thư vương giả.',
    story: [
      'The Afterglow lấy cảm hứng từ ánh hoàng hôn diễm lệ và vẻ đẹp kiêu sa, lãng mạn.',
      'Những chất liệu mềm mại, corset tinh tế và sắc màu từ hồng tulle đến xanh Sapphire tạo nên cảm giác vương giả.',
      'Khi kết hợp cùng phụ kiện lấp lánh, mỗi set đồ trở thành một dấu ấn nữ tính, nổi bật nhưng vẫn đầy tiết chế.',
    ],
  },
];
