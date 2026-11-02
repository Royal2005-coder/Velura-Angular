import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  AdminAuditRow,
  AdminDashboardSummary,
  AdminErpApiService,
  AdminInsightRange,
  AdminManagementInsight,
} from '../../core/admin-erp-api.service';
import { adminKpiMoney, adminMoney } from '../../core/admin-erp-format';
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

type DashboardTab = 'operations' | 'business' | 'insights';

/** The API refuses a second warehouse sync inside this window (ANALYTICS_REFRESH_THROTTLED). */
const REFRESH_COOLDOWN_SECONDS = 10;

const SEVERITY_VIEW: Readonly<Record<AdminManagementInsight['severity'], { label: string; tone: 'danger' | 'warning' | 'success' }>> = {
  critical: { label: 'Nghiêm trọng', tone: 'danger' },
  high: { label: 'Mức cao', tone: 'danger' },
  watch: { label: 'Cần theo dõi', tone: 'warning' },
  ok: { label: 'Ổn định', tone: 'success' },
};

/** The four mandatory parts of a Management Insight card, in reading order (BA 3.1.13 bước 5). */
const INSIGHT_PARTS: ReadonlyArray<{ key: 'phenomenon' | 'scope' | 'magnitude' | 'consequence'; label: string }> = [
  { key: 'phenomenon', label: 'Hiện tượng' },
  { key: 'scope', label: 'Phạm vi' },
  { key: 'magnitude', label: 'Mức độ / tác động' },
  { key: 'consequence', label: 'Hệ quả' },
];

