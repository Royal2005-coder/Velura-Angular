import { selectRows } from "./supabase.js";
import { asJsonObject, asString, type JsonObject } from "./types.js";

/**
 * Bảng `audit_log` chỉ lưu UUID: ai thao tác, trên đối tượng nào, kèm hai khối JSON
 * trước/sau. Đọc thô thì người vận hành thấy một dãy id và một cục JSON — không trả lời
 * được câu hỏi duy nhất họ cần: "ai vừa đổi gì".
 *
 * Module này tra id ra tên và diễn giải phần chênh lệch thành một câu tiếng Việt, theo
 * đúng cách `product-service.ts` đã làm riêng cho catalog từ trước — chỉ khác là tham số
 * hoá theo phân hệ để mọi module dùng chung một bản.
 */

/** Cách tra nhãn cho đối tượng bị tác động của một phân hệ. */
export interface AuditTargetLookup {
  /** Bảng chứa đối tượng, ví dụ `orders`. */
  table: string;
  /** Cột khoá chính dùng để lọc `in.(...)`, ví dụ `order_id`. */
  idColumn: string;
  /** Danh sách cột cần lấy, đủ để dựng nhãn. */
  select: string;
  /** Dựng nhãn hiển thị từ một dòng đã tra được. */
  label(row: JsonObject): string;
}

/** Cấu hình enrich riêng của từng phân hệ. */
export interface AuditEnrichmentConfig {
  /** Bỏ trống nếu phân hệ không có bảng đối tượng để tra. */
  target?: AuditTargetLookup;
  /**
   * Bộ tra theo `module` của từng dòng, cho trang nhật ký tổng hợp nhiều phân hệ.
   * Khi có cả `target` thì `target` được ưu tiên.
   */
  targets?: Readonly<Record<string, AuditTargetLookup>>;
  /** Các trường đáng tóm tắt khi so sánh trước/sau, theo thứ tự ưu tiên. */
  fields?: readonly string[];
  /** Từ điển trạng thái sang tiếng Việt của phân hệ. */
  statusLabels?: Readonly<Record<string, string>>;
  /** Nhãn hành động riêng; trả `null` để dùng nhãn mặc định. */
  actionLabel?(action: string, oldValue: JsonObject, newValue: JsonObject): string | null;
}

/** Danh sách nhật ký đã chuẩn hoá theo hợp đồng `{ rows, count }` của admin. */
export interface AuditListPayload {
  rows: JsonObject[];
  count: number | undefined;
}

const ROLE_LABELS: Readonly<Record<string, string>> = {
  admin_super: "Super Admin",
  super_admin: "Super Admin",
  admin_operator_sanpham: "Quản lý sản phẩm",
  admin_operator_donhang: "Quản lý đơn hàng",
  admin_operator_gia_km: "Quản lý giá / KM",
  admin_operator_danhgia_review: "Quản lý đánh giá",
  admin_operator_cskh_dt: "CSKH / Đổi trả",
  admin_viewer: "Chỉ xem",
  member: "Khách hàng",
  system: "Hệ thống"
};

const ACTION_LABELS: Readonly<Record<string, string>> = {
  create: "Tạo mới",
  update: "Cập nhật",
  delete: "Xoá",
  approve: "Phê duyệt",
  reject: "Từ chối",
  hide: "Ẩn",
  unhide: "Bỏ ẩn",
  reply: "Phản hồi",
  escalate: "Chuyển CSKH",
  lock: "Khoá tài khoản",
  unlock: "Mở khoá tài khoản",
  role: "Đổi vai trò",
  login: "Đăng nhập",
  logout: "Đăng xuất",
  refund: "Hoàn tiền",
  exchange: "Đổi hàng"
};

/**
 * Bộ tra đối tượng theo `module`, dùng chung cho trang nhật ký tổng hợp và cho tab
 * nhật ký của từng phân hệ. Một chỗ khai báo để mọi màn hình gọi cùng một tên.
 */
