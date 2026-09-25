import { selectRows } from "./supabase.js";
import { HttpError } from "./http.js";
import { isJsonObject, type JsonObject } from "./types.js";

const DELIVERED_STATUSES = new Set(["delivered"]);
const CLOSED_TICKET_STATUSES = new Set(["resolved", "closed"]);
const PERIOD_LABEL: Record<string, string> = {
  day: "hôm nay",
  week: "7 ngày gần nhất",
  month: "30 ngày gần nhất"
};

export const INSIGHT_SCOPES = [
  "hq",
  "products",
  "orders",
  "reviews",
  "returns",
  "pricing",
  "promotions",
  "accounts",
  "logs"
] as const;

export type InsightScope = (typeof INSIGHT_SCOPES)[number];
export type InsightSeverity = "critical" | "high" | "watch" | "ok";

export interface InsightEvidence {
  label: string;
  value: string;
}

export interface InsightQuestion {
  id: string;
  question: string;
  answer: string;
  severity: InsightSeverity;
  evidence: InsightEvidence[];
}

export interface InsightAction {
  id: string;
  title: string;
  reason: string;
  route: string;
  routeLabel: string;
  severity: InsightSeverity;
  clientSteer: string;
}

export interface InsightBoard {
  scope: InsightScope;
  range: string;
  periodLabel: string;
  headline: string;
  questions: InsightQuestion[];
  actions: InsightAction[];
}

export interface ProductReactionRow {
  product_id: string;
  name: string;
  sku: string;
  reviews: number;
  avgRating: number;
  lowStarCount: number;
}

export interface VoiceInsights {
  range: string;
  periodLabel: string;
  coverage: {
    deliveredOrders: number;
    reviewedOrders: number;
    silentOrders: number;
    coveragePct: number;
  };
  productReaction: {
    reviewCount: number;
    avgRating: number | null;
    loved: ProductReactionRow[];
    complained: ProductReactionRow[];
  };
  serviceQuality: {
    tickets: number;
    closedTickets: number;
    csatCount: number;
    csatAvg: number | null;
    ticketsWithoutCsat: number;
    returns: number;
    returnRatePct: number;
  };
  orderFriction: {
    orderCount: number;
    completedOrders: number;
    cancelledOrders: number;
    failedDelivery: number;
    cancelReasons: Array<{ reason: string; count: number }>;
  };
  /**
   * true khi dữ liệu nguồn của kỳ này vượt trần đọc, tức các con số trên là tính trên
   * một phần. Giao diện phải nói điều đó ra thay vì trình bày như số liệu đầy đủ.
   */
  truncated: boolean;
}

export interface VoiceFacts {
  orders: JsonObject[];
  reviews: JsonObject[];
  returns: JsonObject[];
  tickets: JsonObject[];
  products: Record<string, { name: string; sku: string }>;
  /**
   * true khi ít nhất một trong bốn truy vấn chạm trần của nó.
   *
   * Các con số dẫn xuất khi đó chỉ tính trên phần dữ liệu lấy được. Không có cờ này
   * thì một tháng đông đơn sẽ hiện ra những chỉ số nhỏ hơn thực tế mà không ai biết.
   */
  truncated: boolean;
}

const SCOPE_MODULE: Record<InsightScope, string> = {
  hq: "dashboard",
  products: "products",
  orders: "orders",
  reviews: "reviews",
  returns: "returns",
  pricing: "pricing",
  promotions: "promotions",
  accounts: "accounts",
  logs: "audit_logs"
};

/**
 * Maps an insight board scope onto the RBAC module that may read it.
 */
export function moduleForInsightScope(scope: string): string {
  if (!INSIGHT_SCOPES.includes(scope as InsightScope)) {
    throw new HttpError(400, "INVALID_INSIGHT_SCOPE", "Phạm vi insight không hợp lệ");
  }
  return SCOPE_MODULE[scope as InsightScope];
}

function asNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function pct(part: number, total: number): number {
  if (!total) return 0;
  return round1((part / total) * 100);
}

function periodLabelOf(range: string): string {
  return PERIOD_LABEL[range] || PERIOD_LABEL.week;
}

/**
 * Kết quả một lần đọc, kèm thông tin có bị cắt ở trần hay không.
 */
interface CappedRows {
  rows: JsonObject[];
  /** true khi khoảng thời gian có nhiều dòng hơn trần, tức phép tính bên dưới là thiếu. */
  truncated: boolean;
}

async function safeSelect(table: string, query: Record<string, unknown>): Promise<CappedRows> {
  try {
    const { rows, count } = await selectRows(table, query, { silentError: true });
    const cap = Number(query.limit || 0);
    return { rows, truncated: cap > 0 && typeof count === "number" && count > cap };
  } catch {
    return { rows: [], truncated: false };
  }
}

/**
 * Loads OLTP voice-of-customer rows for one Vietnam business period.
 */
export async function loadVoiceFacts(
  period: { from: Date; to: Date },
  productId: string | null = null
): Promise<VoiceFacts> {
  const from = period.from.toISOString();
  const to = period.to.toISOString();
  const reviewQuery: Record<string, unknown> = {
    select: "review_id,product_id,order_id,rating,status,submitted_at",
    and: `(submitted_at.gte.${from},submitted_at.lt.${to})`,
    limit: 2000
  };
  if (productId) {
    reviewQuery.product_id = `eq.${productId}`;
  }

  const [orders, reviews, returns, tickets] = await Promise.all([
    safeSelect("orders", {
      select: "order_id,user_id,status,order_date,cancelled_reason,total_amount",
      and: `(order_date.gte.${from},order_date.lt.${to})`,
      limit: 2000
    }),
    safeSelect("review", reviewQuery),
    safeSelect("return_exchange", {
      select: "return_id,order_id,status,created_at",
      and: `(created_at.gte.${from},created_at.lt.${to})`,
      limit: 1000
    }),
    safeSelect("support_ticket", {
      select: "ticket_id,status,csat_score,created_at,resolved_at",
      and: `(created_at.gte.${from},created_at.lt.${to})`,
      limit: 1000
    })
  ]);

  const productIds = [...new Set(reviews.rows.map((row) => String(row.product_id || "")).filter(Boolean))];
  const products: VoiceFacts["products"] = {};
  if (productIds.length) {
    const { rows } = await safeSelect("product", {
      select: "product_id,name,sku",
      product_id: `in.(${productIds.join(",")})`,
      limit: 500
    });
    for (const row of rows) {
      const id = String(row.product_id || "");
      if (!id) continue;
      products[id] = {
        name: String(row.name || "Sản phẩm"),
        sku: String(row.sku || "")
      };
    }
  }

  // Bốn truy vấn trên đều có trần. Khoảng thời gian đông hơn trần thì mọi con số dẫn
  // xuất bên dưới đều là tính trên một phần dữ liệu — phải nói ra thay vì trình bày
  // như thể đã tính hết. Chuyển hẳn sang tổng hợp phía cơ sở dữ liệu là việc của KAN-52.
  const truncated =
    orders.truncated || reviews.truncated || returns.truncated || tickets.truncated;

  return {
    orders: orders.rows,
    reviews: reviews.rows,
    returns: returns.rows,
    tickets: tickets.rows,
    products,
    truncated
  };
}

function productBuckets(facts: VoiceFacts): ProductReactionRow[] {
  const grouped = new Map<string, { reviews: number; sum: number; lowStarCount: number }>();
  for (const row of facts.reviews) {
    const productId = String(row.product_id || "");
    if (!productId) continue;
    const rating = asNumber(row.rating);
    const current = grouped.get(productId) || { reviews: 0, sum: 0, lowStarCount: 0 };
    current.reviews += 1;
    current.sum += rating;
    if (rating > 0 && rating <= 2) current.lowStarCount += 1;
    grouped.set(productId, current);
  }
  return [...grouped.entries()]
    .map(([productId, stats]) => ({
      product_id: productId,
      name: facts.products[productId]?.name || "Sản phẩm",
      sku: facts.products[productId]?.sku || "",
      reviews: stats.reviews,
      avgRating: round1(stats.sum / Math.max(stats.reviews, 1)),
      lowStarCount: stats.lowStarCount
    }))
    .sort((a, b) => b.reviews - a.reviews);
}

