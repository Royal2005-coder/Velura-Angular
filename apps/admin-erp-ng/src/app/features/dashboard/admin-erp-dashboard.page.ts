import { Component, computed, HostListener, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { of, Subscription, timer } from 'rxjs';
import { catchError, switchMap } from 'rxjs/operators';
import {
  AdminErpApiService as AdminApiService,
  AdminDashboardSummary,
  AdminInsightRange,
} from '../../core/admin-erp-api.service';
import { adminErrorMessage } from '../../core/admin-erp-http';
import { AdminErpSessionService } from '../../core/admin-erp-session.service';
import { AdminIcon } from '../../shared/admin-icon';
import { DashboardService } from './services/dashboard.service';
import { InventoryAlertItem, ModuleHealthData, SlaMetric } from './models/sla-metric.model';

export type DashboardTab = 'operations' | 'business';

/** Widget ids rendered by the dashboard; each one opens the shared drill-down modal. */
export type DashboardWidget = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5' | 'B1' | 'B2' | 'B3' | 'B4' | 'B5';

type ModuleHealthCountField = Exclude<keyof ModuleHealthData, 'total_issues' | 'fetched_at'>;

/** One Q1 module row. `count` comes from `getModuleHealth()`; null until it loads or when it fails. */
export interface Q1ModuleRow {
  key: ModuleHealthCountField;
  name: string;
  hint: string;
  count: number | null;
}

/** One Q4 queue row built from the live OLTP queue counts in `dashboard().operations`. */
export interface Q4QueueRow {
  key: 'tickets' | 'returns';
  name: string;
  count: number | null;
}

/** Low-stock variants from `getInventoryAlerts()` grouped by category. */
export interface Q5CategoryRow {
  name: string;
  outOfStock: number;
  low: number;
  total: number;
}

/** One B3 overview metric with its period-over-period comparison copy. */
export interface B3Stat {
  label: string;
  value: string;
  trend: string;
}

/** Empty-state copy for panels whose facts no API returns yet. */
export const NO_DATA_SOURCE = 'Chưa có nguồn dữ liệu cho mục này';

const Q1_MODULES: ReadonlyArray<Omit<Q1ModuleRow, 'count'>> = [
  { key: 'orders_pending_24h', name: 'Đơn hàng', hint: 'Đơn đang chờ xử lý' },
  { key: 'variants_out_of_stock', name: 'SP & Kho vận', hint: 'Biến thể hết / sắp hết hàng' },
  { key: 'tickets_open_24h', name: 'CSKH & Hậu mãi', hint: 'Ticket chưa đóng' },
  { key: 'promotions_near_budget', name: 'Giá & KM', hint: 'Khuyến mãi cần theo dõi ngân sách' },
  { key: 'reviews_urgent', name: 'Đánh giá & VoC', hint: 'Đánh giá cần xử lý gấp' },
  { key: 'admin_requests_pending', name: 'Tài khoản & RBAC', hint: 'Yêu cầu cấp quyền chờ duyệt' },
];

const DRILL_TITLES: Record<DashboardWidget, string> = {
  Q1: 'Sức khỏe phân hệ vận hành',
  Q2: 'Đơn hàng & SLA cung ứng',
  Q3: 'Cổng thanh toán & đối soát',
  Q4: 'CSKH & hàng đợi đổi trả',
  Q5: 'Cảnh báo tồn kho & SKU',
  B1: 'Doanh thu & tăng trưởng',
  B2: 'Danh mục & sản phẩm chủ lực',
  B3: 'Khách hàng & phân khúc',
  B4: 'Khuyến mãi & hiệu quả ngân sách',
  B5: 'Đổi trả & chất lượng sản phẩm',
};

/** Finite numbers only: the API sends null for unobserved values, and those must never render as 0. */
function observed(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

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
    revenue: null,
    orderCount: null,
    averageOrderValue: null,
    completionRate: null,
    promotionRevenue: null,
    promotionRevenueShare: null,
    pendingReviews: 0,
    revenueTrend: [],
    categoryContributions: [],
    bestSellers: [],
  },
  recentLogs: [],
  periodDays: 7,
  voice: null,
});

/**
 * Admin dashboard. Every number comes from `AdminErpApiService.dashboard()` or `DashboardService`;
 * panels without a data source render an empty state instead of sample figures.
 */