export const AUDIT_TARGETS: Readonly<Record<string, AuditTargetLookup>> = {
  accounts: {
    table: "users",
    idColumn: "user_id",
    select: "user_id,full_name,email",
    label: (row) => {
      const name = asString(row.full_name);
      const email = asString(row.email);
      if (name && email) return `${name} (${email})`;
      return name || email || shortId(asString(row.user_id));
    }
  },
  products: {
    table: "product",
    idColumn: "product_id",
    select: "product_id,sku,name",
    label: (row) => {
      const sku = asString(row.sku);
      const name = asString(row.name);
      if (sku && name) return `${sku} — ${name}`;
      return sku || name || shortId(asString(row.product_id));
    }
  },
  orders: {
    table: "orders",
    idColumn: "order_id",
    select: "order_id,shipping_name",
    label: (row) => {
      const code = shortId(asString(row.order_id));
      const customer = asString(row.shipping_name);
      return customer ? `Đơn ${code} — ${customer}` : `Đơn ${code}`;
    }
  },
  promotions: {
    table: "promotion",
    idColumn: "promo_id",
    select: "promo_id,promo_name",
    label: (row) => asString(row.promo_name) || shortId(asString(row.promo_id))
  },
  vouchers: {
    table: "voucher",
    idColumn: "voucher_id",
    select: "voucher_id,code,name",
    label: (row) => {
      const code = asString(row.code);
      const name = asString(row.name);
      if (code && name) return `${code} — ${name}`;
      return code || name || shortId(asString(row.voucher_id));
    }
  },
  reviews: {
    table: "review",
    idColumn: "review_id",
    select: "review_id,rating",
    label: (row) => {
      const rating = asString(row.rating);
      const code = shortId(asString(row.review_id));
      return rating ? `Đánh giá ${rating}★ ${code}` : `Đánh giá ${code}`;
    }
  },
  returns: {
    table: "return_exchange",
    idColumn: "return_id",
    select: "return_id,return_type",
    label: (row) => {
      const type = asString(row.return_type);
      const code = shortId(asString(row.return_id));
      return type ? `Phiếu ${type} ${code}` : `Phiếu ${code}`;
    }
  }
};

// Giá đổi trên sản phẩm, nên nhật ký giá tra cùng bảng với catalog.
const PRICING_TARGETS: Readonly<Record<string, AuditTargetLookup>> = {
  pricing: AUDIT_TARGETS.products
};

/** Bộ tra đầy đủ cho trang nhật ký tổng hợp. */
export const ALL_AUDIT_TARGETS: Readonly<Record<string, AuditTargetLookup>> = {
  ...AUDIT_TARGETS,
  ...PRICING_TARGETS
};

/**
 * Cấu hình nhật ký của từng phân hệ: tra đối tượng ở bảng nào, tóm tắt trường nào,
 * và đọc trạng thái ra tiếng Việt theo từ vựng của chính phân hệ đó.
 *
 * Để chung một chỗ vì đây là hợp đồng hiển thị giữa API và tab nhật ký trên admin —
 * tách ra mỗi module một bản thì các phân hệ lại gọi cùng một trạng thái bằng hai tên
 * khác nhau, đúng lỗi đang có giữa Orders và CSKH.
 */
export const ACCOUNT_AUDIT: AuditEnrichmentConfig = {
  target: AUDIT_TARGETS.accounts,
  fields: ["role", "admin_role", "is_active", "lock_type", "locked_until"],
  statusLabels: { active: "Đang hoạt động", locked: "Bị khoá" }
};

export const REVIEW_AUDIT: AuditEnrichmentConfig = {
  target: AUDIT_TARGETS.reviews,
  fields: ["status", "admin_reply", "rejection_reason"],
  statusLabels: { pending: "Chờ duyệt", approved: "Đã duyệt", rejected: "Đã ẩn" }
};

export const RETURN_AUDIT: AuditEnrichmentConfig = {
  target: AUDIT_TARGETS.returns,
  fields: ["status", "refund_amount", "admin_note", "rejection_reason"],
  statusLabels: {
    pending: "Chờ xử lý",
    approved: "Đã duyệt",
    shipping_back: "Đang gửi về",
    received: "Đã nhận",
    completed: "Hoàn tất",
    rejected: "Từ chối",
    open: "Mới",
    processing: "Đang xử lý",
    resolved: "Đã giải quyết",
    closed: "Đã đóng"
  }
};