/**
 * Turns raw VoC rows into coverage, product reaction, CSKH quality, and order friction.
 */
export function deriveVoiceInsights(facts: VoiceFacts, range: string): VoiceInsights {
  const delivered = facts.orders.filter((row) => DELIVERED_STATUSES.has(String(row.status || "")));
  const reviewedOrderIds = new Set(
    facts.reviews.map((row) => String(row.order_id || "")).filter(Boolean)
  );
  const reviewedOrders = delivered.filter((row) => reviewedOrderIds.has(String(row.order_id || ""))).length;
  const silentOrders = Math.max(delivered.length - reviewedOrders, 0);
  const ratings = facts.reviews.map((row) => asNumber(row.rating)).filter((value) => value > 0);
  const buckets = productBuckets(facts);
  const closedTickets = facts.tickets.filter((row) => CLOSED_TICKET_STATUSES.has(String(row.status || "")));
  const csatScores = facts.tickets
    .map((row) => (row.csat_score === null || row.csat_score === undefined ? null : asNumber(row.csat_score)))
    .filter((value): value is number => value !== null && value > 0);
  const ticketsWithoutCsat = closedTickets.filter(
    (row) => row.csat_score === null || row.csat_score === undefined
  ).length;
  const completedOrders = delivered.length;
  const cancelled = facts.orders.filter((row) => String(row.status || "") === "cancelled");
  const failedDelivery = facts.orders.filter((row) => String(row.status || "") === "delivery_failed").length;
  const reasonMap = new Map<string, number>();
  for (const row of cancelled) {
    const reason = String(row.cancelled_reason || "Không ghi lý do").trim() || "Không ghi lý do";
    reasonMap.set(reason, (reasonMap.get(reason) || 0) + 1);
  }

  return {
    range,
    periodLabel: periodLabelOf(range),
    truncated: facts.truncated,
    coverage: {
      deliveredOrders: delivered.length,
      reviewedOrders,
      silentOrders,
      coveragePct: pct(reviewedOrders, delivered.length)
    },
    productReaction: {
      reviewCount: facts.reviews.length,
      avgRating: ratings.length ? round1(ratings.reduce((sum, value) => sum + value, 0) / ratings.length) : null,
      loved: buckets.filter((row) => row.avgRating >= 4 && row.reviews >= 2).slice(0, 5),
      complained: buckets
        .filter((row) => row.avgRating <= 2.5 || row.lowStarCount >= 2)
        .sort((a, b) => b.lowStarCount - a.lowStarCount || a.avgRating - b.avgRating)
        .slice(0, 5)
    },
    serviceQuality: {
      tickets: facts.tickets.length,
      closedTickets: closedTickets.length,
      csatCount: csatScores.length,
      csatAvg: csatScores.length
        ? round1(csatScores.reduce((sum, value) => sum + value, 0) / csatScores.length)
        : null,
      ticketsWithoutCsat,
      returns: facts.returns.length,
      returnRatePct: pct(facts.returns.length, completedOrders)
    },
    orderFriction: {
      orderCount: facts.orders.length,
      completedOrders,
      cancelledOrders: cancelled.length,
      failedDelivery,
      cancelReasons: [...reasonMap.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5)
    }
  };
}

