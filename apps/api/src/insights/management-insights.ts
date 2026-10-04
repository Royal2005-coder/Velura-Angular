import { isJsonObject, type JsonObject } from '../types.js';
import type { VoiceInsights } from '../insights.js';

/** A management card separates observed metrics from a conditional business consequence. */
export interface ManagementInsight {
  id: string;
  title: string;
  availability: 'ready' | 'insufficient_data' | 'oltp_fallback';
  severity: 'critical' | 'high' | 'watch' | 'ok';
  dataNote?: string;
  phenomenon?: string;
  scope?: string;
  magnitude?: string;
  consequence?: string;
  action?: { label: string; route: string; module: string; query?: Record<string, string> };
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
export function buildManagementInsights(summary: JsonObject, voice: VoiceInsights, olap: boolean, lastSyncedAt?: string) {
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
  if (revenue !== null && orders !== null && aov !== null) {
    const growth = finite(comparisons.revenuePct);
    groups[0] = {
      ...groups[0], availability: olap ? 'ready' : 'oltp_fallback',
      severity: growth !== null && growth < 0 ? 'watch' : 'ok',
      dataNote: olap ? 'Nguồn kho phân tích; doanh thu là giá trị đơn hợp lệ, chưa phải lợi nhuận.' : 'Nguồn giao dịch trực tiếp; kho phân tích chưa đồng bộ.',
      phenomenon: `Giá trị đơn hợp lệ đạt ${money(revenue)}.`,
      scope: `${orders} đơn trong kỳ; giá trị đơn trung bình ${money(aov)}.`,
      magnitude: growth === null ? 'Chưa có dữ liệu kỳ trước để so sánh.' : `Thay đổi ${growth}% so với kỳ trước.`,
      consequence: growth !== null && growth < 0 ? 'Cần đối chiếu danh mục và giá trước khi điều chỉnh chương trình bán hàng.' : 'Theo dõi danh mục đóng góp và khả năng đáp ứng tồn kho khi lập kế hoạch.',
      action: { label: 'Phân tích danh mục', route: '/products', module: 'products' },
    };
  }
  groups[1].dataNote = 'Số đơn chờ chưa chứng minh vi phạm SLA; cần thời gian tại trạng thái và cam kết xử lý.';
  groups[2].dataNote = 'Chưa có tỷ lệ trả hàng đối chiếu theo SKU và nhóm khách; không suy diễn từ thứ hạng bán chạy.';
  const delivered = voice.coverage.deliveredOrders;
  if (!voice.truncated && delivered > 0) {
    const missing = Math.round(1000 * voice.coverage.silentOrders / delivered) / 10;
    groups[3] = {
      ...groups[3], availability: 'ready', severity: missing > 30 ? 'watch' : 'ok',
      dataNote: 'Đếm đơn giao có đánh giá trong nguồn giao dịch của kỳ; không thay thế đánh giá chất lượng sản phẩm.',
      phenomenon: `${voice.coverage.silentOrders} đơn đã giao chưa có đánh giá.`,
      scope: `${delivered} đơn đã giao; ${voice.coverage.reviewedOrders} đơn có đánh giá.`,
      magnitude: `${missing}% đơn thiếu đánh giá; ngưỡng chú ý 30%.`,
      consequence: 'Thiếu phản hồi làm giảm tín hiệu để đánh giá chất lượng; cần kiểm tra luồng và thời điểm mời đánh giá.',
      action: { label: 'Kiểm tra đánh giá', route: '/reviews', module: 'reviews' },
    };
  }
  if (!voice.truncated && voice.serviceQuality.csatCount >= 20 && voice.serviceQuality.csatAvg !== null) {
    const service = voice.serviceQuality;
    groups[4] = {
      ...groups[4], availability: 'ready', severity: service.csatAvg! < 3 ? 'high' : 'ok',
      dataNote: 'Đủ ít nhất 20 phản hồi; chưa kết luận xu hướng hai tuần hoặc nguyên nhân theo nhóm yêu cầu.',
      phenomenon: `Điểm CSAT trung bình ${service.csatAvg}/5.`,
      scope: `${service.csatCount} phản hồi trên ${service.tickets} phiếu trong kỳ.`,
      magnitude: `Có ${service.ticketsWithoutCsat} phiếu đã đóng chưa ghi nhận CSAT.`,
      consequence: 'Đối chiếu nội dung hỗ trợ trước khi thay đổi quy trình chăm sóc khách hàng.',
      action: { label: 'Kiểm tra CSKH', route: '/returns', module: 'returns' },
    };
  } else {
    groups[4].dataNote = voice.truncated ? 'Nguồn dữ liệu bị giới hạn; chưa đủ căn cứ kết luận toàn kỳ.' : `Cần ít nhất 20 phản hồi CSAT; hiện có ${voice.serviceQuality.csatCount}.`;
  }
  const promoRevenue = finite(business.promotionRevenue);
  if (promoRevenue !== null) groups[5].dataNote = `Đã ghi nhận ${money(promoRevenue)} giá trị đơn có khuyến mãi; chưa có chi phí để tính ROI.`;
  if (!voice.truncated && delivered > 0 && voice.serviceQuality.returns > 0) {
    const returns = voice.serviceQuality;
    const reason = returns.returnReasons[0];
    groups[6] = {
      ...groups[6], availability: 'ready', severity: returns.returnRatePct > 10 ? 'watch' : 'ok',
      dataNote: 'Tỷ lệ phiếu phát sinh trong kỳ / đơn giao trong kỳ; không phải tỷ lệ hoàn theo cohort và chưa định lượng lợi nhuận.',
      phenomenon: `${returns.returns} phiếu đổi trả phát sinh trong kỳ.`,
      scope: reason ? `Lý do thường gặp: ${reason.reason} (${reason.count} phiếu).` : 'Toàn bộ phiếu trong kỳ; chưa có phân nhóm lý do.',
      magnitude: `${returns.returnRatePct}% so với số đơn giao trong kỳ.`,
      consequence: 'Cần kiểm tra các phiếu và nguyên nhân trước khi điều chỉnh chất lượng hoặc chính sách.',
      action: { label: 'Xem phiếu đổi trả', route: '/returns', module: 'returns' },
    };
  }
  groups[7].dataNote = 'Chưa có dữ liệu kết hợp mức giảm giá, đánh giá và CSAT; không suy diễn tương quan hoặc quan hệ nhân quả.';
  groups[8].dataNote = 'Chưa có cohort mua lại và doanh thu theo khách để tính retention hoặc LTV.';
  return { groups, ...(lastSyncedAt ? { lastSyncedAt } : {}) };
}