/** Prepared view of one insight card; `parts` is empty when the source has too little data. */
export interface InsightCardView {
  id: string;
  title: string;
  ready: boolean;
  severity: AdminManagementInsight['severity'];
  severityLabel: string;
  tone: 'danger' | 'warning' | 'success' | 'neutral';
  parts: ReadonlyArray<{ label: string; text: string }>;
  note: string;
  action: { label: string; link: { commands: readonly string[]; query: Record<string, string> } | null } | null;
}

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
  private readonly destroyRef = inject(DestroyRef);
  private cooldownTimer: ReturnType<typeof setInterval> | null = null;

  /** Why the free date picker is not offered; shown as a tooltip on the fixed range buttons. */
  readonly rangeHint =
    'Hệ thống chỉ hỗ trợ Ngày / Tuần / Tháng cố định để các kỳ báo cáo luôn so sánh được với nhau; không chọn khoảng ngày tùy ý.';

  readonly tab = signal<DashboardTab>('operations');
  readonly range = signal<AdminInsightRange>('week');
  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly data = signal<AdminDashboardSummary>(emptyDashboard());
  readonly generatedAt = signal('');
  /** True while the warehouse re-sync request is in flight. */
  readonly refreshing = signal(false);
  /** Seconds left before the refresh button re-enables. */
  readonly cooldown = signal(0);
  readonly notice = signal<{ tone: 'success' | 'warning' | 'danger'; text: string } | null>(null);
  /** Only roles allowed to update the dashboard module may trigger the warehouse sync. */
  readonly canSyncWarehouse = computed(() => this.session.can('update', 'dashboard'));
  readonly refreshLabel = computed(() => {
    if (this.refreshing()) return 'Đang đồng bộ kho dữ liệu…';
    if (this.loading()) return 'Đang tải…';
    if (this.cooldown() > 0) return `Làm mới (${this.cooldown()}s)`;
    return 'Làm mới';
  });

  readonly ops = computed(() => this.data().operations);
  readonly business = computed(() => this.data().business);
  readonly logs = computed(() => this.data().recentLogs || []);
  readonly tabs = computed<readonly AdminErpTab[]>(() => [
    { key: 'operations', label: 'Vận hành', count: this.alertTotal() },
    { key: 'business', label: 'Kinh doanh' },
    { key: 'insights', label: 'Insight quản trị', count: this.readyInsightCount() },
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
        hint: 'Chờ xác nhận hoặc có cảnh báo, cùng tab "Cần xử lý"',
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
        label: 'Đổi trả chờ duyệt',
        value: this.num(ops.openReturns),
        hint: 'Yêu cầu mới ở trạng thái "Yêu cầu"',
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
        label: 'Biến thể sắp hết',
        value: this.num(ops.lowStockProducts),
        hint: 'Mỗi biến thể tồn ≤ ngưỡng là một dòng',
        tone: 'warning',
        icon: 'box',
      },
      {
        label: 'Đánh giá gấp',
        value: this.num(ops.urgentReviews),
        hint: 'Chưa xử lý, gắn cờ gấp hoặc ≤ 2 sao',
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
        value: this.compactMoney(business.revenue),
        hint: this.kpiHint(business.revenue, this.trend(business.comparisons?.revenuePct)),
        tone: 'accent',
        icon: 'dashboard',
      },
      {
        label: 'Số đơn',
        value: this.num(business.orderCount),
        hint: this.kpiHint(business.orderCount, this.trend(business.comparisons?.orderCountPct)),
        tone: 'info',
        icon: 'cart',
      },
      {
        label: 'Giá trị đơn TB',
        value: this.compactMoney(business.averageOrderValue),
        hint: this.kpiHint(business.averageOrderValue, this.trend(business.comparisons?.aovPct)),
        tone: 'neutral',
        icon: 'tag',
      },
      {
        label: 'Tỷ lệ hoàn tất',
        value: this.pct(business.completionRate),
        hint: this.kpiHint(
          business.completionRate,
          this.trend(business.comparisons?.completionRatePoints, ' điểm so với kỳ trước'),
        ),
        tone: 'success',
        icon: 'check',
      },
      {
        label: 'Doanh thu có KM',
        value: this.pct(business.promotionRevenueShare),
        hint: this.kpiHint(business.promotionRevenue, `${this.compactMoney(business.promotionRevenue)} từ khuyến mãi`),
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
        title: `${this.num(ops.pendingOrders)} đơn cần xử lý · ${this.num(ops.paymentErrors)} lỗi thanh toán`,
        detail: 'Xác nhận đơn, xử lý thanh toán và bàn giao vận chuyển.',
        page: 'orders',
        tone: 'danger' as const,
        action: 'Xử lý đơn',
      },
      {
        key: 'returns',
        title: `${this.num(ops.openReturns)} đổi trả chờ duyệt · ${this.num(ops.openSupportTickets)} phiếu hỗ trợ`,
        detail: 'Hàng đợi CSKH đang mở trên hệ thống hiện tại.',
        page: 'returns-cskh',
        tone: 'warning' as const,
        action: 'Mở CSKH',
      },
      {
        key: 'products',
        title: `${this.num(ops.lowStockProducts)} biến thể dưới ngưỡng tồn`,
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
      { key: 'products', label: 'Sản phẩm', value: `${this.num(ops.lowStockProducts)} biến thể thấp`, page: 'products', icon: 'box' },
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
      amount: adminKpiMoney(point.revenue),
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
    // Operational queues are read live from the transactional store, so warehouse staleness is irrelevant here.
    if (this.tab() === 'operations') return { label: 'Hàng đợi trực tiếp', tone: 'success' };
    if (this.freshness() === 'fresh') return { label: 'Dữ liệu thật', tone: 'success' };
    if (this.freshness() === 'stale') return { label: 'Dữ liệu cũ', tone: 'warning' };
    return { label: 'Chưa xác minh', tone: 'danger' };
  });

  readonly insightCards = computed<readonly InsightCardView[]>(() =>
    (this.data().management?.groups ?? []).map((group) => this.insightView(group)),
  );
  readonly readyInsightCount = computed(() => this.insightCards().filter((card) => card.ready).length);
  readonly pendingEvents = computed(() => this.data().meta?.pendingEvents ?? null);
  /** Footer: when the warehouse was last verified and why live queues may be ahead of it. */
  readonly footerNote = computed(() => {
    const at = this.generatedAt();
    const synced = at ? `Kho phân tích đồng bộ lần cuối lúc ${at}.` : 'Kho phân tích chưa có bản đồng bộ đã xác minh.';
    const pending = this.pendingEvents();
    const queue = pending !== null && pending > 0 ? ` Còn ${this.num(pending)} sự kiện giao dịch chờ đồng bộ.` : '';
    const stale = this.freshness() === 'stale' ? ' Dữ liệu kinh doanh đã cũ hơn 5 phút.' : '';
    return `${synced}${queue}${stale} Đơn phát sinh sau thời điểm này chưa có trong số liệu kinh doanh; hàng đợi vận hành là thời gian thực.`;
  });

  constructor() {
    this.reload();
    useWorkspaceRefresh(() => this.reload());
    this.destroyRef.onDestroy(() => this.stopCooldown());
  }

  /**
   * Switches between the operations and business views.
   */
  setTab(tab: string): void {
    if (this.loading()) return;
    if (tab === 'operations' || tab === 'business' || tab === 'insights') {
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
          management: summary.management,
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
   * "Làm mới": super admin re-syncs the OLAP warehouse (blocked for 10 s afterwards, 429 handled),
   * every other role simply re-reads the current snapshot.
   */
  refresh(): void {
    if (this.refreshing() || this.cooldown() > 0 || this.loading()) return;
    if (!this.canSyncWarehouse()) {
      this.reload();
      return;
    }
    this.notice.set(null);
    this.refreshing.set(true);
    this.startCooldown(REFRESH_COOLDOWN_SECONDS);
    this.api.refreshDashboard().subscribe({
      next: () => {
        this.refreshing.set(false);
        this.notice.set({ tone: 'success', text: 'Đã đồng bộ kho dữ liệu thành công.' });
        this.reload();
      },
      error: (error: unknown) => {
        this.refreshing.set(false);
        if (error instanceof HttpErrorResponse && error.status === 429) {
          this.notice.set({ tone: 'warning', text: 'Kho dữ liệu vừa được đồng bộ. Vui lòng chờ 10 giây rồi thử lại.' });
          return;
        }
        this.notice.set({
          tone: 'danger',
          text: adminErrorMessage(error, 'Đồng bộ thất bại; đang giữ bản đã xác minh gần nhất.'),
        });
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
   * Turns one Management Insight into a card. Insufficient data keeps the reason, never a fake figure.
   */
  insightView(group: AdminManagementInsight): InsightCardView {
    const ready = group.availability === 'ready';
    const severity = SEVERITY_VIEW[group.severity] ?? SEVERITY_VIEW.watch;
    const parts = ready
      ? INSIGHT_PARTS.flatMap((part) => (group[part.key] ? [{ label: part.label, text: String(group[part.key]) }] : []))
      : [];
    return {
      id: group.id,
      title: group.title,
      ready,
      severity: group.severity,
      severityLabel: ready ? severity.label : 'Chưa đủ dữ liệu',
      tone: ready ? severity.tone : 'neutral',
      parts,
      note: group.dataNote || (ready ? '' : 'Chưa có đủ dữ liệu đã đối chiếu để kết luận.'),
      action: ready && group.action ? { label: group.action.label, link: this.insightLink(group.action) } : null,
    };
  }

  /**
   * Deep link of an insight action into the matching ERP workspace, or null when the role may not open it.
   */
  insightLink(
    action: NonNullable<AdminManagementInsight['action']>,
  ): { commands: readonly string[]; query: Record<string, string> } | null {
    const item = Object.values(ADMIN_ERP_NAV_ITEMS).find((candidate) => candidate.path === action.route);
    if (!item || !this.session.canOpenAny(item.pageKeys)) {
      return null;
    }
    const query: Record<string, string> = { ...(item.queryParams || {}) };
    for (const [key, value] of Object.entries(action.query || {})) {
      if (value) query[key] = value;
    }
    return { commands: [item.path], query };
  }

  /**
   * A missing observation is announced instead of a trend line that would imply real data.
   */
  kpiHint(value: number | null | undefined, hint: string): string {
    return value === null || value === undefined ? 'Chưa có dữ liệu' : hint;
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
    return adminKpiMoney(value);
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

  private startCooldown(seconds: number): void {
    this.stopCooldown();
    this.cooldown.set(seconds);
    this.cooldownTimer = setInterval(() => {
      const left = this.cooldown() - 1;
      this.cooldown.set(Math.max(left, 0));
      if (left <= 0) this.stopCooldown();
    }, 1000);
  }

  private stopCooldown(): void {
    if (this.cooldownTimer !== null) {
      clearInterval(this.cooldownTimer);
      this.cooldownTimer = null;
    }
  }

  private safeNumber(value: unknown): number {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
  }
}