function coverageQuestion(voice: VoiceInsights): InsightQuestion {
  const { coverage, productReaction, periodLabel } = voice;
  if (!coverage.deliveredOrders) {
    return {
      id: "coverage",
      question: "Khách hàng phản ứng thế nào với mặt hàng?",
      answer: `Chưa có đơn giao ${periodLabel}, nên chưa đo được phản ứng thật. Không dùng số liệu tồn kho hay lượt xem thay cho tiếng nói khách hàng.`,
      severity: "watch",
      evidence: [
        { label: "Đơn đã giao", value: "0" },
        { label: "Đánh giá", value: String(productReaction.reviewCount) }
      ]
    };
  }
  if (!coverage.reviewedOrders) {
    return {
      id: "coverage",
      question: "Khách hàng phản ứng thế nào với mặt hàng?",
      answer: `${coverage.silentOrders} đơn đã giao ${periodLabel} mà phía client không đánh giá. Không có phản hồi thì không hoạch định được mặt hàng nào giữ, ẩn, hay giao CSKH chủ động.`,
      severity: "critical",
      evidence: [
        { label: "Đơn đã giao", value: String(coverage.deliveredOrders) },
        { label: "Đơn im lặng", value: String(coverage.silentOrders) },
        { label: "Tỷ lệ có đánh giá", value: "0%" }
      ]
    };
  }
  const ratingText =
    productReaction.avgRating === null
      ? "chưa có điểm sao"
      : `điểm sao trung bình ${productReaction.avgRating}/5`;
  const complained = productReaction.complained[0];
  const loved = productReaction.loved[0];
  let answer = `${coverage.coveragePct}% đơn giao ${periodLabel} có đánh giá (${ratingText}).`;
  if (complained) {
    answer += ` KH phản ứng kém với ${complained.name} (${complained.avgRating}/5).`;
  } else if (loved) {
    answer += ` KH đang ủng hộ ${loved.name} (${loved.avgRating}/5) — ưu tiên giữ trải nghiệm này.`;
  }
  if (coverage.coveragePct < 40) {
    answer += ` Phần còn lại im lặng nên chiến lược mặt hàng vẫn thiếu bằng chứng.`;
  }
  return {
    id: "coverage",
    question: "Khách hàng phản ứng thế nào với mặt hàng?",
    answer,
    severity: coverage.coveragePct < 40 || productReaction.complained.length ? "high" : coverage.coveragePct < 70 ? "watch" : "ok",
    evidence: [
      { label: "Đơn đã giao", value: String(coverage.deliveredOrders) },
      { label: "Có đánh giá", value: String(coverage.reviewedOrders) },
      { label: "Im lặng", value: String(coverage.silentOrders) },
      { label: "Điểm sao", value: productReaction.avgRating === null ? "—" : `${productReaction.avgRating}/5` }
    ]
  };
}