export const PRICING_AUDIT: AuditEnrichmentConfig = {
  targets: { ...PRICING_TARGETS, promotions: AUDIT_TARGETS.promotions, vouchers: AUDIT_TARGETS.vouchers },
  fields: ["base_price", "sale_price", "promo_name", "budget_limit", "is_active", "discount_value"],
  statusLabels: {
    on_sale: "Đang bán",
    hidden: "Tạm ẩn",
    out_of_stock: "Hết hàng",
    discontinued: "Ngừng kinh doanh"
  }
};

function lookupFor(row: JsonObject, config: AuditEnrichmentConfig): AuditTargetLookup | undefined {
  if (config.target) return config.target;
  const module = asString(row.module) || "";
  return config.targets?.[module];
}

/**
 * Tra UUID thành nhãn đọc được cho một trang nhật ký.
 *
 * Mọi lỗi tra cứu đều nuốt và trả về map rỗng: nhật ký hiển thị thiếu tên vẫn hơn là
 * cả trang nhật ký trả lỗi.
 */
export async function enrichAuditLogs(
  payload: AuditListPayload | JsonObject[] | unknown,
  config: AuditEnrichmentConfig = {}
): Promise<AuditListPayload> {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { rows?: JsonObject[] })?.rows)
      ? (payload as { rows: JsonObject[] }).rows
      : [];
  const count = Array.isArray(payload)
    ? payload.length
    : (payload as { count?: number | undefined })?.count;

  if (!rows.length) {
    return { rows: [], count: count ?? 0 };
  }

  const actorIds = uniqueIds(rows.map((row) => asString(row.actor_id)));

  // Gom id đối tượng theo từng bảng cần tra: trang nhật ký tổng hợp có thể trộn
  // đơn hàng, tài khoản và sản phẩm trong cùng một trang.
  const idsByTable = new Map<string, { lookup: AuditTargetLookup; ids: Set<string> }>();
  for (const row of rows) {
    const targetLookup = lookupFor(row, config);
    const targetId = asString(row.target_id);
    if (!targetLookup || !targetId) continue;
    const bucket = idsByTable.get(targetLookup.table)
      || { lookup: targetLookup, ids: new Set<string>() };
    bucket.ids.add(targetId);
    idsByTable.set(targetLookup.table, bucket);
  }

  const [actors, ...targetResults] = await Promise.all([
    lookup("users", "user_id", "user_id,full_name,email,admin_role,role", actorIds),
    ...[...idsByTable.values()].map(async (bucket) =>
      [bucket.lookup.table, await lookup(
        bucket.lookup.table,
        bucket.lookup.idColumn,
        bucket.lookup.select,
        [...bucket.ids]
      )] as const
    )
  ]);
  const targetsByTable = new Map(targetResults);

  const enriched = rows.map((row) => {
    const actor = actors.get(asString(row.actor_id) || "");
    const oldValue = asJsonObject(row.old_value) || {};
    const newValue = asJsonObject(row.new_value) || {};
    const targetLookup = lookupFor(row, config);
    const targetRow = targetLookup
      ? targetsByTable.get(targetLookup.table)?.get(asString(row.target_id) || "")
      : undefined;

    const actorName = asString(actor?.full_name) || asString(row.actor_name) || "";
    const actorEmail = asString(actor?.email) || "";
    const actorRole =
      asString(row.actor_role) || asString(actor?.admin_role) || asString(actor?.role) || "";
    const fallbackActor = asString(row.actor_id) ? "Không rõ" : "Hệ thống";

    return {
      ...row,
      actor_name: actorName || actorEmail || fallbackActor,
      actor_email: actorEmail || null,
      actor_label:
        actorName && actorEmail
          ? `${actorName} (${actorEmail})`
          : actorName || actorEmail || fallbackActor,
      actor_role_label: auditRoleLabel(actorRole),
      target_label: targetRow && targetLookup
        ? targetLookup.label(targetRow)
        : shortId(asString(row.target_id)),
      action_label: auditActionLabel(asString(row.action), oldValue, newValue, config),
      change_summary: auditChangeSummary(oldValue, newValue, asString(row.action), config),
      result: asString(row.result) || "Thành công"
    };
  });

  return { rows: enriched, count };
}