@Component({
  selector: 'app-admin-erp-dashboard-page',
  imports: [AdminIcon],
  templateUrl: './admin-erp-dashboard.page.html',
  styleUrl: './admin-erp-dashboard.page.scss',
})
export class AdminErpDashboardPage implements OnInit, OnDestroy {
  private readonly dashboardService = inject(DashboardService);
  private readonly api = inject(AdminApiService);
  private readonly sessionService = inject(AdminErpSessionService);
  private pollingSub?: Subscription;
  private toastTimer?: ReturnType<typeof setTimeout>;

  /** Empty-state copy exposed to the template. */
  readonly noDataSource = NO_DATA_SOURCE;

  /** Name of the signed-in operator for the greeting; neutral fallback when the session has none. */
  readonly operatorName = computed(() => this.sessionService.session()?.name?.trim() || 'bạn');

  // SLA materialized view (Q2): isInitialLoading only on first load, isRefreshing for background polls.
  readonly slaData = signal<SlaMetric[]>([]);
  readonly isInitialLoading = signal<boolean>(true);
  readonly isRefreshing = signal<boolean>(false);
  readonly lastUpdated = signal<Date | null>(null);
  readonly mvRefreshedAt = signal<string | null>(null);

  // Q5: low-stock variants from PostgreSQL.
  readonly inventoryAlerts = signal<InventoryAlertItem[]>([]);
  readonly inventoryLoading = signal<boolean>(true);

  // Q1: open-item counts for the six core modules.
  readonly moduleHealth = signal<ModuleHealthData | null>(null);
  readonly moduleHealthLoading = signal<boolean>(true);

  readonly tab = signal<DashboardTab>('operations');
  readonly q4Tab = signal<'queue' | 'resolution_time' | 'priority'>('queue');
  readonly q5Tab = signal<'alerts_table' | 'category'>('alerts_table');
  readonly b1Tab = signal<'time_combo' | 'price_bar' | 'payment_stacked'>('time_combo');
  readonly b2Tab = signal<'category' | 'best_sellers' | 'margin_matrix'>('category');
  readonly b3Tab = signal<'overview' | 'geo' | 'segments'>('overview');
  readonly range = signal<AdminInsightRange>('week');
  readonly productId = signal<string | null>(null);
  readonly categoryId = signal<string | null>(null);
  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly data = signal<AdminDashboardSummary>(emptyDashboard());
  readonly generatedAt = signal('');
  readonly activeDrillWidget = signal<DashboardWidget | null>(null);
  readonly toastMessage = signal<string | null>(null);
  readonly recommendation = signal<string[]>([]);
  readonly recommendationSource = signal<string | null>(null);
  readonly recommendationLoading = signal(false);
  readonly recommendationError = signal<string | null>(null);

  /** True once `dashboard()` answered for the current filters; KPIs render "—" otherwise. */
  readonly summaryReady = computed(() => !this.loading() && !this.loadError());
  /** Live OLTP queue counts, or null while loading / after an error. */
  readonly liveOps = computed(() => (this.summaryReady() ? this.data().operations : null));
  private readonly liveBusiness = computed(() => (this.summaryReady() ? this.data().business : null));

  // ---------------------------------------------------------------- Operations (Q1–Q5)

  readonly q1ModuleRows = computed<Q1ModuleRow[]>(() => {
    const health = this.moduleHealth();
    return Q1_MODULES.map((module) => ({ ...module, count: health ? observed(health[module.key]) : null }));
  });
  readonly q1MaxCount = computed(() => Math.max(1, ...this.q1ModuleRows().map((row) => row.count ?? 0)));
  readonly totalSystemIssues = computed(() => observed(this.moduleHealth()?.total_issues));

  readonly q2TotalPipelineOrders = computed(() => this.slaData().reduce((acc, r) => acc + (r.total_orders || 0), 0));
  readonly q2TotalViolatedOrders = computed(() => this.slaData().reduce((acc, r) => acc + (r.violated_orders || 0), 0));
  readonly q2OverallSlaPct = computed(() => {
    const total = this.q2TotalPipelineOrders();
    if (!total) return 0;
    const compliant = this.slaData().reduce(
      (acc, r) => acc + (r.new_orders || 0) + (r.normal_orders || 0) + (r.warning_orders || 0),
      0,
    );
    return Math.round((compliant / total) * 1000) / 10;
  });

