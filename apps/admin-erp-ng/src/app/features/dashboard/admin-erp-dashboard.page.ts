import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  AdminAuditRow,
  AdminDashboardSummary,
  AdminErpApiService,
  AdminInsightRange,
} from '../../core/admin-erp-api.service';
import { adminCompactMoney, adminMoney } from '../../core/admin-erp-format';
import { adminErrorMessage } from '../../core/admin-erp-http';
import {
  ADMIN_ERP_NAV_ITEMS,
  adminErpNavItemForPage,
  adminErpNavLink,
} from '../../core/admin-erp-navigation';
import { AdminErpSessionService } from '../../core/admin-erp-session.service';
import { useWorkspaceRefresh } from '../../core/admin-erp-refresh.service';
import { AdminErpIcon } from '../../shared/ui/admin-erp-icon';
import { AdminErpEmptyState } from '../../shared/ui/admin-empty-state';
import { AdminErpKpiCard, AdminKpiTone } from '../../shared/ui/admin-kpi-card';
import { AdminErpPageHeader } from '../../shared/ui/admin-page-header';
import { AdminErpStatusBadge } from '../../shared/ui/admin-status-badge';
import { AdminErpTableSkeleton } from '../../shared/ui/admin-table-skeleton';
import { AdminErpTab, AdminErpTabs } from '../../shared/ui/admin-tabs';

type DashboardTab = 'operations' | 'business';

/** Queue each alert is counting, so opening the alert shows exactly those rows. */
const QUEUE_FILTERS: Readonly<Record<string, Record<string, string>>> = {
  orders: { tab: 'attention' },
  'returns-cskh': { tab: 'returns', status: 'REQUESTED' },
  products: { tab: 'stock' },
  reviews: { tab: 'urgent' },
};

const emptyDashboard = (): AdminDashboardSummary => ({
  operations: {
    pendingOrders: 0,
    paymentErrors: 0,
    openReturns: 0,
    openSupportTickets: 0,
    lowStockProducts: 0,
    urgentReviews: 0,
  },
  business: {
    revenue: 0,
    orderCount: 0,
    averageOrderValue: 0,
    completionRate: 0,
    promotionRevenue: 0,
    promotionRevenueShare: 0,
    pendingReviews: 0,
    revenueTrend: [],
    categoryContributions: [],
    bestSellers: [],
  },
  recentLogs: [],
  periodDays: 7,
});

/**
 * Operations-first dashboard. Uses the real `/api/v1/admin/dashboard` summary and
 * never substitutes demo numbers while the API is loading or failing.
 */