function serviceQuestion(voice: VoiceInsights): InsightQuestion {
  const { serviceQuality, periodLabel } = voice;
  if (!serviceQuality.tickets && !serviceQuality.returns) {
    return {
      id: "cskh",
      question: "Khách hàng đánh giá dịch vụ CSKH thế nào?",
      answer: `Chưa có phiếu hỗ trợ hay đổi trả ${periodLabel}. Không suy ra CSKH đang tốt — chỉ là chưa có tương tác để đo.`,
      severity: "watch",
      evidence: [
        { label: "Phiếu hỗ trợ", value: "0" },
        { label: "Đổi trả", value: "0" }
      ]
    };
  }
  if (serviceQuality.closedTickets > 0 && serviceQuality.csatCount === 0) {
    return {
      id: "cskh",
      question: "Khách hàng đánh giá dịch vụ CSKH thế nào?",
      answer: `${serviceQuality.ticketsWithoutCsat} phiếu đã đóng ${periodLabel} mà client không chấm CSAT. Phía client không đánh giá thì không được xem CSKH là đạt — bắt buộc hỏi điểm sau khi xử lý.`,
      severity: "critical",
      evidence: [
        { label: "Phiếu đã đóng", value: String(serviceQuality.closedTickets) },
        { label: "Có CSAT", value: "0" },
        { label: "Đổi trả / đơn giao", value: `${serviceQuality.returnRatePct}%` }
      ]
    };
  }
  const csatText =
    serviceQuality.csatAvg === null ? "chưa có CSAT" : `CSAT ${serviceQuality.csatAvg}/5 từ ${serviceQuality.csatCount} phiếu`;
  let answer = `${csatText}. Tỷ lệ đổi trả trên đơn đã giao là ${serviceQuality.returnRatePct}%.`;
  if (serviceQuality.csatAvg !== null && serviceQuality.csatAvg < 4) {
    answer += " KH chưa hài lòng với cách xử lý — ưu tiên SLA và chất lượng phản hồi, không tăng voucher cho xong.";
  } else if (serviceQuality.returnRatePct >= 15) {
    answer += " Đổi trả đang thay cho lời phàn nàn — kiểm tra mô tả hàng và size trước khi đổ lỗi CSKH.";
  } else if (serviceQuality.csatAvg !== null && serviceQuality.csatAvg >= 4.2) {
    answer += " Giữ quy trình hiện tại và nhân rộng kịch bản phản hồi tốt sang client.";
  }
  const severity: InsightSeverity =
    serviceQuality.csatAvg !== null && serviceQuality.csatAvg < 3.5
      ? "high"
      : serviceQuality.returnRatePct >= 15 || (serviceQuality.csatAvg !== null && serviceQuality.csatAvg < 4)
        ? "watch"
        : "ok";
  return {
    id: "cskh",
    question: "Khách hàng đánh giá dịch vụ CSKH thế nào?",
    answer,
    severity,
    evidence: [
      { label: "CSAT", value: serviceQuality.csatAvg === null ? "Chưa đo" : `${serviceQuality.csatAvg}/5` },
      { label: "Phiếu thiếu CSAT", value: String(serviceQuality.ticketsWithoutCsat) },
      { label: "Đổi trả", value: String(serviceQuality.returns) },
      { label: "Tỷ lệ đổi trả", value: `${serviceQuality.returnRatePct}%` }
    ]
  };
}

function revenueQuestion(voice: VoiceInsights, business: JsonObject | null): InsightQuestion {
  const revenue = asNumber(business?.revenue);
  const orderCount = asNumber(business?.orderCount ?? voice.orderFriction.orderCount);
  const comparisons = isJsonObject(business?.comparisons) ? business.comparisons : {};
  const revenuePct = comparisons.revenuePct;
  const orderPct = comparisons.orderCountPct;
  const periodLabel = voice.periodLabel;
  const trend =
    typeof revenuePct === "number"
      ? `${revenuePct > 0 ? "tăng" : revenuePct < 0 ? "giảm" : "đi ngang"} ${Math.abs(revenuePct)}% so với kỳ trước`
      : "chưa so được kỳ trước";
  const orderTrend =
    typeof orderPct === "number"
      ? `số đơn ${orderPct > 0 ? "tăng" : orderPct < 0 ? "giảm" : "đi ngang"} ${Math.abs(orderPct)}%`
      : "chưa so được số đơn kỳ trước";
  let answer = `Trong ${periodLabel}, doanh thu ${revenue.toLocaleString("vi-VN")} ₫ từ ${orderCount} đơn — ${trend}, ${orderTrend}.`;
  if (typeof revenuePct === "number" && revenuePct < 0 && typeof orderPct === "number" && orderPct >= 0) {
    answer += " Đơn không giảm nhưng giá trị giảm: xem KM đang kéo AOV xuống chứ đừng tăng thêm giảm giá.";
  } else if (typeof orderPct === "number" && orderPct < 0) {
    answer += " Ít đơn hơn kỳ trước: kiểm tra ma sát thanh toán/giao hàng trước khi đổ cho nhu cầu.";
  } else if (!orderCount) {
    answer = `Chưa phát sinh đơn ${periodLabel}. DT/DS bằng 0 không phải “ổn định” — cần xem client có chặn mua hay hàng có đang bán.`;
  }
  return {
    id: "revenue",
    question: "Doanh thu và số đơn kỳ này nói gì?",
    answer,
    severity: !orderCount ? "watch" : typeof revenuePct === "number" && revenuePct < -10 ? "high" : "ok",
    evidence: [
      { label: "Doanh thu", value: `${revenue.toLocaleString("vi-VN")} ₫` },
      { label: "Số đơn", value: String(orderCount) },
      { label: "AOV", value: `${asNumber(business?.averageOrderValue).toLocaleString("vi-VN")} ₫` }
    ]
  };
}

