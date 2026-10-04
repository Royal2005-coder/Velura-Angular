import type { JsonObject } from '../types.js';
import type { VoiceInsights } from '../insights.js';

const DAY = 86_400_000;
const uuid = (kind: number, index: number) => `${String(kind).padStart(8, '0')}-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
const PROVINCES = ['Hồ Chí Minh', 'Hà Nội', 'Đà Nẵng', 'Cần Thơ', 'Đồng Nai', 'Bình Dương'];
const STATUS = ['delivered', 'delivered', 'delivered', 'delivered', 'pending', 'confirmed', 'preparing', 'shipping', 'cancelled', 'failed_delivery'];
const RETURN_STATUS = ['REQUESTED', 'CONTACTING', 'WAITING_RETURN', 'RETURN_IN_TRANSIT', 'RECEIVED', 'REFUNDED', 'EXCHANGE_PREPARING', 'EXCHANGE_SHIPPING', 'COMPLETED', 'NEEDS_SUPPORT'];
const ratio = (part: number, total: number) => total ? Math.round(10000 * part / total) / 100 : null;
const sum = <T>(items: T[], value: (item: T) => number) => items.reduce((total, item) => total + value(item), 0);

/**
 * A bounded deterministic fixture lives in process memory, never in Supabase or operational tables.
 * IDs, labels and dataset markers are Demo-only. Simulated paid rows are analytical examples,
 * not payment callbacks; they cannot alter real order, stock, return or gateway state.
 */
export function buildManagementDemo(period: { from: Date; to: Date; range: string }, categoryId: string | null = null, productId: string | null = null) {
  const categories = ['Đầm', 'Áo', 'Quần', 'Chân váy'].map((name, i) => ({ category_id: uuid(2, i), name }));
  const products = Array.from({ length: 12 }, (_, i) => ({
    product_id: uuid(3, i), sku: `DEMO-${String(i + 1).padStart(3, '0')}`,
    name: `Demo · ${categories[i % 4].name} mẫu ${i + 1}`, category_id: categories[i % 4].category_id,
    category_name: categories[i % 4].name, color: ['Đen', 'Kem', 'Nâu'][i % 3], size: ['S', 'M', 'L', 'XL'][i % 4],
    price: 250000 + i * 75000,
  }));
  const days = Math.max(1, Math.round((period.to.getTime() - period.from.getTime()) / DAY));
  const orders = Array.from({ length: 160 }, (_, i) => {
    const product = products[i % products.length], quantity = 1 + i % 3;
    const discountPct = [0, 10, 20, 35][i % 4], subtotal = product.price * quantity;
    return {
      demo: true, order_id: uuid(4, i), customer_id: uuid(1, i % 24), is_guest: i % 13 === 0,
      status: STATUS[i % STATUS.length], province: PROVINCES[i % 6], product,
      quantity, subtotal, discountPct, discount: subtotal * discountPct / 100,
      value: subtotal * (1 - discountPct / 100),
      created_at: new Date(period.from.getTime() + (i % days) * DAY + (i % 20) * 3600000).toISOString(),
      hours_in_state: 4 + i % 64,
      payment_method: ['COD', 'stripe', 'vnpay', 'momo'][i % 4],
    };
  });
  const selected = orders.filter(o => (!categoryId || o.product.category_id === categoryId) && (!productId || o.product.product_id === productId));
  const valid = selected.filter(o => o.status !== 'cancelled'), delivered = selected.filter(o => o.status === 'delivered');
  const returns = delivered.filter((_, i) => i % 3 === 0).map((o, i) => ({ demo: true, return_id: uuid(6, i), order_id: o.order_id,
    product_id: o.product.product_id, quantity: 1, status: RETURN_STATUS[i % 10], reason: ['Không vừa size', 'Khác mô tả', 'Đổi màu'][i % 3],
    received: i % 10 >= 4 && i % 10 !== 9 ? 1 : 0 }));
  const reviews = delivered.filter((_, i) => i % 5 !== 0).map((o, i) => ({ demo: true, review_id: uuid(7, i), order_id: o.order_id,
    product_id: o.product.product_id, rating: 1 + i % 5, discountPct: o.discountPct }));
  const tickets = Array.from({ length: 48 }, (_, i) => ({ demo: true, ticket_id: uuid(8, i), status: ['open', 'processing', 'resolved', 'closed'][i % 4],
    score: i % 7 === 0 ? null : 1 + i % 5 }));
  const payments = orders.map((o, i) => ({ demo: true, payment_id: uuid(5, i), order_id: o.order_id, provider: o.payment_method,
    amount: o.value, status: o.status === 'cancelled' ? 'failed' : o.payment_method === 'COD' && o.status !== 'delivered' ? 'pending' : 'paid' }));
  const skuReturns = products.map(p => {
    const sales = delivered.filter(o => o.product.product_id === p.product_id), rs = returns.filter(r => r.product_id === p.product_id), ratings = reviews.filter(r => r.product_id === p.product_id);
    const units = sum(sales, o => o.quantity), requested = sum(rs, r => r.quantity), received = sum(rs, r => r.received);
    return { product_key: p.product_id, product_name: p.name, sku: p.sku, category_id: p.category_id, category_name: p.category_name,
      delivered_units: units, requested_units: requested, received_units: received, net_item_value: sum(sales, o => o.value),
      requested_rate_pct: ratio(requested, units), received_rate_pct: ratio(received, units), rating_count: ratings.length,
      low_rating_count: ratings.filter(r => r.rating <= 2).length, average_rating: ratings.length ? sum(ratings, r => r.rating) / ratings.length : null };
  }).filter(p => p.delivered_units > 0);
  const active = selected.filter(o => ['pending', 'confirmed', 'preparing'].includes(o.status));
  const csat = tickets.filter(t => t.score !== null), reviewedOrderIds = new Set(reviews.map(r => r.order_id));
  const customers = [...new Set(delivered.filter(o => !o.is_guest).map(o => o.customer_id))];
  const repeated = customers.filter(id => delivered.filter(o => o.customer_id === id).length >= 2);
  const promos = valid.filter(o => o.discount > 0);
  const facts: JsonObject = {
    source: 'analytics.demo.fixture.v1', dataset: 'demo', snapshotAt: period.to.toISOString(),
    cohortDefinition: 'Demo-only original delivered orders; requested and received returns remain separate.',
    sla: { contractualSlaAvailable: false, active_orders: active.length, known_state_orders: active.length,
      attention_orders_24h: active.filter(o => o.hours_in_state > 24).length,
      attention_rate_pct: ratio(active.filter(o => o.hours_in_state > 24).length, active.length),
      average_hours_in_state: active.length ? Math.round(sum(active, o => o.hours_in_state) / active.length * 100) / 100 : null },
    skuReturns, categoryReturns: categories.map(c => {
      const rows = skuReturns.filter(s => s.category_id === c.category_id), units = sum(rows, r => r.delivered_units);
      return { category_id: c.category_id, category_name: c.name, delivered_units: units,
        requested_units: sum(rows, r => r.requested_units), received_units: sum(rows, r => r.received_units),
        requested_rate_pct: ratio(sum(rows, r => r.requested_units), units), received_rate_pct: ratio(sum(rows, r => r.received_units), units) };
    }).filter(c => c.delivered_units > 0),
    returnReasons: [...new Set(returns.map(r => r.reason))].map(reason => ({ reason, requested_units: returns.filter(r => r.reason === reason).length })),
    promotion: { redemptions: promos.length, discountAmount: sum(promos, o => o.discount), associatedOrderValue: sum(promos, o => o.value), costAvailable: false, roi: null, programs: [] },
    discountSatisfaction: ['none', 'up_to_30_percent', 'over_30_percent'].map(bracket => {
      const filter = (pct: number) => bracket === 'none' ? pct === 0 : bracket === 'over_30_percent' ? pct > 30 : pct > 0 && pct <= 30;
      const os = delivered.filter(o => filter(o.discountPct)), rs = reviews.filter(r => filter(r.discountPct));
      return { bracket, orders: os.length, reviewed_orders: new Set(rs.map(r => r.order_id)).size, review_count: rs.length,
        low_rating_count: rs.filter(r => r.rating <= 2).length, average_rating: rs.length ? Math.round(sum(rs, r => r.rating) / rs.length * 100) / 100 : null };
    }), discountCsatJoinAvailable: false,
    retention: { known_customers: customers.length, repeat_customers: repeated.length, repeat_purchase_rate_pct: ratio(repeated.length, customers.length),
      observed_lifetime_order_value_avg: customers.length ? sum(delivered.filter(o => !o.is_guest), o => o.value) / customers.length : null,
      predictedLtvAvailable: false, currentTierRevenues: [] },
    refunds: { completedAmount: sum(returns.filter(r => r.status === 'REFUNDED'), r => selected.find(o => o.order_id === r.order_id)!.value / selected.find(o => o.order_id === r.order_id)!.quantity),
      pendingAmount: null, profitImpactAvailable: false },
    csat: { tickets: tickets.length, sample_count: csat.length, average_score: Math.round(sum(csat, t => t.score ?? 0) / csat.length * 100) / 100,
      closed_without_score: tickets.filter(t => ['resolved','closed'].includes(t.status) && t.score === null).length },
    reviewCoverage: { delivered_orders: delivered.length, reviewed_orders: reviewedOrderIds.size },
  };
  const revenue = sum(valid, o => o.value);
  const summary: JsonObject = {
    operations: { pendingOrders: active.length, paymentErrors: selected.filter(o => o.status === 'cancelled').length,
      openReturns: returns.filter(r => r.status !== 'COMPLETED').length, openSupportTickets: tickets.filter(t => ['open','processing'].includes(t.status)).length,
      lowStockProducts: 0, urgentReviews: reviews.filter(r => r.rating <= 2).length },
    business: { revenue, orderCount: selected.length, averageOrderValue: valid.length ? revenue / valid.length : 0,
      completionRate: ratio(delivered.length, selected.length) ?? 0, customers: customers.length,
      promotionRevenue: sum(promos, o => o.value), promotionRevenueShare: ratio(sum(promos, o => o.value), revenue) ?? 0,
      pendingReviews: 0, comparisons: { revenuePct: null, orderCountPct: null, aovPct: null, completionRatePoints: null },
      bestSellers: products.map(p => ({ product_id: p.product_id, sku: p.sku, name: p.name, sold: sum(valid.filter(o => o.product.product_id === p.product_id), o => o.quantity),
        revenue: sum(valid.filter(o => o.product.product_id === p.product_id), o => o.value), lowStock: false })).sort((a,b) => b.revenue-a.revenue).slice(0,5),
      categoryContributions: categories.map(c => ({ category_id: c.category_id, name: c.name, revenue: sum(valid.filter(o => o.product.category_id === c.category_id), o => o.value),
        pct: ratio(sum(valid.filter(o => o.product.category_id === c.category_id), o => o.value), revenue) ?? 0 })),
      revenueTrend: Array.from({ length: days }, (_, i) => {
        const date = new Date(period.from.getTime() + i * DAY + 7 * 3600000).toISOString().slice(0,10);
        const os = valid.filter(o => new Date(Date.parse(o.created_at) + 7 * 3600000).toISOString().startsWith(date));
        return { date, dateStr: date.slice(5), revenue: sum(os, o => o.value), orderCount: os.length };
      }) }, recentLogs: [],
  };
  const voice: VoiceInsights = {
    range: period.range, periodLabel: 'Dữ liệu Demo', truncated: false,
    coverage: { deliveredOrders: delivered.length, reviewedOrders: reviewedOrderIds.size, silentOrders: delivered.length-reviewedOrderIds.size, coveragePct: ratio(reviewedOrderIds.size, delivered.length) ?? 0 },
    productReaction: { reviewCount: reviews.length, avgRating: reviews.length ? sum(reviews, r => r.rating)/reviews.length : null, loved: [], complained: [] },
    serviceQuality: { tickets: tickets.length, closedTickets: tickets.filter(t => ['closed','resolved'].includes(t.status)).length,
      csatCount: csat.length, csatAvg: sum(csat, t => t.score ?? 0)/csat.length, ticketsWithoutCsat: tickets.filter(t => ['closed','resolved'].includes(t.status) && t.score === null).length,
      returns: returns.length, returnRatePct: ratio(returns.length,delivered.length) ?? 0, returnReasons: [...new Set(returns.map(r => r.reason))].map(reason => ({ reason, count: returns.filter(r => r.reason === reason).length })) },
    orderFriction: { orderCount: selected.length, completedOrders: delivered.length, cancelledOrders: selected.filter(o => o.status==='cancelled').length,
      failedDelivery: selected.filter(o => o.status==='failed_delivery').length, cancelReasons: [] },
    regions: PROVINCES.map(name => ({ name, count: selected.filter(o => o.province===name).length })),
  };
  return { summary, facts, voice, fixture: { dataset: 'demo', products, orders, payments, returns, reviews, tickets } };
}