@Component({
  selector: 'app-admin-erp-dashboard-page',
  imports: [
    RouterLink,
    AdminErpIcon,
    AdminErpPageHeader,
    AdminErpKpiCard,
    AdminErpStatusBadge,
    AdminErpTabs,
    AdminErpEmptyState,
    AdminErpTableSkeleton,
  ],
  templateUrl: './admin-erp-dashboard.page.html',
  styleUrl: './admin-erp-dashboard.page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminErpDashboardPage {
  private readonly api = inject(AdminErpApiService);
  private readonly session = inject(AdminErpSessionService);

  readonly tab = signal<DashboardTab>('operations');
  readonly range = signal<AdminInsightRange>('week');
  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly data = signal<AdminDashboardSummary>(emptyDashboard());
  readonly generatedAt = signal('');

  readonly ops = computed(() => this.data().operations);
  readonly business = computed(() => this.data().business);
  readonly logs = computed(() => this.data().recentLogs || []);
  readonly tabs = computed<readonly AdminErpTab[]>(() => [
    { key: 'operations', label: 'Vận hành', count: this.alertTotal() },
    { key: 'business', label: 'Kinh doanh' },
  ]);

  readonly alertTotal = computed(() => {
    const ops = this.ops();
    return (
      this.safeNumber(ops.pendingOrders) +
      this.safeNumber(ops.paymentErrors) +
      this.safeNumber(ops.openReturns) +
      this.safeNumber(ops.openSupportTickets) +
      this.safeNumber(ops.lowStockProducts) +
      this.safeNumber(ops.urgentReviews)
    );
  });

  readonly operationKpis = computed<Array<{ label: string; value: string; hint: string; tone: AdminKpiTone; icon: string }>>(() => {
    const ops = this.ops();
    return [
      {
        label: 'Đơn chờ xử lý',
        value: this.num(ops.pendingOrders),
        hint: 'Hàng đợi xác nhận / chuẩn bị',
        tone: 'accent',
        icon: 'cart',
      },
      {
        label: 'Lỗi thanh toán',
        value: this.num(ops.paymentErrors),
        hint: 'Đơn lệch hoặc thanh toán thất bại',
        tone: 'danger',
        icon: 'credit-card',
      },
      {
        label: 'Đổi trả đang mở',
        value: this.num(ops.openReturns),
        hint: 'Yêu cầu chưa đóng',
        tone: 'warning',
        icon: 'return',
      },
      {
        label: 'Phiếu hỗ trợ',
        value: this.num(ops.openSupportTickets),
        hint: 'Ticket CSKH còn mở',
        tone: 'info',
        icon: 'support',
      },
      {
        label: 'SKU sắp hết',
        value: this.num(ops.lowStockProducts),
        hint: 'Dưới ngưỡng tồn kho',
        tone: 'warning',
        icon: 'box',
      },
      {
        label: 'Đánh giá gấp',
        value: this.num(ops.urgentReviews),
        hint: 'Cần kiểm duyệt ưu tiên',
        tone: 'danger',
        icon: 'star',
      },
    ];
  });

  readonly businessKpis = computed<Array<{ label: string; value: string; hint: string; tone: AdminKpiTone; icon: string }>>(() => {
    const business = this.business();
    return [
      {
        label: 'Doanh thu kỳ',
        value: `${adminCompactMoney(business.revenue)}đ`,
        hint: this.trend(business.comparisons?.revenuePct),
        tone: 'accent',
        icon: 'dashboard',
      },
      {
        label: 'Số đơn',
        value: this.num(business.orderCount),
        hint: this.trend(business.comparisons?.orderCountPct),
        tone: 'info',
        icon: 'cart',
      },
      {
        label: 'Giá trị đơn TB',
        value: this.compactMoney(business.averageOrderValue),
        hint: this.trend(business.comparisons?.aovPct),
        tone: 'neutral',
        icon: 'tag',
      },
      {
        label: 'Tỷ lệ hoàn tất',
        value: this.pct(business.completionRate),
        hint: this.trend(business.comparisons?.completionRatePoints, ' điểm so với kỳ trước'),
        tone: 'success',
        icon: 'check',
      },
      {
        label: 'Doanh thu có KM',
        value: this.pct(business.promotionRevenueShare),
        hint: `${this.compactMoney(business.promotionRevenue)} từ khuyến mãi`,
        tone: 'warning',
        icon: 'tag',
      },
    ];
  });

  readonly alerts = computed(() => {
    const ops = this.ops();
    return [
      {
        key: 'orders',
        title: `${this.num(ops.pendingOrders)} đơn chờ · ${this.num(ops.paymentErrors)} lỗi thanh toán`,
        detail: 'Xác nhận đơn, xử lý thanh toán và bàn giao vận chuyển.',
        page: 'orders',
        tone: 'danger' as const,
        action: 'Xử lý đơn',
      },
      {
        key: 'returns',
        title: `${this.num(ops.openReturns)} đổi trả mở · ${this.num(ops.openSupportTickets)} phiếu hỗ trợ`,
        detail: 'Hàng đợi CSKH đang mở trên hệ thống hiện tại.',
        page: 'returns-cskh',
        tone: 'warning' as const,
        action: 'Mở CSKH',
      },
      {
        key: 'products',
        title: `${this.num(ops.lowStockProducts)} SKU dưới ngưỡng tồn`,
        detail: 'Đếm biến thể có tồn kho thấp hơn ngưỡng cảnh báo.',
        page: 'products',
        tone: 'info' as const,
        action: 'Xem tồn',
      },
      {
        key: 'reviews',
        title: `${this.num(ops.urgentReviews)} đánh giá gấp · ${this.num(this.business().pendingReviews)} chờ duyệt`,
        detail: 'Hàng đợi kiểm duyệt nội dung khách hàng.',
        page: 'reviews',
        tone: 'neutral' as const,
        action: 'Mở đánh giá',
      },
    ];
  });

  readonly healthLinks = computed(() => {
    const ops = this.ops();
    return [
      { key: 'orders', label: 'Đơn hàng', value: `${this.num(ops.pendingOrders)} chờ`, page: 'orders', icon: 'cart' },
      { key: 'products', label: 'Sản phẩm', value: `${this.num(ops.lowStockProducts)} SKU thấp`, page: 'products', icon: 'box' },
      { key: 'reviews', label: 'Đánh giá', value: `${this.num(this.business().pendingReviews)} chờ`, page: 'reviews', icon: 'star' },
      { key: 'returns', label: 'CSKH', value: `${this.num(ops.openSupportTickets)} phiếu`, page: 'returns-cskh', icon: 'support' },
      { key: 'accounts', label: 'Tài khoản', value: `${this.num(this.business().customers)} khách`, page: 'accounts', icon: 'users' },
    ];
  });

  readonly recentActivity = computed(() =>
    this.logs()
      .slice(0, 6)
      .map((log) => ({ log, copy: this.logCopy(log) })),
  );

  readonly chartBars = computed(() => {
    const points = this.business().revenueTrend || [];
    const maxRevenue = Math.max(...points.map((point) => this.safeNumber(point.revenue)), 1);
    const maxOrders = Math.max(...points.map((point) => this.safeNumber(point.orderCount)), 1);
    return points.map((point) => ({
      ...point,
      revenuePct: `${Math.round((this.safeNumber(point.revenue) / maxRevenue) * 100)}%`,
      orderPct: `${Math.round((this.safeNumber(point.orderCount) / maxOrders) * 100)}%`,
      label: point.dateStr || point.date,
      amount: `${adminCompactMoney(point.revenue)}đ`,
    }));
  });

  readonly chartColumns = computed(() => `repeat(${Math.max(this.chartBars().length, 1)}, minmax(0, 1fr))`);
  readonly hasBusinessData = computed(
    () => this.safeNumber(this.business().orderCount) > 0 || this.chartBars().some((point) => point.revenue > 0),
  );
  readonly bestSellers = computed(() => (this.business().bestSellers || []).slice(0, 6));
  readonly categories = computed(() => (this.business().categoryContributions || []).slice(0, 5));
  readonly periodLabel = computed(() => {
    if (this.range() === 'day') return 'hôm nay';
    if (this.range() === 'month') return '30 ngày gần nhất';
    return '7 ngày gần nhất';
  });
  readonly sourceLabel = computed(() => {
    const source = this.data().meta?.source;
    if (source === 'analytics.star') return 'OLAP star (analytics)';
    if (source === 'oltp.rpc') return 'OLTP RPC';
    return 'nguồn API';
  });
  readonly freshness = computed(() => this.data().meta?.freshness ?? '');
  readonly sourceWarning = computed(() => this.data().meta?.sourceWarning ?? '');
  readonly dataStatus = computed<{ label: string; tone: 'success' | 'warning' | 'danger' }>(() => {
    if (this.loadError()) return { label: 'Mất kết nối', tone: 'danger' };
    if (this.loading()) return { label: 'Đang tải', tone: 'warning' };
    if (this.freshness() === 'fresh') return { label: 'Dữ liệu thật', tone: 'success' };
    if (this.freshness() === 'stale') return { label: 'Dữ liệu cũ', tone: 'warning' };
    return { label: 'Chưa xác minh', tone: 'danger' };
  });

  constructor() {
    this.reload();
    useWorkspaceRefresh(() => this.reload());
  }

  /**
   * Switches between the operations and business views.
   */
  setTab(tab: string): void {
    if (tab === 'operations' || tab === 'business') {
      this.tab.set(tab);
    }
  }

  /**
   * Applies a fixed day/week/month window and reloads the real summary.
   */
  setRange(range: AdminInsightRange): void {
    this.range.set(range);
    this.reload();
  }

  /**
   * Reloads the active dashboard window.
   */
  reload(): void {
    this.loading.set(true);
    this.loadError.set(null);
    this.api.dashboard({ range: this.range() }).subscribe({
      next: (summary) => {
        this.data.set({
          ...emptyDashboard(),
          ...summary,
          operations: { ...emptyDashboard().operations, ...summary.operations },
          business: { ...emptyDashboard().business, ...summary.business },
          meta: summary.meta,
        });
        const generated = summary.meta?.generatedAt ? new Date(summary.meta.generatedAt) : null;
        this.generatedAt.set(
          generated
            ? generated.toLocaleString('vi-VN', {
                timeZone: 'Asia/Ho_Chi_Minh',
                hour: '2-digit',
                minute: '2-digit',
                day: '2-digit',
                month: '2-digit',
                year: 'numeric',
              })
            : '',
        );
        this.loading.set(false);
      },
      error: (error: unknown) => {
        this.data.set(emptyDashboard());
        this.loadError.set(adminErrorMessage(error, 'Không thể tải dữ liệu dashboard.'));
        this.loading.set(false);
      },
    });
  }

  /**
   * Resolves the ERP link for a page key when the role may open it.
   */
  routeFor(page: string): string | null {
    const item = adminErpNavItemForPage(page);
    if (!item || !this.session.canOpenAny(item.pageKeys)) {
      return null;
    }
    return adminErpNavLink(item);
  }

  /**
   * Where an alert sends the operator: the workspace they may open, already filtered to the queue
   * the alert counts, so one click lands on the work instead of the top of a list.
   */
  alertLink(page: string): { commands: readonly string[]; query: Record<string, string> } | null {
    const item = adminErpNavItemForPage(page);
    if (!item || !this.session.canOpenAny(item.pageKeys)) {
      return null;
    }
    return { commands: [item.path], query: { ...(item.queryParams || {}), ...(QUEUE_FILTERS[page] || {}) } };
  }

  /**
   * Formats a locale integer.
   */
  num(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
    return Number(value).toLocaleString('vi-VN');
  }

  /**
   * Formats full VND, leaving unsynced KPIs visibly unavailable instead of zero.
   */
  money(value: number | null | undefined): string {
    if (value === null || value === undefined) return '—';
    return adminMoney(value);
  }

  /**
   * Compact money for KPI cards, unavailable when the synced facts are missing.
   */
  compactMoney(value: number | null | undefined): string {
    if (value === null || value === undefined) return '—';
    return `${adminCompactMoney(value)}đ`;
  }

  /**
   * Percentage for KPI cards, unavailable instead of a fabricated 0%.
   */
  pct(value: number | null | undefined): string {
    if (value === null || value === undefined) return '—';
    return `${this.num(value)}%`;
  }

  /**
   * Formats a comparison label without inventing a trend when the API has no prior period.
   */
  trend(value: number | null | undefined, suffix = '% so với kỳ trước'): string {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) {
      return 'Chưa có dữ liệu kỳ trước';
    }
    const numeric = Number(value);
    const arrow = numeric > 0 ? '↑' : numeric < 0 ? '↓' : '→';
    return `${arrow} ${Math.abs(numeric).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}${suffix}`;
  }

  /**
   * Builds a readable audit line for the activity feed.
   */
  logCopy(log: AdminAuditRow): { time: string; actor: string; desc: string; module: string } {
    const date = log.timestamp ? new Date(log.timestamp) : new Date();
    const verbs: Record<string, string> = {
      create: 'Tạo mới',
      update: 'Cập nhật',
      delete: 'Xóa',
      approve: 'Duyệt',
      reject: 'Từ chối',
    };
    const targets: Record<string, string> = {
      orders: 'đơn hàng',
      product: 'sản phẩm',
      products: 'sản phẩm',
      reviews: 'đánh giá',
      accounts: 'tài khoản',
      returns: 'yêu cầu đổi trả',
      return_exchange: 'yêu cầu đổi trả',
    };
    const modules: Record<string, string> = {
      orders: 'Đơn hàng',
      product: 'Sản phẩm',
      products: 'Sản phẩm',
      reviews: 'Đánh giá',
      accounts: 'Tài khoản',
      returns: 'Đổi trả & CSKH',
      return_exchange: 'Đổi trả & CSKH',
    };
    const action = verbs[log.action || ''] || log.action || 'Thao tác';
    const target = targets[log.module || ''] || log.module || '';
    let desc = `${action} ${target}`.trim();
    if (log.target_id) {
      desc += ` #${String(log.target_id).slice(0, 8)}`;
    }
    return {
      time: date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' }),
      actor: log.actor_name || log.actor_id || 'Hệ thống',
      desc,
      module: modules[log.module || ''] || 'Hệ thống',
    };
  }

  private safeNumber(value: unknown): number {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
  }
}