function orderFrictionQuestion(voice: VoiceInsights): InsightQuestion {
  const friction = voice.orderFriction;
  const cancelPct = pct(friction.cancelledOrders, friction.orderCount);
  const topReason = friction.cancelReasons[0];
  let answer = `${friction.completedOrders}/${friction.orderCount} đơn đi đến giao-hoàn tất ${voice.periodLabel}.`;
  if (friction.cancelledOrders) {
    answer += ` ${friction.cancelledOrders} đơn hủy${topReason ? ` — lý do phổ biến: ${topReason.reason}` : ""}.`;
  }
  if (friction.failedDelivery) {
    answer += ` ${friction.failedDelivery} giao thất bại là ma sát giao nhận, không phải nhu cầu kém.`;
  }
  if (!friction.orderCount) {
    answer = `Chưa có đơn ${voice.periodLabel} để đọc ma sát mua hàng.`;
  }
  return {
    id: "friction",
    question: "Trải nghiệm mua hàng đang ma sát ở đâu?",
    answer,
    severity: cancelPct >= 20 || friction.failedDelivery >= 3 ? "high" : cancelPct >= 10 ? "watch" : "ok",
    evidence: [
      { label: "Đơn trong kỳ", value: String(friction.orderCount) },
      { label: "Giao/hoàn tất", value: String(friction.completedOrders) },
      { label: "Hủy", value: String(friction.cancelledOrders) },
      { label: "Giao thất bại", value: String(friction.failedDelivery) }
    ]
  };
}

