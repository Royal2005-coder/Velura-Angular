export const CHAT_SESSION_SELECT = [
  "session_id",
  "user_id",
  "profile_user_id",
  "guest_id",
  "title",
  "source",
  "is_active",
  "handoff_status",
  "support_ticket_id",
  "last_message_preview",
  "last_message_at",
  "metadata",
  "assigned_to",
  "created_at",
  "updated_at",
  "support_ticket:support_ticket(ticket_id,status,priority,admin_reply,created_at,resolved_at,version)"
].join(",");

export const CHAT_MESSAGE_SELECT = [
  "message_id",
  "session_id",
  "sender",
  "text",
  "metadata",
  "product_ids",
  "created_at"
].join(",");

export const CHAT_PRODUCT_SELECT = [
  "product_id",
  "sku",
  "is_combo",
  "name",
  "slug",
  "description",
  "category_id",
  "brand",
  "base_price",
  "sale_price",
  "images",
  "style_tags",
  "color_tone",
  "occasions",
  "suitable_body_shapes",
  "status",
  "is_featured",
  "collection",
  "category:category(category_id,name,slug)",
  "variants:variant(variant_id,color,color_hex,size,stock_quantity,reserved_quantity)"
].join(",");

export const CHAT_SUPPORT_ROLES = [
  "super_admin",
  "admin_operator_cskh_dt"
];

export const DEFAULT_ASSISTANT_GREETING =
  "Xin chào, mình là **Velura Stylist** - trợ lý thời trang AI của cửa hàng Velura.\n\nMình ở đây để giúp bạn mua sắm dễ hơn, chọn đồ có gu hơn và được chăm sóc đúng lúc hơn.\n\n**Mình có thể hỗ trợ bạn:**\n- Gợi ý outfit theo dịp mặc: đi làm, đi chơi, dự tiệc, du lịch hoặc hẹn hò\n- Tìm sản phẩm Velura theo phong cách, màu sắc, ngân sách và chất liệu bạn thích\n- Tư vấn size theo chiều cao, cân nặng, số đo và dáng người\n- Gợi ý cách phối đồ, phụ kiện và bảng màu để tổng thể thanh lịch hơn\n- Hỗ trợ tra cứu đơn hàng, chính sách giao hàng, đổi trả và thanh toán\n- Tạo ticket hoặc kết nối nhân viên CSKH khi bạn cần hỗ trợ trực tiếp\n\n**Bạn có thể bắt đầu bằng:**\n- \"Gợi ý outfit công sở thanh lịch\"\n- \"Tìm váy dự tiệc dưới 800.000đ\"\n- \"Tư vấn size cho mình: cao 1m60, nặng 50kg\"\n- \"Mình muốn gặp CSKH\"";

export const HANDOFF_REPLY =
  "Mình đã ghi nhận yêu cầu hỗ trợ trực tiếp của bạn. Velura sẽ chuyển cuộc trò chuyện này đến nhân viên CSKH để tiếp tục chăm sóc bạn trong thời gian sớm nhất.";
