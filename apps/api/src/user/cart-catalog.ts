import { quotePostgrestValue, selectRows } from "../supabase.js";
import { catalogUnitPrice, type CatalogPrice } from "./order-pricing.js";
import type { VoucherCartLine } from "./voucher-engine.js";
import type { JsonObject } from "../types.js";

/**
 * Bảng giá và danh mục của các dòng trong giỏ, tra một lần cho cả giỏ.
 *
 * Đặt đơn và ví mã giảm giá cùng đọc từ đây, để số tiền trong ví và số tiền trừ khi
 * đặt đơn không thể lệch nhau. Trước module này, đặt đơn tra hai truy vấn cho mỗi dòng.
 */

export interface CatalogEntry extends CatalogPrice {
  categoryId: string | null;
}

export interface CategoryTree {
  /** Danh mục của chính nó cùng mọi tổ tiên, từ gần tới xa. */
  pathById: ReadonlyMap<string, readonly string[]>;
  nameById: Readonly<Record<string, string>>;
}

/** Một dòng như trình duyệt gửi lên: chỉ cần biến thể và số lượng. */
export interface CartItemInput {
  variantId: string;
  quantity: number;
}

/**
 * Dựng đường danh mục cho mọi danh mục từ các dòng của bảng `category`.
 *
 * Thuần, không I/O. Chặn vòng lặp cha–con: dữ liệu nhập tay có thể trỏ vòng, và đi
 * theo `parent_id` không giới hạn sẽ treo cả yêu cầu.
 */
export function buildCategoryTree(rows: readonly JsonObject[]): CategoryTree {
  const parentById = new Map<string, string | null>();
  const nameById: Record<string, string> = {};
  for (const row of rows) {
    const id = String(row.category_id || "");
    if (!id) continue;
    parentById.set(id, row.parent_id ? String(row.parent_id) : null);
    nameById[id] = String(row.name || "");
  }

  const pathById = new Map<string, string[]>();
  for (const id of parentById.keys()) {
    const path: string[] = [];
    const seen = new Set<string>();
    let cursor: string | null = id;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      path.push(cursor);
      cursor = parentById.get(cursor) ?? null;
    }
    pathById.set(id, path);
  }
  return { pathById, nameById };
}

/**
 * Dòng hàng cho engine chọn mã, tính theo giá catalog.
 *
 * Biến thể không có trong catalog bị bỏ qua ở đây: tầng đặt đơn đã từ chối chúng bằng
 * `UNKNOWN_VARIANT`, còn ví mã chỉ cần không tính sai.
 */
export function buildCartLines(
  items: readonly CartItemInput[],
  catalog: ReadonlyMap<string, CatalogEntry>,
  tree: CategoryTree
): { lines: VoucherCartLine[]; orderValue: number } {
  const lines: VoucherCartLine[] = [];
  for (const item of items) {
    const entry = catalog.get(item.variantId);
    const quantity = Math.round(Number(item.quantity));
    if (!entry || !Number.isFinite(quantity) || quantity <= 0) continue;
    lines.push({
      categoryPath: entry.categoryId ? tree.pathById.get(entry.categoryId) || [entry.categoryId] : [],
      lineTotal: entry.unitPrice * quantity
    });
  }
  return { lines, orderValue: lines.reduce((sum, line) => sum + line.lineTotal, 0) };
}

/**
 * Đọc danh sách dòng hàng trình duyệt gửi lên, bỏ dòng hỏng.
 *
 * Nhận cả dạng mảng đối tượng (`[{ variant_id, quantity }]`) lẫn dạng chuỗi gọn dùng
 * trên query string (`<variant_id>:<số lượng>,...`).
 */
export function parseCartItems(raw: unknown): CartItemInput[] {
  if (typeof raw === "string") {
    return raw.split(",")
      .map((part) => {
        const [variantId, quantity] = part.split(":");
        return { variantId: String(variantId || "").trim(), quantity: Number(quantity || 1) };
      })
      .filter((item) => item.variantId && item.quantity > 0);
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const row = (item || {}) as JsonObject;
      return { variantId: String(row.variant_id || row.variantId || "").trim(), quantity: Number(row.quantity || 0) };
    })
    .filter((item) => item.variantId && Number.isFinite(item.quantity) && item.quantity > 0);
}

/**
 * Tra giá catalog và danh mục của các biến thể, một truy vấn cho cả giỏ.
 */
export async function loadCatalog(variantIds: readonly string[]): Promise<Map<string, CatalogEntry>> {
  const unique = [...new Set(variantIds.filter(Boolean))];
  const catalog = new Map<string, CatalogEntry>();
  if (!unique.length) return catalog;

  const { rows } = await selectRows("variant", {
    select: "variant_id,product:product(name,sale_price,base_price,category_id)",
    variant_id: `in.(${unique.map(quotePostgrestValue).join(",")})`,
    limit: unique.length
  });
  for (const row of rows) {
    const product = row.product as JsonObject | null | undefined;
    if (!product) continue;
    const variantId = String(row.variant_id);
    catalog.set(variantId, {
      variantId,
      unitPrice: catalogUnitPrice(product.sale_price, product.base_price),
      productName: String(product.name || ""),
      categoryId: product.category_id ? String(product.category_id) : null
    });
  }
  return catalog;
}

/** Cây danh mục. Bảng nhỏ, đọc cả bảng một lần. */
export async function loadCategoryTree(): Promise<CategoryTree> {
  const { rows } = await selectRows("category", { select: "category_id,name,parent_id", limit: 1000 });
  return buildCategoryTree(rows);
}

/**
 * Giỏ hàng đã quy về giá catalog, sẵn cho engine chọn mã.
 */
export async function loadVoucherCart(items: readonly CartItemInput[]): Promise<{
  lines: VoucherCartLine[];
  orderValue: number;
  categoryNameById: Readonly<Record<string, string>>;
}> {
  const [catalog, tree] = await Promise.all([
    loadCatalog(items.map((item) => item.variantId)),
    loadCategoryTree()
  ]);
  const { lines, orderValue } = buildCartLines(items, catalog, tree);
  return { lines, orderValue, categoryNameById: tree.nameById };
}
