import { isJsonObject, type JsonObject } from '../types.js';
import { validateManagementFacts } from './management-source-service.js';

/** A management card separates observed metrics from a conditional business consequence. */
export interface ManagementInsight {
  id: string;
  title: string;
  availability: 'ready' | 'insufficient_data';
  severity: 'critical' | 'high' | 'watch' | 'ok';
  dataNote?: string;
  phenomenon?: string;
  scope?: string;
  magnitude?: string;
  consequence?: string;
  action?: { label: string; route: string; module: string; query?: Record<string, string> };
  ruleVersion?: string;
  source?: string;
  updated_at?: string;
  kpis?: Record<string, number | null>;
}

const TITLES = [
  'Hiệu quả bán hàng và doanh thu', 'Điểm nghẽn đơn hàng và SLA',
  'Sản phẩm bán chạy và than phiền', 'Đơn đã giao chưa có đánh giá',
  'Điểm hài lòng dịch vụ', 'Hiệu quả khuyến mãi', 'Tác động đổi trả',
  'Khuyến mãi và mức độ hài lòng', 'Giữ chân khách hàng',
];

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function money(value: number): string { return `${value.toLocaleString('vi-VN')}đ`; }

/**
 * Produce all nine A3 groups from measured data; absent joins, costs and cohorts remain unavailable.
 * A revenue share is not ROI, and an association is never asserted to cause dissatisfaction.
 */
export function buildManagementInsights(summary: JsonObject, olap: boolean, lastSyncedAt?: string, facts?: JsonObject | null) {
  const business = isJsonObject(summary.business) ? summary.business : {};
  const comparisons = isJsonObject(business.comparisons) ? business.comparisons : {};
  const groups: ManagementInsight[] = TITLES.map((title, index) => ({
    id: `AD_DB_${String(index + 1).padStart(2, '0')}`, title,
    availability: 'insufficient_data', severity: 'watch',
    dataNote: 'Chưa có đủ dữ liệu đã đối chiếu để kết luận.',
  }));
  const revenue = finite(business.revenue);
  const orders = finite(business.orderCount);
  const aov = finite(business.averageOrderValue);
  if (olap && revenue !== null && orders !== null && aov !== null) {
    const growth = finite(comparisons.revenuePct);
    groups[0] = {
      ...groups[0], availability: 'ready',
      severity: growth !== null && growth < 0 ? 'watch' : 'ok',
      dataNote: 'Nguồn kho phân tích; doanh thu là giá trị đơn hợp lệ, chưa phải lợi nhuận.',
      phenomenon: `Giá trị đơn hợp lệ đạt ${money(revenue)}.`,
      scope: `${orders} đơn trong kỳ; giá trị đơn trung bình ${money(aov)}.`,
      magnitude: growth === null ? 'Chưa có dữ liệu kỳ trước để so sánh.' : `Thay đổi ${growth}% so với kỳ trước.`,
      consequence: growth !== null && growth < 0 ? 'Cần đối chiếu danh mục và giá trước khi điều chỉnh chương trình bán hàng.' : 'Theo dõi danh mục đóng góp và khả năng đáp ứng tồn kho khi lập kế hoạch.',
      kpis: { revenue, orders, aov, revenueGrowthPct: growth },
      action: { label: 'Phân tích danh mục', route: '/products', module: 'products' },
    };
  }
  groups[1].dataNote = 'Số đơn chờ chưa chứng minh vi phạm SLA; cần thời gian tại trạng thái và cam kết xử lý.';
  groups[2].dataNote = 'Chưa có tỷ lệ trả hàng đối chiếu theo SKU và nhóm khách; không suy diễn từ thứ hạng bán chạy.';
  groups[7].dataNote = 'Chưa có dữ liệu kết hợp mức giảm giá, đánh giá và CSAT; không suy diễn tương quan hoặc quan hệ nhân quả.';
  groups[8].dataNote = 'Chưa có cohort mua lại và doanh thu theo khách để tính retention hoặc LTV.';
  const validation = olap ? validateManagementFacts(facts) : null;
  const evidence = validation?.availability === 'ready' ? validation.facts : null;
  if (evidence) applyJoinedFacts(groups, evidence);
  for (const group of groups) {
    group.ruleVersion = 'management.v3';
    group.source = group.availability === 'ready' ? 'analytics.star.v3' : 'unavailable';
    if (olap && lastSyncedAt) group.updated_at = lastSyncedAt;
  }
  return { groups, ruleVersion: 'management.v3', ...(olap && lastSyncedAt ? { lastSyncedAt } : {}), ...(evidence ? { evidence } : {}) };
}

