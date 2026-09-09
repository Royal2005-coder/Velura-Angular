export const adminResources = {
  accounts: {
    table: "users",
    module: "accounts",
    select: "user_id,email,phone,full_name,avatar,role,admin_role,is_active,is_verified,lock_type,lock_reason,locked_at,created_at,last_login_at,version,updated_at",
    searchColumns: ["full_name", "email", "phone"],
    defaultOrder: "created_at.desc"
  },
  products: {
    table: "products",
    module: "products",
    select: "*,category:categories(id,name,slug)",
    searchColumns: ["name", "sku"],
    defaultOrder: "updated_at.desc"
  },
  categories: {
    table: "categories",
    module: "products",
    select: "*",
    searchColumns: ["name", "slug"],
    defaultOrder: "sort_order.asc"
  },
  orders: {
    table: "orders",
    module: "orders",
    select: "*,customer:profiles(id,full_name,email,phone)",
    searchColumns: ["order_code", "customer_name", "customer_phone", "customer_email"],
    defaultOrder: "created_at.desc"
  },
  "order-items": {
    table: "order_items",
    module: "orders",
    select: "*,product:products(id,sku,name)",
    searchColumns: ["sku", "product_name"],
    defaultOrder: "created_at.asc"
  },
  reviews: {
    table: "reviews",
    module: "reviews",
    select: "*,product:products(id,sku,name),customer:profiles(id,full_name,email)",
    searchColumns: ["title", "body", "customer_name"],
    defaultOrder: "created_at.desc"
  },
  returns: {
    table: "return_requests",
    module: "returns",
    select: "*,order:orders(id,order_code),customer:profiles(id,full_name,email,phone)",
    searchColumns: ["request_code", "customer_name", "customer_phone"],
    defaultOrder: "created_at.desc"
  },
  "support-tickets": {
    table: "support_tickets",
    module: "support_tickets",
    select: "*,customer:profiles(id,full_name,email,phone)",
    searchColumns: ["ticket_code", "customer_name", "subject", "content"],
    defaultOrder: "created_at.desc"
  },
  promotions: {
    table: "promotions",
    module: "promotions",
    select: "*",
    searchColumns: ["name", "code"],
    defaultOrder: "created_at.desc"
  },
  vouchers: {
    table: "vouchers",
    module: "vouchers",
    select: "*,promotion:promotions(id,name,code)",
    searchColumns: ["code", "name"],
    defaultOrder: "created_at.desc"
  },
  bundles: {
    table: "bundles",
    module: "bundles",
    select: "*",
    searchColumns: ["name", "code"],
    defaultOrder: "created_at.desc"
  },
  budgets: {
    table: "promotion_budgets",
    module: "budgets",
    select: "*,promotion:promotions(id,name,code)",
    searchColumns: ["name"],
    defaultOrder: "created_at.desc"
  },
  logs: {
    table: "audit_logs",
    module: "audit_logs",
    select: "*",
    searchColumns: ["actor_name", "target_code", "action", "summary"],
    defaultOrder: "created_at.desc",
    readOnly: true
  },
  "email-outbox": {
    table: "email_outbox",
    module: "audit_logs",
    select: "*",
    searchColumns: ["recipient", "subject"],
    defaultOrder: "created_at.desc",
    readOnly: true
  }
};

export function getResource(name) {
  return adminResources[name] || null;
}

export function buildListQuery(resource, url) {
  const query = {
    select: resource.select,
    order: url.searchParams.get("order") || resource.defaultOrder,
    limit: clamp(Number(url.searchParams.get("limit") || 50), 1, 200),
    offset: clamp(Number(url.searchParams.get("offset") || 0), 0, 1000000)
  };

  const status = url.searchParams.get("status");
  if (status) query.status = `eq.${status}`;

  const type = url.searchParams.get("type");
  if (type) query.type = `eq.${type}`;

  const q = url.searchParams.get("q");
  if (q && resource.searchColumns?.length) {
    const safe = q.replace(/[,*()]/g, " ").trim();
    if (safe) {
      query.or = `(${resource.searchColumns.map((column) => `${column}.ilike.*${safe}*`).join(",")})`;
    }
  }

  const id = url.searchParams.get("id");
  if (id) query.id = `eq.${id}`;

  const orderId = url.searchParams.get("order_id");
  if (orderId) query.order_id = `eq.${orderId}`;

  const promotionId = url.searchParams.get("promotion_id");
  if (promotionId) query.promotion_id = `eq.${promotionId}`;

  return query;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