function planningActions(scope: InsightScope, voice: VoiceInsights): InsightAction[] {
  const actions: InsightAction[] = [];
  if (voice.coverage.silentOrders > 0) {
    actions.push({
      id: "nudge-review",
      title: "Điều hướng client: bắt buộc xin đánh giá sau khi giao",
      reason: `${voice.coverage.silentOrders} đơn đã giao không có đánh giá. Không có VoC thì không quyết định được giữ hay cắt SKU.`,
      route: "/reviews",
      routeLabel: "Mở đánh giá",
      severity: voice.coverage.reviewedOrders === 0 ? "critical" : "high",
      clientSteer: "Storefront đơn đã giao phải hiện form đánh giá trước khi xem là hoàn tất trải nghiệm."
    });
  }
  if (voice.productReaction.complained.length) {
    const top = voice.productReaction.complained[0];
    actions.push({
      id: "fix-product",
      title: `Xử lý phản ứng kém: ${top.name}`,
      reason: `${top.lowStarCount} đánh giá 1–2 sao, trung bình ${top.avgRating}/5. Ánh xạ sang ẩn hàng, sửa mô tả, hoặc mở phiếu CSKH — không để số sao nằm im.`,
      route: "/products",
      routeLabel: "Mở sản phẩm",
      severity: "high",
      clientSteer: "Client PDP phải hiện cảnh báo chất lượng và chặn đẩy item này vào gợi ý AI cho đến khi rating phục hồi."
    });
  }
  if (voice.serviceQuality.ticketsWithoutCsat > 0 || (voice.serviceQuality.closedTickets > 0 && voice.serviceQuality.csatCount === 0)) {
    actions.push({
      id: "force-csat",
      title: "Bắt buộc CSAT sau mỗi phiếu CSKH đóng",
      reason: "Phiếu đóng mà không có điểm hài lòng thì quản lý không biết dịch vụ đang tốt hay kém.",
      route: "/returns",
      routeLabel: "Mở CSKH",
      severity: "critical",
      clientSteer: "Client không cho đóng trải nghiệm hỗ trợ khi chưa chấm 1–5. Thiếu CSAT = chưa xong."
    });
  }
  if (voice.serviceQuality.returnRatePct >= 15) {
    actions.push({
      id: "return-root",
      title: "Đổi trả đang thay lời phàn nàn — tìm nguyên nhân hàng",
      reason: `Tỷ lệ đổi trả ${voice.serviceQuality.returnRatePct}% trên đơn đã giao. Đây là tín hiệu sản phẩm/mô tả, không phải KPI kho.`,
      route: "/returns",
      routeLabel: "Mở đổi trả",
      severity: "high",
      clientSteer: "Sau đổi trả thành công, client hỏi đúng một câu: hàng lệch mô tả, size, hay dịch vụ."
    });
  }
  if (voice.orderFriction.cancelledOrders > 0 && (scope === "hq" || scope === "orders")) {
    actions.push({
      id: "cancel-friction",
      title: "Đọc lý do hủy để sửa luồng mua",
      reason: `${voice.orderFriction.cancelledOrders} đơn hủy ${voice.periodLabel}. Hủy là phản ứng, không phải thống kê rác.`,
      route: "/orders",
      routeLabel: "Mở đơn hàng",
      severity: "watch",
      clientSteer: "Checkout phải ghi lý do hủy bắt buộc và hiện lại cho CSKH, không để trống."
    });
  }
  if (!actions.length) {
    actions.push({
      id: "hold-course",
      title: "Giữ nhịp hiện tại và theo dõi kỳ sau",
      reason: "VoC và CSKH trong kỳ không có tín hiệu đỏ. Kỳ sau vẫn phải giữ tỷ lệ đánh giá — im lặng là thụt lùi.",
      route: scope === "returns" ? "/returns" : "/reviews",
      routeLabel: "Theo dõi",
      severity: "ok",
      clientSteer: "Client tiếp tục xin đánh giá sau giao; không tắt CSAT."
    });
  }
  return actions.slice(0, 4);
}

function headlineFor(scope: InsightScope, voice: VoiceInsights, questions: InsightQuestion[]): string {
  const worst = questions.reduce<InsightSeverity>((acc, item) => {
    const rank = { critical: 3, high: 2, watch: 1, ok: 0 };
    return rank[item.severity] > rank[acc] ? item.severity : acc;
  }, "ok");
  if (scope === "hq") {
    if (worst === "critical") return `Hoạch định bị chặn: client chưa cho đủ tín hiệu ${voice.periodLabel}`;
    if (worst === "high") return `Cần điều hướng phân hệ trước khi tăng doanh số ${voice.periodLabel}`;
    return `Tín hiệu kinh doanh ${voice.periodLabel} đủ để giữ hướng`;
  }
  if (worst === "critical") return "Thiếu phản hồi khách hàng — chưa được phép kết luận";
  if (worst === "high") return "Có phản ứng xấu cần ánh xạ thành việc làm";
  if (worst === "watch") return "Có tín hiệu, chưa đủ để coi là ổn";
  return "Phản hồi khách hàng đang ủng hộ hướng hiện tại";
}

/**
 * Builds the question-driven board for HQ or one operator module.
 */