function object(value: unknown): JsonObject { return isJsonObject(value) ? value : {}; }
function rows(value: unknown): JsonObject[] { return Array.isArray(value) ? value.filter(isJsonObject) : []; }
function count(value: unknown): number {
  const number = finite(value);
  if (number === null) throw new Error('Validated analytics count is missing');
  return number;
}
function percent(numerator: number, denominator: number): string { return `${Math.round(10000 * numerator / denominator) / 100}%`; }

/** Prefer complete joined facts over paginated VoC; express associations without inventing causes. */
function applyJoinedFacts(groups: ManagementInsight[], facts: JsonObject): void {
  const set = (index: number, card: Omit<ManagementInsight, 'id' | 'title'>) => { groups[index] = { ...groups[index], ...card }; };
  const sla = object(facts.sla), known = count(sla.known_state_orders), active = count(sla.active_orders);
  if (active > 0 && known > 0) set(1, {
    availability: 'ready', severity: count(sla.attention_orders_24h) > 0 ? 'watch' : 'ok',
    dataNote: '24 giờ là mốc chú ý vận hành, chưa phải cam kết SLA. Bao gồm hàng đợi cũ ngoài kỳ; thời gian thiếu lịch sử không được suy đoán.',
    phenomenon: `${count(sla.attention_orders_24h)} đơn ở trạng thái xử lý trên 24 giờ.`,
    scope: `${active} đơn đang mở; ${known} đơn có thời điểm vào trạng thái được xác minh.`,
    magnitude: `${sla.attention_rate_pct}% trên số đơn có đủ dấu thời gian; trung bình ${sla.average_hours_in_state} giờ.`,
    consequence: 'Đối chiếu hàng đợi và lịch sử từng đơn trước khi phân công xử lý.',
    kpis: { activeOrders: active, knownStateOrders: known, attentionOrders: finite(sla.attention_orders_24h), attentionRatePct: finite(sla.attention_rate_pct), contractualSla: null },
    action: { label: 'Kiểm tra hàng đợi', route: '/orders', module: 'orders' },
  });
  const sku = rows(facts.skuReturns), deliveredUnits = sku.reduce((sum, row) => sum + count(row.delivered_units), 0);
  const requestedUnits = sku.reduce((sum, row) => sum + count(row.requested_units), 0);
  const receivedUnits = sku.reduce((sum, row) => sum + count(row.received_units), 0);
  const focus = [...sku].sort((a, b) => count(b.delivered_units) - count(a.delivered_units))[0];
  if (focus && deliveredUnits > 0) set(2, {
    availability: 'ready', severity: count(focus.requested_units) > 0 || count(focus.low_rating_count) > 0 ? 'watch' : 'ok',
    dataNote: 'Cùng cohort đơn đã giao; yêu cầu trả chưa phải hàng nhận lại. Số đánh giá thấp là quan sát, không chứng minh lỗi sản phẩm.',
    phenomenon: `${focus.product_name} đã giao ${focus.delivered_units} sản phẩm.`,
    scope: `SKU ${focus.sku || 'chưa ghi mã'}; ${count(focus.rating_count)} đánh giá gắn với đơn.`,
    magnitude: `${count(focus.requested_units)} sản phẩm yêu cầu trả (${focus.requested_rate_pct}%); ${count(focus.low_rating_count)} đánh giá 1–2 sao.`,
    consequence: 'Mở sản phẩm và đối chiếu nội dung phản hồi trước khi điều chỉnh chất lượng hoặc tư vấn size.',
    kpis: { deliveredUnits: finite(focus.delivered_units), requestedUnits: finite(focus.requested_units), requestedRatePct: finite(focus.requested_rate_pct), lowRatings: finite(focus.low_rating_count) },
    action: { label: 'Xem sản phẩm', route: '/products', module: 'products', query: { q: String(focus.sku || '') } },
  });
  const coverage = object(facts.reviewCoverage), delivered = count(coverage.delivered_orders), reviewed = count(coverage.reviewed_orders);
  if (delivered > 0) set(3, {
    availability: 'ready', severity: 'watch', dataNote: 'Đếm trên cohort đơn đã giao đầy đủ trong kho; không bị giới hạn trang đánh giá.',
    phenomenon: `${delivered - reviewed} đơn đã giao chưa có đánh giá.`, scope: `${delivered} đơn đã giao; ${reviewed} đơn có đánh giá.`,
    magnitude: `${percent(delivered - reviewed, delivered)} đơn thiếu phản hồi.`,
    consequence: 'Kiểm tra khả năng truy cập và thời điểm mời đánh giá để thu thập thêm phản hồi.',
    kpis: { deliveredOrders: delivered, reviewedOrders: reviewed, unreviewedRatePct: (delivered-reviewed)/delivered*100 },
    action: { label: 'Kiểm tra đánh giá', route: '/reviews', module: 'reviews' },
  });
  const csat = object(facts.csat), sample = count(csat.sample_count), score = finite(csat.average_score);
  if (sample >= 20 && score !== null) set(4, {
    availability: 'ready', severity: score < 3 ? 'high' : 'ok',
    dataNote: 'Toàn bộ phiếu tạo trong kỳ; chưa có liên kết đơn/danh mục để suy ra nguyên nhân hoặc xu hướng hai tuần.',
    phenomenon: `CSAT trung bình ${score}/5.`, scope: `${sample} phản hồi trên ${count(csat.tickets)} phiếu hỗ trợ.`,
    magnitude: `${count(csat.closed_without_score)} phiếu đã đóng chưa có điểm hài lòng.`,
    consequence: 'Đọc phản hồi và lịch sử hỗ trợ trước khi thay đổi quy trình.',
    kpis: { sampleCount: sample, csatAverage: score, closedWithoutScore: finite(csat.closed_without_score) },
    action: { label: 'Kiểm tra CSKH', route: '/returns', module: 'returns' },
  });
  else {
    groups[4].dataNote = `Cần ít nhất 20 phản hồi CSAT; kho ghi nhận ${sample}. Không ngoại suy điểm của mẫu nhỏ.`;
    groups[4].kpis = { sampleCount: sample, csatAverage: score, closedWithoutScore: finite(csat.closed_without_score) };
  }
  const promotion = object(facts.promotion);
  const redemptionCount = finite(promotion.redemptions), discount = finite(promotion.discountAmount), associated = finite(promotion.associatedOrderValue);
  if (redemptionCount !== null) set(5, {
    availability: 'ready', severity: 'ok',
    dataNote: 'Giá trị đơn liên quan không chứng minh doanh thu tăng thêm. ROI chưa có định nghĩa chi phí và đối chứng.',
    phenomenon: `${redemptionCount} lượt dùng voucher trong kỳ.`,
    scope: `${rows(promotion.programs).length} chương trình; ${rows(promotion.appliedProductPromotions).length} ưu đãi sản phẩm.`,
    magnitude: `Giảm giá ghi nhận ${discount === null ? 'chưa có quan sát' : money(discount)}; giá trị đơn liên quan ${associated === null ? 'chưa có quan sát' : money(associated)}.`,
    consequence: 'Đối chiếu mức giảm và đơn dùng voucher; không mở rộng ngân sách chỉ từ doanh thu liên quan.',
    kpis: { redemptions: redemptionCount, discountAmount: discount, associatedOrderValue: associated, roi: null },
    action: { label: 'Xem chương trình và voucher', route: '/promotions', module: 'promotions' },
  });
  const categories = rows(facts.categoryReturns);
  const category = [...categories].sort((a,b) => count(b.requested_units)-count(a.requested_units))[0];
  if (deliveredUnits > 0) set(6, {
    availability: 'ready', severity: requestedUnits > 0 ? 'watch' : 'ok',
    dataNote: 'Yêu cầu và nhận lại tính trên dòng hàng của cùng cohort đơn đã giao; chưa có giá vốn để tính tác động lợi nhuận.',
    phenomenon: `${requestedUnits} sản phẩm yêu cầu trả; ${receivedUnits} sản phẩm đã nhận và qua QA.`,
    scope: category ? `Danh mục ${category.category_name || 'chưa ghi nhận'}: ${category.requested_units}/${category.delivered_units} sản phẩm yêu cầu trả; toàn cohort ${deliveredUnits} sản phẩm đã giao.` : `${deliveredUnits} sản phẩm đã giao trong ${delivered} đơn gốc.`,
    magnitude: `Tỷ lệ yêu cầu ${percent(requestedUnits, deliveredUnits)}; tỷ lệ thực nhận ${percent(receivedUnits, deliveredUnits)}.`,
    consequence: 'Đối chiếu lý do và kết quả kiểm kho trước khi hoàn tiền hoặc chuẩn bị đơn đổi.',
    kpis: { deliveredUnits, requestedUnits, receivedUnits, requestedRatePct: requestedUnits/deliveredUnits*100, receivedRatePct: receivedUnits/deliveredUnits*100 },
    action: { label: 'Xem phiếu đổi trả', route: '/returns', module: 'returns' },
  });
  const ratings = rows(facts.discountSatisfaction).filter(row => count(row.review_count) > 0 && finite(row.average_rating) !== null);
  if (ratings.length) {
    const row = [...ratings].sort((a, b) => count(b.review_count) - count(a.review_count))[0];
    const label = row.bracket === 'none' ? 'không giảm giá' : row.bracket === 'over_30_percent' ? 'giảm trên 30%' : 'giảm tối đa 30%';
    set(7, {
      availability: 'ready', severity: 'watch', dataNote: 'Chỉ là mô tả đánh giá theo mức giảm. Phiếu hỗ trợ không có liên kết đơn nên không suy ra CSAT theo khuyến mãi hoặc quan hệ nhân quả.',
      phenomenon: `Nhóm ${label} ghi nhận ${row.average_rating}/5 sao.`,
      scope: `${count(row.review_count)} đánh giá trên ${count(row.reviewed_orders)} đơn có phản hồi; ${count(row.orders)} đơn trong nhóm.`,
      magnitude: `${count(row.low_rating_count)} đánh giá 1–2 sao; ${ratings.length} nhóm có dữ liệu.`,
      consequence: 'Đọc nội dung đánh giá và so cỡ mẫu trước khi thay đổi ưu đãi; không dùng tương quan làm nguyên nhân.',
      kpis: { reviewCount: finite(row.review_count), averageRating: finite(row.average_rating), lowRatings: finite(row.low_rating_count), linkedCsat: null },
      action: { label: 'Đối chiếu ưu đãi', route: '/promotions', module: 'promotions' },
    });
  }
  const retention = object(facts.retention), customers = count(retention.known_customers), repeatRate = finite(retention.repeat_purchase_rate_pct);
  if (customers > 0 && repeatRate !== null) set(8, {
    availability: 'ready', severity: 'ok',
    dataNote: 'Khách đăng ký, loại khách vãng lai và đơn đổi thay thế. Mua lại dựa lịch sử đơn đã giao trước cuối kỳ; giá trị quan sát chưa phải LTV dự báo hoặc lợi nhuận.',
    phenomenon: `${count(retention.repeat_customers)} khách trong kỳ đã mua ít nhất hai đơn.`,
    scope: `${customers} khách đăng ký có đơn đã giao trong kỳ; hạng khách là hạng hiện tại.`,
    magnitude: `Tỷ lệ khách mua lại ${repeatRate}%; giá trị đơn trọn lịch sử trung bình ${finite(retention.observed_lifetime_order_value_avg) === null ? 'chưa có quan sát' : money(retention.observed_lifetime_order_value_avg as number)}.`,
    consequence: 'Đối chiếu lịch sử mua và phản hồi khi lập kế hoạch chăm sóc khách hàng quay lại.',
    kpis: { customers, repeatCustomers: finite(retention.repeat_customers), repeatRatePct: repeatRate, observedLifetimeValue: finite(retention.observed_lifetime_order_value_avg), predictedLtv: null },
    action: { label: 'Xem khách hàng', route: '/accounts', module: 'accounts' },
  });
}