/** Vai trò dạng mã sang tên tiếng Việt. */
export function auditRoleLabel(role: string | null): string {
  const key = String(role || "");
  return ROLE_LABELS[key] || key || "—";
}

/** Hành động dạng mã sang động từ tiếng Việt, ưu tiên nhãn riêng của phân hệ. */
export function auditActionLabel(
  action: string | null,
  oldValue: JsonObject,
  newValue: JsonObject,
  config: AuditEnrichmentConfig = {}
): string {
  const raw = String(action || "").toLowerCase();
  const custom = config.actionLabel?.(raw, oldValue, newValue);
  if (custom) return custom;
  if (
    oldValue.status !== undefined &&
    newValue.status !== undefined &&
    oldValue.status !== newValue.status
  ) {
    return "Đổi trạng thái";
  }
  return ACTION_LABELS[raw] || action || "—";
}

/**
 * Diễn giải chênh lệch trước/sau thành một câu đọc được.
 *
 * Đây là chỗ thay cho việc đổ thẳng JSON ra màn hình. Ưu tiên đổi trạng thái vì đó là
 * thứ người vận hành tra nhiều nhất, sau đó mới tới các trường trong danh sách trắng.
 */
export function auditChangeSummary(
  oldValue: JsonObject,
  newValue: JsonObject,
  action: string | null,
  config: AuditEnrichmentConfig = {}
): string {
  const hasOld = Object.keys(oldValue).length > 0;
  const hasNew = Object.keys(newValue).length > 0;
  if (!hasOld && !hasNew) return "—";

  const statusLabel = (value: unknown): string => {
    const key = String(value ?? "");
    return config.statusLabels?.[key] || key || "—";
  };

  if (String(action || "").toLowerCase() === "create") {
    return "— → đã tạo";
  }

  if (
    oldValue.status !== undefined &&
    newValue.status !== undefined &&
    oldValue.status !== newValue.status
  ) {
    return `${statusLabel(oldValue.status)} → ${statusLabel(newValue.status)}`;
  }

  const parts: string[] = [];
  for (const key of config.fields || []) {
    if (oldValue[key] !== undefined && newValue[key] !== undefined && oldValue[key] !== newValue[key]) {
      parts.push(`${key}: ${formatAuditScalar(oldValue[key])} → ${formatAuditScalar(newValue[key])}`);
    }
  }
  if (parts.length) return parts.slice(0, 3).join("; ");

  // Nhiều RPC chỉ ghi `{is_active, version}`; nói rõ bật/tắt còn hơn "Đã cập nhật".
  if (oldValue.is_active !== undefined && newValue.is_active !== undefined
      && oldValue.is_active !== newValue.is_active) {
    return newValue.is_active ? "Tắt → Bật" : "Bật → Tắt";
  }

  if (hasOld && hasNew) return "Đã cập nhật";
  if (hasNew) return "— → có dữ liệu mới";
  return "có → —";
}

/** Giá trị đơn lẻ trong nhật ký sang chuỗi hiển thị. */
export function formatAuditScalar(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "có" : "không";
  return String(value);
}

/** Rút gọn UUID khi không tra được nhãn, để bảng không bị một dãy 36 ký tự làm vỡ. */
export function shortId(value: string | null): string {
  const id = String(value || "");
  if (!id) return "—";
  return id.length > 8 ? `#${id.slice(0, 8)}` : id;
}

async function lookup(
  table: string,
  idColumn: string,
  select: string,
  ids: readonly string[]
): Promise<Map<string, JsonObject>> {
  if (!ids.length) return new Map();
  try {
    const result = await selectRows(
      table,
      { select, [idColumn]: `in.(${ids.join(",")})`, limit: ids.length },
      { useAnonKey: false, silentError: true }
    );
    return new Map((result.rows || []).map((row) => [asString(row[idColumn]) || "", row] as const));
  } catch {
    return new Map();
  }
}

function uniqueIds(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}
