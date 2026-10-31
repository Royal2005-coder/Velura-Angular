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
  colNumber: string;
  script: string;
  heroGradient: string;
  kicker: string;
  storyHeadline: string;
  storyDesc: string;
  exploreCta: string;
  categoryLink: string;
  productsSub: string;
  productsTitle: string;
  closingQuote: string;
  models: string[];
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
    colNumber: 'COLLECTION 01 · SPRING / SUMMER',
    script: 'in bloom',
    heroGradient: 'linear-gradient(115deg, #D9D7C8 0%, #EEE6D9 48%, #E9D4CE 100%)',
    kicker: 'THE ART OF SOFTNESS',
    storyHeadline: 'Dịu dàng, có chủ ý.',
    storyDesc:
      'Những chuyển động mềm như lụa, sắc hoa phai và phom dáng thanh thoát. Cho những dịp đặc biệt — và cả những ngày rất đỗi bình thường.',
    exploreCta: 'Khám phá bộ sưu tập',
    categoryLink: '/products?category=dam-vay',
    productsSub: 'SELECTED FOR YOU',
    productsTitle: 'Những thiết kế nổi bật',
    closingQuote: 'Một chút lãng mạn, vừa đủ cho riêng bạn.',
    models: [
      '/assets/images/models/model_cutout_1.png',
      '/assets/images/models/model_cutout_2.png',
      '/assets/images/models/model_cutout_4.png',
      '/assets/images/models/model_cutout_3.png',
      '/assets/images/models/model_cutout_5.png',
    ],
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
    colNumber: 'COLLECTION 02 · EVERYDAY ICONS',
    script: 'city muse',
    heroGradient: 'linear-gradient(115deg, #C9C2B8 0%, #E4DDD3 48%, #BBB7AD 100%)',
    kicker: 'MADE FOR THE CITY',
    storyHeadline: 'Tự tin trong nhịp riêng.',
    storyDesc:
      'Phom dáng tinh gọn, bảng màu dịu mắt và những lớp phối linh hoạt — để nàng luôn chỉn chu mà vẫn là chính mình.',
    exploreCta: 'Xem các thiết kế',
    categoryLink: '/products?category=set-do',
    productsSub: 'CITY-READY WARDROBE',
    productsTitle: 'Chuyển động cùng thành phố',
    closingQuote: 'Từ buổi sáng đầu tiên đến cuộc hẹn cuối ngày.',
    models: [
      '/assets/images/models/model_cutout_1.png',
      '/assets/images/models/model_cutout_5.png',
      '/assets/images/models/model_cutout_3.png',
      '/assets/images/models/model_cutout_2.png',
      '/assets/images/models/model_cutout_1.png',
    ],
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
    colNumber: 'COLLECTION 03 · OFF-DUTY EASE',
    script: 'slow days',
    heroGradient: 'linear-gradient(115deg, #E1D9C9 0%, #F1E9DD 48%, #D8E0D5 100%)',
    kicker: 'A LITTLE ROOM TO BREATHE',
    storyHeadline: 'Cuối tuần thật thảnh thơi.',
    storyDesc:
      'Chất liệu thoáng nhẹ, phom dáng tự do cùng gam màu lấy cảm hứng từ thiên nhiên. Mặc đẹp mà không cần cố gắng.',
    exploreCta: 'Tìm cảm hứng dạo phố',
    categoryLink: '/products?category=set-do',
    productsSub: 'MADE FOR SLOW MORNINGS',
    productsTitle: 'Mặc nhẹ tênh, đi muôn nơi',
    closingQuote: 'Gói ghém một ngày tự do theo cách của bạn.',
    models: [
      '/assets/images/models/model_cutout_1.png',
      '/assets/images/models/model_cutout_2.png',
      '/assets/images/models/model_cutout_3.png',
      '/assets/images/models/model_cutout_4.png',
      '/assets/images/models/model_cutout_1.png',
    ],
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
    colNumber: 'COLLECTION 04 · AFTER-HOURS MUSE',
    script: 'after dark',
    heroGradient: 'linear-gradient(115deg, #716C6B 0%, #A79B95 48%, #5D5657 100%)',
    kicker: 'THE NIGHT IS YOURS',
    storyHeadline: 'Lấp lánh theo cách riêng.',
    storyDesc:
      'Đường cắt mềm, chất liệu bắt sáng vừa đủ và sắc độ nữ tính tạo nên dấu ấn không thể nhầm lẫn.',
    exploreCta: 'Chọn thiết kế dự tiệc',
    categoryLink: '/products?category=dam-vay',
    productsSub: 'A MOMENT IN THE SPOTLIGHT',
    productsTitle: 'Sắc đêm, nét kiêu kỳ',
    closingQuote: 'Để khoảnh khắc của nàng trở thành tâm điểm.',
    models: [
      '/assets/images/models/model_cutout_5.png',
      '/assets/images/models/model_cutout_4.png',
      '/assets/images/models/model_cutout_3.png',
      '/assets/images/models/model_cutout_5.png',
      '/assets/images/models/model_cutout_4.png',
    ],
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
    colNumber: 'COLLECTION 05 · MOMENTS TO KEEP',
    script: 'softly, forever',
    heroGradient: 'linear-gradient(115deg, #E7CFCA 0%, #F1E2DC 48%, #D8D9D0 100%)',
    kicker: 'A MEMORY IN EVERY THREAD',
    storyHeadline: 'Khoảnh khắc còn vương mãi.',
    storyDesc:
      'Một tuyển tập dành cho những dịp đáng nhớ: nữ tính, mềm mại và tinh tế đến từng chi tiết.',
    exploreCta: 'Khám phá sắc hồng',
    categoryLink: '/products?category=dam-vay',
    productsSub: 'THE FINAL TOUCH',
    productsTitle: 'Dành cho ngày đặc biệt',
    closingQuote: 'Giữ lại ánh nhìn, lưu lại cảm xúc.',
    models: [
      '/assets/images/models/model_cutout_2.png',
      '/assets/images/models/model_cutout_3.png',
      '/assets/images/models/model_cutout_5.png',
      '/assets/images/models/model_cutout_4.png',
      '/assets/images/models/model_cutout_2.png',
    ],
    story: [
      'The Afterglow lấy cảm hứng từ ánh hoàng hôn diễm lệ và vẻ đẹp kiêu sa, lãng mạn.',
      'Những chất liệu mềm mại, corset tinh tế và sắc màu từ hồng tulle đến xanh Sapphire tạo nên cảm giác vương giả.',
      'Khi kết hợp cùng phụ kiện lấp lánh, mỗi set đồ trở thành một dấu ấn nữ tính, nổi bật nhưng vẫn đầy tiết chế.',
    ],
  },
];