  readonly totalProcessingOrders = computed(() => observed(this.liveOps()?.pendingOrders));
  readonly totalPaymentErrors = computed(() => observed(this.liveOps()?.paymentErrors));
  readonly totalLowStockVariants = computed(() => observed(this.liveOps()?.lowStockProducts));

  readonly q4Rows = computed<Q4QueueRow[]>(() => {
    const ops = this.liveOps();
    return [
      { key: 'tickets', name: 'Ticket CSKH', count: observed(ops?.openSupportTickets) },
      { key: 'returns', name: 'Phiếu đổi/trả', count: observed(ops?.openReturns) },
    ];
  });
  readonly q4MaxCount = computed(() => Math.max(1, ...this.q4Rows().map((row) => row.count ?? 0)));
  readonly totalCskhQueue = computed(() => {
    const [tickets, returns] = this.q4Rows().map((row) => row.count);
    return tickets === null || returns === null ? null : tickets + returns;
  });

  readonly q5OutOfStockCount = computed(() => this.inventoryAlerts().filter((item) => item.stock_quantity === 0).length);
  readonly q5CategoryRows = computed<Q5CategoryRow[]>(() => {
    const groups = new Map<string, Q5CategoryRow>();
    for (const item of this.inventoryAlerts()) {
      const name = item.category_name || 'Chưa phân loại';
      const row = groups.get(name) ?? { name, outOfStock: 0, low: 0, total: 0 };
      if (item.stock_quantity === 0) {
        row.outOfStock += 1;
      } else {
        row.low += 1;
      }
      row.total += 1;
      groups.set(name, row);
    }
    return [...groups.values()].sort((a, b) => b.total - a.total);
  });
  readonly q5CategoryMax = computed(() => Math.max(1, ...this.q5CategoryRows().map((row) => row.total)));

  // ---------------------------------------------------------------- Business (B1–B5)

  readonly comparisons = computed<NonNullable<AdminDashboardSummary['business']['comparisons']>>(
    () => this.liveBusiness()?.comparisons ?? {},
  );
  readonly revenue = computed(() => observed(this.liveBusiness()?.revenue));
  readonly revenueGrowthPct = computed(() => observed(this.comparisons().revenuePct));
  readonly orderCount = computed(() => observed(this.liveBusiness()?.orderCount));
  readonly averageOrderValue = computed(() => observed(this.liveBusiness()?.averageOrderValue));
  readonly completionRate = computed(() => observed(this.liveBusiness()?.completionRate));
  readonly promotionRevenue = computed(() => observed(this.liveBusiness()?.promotionRevenue));
  readonly promotionRevenueShare = computed(() => observed(this.liveBusiness()?.promotionRevenueShare));
  readonly customers = computed(() => {
    const business = this.liveBusiness();
    return observed(business?.customers ?? business?.customerCount);
  });

  readonly categories = computed(() =>
    (this.liveBusiness()?.categoryContributions ?? []).filter((cat) => observed(cat.revenue) !== null),
  );
  readonly topCategory = computed(() => {
    const cats = this.categories();
    return cats.length ? cats.reduce((top, cat) => (cat.revenue > top.revenue ? cat : top)) : null;
  });
  readonly bestSellers = computed(() =>
    (this.liveBusiness()?.bestSellers ?? []).map((item, index) => ({
      ...item,
      rank: String(index + 1).padStart(2, '0'),
    })),
  );

  readonly b3Stats = computed<B3Stat[]>(() => {
    const cmp = this.comparisons();
    return [
      { label: 'Khách hàng', value: this.countText(this.customers()), trend: this.trend(null) },
      { label: 'Đơn hàng', value: this.countText(this.orderCount()), trend: this.trend(cmp.orderCountPct) },
      { label: 'Giá trị đơn TB', value: this.moneyText(this.averageOrderValue()), trend: this.trend(cmp.aovPct) },
      {
        label: 'Tỷ lệ hoàn tất',
        value: this.pctText(this.completionRate()),
        trend: this.trend(cmp.completionRatePoints, ' điểm % so với kỳ trước'),
      },
    ];
  });