export function buildInsightBoard(
  scope: InsightScope,
  voice: VoiceInsights,
  business: JsonObject | null = null
): InsightBoard {
  const questions: InsightQuestion[] = [];
  if (scope === "hq" || scope === "orders" || scope === "promotions" || scope === "pricing") {
    questions.push(revenueQuestion(voice, business));
  }
  if (scope === "hq" || scope === "products" || scope === "reviews" || scope === "pricing") {
    questions.push(coverageQuestion(voice));
  }
  if (scope === "hq" || scope === "returns" || scope === "reviews") {
    questions.push(serviceQuestion(voice));
  }
  if (scope === "hq" || scope === "orders") {
    questions.push(orderFrictionQuestion(voice));
  }
  if (scope === "promotions") {
    const share = asNumber(business?.promotionRevenueShare);
    questions.push({
      id: "promo-fit",
      question: "Khuyến mãi có đang mua doanh số bằng sự hài lòng?",
      answer:
        share >= 40 && voice.serviceQuality.returnRatePct >= 10
          ? `${share}% doanh thu đi qua KM trong khi đổi trả ${voice.serviceQuality.returnRatePct}%. KM đang kéo đơn kém khớp — thu hẹp voucher, đừng tăng ngân sách.`
          : share >= 40
            ? `${share}% doanh thu phụ thuộc KM. Nếu rating mặt hàng KM không giữ ≥4 sao, đây là doanh số thuê chứ không phải nhu cầu.`
            : `KM chiếm ${share}% doanh thu ${voice.periodLabel}. Đối chiếu với rating và đổi trả trước khi gia hạn chiến dịch.`,
      severity: share >= 40 && voice.serviceQuality.returnRatePct >= 10 ? "high" : "watch",
      evidence: [
        { label: "Tỷ trọng KM", value: `${share}%` },
        { label: "Đổi trả", value: `${voice.serviceQuality.returnRatePct}%` }
      ]
    });
  }
  if (scope === "accounts") {
    questions.push({
      id: "account-voc",
      question: "Tài khoản client có đang cho phép phản hồi không?",
      answer:
        voice.coverage.silentOrders > 0
          ? `${voice.coverage.silentOrders} đơn giao không có đánh giá. Member bị khóa hoặc luồng sau giao thiếu form thì HQ mất tín hiệu hoạch định.`
          : `Tỷ lệ đánh giá ${voice.coverage.coveragePct}% ${voice.periodLabel}. Chỉ khóa tài khoản khi lạm dụng — khóa nhầm là cắt VoC.`,
      severity: voice.coverage.reviewedOrders === 0 && voice.coverage.deliveredOrders > 0 ? "critical" : "watch",
      evidence: [
        { label: "Đơn im lặng", value: String(voice.coverage.silentOrders) },
        { label: "Tỷ lệ có đánh giá", value: `${voice.coverage.coveragePct}%` }
      ]
    });
    questions.push(coverageQuestion(voice));
  }
  if (scope === "logs") {
    questions.push({
      id: "log-steer",
      question: "Hệ thống có đang chặn khách phản hồi không?",
      answer:
        "Nhật ký không phải bảng đếm sự kiện. Ưu tiên lỗi/chặn trên đánh giá, CSAT, đặt hàng — đó là chỗ client bị cắt tiếng nói.",
      severity: "watch",
      evidence: [
        { label: "Đơn im lặng", value: String(voice.coverage.silentOrders) },
        { label: "Phiếu thiếu CSAT", value: String(voice.serviceQuality.ticketsWithoutCsat) }
      ]
    });
  }
  if (!questions.length) {
    questions.push(coverageQuestion(voice));
  }
  return {
    scope,
    range: voice.range,
    periodLabel: voice.periodLabel,
    headline: headlineFor(scope, voice, questions),
    questions,
    actions: planningActions(scope, voice)
  };
}

/**
 * Loads VoC facts and derives the insight model for one period.
 */
export async function loadVoiceInsights(
  period: { range: string; from: Date; to: Date },
  productId: string | null = null
): Promise<VoiceInsights> {
  const facts = await loadVoiceFacts(period, productId);
  return deriveVoiceInsights(facts, period.range);
}

/**
 * Parses and validates an insight board scope from the query string.
 */
export function parseInsightScope(raw: string | null): InsightScope {
  const scope = raw || "hq";
  if (!INSIGHT_SCOPES.includes(scope as InsightScope)) {
    throw new HttpError(400, "INVALID_INSIGHT_SCOPE", "Phạm vi insight không hợp lệ");
  }
  return scope as InsightScope;
}