  /** Voice-of-customer block; the dashboard API currently returns null, so B5/B3 geo show empty states. */
  readonly voice = computed(() => (this.summaryReady() ? (this.data().voice ?? null) : null));
  readonly hasVoice = computed(() => this.voice() !== null);
  readonly returnReasons = computed(() => this.voice()?.serviceQuality.returnReasons ?? []);
  readonly returnRatePct = computed(() => observed(this.voice()?.serviceQuality.returnRatePct));
  readonly complainedProducts = computed(() => this.voice()?.productReaction.complained ?? []);
  readonly regions = computed(() => this.voice()?.regions ?? []);

  readonly chartBars = computed(() => {
    const points = this.liveBusiness()?.revenueTrend ?? [];
    const maxRevenue = Math.max(...points.map((point) => this.safeNumber(point.revenue)), 1);
    return points.map((point) => ({
      ...point,
      revenuePct: `${Math.round((this.safeNumber(point.revenue) / maxRevenue) * 100)}%`,
    }));
  });
  readonly chartColumns = computed(() => `repeat(${Math.max(this.chartBars().length, 1)}, minmax(0, 1fr))`);
  readonly chartMaxLabel = computed(() => this.money(Math.max(...this.chartBars().map((point) => this.safeNumber(point.revenue)), 0)));
  readonly peakInsight = computed(() => {
    const peak = this.liveBusiness()?.insights?.['peakDay'];
    if (!peak || typeof peak !== 'object') {
      return 'Chưa đủ dữ liệu để nhận đỉnh doanh thu trong kỳ.';
    }
    const row = peak as { date?: string; revenue?: number; changePct?: number | null };
    if (!row.date) {
      return 'Chưa đủ dữ liệu để nhận đỉnh doanh thu trong kỳ.';
    }
    const change =
      row.changePct === null || row.changePct === undefined
        ? 'không so sánh được ngày liền trước'
        : `${row.changePct > 0 ? 'tăng' : 'giảm'} ${Math.abs(row.changePct)}% so với ngày liền trước`;
    return `Ngày ${row.date} đạt ${this.moneyText(row.revenue)} — ${change}.`;
  });

  readonly periodLabel = computed(() => {
    if (this.range() === 'day') {
      return 'hôm nay';
    }
    if (this.range() === 'month') {
      return '30 ngày gần nhất';
    }
    return '7 ngày gần nhất';
  });
  readonly filterChips = computed(() => {
    const chips: Array<{ key: 'product' | 'category'; label: string }> = [];
    if (this.productId()) {
      chips.push({ key: 'product', label: 'Lọc theo sản phẩm' });
    }
    if (this.categoryId()) {
      chips.push({ key: 'category', label: 'Lọc theo danh mục' });
    }
    return chips;
  });
  readonly sourceLabel = computed(() => {
    const source = this.data().meta?.source;
    if (source === 'analytics.star') {
      return 'OLAP star (analytics)';
    }
    if (source === 'oltp.rpc') {
      return 'OLTP RPC (đơn, thanh toán, tồn)';
    }
    if (source === 'unavailable') {
      return 'nguồn phân tích chưa đồng bộ';
    }
    return 'chưa xác định nguồn';
  });
  /** Backend warning when business KPIs are withheld because the analytics snapshot is not validated. */
  readonly sourceWarning = computed(() => (this.summaryReady() ? (this.data().meta?.sourceWarning ?? null) : null));

  constructor() {
    this.reload();
  }

  ngOnInit(): void {
    this.startSlaPolling();
  }

  ngOnDestroy(): void {
    this.pollingSub?.unsubscribe();
    clearTimeout(this.toastTimer);
  }

  /**
   * Polls the SLA view every 120 000 ms (switchMap drops stale requests) and loads inventory alerts
   * and module health once.
   */
  startSlaPolling(): void {
    this.pollingSub = timer(0, 120000)
      .pipe(
        switchMap(() => {
          this.isRefreshing.set(true);
          return this.dashboardService.getSlaMetrics().pipe(catchError(() => of(null)));
        }),
      )
      .subscribe((res) => {
        this.applySla(res?.success ? res.data : null);
        this.isInitialLoading.set(false);
        this.isRefreshing.set(false);
      });
    this.loadInventoryAlerts();
    this.loadModuleHealth();
  }

  @HostListener('window:keydown', ['$event'])
  handleKeyboardShortcut(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
      return;
    }
    if (event.key === 'Escape') {
      this.closeDrill();
      return;
    }
    const ranges: Record<string, { range: AdminInsightRange; label: string }> = {
      d: { range: 'day', label: 'Hôm nay' },
      w: { range: 'week', label: '7 ngày' },
      m: { range: 'month', label: '30 ngày' },
    };
    const key = event.key.toLowerCase();
    if (ranges[key]) {
      event.preventDefault();
      this.setRange(ranges[key].range);
      this.showToast(`Đã chuyển khung nhìn: ${ranges[key].label} (Phím tắt ${key.toUpperCase()})`);
      return;
    }
    if (this.activeDrillWidget()) {
      return;
    }
    if (event.key === '1') {
      this.setTab('operations');
    } else if (event.key === '2') {
      this.setTab('business');
    } else if (key === 'r') {
      event.preventDefault();
      this.reload();
      this.showToast('Đã làm mới dữ liệu dashboard (Phím tắt R)');
    }
  }

  setTab(tab: DashboardTab): void {
    this.tab.set(tab);
  }

  setQ4Tab(tab: 'queue' | 'resolution_time' | 'priority'): void {
    this.q4Tab.set(tab);
  }

  setQ5Tab(tab: 'alerts_table' | 'category'): void {
    this.q5Tab.set(tab);
  }

  setB1Tab(tab: 'time_combo' | 'price_bar' | 'payment_stacked'): void {
    this.b1Tab.set(tab);
  }

  setB2Tab(tab: 'category' | 'best_sellers' | 'margin_matrix'): void {
    this.b2Tab.set(tab);
  }

  setB3Tab(tab: 'overview' | 'geo' | 'segments'): void {
    this.b3Tab.set(tab);
  }

  setRange(range: AdminInsightRange): void {
    this.range.set(range);
    this.recommendation.set([]);
    this.reload();
  }

  loadRecommendation(): void {
    this.recommendationLoading.set(true);
    this.recommendationError.set(null);
    this.api.recommendInsights({ range: this.range() }).subscribe({
      next: (result) => {
        this.recommendationLoading.set(false);
        this.recommendationSource.set(result.source || 'facts');
        const narrative = result.narrative || [];
        this.recommendation.set(narrative.length ? narrative : result.lines || []);
      },
      error: (error: unknown) => {
        this.recommendationLoading.set(false);
        this.recommendationError.set(adminErrorMessage(error, 'Không đọc được khuyến nghị từ số liệu kỳ này.'));
      },
    });
  }

  reload(): void {
    this.loading.set(true);
    this.loadError.set(null);
    const params: Record<string, string> = { range: this.range() };
    const productId = this.productId();
    const categoryId = this.categoryId();
    if (productId) {
      params['productId'] = productId;
    }
    if (categoryId) {
      params['categoryId'] = categoryId;
    }
    this.api.dashboard(params).subscribe({
      next: (summary) => {
        this.data.set({
          ...emptyDashboard(),
          ...summary,
          operations: { ...emptyDashboard().operations, ...summary.operations },
          business: { ...emptyDashboard().business, ...summary.business },
          voice: summary.voice ?? null,
          meta: summary.meta,
        });
        this.generatedAt.set(summary.meta?.generatedAt ? this.dateTimeText(summary.meta.generatedAt) : '');
        this.loading.set(false);
      },
      error: (error: unknown) => {
        this.data.set(emptyDashboard());
        this.generatedAt.set('');
        this.loadError.set(adminErrorMessage(error, 'Không thể tải dữ liệu dashboard'));
        this.loading.set(false);
      },
    });

    if (!this.isInitialLoading()) {
      this.isRefreshing.set(true);
      this.dashboardService
        .getSlaMetrics()
        .pipe(catchError(() => of(null)))
        .subscribe((res) => {
          this.applySla(res?.success ? res.data : null);
          this.isRefreshing.set(false);
        });
      this.loadInventoryAlerts();
      this.loadModuleHealth();
    }
  }

  drillProduct(productId: string | undefined): void {
    if (!productId) {
      return;
    }
    this.productId.set(productId);
    this.categoryId.set(null);
    this.closeDrill();
    this.setTab('business');
    this.reload();
  }

  drillCategory(categoryId: string | undefined): void {
    if (!categoryId) {
      return;
    }
    this.categoryId.set(categoryId);
    this.productId.set(null);
    this.closeDrill();
    this.setTab('business');
    this.reload();
  }

  clearFilter(key: 'product' | 'category'): void {
    if (key === 'product') {
      this.productId.set(null);
    } else {
      this.categoryId.set(null);
    }
    this.reload();
  }

  openDrill(widget: DashboardWidget): void {
    this.activeDrillWidget.set(widget);
  }

  closeDrill(): void {
    this.activeDrillWidget.set(null);
  }

  /** Human title of a widget for the drill-down modal header. */
  drillTitle(widget: DashboardWidget): string {
    return DRILL_TITLES[widget];
  }

  showToast(message: string): void {
    clearTimeout(this.toastTimer);
    this.toastMessage.set(message);
    this.toastTimer = setTimeout(() => this.toastMessage.set(null), 4500);
  }

  dismissToast(): void {
    clearTimeout(this.toastTimer);
    this.toastMessage.set(null);
  }

  money(value: number | undefined): string {
    const n = this.safeNumber(value);
    const abs = Math.abs(n);
    if (abs >= 1e9) {
      return `${(n / 1e9).toFixed(1).replace(/\.0$/, '')}B`;
    }
    if (abs >= 1e6) {
      return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
    }
    if (abs >= 1e3) {
      return `${(n / 1e3).toFixed(0)}K`;
    }
    return String(n);
  }

  /** Count for display; "—" when the value was not observed. */
  countText(value: number | null | undefined): string {
    const n = observed(value);
    return n === null ? '—' : n.toLocaleString('vi-VN');
  }

  /** Compact VND amount for display; "—" when the value was not observed. */
  moneyText(value: number | null | undefined): string {
    const n = observed(value);
    return n === null ? '—' : `${this.money(n)} đ`;
  }

  /** Percentage for display; "—" when the value was not observed. */
  pctText(value: number | null | undefined): string {
    const n = observed(value);
    return n === null ? '—' : `${n.toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%`;
  }

  /** Vietnam-local date/time for an ISO timestamp; "—" when missing or invalid. */
  dateTimeText(value: string | null | undefined): string {
    if (!value) {
      return '—';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return '—';
    }
    return date.toLocaleString('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
      hour: '2-digit',
      minute: '2-digit',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
  }

  trend(value: number | null | undefined, suffix = '% so với kỳ trước'): string {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) {
      return 'Chưa có dữ liệu kỳ trước';
    }
    const numeric = Number(value);
    const arrow = numeric > 0 ? '↑' : numeric < 0 ? '↓' : '→';
    return `${arrow} ${Math.abs(numeric).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}${suffix}`;
  }

  /** Bar width (%) of `count` relative to `max`; 0 for unobserved counts. */
  barWidth(count: number | null, max: number): number {
    return count === null || max <= 0 ? 0 : Math.round((count / max) * 100);
  }

  bestSellerWidth(revenue: number | undefined): number {
    const peak = Math.max(...this.bestSellers().map((item) => this.safeNumber(item.revenue)), 1);
    return Math.round((this.safeNumber(revenue) / peak) * 100);
  }

  regionShare(count: number): number {
    const top = Math.max(...this.regions().map((region) => region.count), 0);
    return top ? Math.max(8, Math.round((count / top) * 100)) : 0;
  }

  reasonShare(count: number): number {
    const top = Math.max(...this.returnReasons().map((reason) => reason.count), 0);
    return top ? Math.max(8, Math.round((count / top) * 100)) : 0;
  }

  private applySla(rows: SlaMetric[] | null): void {
    if (!rows) {
      return;
    }
    this.slaData.set(rows);
    if (rows.length > 0) {
      this.lastUpdated.set(new Date());
      this.mvRefreshedAt.set(rows[0].mv_refreshed_at);
    }
  }

  private loadInventoryAlerts(): void {
    this.dashboardService
      .getInventoryAlerts()
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        if (res?.success && res.data) {
          this.inventoryAlerts.set(res.data);
        }
        this.inventoryLoading.set(false);
      });
  }

  private loadModuleHealth(): void {
    this.dashboardService
      .getModuleHealth()
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        if (res?.success && res.data) {
          this.moduleHealth.set(res.data);
        }
        this.moduleHealthLoading.set(false);
      });
  }

  private safeNumber(value: unknown): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
}

export { AdminErpDashboardPage as AdminDashboardPage };
