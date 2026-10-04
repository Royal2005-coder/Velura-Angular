import { Subscription } from 'rxjs';
import { AdminRefreshService } from '../../core/admin-refresh.service';
import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  AdminApiService,
  AdminAuditRow,
  AdminDashboardSummary,
  AdminInsightRange,
  AdminVoiceInsights,
  AdminManagementAction,
  AdminManagementGroup,
  AdminManagementGroupId,
} from '../../core/admin-api.service';
import { AdminSessionService } from '../../core/admin-session.service';
import { adminErrorMessage } from '../../core/admin-http';
import { AdminIcon } from '../../shared/admin-icon';

type DashboardTab = 'operations' | 'business';

/** Layout remains stable when a group is awaiting an authoritative data source. */
const MANAGEMENT_GROUPS: ReadonlyArray<{ id: AdminManagementGroupId; title: string }> = [
  { id: 'AD_DB_01', title: 'Hiệu quả bán hàng và doanh thu' },
  { id: 'AD_DB_02', title: 'Điểm nghẽn đơn hàng và SLA' },
  { id: 'AD_DB_03', title: 'Sản phẩm bán chạy và than phiền' },
  { id: 'AD_DB_04', title: 'Đơn giao chưa được đánh giá' },
  { id: 'AD_DB_05', title: 'Mức hài lòng dịch vụ CSKH' },
  { id: 'AD_DB_06', title: 'Hiệu quả khuyến mãi và voucher' },
  { id: 'AD_DB_07', title: 'Đổi trả theo dòng sản phẩm' },
  { id: 'AD_DB_08', title: 'Khuyến mãi và mức độ hài lòng' },
  { id: 'AD_DB_09', title: 'Giữ chân khách hàng' },
];

const emptyVoice = (): AdminVoiceInsights => ({
  range: 'week',
  periodLabel: '7 ngày gần nhất',
  coverage: { deliveredOrders: 0, reviewedOrders: 0, silentOrders: 0, coveragePct: 0 },
  productReaction: { reviewCount: 0, avgRating: null, loved: [], complained: [] },
  serviceQuality: {
    tickets: 0,
    closedTickets: 0,
    csatCount: 0,
    csatAvg: null,
    ticketsWithoutCsat: 0,
    returns: 0,
    returnRatePct: 0,
    returnReasons: [],
  },
  orderFriction: { orderCount: 0, completedOrders: 0, cancelledOrders: 0, failedDelivery: 0, cancelReasons: [] },
});

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
    customers: 0,
    revenueTrend: [],
    categoryContributions: [],
    bestSellers: [],
  },
  recentLogs: [],
  periodDays: 7,
  voice: emptyVoice(),
});

@Component({
  selector: 'app-admin-dashboard-page',
  imports: [RouterLink, AdminIcon],
  templateUrl: './admin-dashboard.page.html',
})
export class AdminDashboardPage {
  private listRequest = new Subscription();
  private readonly api = inject(AdminApiService);
  private readonly session = inject(AdminSessionService);
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private recommendationRequest = new Subscription();

  readonly tab = signal<DashboardTab>('operations');
  readonly range = signal<AdminInsightRange>('week');
  readonly productId = signal<string | null>(null);
  readonly categoryId = signal<string | null>(null);
  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly data = signal<AdminDashboardSummary>(emptyDashboard());
  readonly generatedAt = signal('');
  readonly lastSyncedAt = signal('');
  readonly loadedPeriodLabel = signal('');
  readonly hasLoadedOnce = signal(false);
  readonly refreshCooldown = signal(false);
  readonly refreshMessage = signal('');
  readonly canRefresh = computed(() => !this.loading() && !this.refreshCooldown());
  readonly managementGroups = computed(() => MANAGEMENT_GROUPS.map((definition): AdminManagementGroup => {
    const group = this.data().management?.groups.find((candidate) => candidate.id === definition.id);
    if (group && group.availability !== 'insufficient_data' && [group.phenomenon, group.scope, group.magnitude, group.consequence].every((part) => typeof part === 'string' && part.trim().length > 0)) return group;
    return { ...definition, availability: 'insufficient_data', severity: 'watch', dataNote: group?.dataNote || 'Chưa đủ dữ liệu nguồn đã xác minh để phân tích nhóm này. Insight sẽ xuất hiện khi có đủ bằng chứng.' };
  }));
  readonly managementWarnings = computed(() => this.managementGroups().filter((group) => group.availability !== 'insufficient_data' && (group.severity === 'critical' || group.severity === 'high' || group.availability === 'oltp_fallback')));
  readonly viewerOnly = computed(() => this.session.session()?.roleCode === 'admin_viewer');

  readonly ops = computed(() => this.data().operations);
  readonly business = computed(() => this.data().business);
  readonly logs = computed(() => this.data().recentLogs || []);
  readonly voice = computed(() => this.data().voice || emptyVoice());
  readonly returnReasons = computed(() => this.voice().serviceQuality.returnReasons || []);
  readonly regions = computed(() => this.voice().regions || []);
  readonly recommendation = signal<string[]>([]);
  readonly recommendationSource = signal<string | null>(null);
  readonly recommendationLoading = signal(false);
  readonly recommendationError = signal<string | null>(null);

  /**
   * Độ rộng thanh so với lý do đông nhất trong kỳ. Không vẽ khi chưa có phiếu.
   */
  regionShare(count: number): number {
    const top = Math.max(...this.regions().map((region) => region.count), 0);
    if (!top) return 0;
    return Math.max(8, Math.round((count / top) * 100));
  }

  reasonShare(count: number): number {
    const top = Math.max(...this.returnReasons().map((reason) => reason.count), 0);
    if (!top) return 0;
    return Math.max(8, Math.round((count / top) * 100));
  }
  readonly comparisons = computed(() => this.business().comparisons || {});
  readonly periodLabel = computed(() => {
    if (this.range() === 'day') {
      return 'hôm nay';
    }
    if (this.range() === 'month') {
      return '30 ngày gần nhất';
    }
    return '7 ngày gần nhất';
  });
  readonly reviewSample = computed(
    () => this.data().meta?.samples?.reviews ?? this.voice().productReaction.reviewCount,
  );
  readonly csatSample = computed(() => this.data().meta?.samples?.csat ?? this.voice().serviceQuality.csatCount);
  readonly voiceReliable = computed(
    () => this.data().meta?.reliable?.reviews === true && this.data().meta?.reliable?.csat === true,
  );
  readonly reviewTrustCopy = computed(() => {
    const reviews = this.safeNumber(this.reviewSample());
    const csat = this.safeNumber(this.csatSample());
    const delivered = this.safeNumber(this.voice().coverage.deliveredOrders);
    return `${reviews} đánh giá · ${csat} CSAT trên ${delivered} đơn giao. Cần ≥30 đánh giá và ≥20 CSAT trước khi dùng VoC để hoạch định.`;
  });
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
  readonly categories = computed(() => this.business().categoryContributions || []);
  readonly bestSellers = computed(() =>
    (this.business().bestSellers || []).map((item, index) => ({
      ...item,
      rank: String(index + 1).padStart(2, '0'),
    })),
  );
  readonly chartBars = computed(() => {
    const points = this.business().revenueTrend || [];
    const maxRevenue = Math.max(...points.map((point) => this.safeNumber(point.revenue)), 1);
    const maxOrders = Math.max(...points.map((point) => this.safeNumber(point.orderCount)), 1);
    return points.map((point) => ({
      ...point,
      revenuePct: `${Math.round((this.safeNumber(point.revenue) / maxRevenue) * 100)}%`,
      orderPct: `${Math.round((this.safeNumber(point.orderCount) / maxOrders) * 100)}%`,
    }));
  });
  readonly chartColumns = computed(() => `repeat(${Math.max(this.chartBars().length, 1)}, minmax(0, 1fr))`);
  readonly chartMaxLabel = computed(() => this.money(Math.max(...this.chartBars().map((point) => point.revenue), 0)));
  readonly hasBusinessData = computed(() => this.safeNumber(this.business().orderCount) > 0 || this.chartBars().some((point) => point.revenue > 0));
  readonly peakInsight = computed(() => {
    const peak = this.business().insights?.['peakDay'];
    if (!peak || typeof peak !== 'object') {
      return 'Chưa đủ dữ liệu để nhận đỉnh doanh thu trong kỳ cố định.';
    }
    const row = peak as { date?: string; revenue?: number; changePct?: number | null };
    if (!row.date) {
      return 'Chưa đủ dữ liệu để nhận đỉnh doanh thu trong kỳ cố định.';
    }
    const change =
      row.changePct === null || row.changePct === undefined
        ? 'không so sánh được ngày liền trước'
        : `${row.changePct > 0 ? 'tăng' : 'giảm'} ${Math.abs(row.changePct)}% so với ngày liền trước`;
    return `Ngày ${row.date} đạt ${this.money(row.revenue)} — ${change}. Đây là tín hiệu nhịp mua, không phải mốc tùy chọn.`;
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
    return 'chưa xác định nguồn';
  });
  readonly recentActivity = computed(() => this.logs().slice(0, 5).map((log) => ({ log, copy: this.logCopy(log) })));
  readonly healthOrders = computed(() => this.health(this.ops().pendingOrders > 0 || this.ops().paymentErrors > 0));
  readonly healthProducts = computed(() => this.health(this.ops().lowStockProducts > 0));
  readonly healthReviews = computed(() =>
    this.health(this.business().pendingReviews > 0 || this.ops().urgentReviews > 0),
  );
  readonly healthReturns = computed(() =>
    this.health(this.ops().openReturns > 0 || this.ops().openSupportTickets > 0),
  );

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.listRequest.unsubscribe(); this.recommendationRequest.unsubscribe();
      if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
    });
    inject(AdminRefreshService).register(() => {
      this.refresh();
    }, inject(DestroyRef));
    this.reload();
  }

  /**
   * Switches the original Quản trị / Kinh doanh tabs.
   */
  setTab(tab: DashboardTab): void {
    this.tab.set(tab);
  }

  /**
   * Applies the fixed day / week / month window.
   */
  setRange(range: AdminInsightRange): void {
    if (range === this.range()) return;
    this.recommendationRequest.unsubscribe(); this.recommendationLoading.set(false);
    this.range.set(range);
    this.recommendation.set([]);
    this.reload();
  }

  /**
   * Khuyến nghị chỉ từ số liệu kỳ đang chọn. Thiếu Gemini thì hiện đúng bản tóm tắt.
   */
  loadRecommendation(): void {
    if (this.recommendationLoading()) return;
    this.recommendationLoading.set(true);
    this.recommendationError.set(null);
    this.recommendationRequest = this.api.recommendInsights({ range: this.range() }).subscribe({
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

  /**
   * Reloads `/api/v1/admin/dashboard` for the active fixed period.
   */
  reload(): void {
    this.listRequest.unsubscribe();
    this.loading.set(true);
    this.loadError.set(null);
    const params: Record<string, string> = { range: this.range() };
    if (this.productId()) {
      params['productId'] = this.productId() as string;
    }
    if (this.categoryId()) {
      params['categoryId'] = this.categoryId() as string;
    }
    this.listRequest = this.api.dashboard(params).subscribe({
      next: (summary) => {
        this.data.set({
          ...emptyDashboard(),
          ...summary,
          operations: { ...emptyDashboard().operations, ...summary.operations },
          business: { ...emptyDashboard().business, ...summary.business },
          voice: summary.voice || emptyVoice(),
          meta: summary.meta,
        });
        const timestamp = summary.meta?.generatedAt;
        const generated = timestamp ? new Date(timestamp) : null;
        this.generatedAt.set(generated && Number.isFinite(generated.getTime()) ?
          generated.toLocaleString('vi-VN', {
            timeZone: 'Asia/Ho_Chi_Minh',
            hour: '2-digit',
            minute: '2-digit',
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
          }) : '',
        );
        const synchronized = summary.management?.lastSyncedAt ? new Date(summary.management.lastSyncedAt) : null;
        this.lastSyncedAt.set(synchronized && Number.isFinite(synchronized.getTime()) ? synchronized.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : '');
        this.loadedPeriodLabel.set(this.periodLabel());
        this.hasLoadedOnce.set(true);
        this.loading.set(false);
        this.refreshMessage.set('Đã cập nhật báo cáo kỳ đang chọn.');
      },
      error: (error: unknown) => {
        this.loadError.set(adminErrorMessage(error, 'Không thể tải dữ liệu dashboard'));
        this.refreshMessage.set('Không thể đồng bộ. Bản đã xác minh gần nhất được giữ để đối chiếu.');
        this.loading.set(false);
      },
    });
  }

  /** Prevents repeated synchronization within ten seconds and concurrent refreshes. */
  refresh(): void {
    if (!this.canRefresh()) return;
    this.refreshCooldown.set(true); this.refreshMessage.set('Đang đồng bộ dữ liệu phân tích…');
    this.cooldownTimer = setTimeout(() => { this.refreshCooldown.set(false); this.cooldownTimer = null; }, 10_000);
    this.reload();
  }

  /** Shows target links only to users allowed to read that business module. */
  canOpenModule(module: string): boolean {
    return this.session.canAccessModule(module);
  }

  /** Limits navigation to known local modules; target guards enforce viewer restrictions. */
  canOpenManagementAction(action: AdminManagementAction): boolean {
    const routes: Record<AdminManagementAction['module'], string> = { orders: '/orders', returns: '/returns', products: '/products', reviews: '/reviews', promotions: '/promotions', pricing: '/pricing', accounts: '/accounts' };
    return this.canOpenModule(action.module) && !/[?#]/.test(action.route) && !action.route.includes('..') && !action.route.includes('//') && (action.route === routes[action.module] || action.route.startsWith(routes[action.module] + '/'));
  }

  /**
   * Product drill stays inside the current day/week/month window.
   */
  drillProduct(productId: string | undefined): void {
    if (!productId) {
      return;
    }
    this.productId.set(productId);
    this.categoryId.set(null);
    this.setTab('business');
    this.reload();
  }

  /**
   * Category drill stays inside the current day/week/month window.
   */
  drillCategory(categoryId: string | undefined): void {
    if (!categoryId) {
      return;
    }
    this.categoryId.set(categoryId);
    this.productId.set(null);
    this.setTab('business');
    this.reload();
  }

  /**
   * Clears one OLAP dimension chip.
   */
  clearFilter(key: 'product' | 'category'): void {
    if (key === 'product') {
      this.productId.set(null);
    } else {
      this.categoryId.set(null);
    }
    this.reload();
  }

  /**
   * Formats compact money the same way vanilla `fmtMoney` does.
   */
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

  /**
   * Formats a locale integer.
   */
  num(value: number | undefined): string {
    return this.safeNumber(value).toLocaleString('vi-VN');
  }

  /**
   * Formats a comparison trend label.
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
   * Trend CSS modifier.
   */
  trendClass(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) {
      return '';
    }
    if (Number(value) > 0) {
      return 'dashboard-trend--up';
    }
    if (Number(value) < 0) {
      return 'dashboard-trend--down';
    }
    return '';
  }

  /**
   * Health badge for a module.
   */
  health(warning: boolean, danger = false): { tone: string; label: string } {
    if (danger) {
      return { tone: 'danger', label: 'Cần xử lý gấp' };
    }
    if (warning) {
      return { tone: 'warning', label: 'Cần xử lý' };
    }
    return { tone: 'success', label: 'Ổn' };
  }

  /**
   * Bar width for a bestseller relative to the top SKU in the period.
   */
  bestSellerWidth(revenue: number | undefined): number {
    const peak = Math.max(...this.bestSellers().map((item) => this.safeNumber(item.revenue)), 1);
    return Math.round((this.safeNumber(revenue) / peak) * 100);
  }

  /**
   * Formats a recent-activity row like vanilla dashboard.js.
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
    const modules: Record<string, string> = {
      orders: 'đơn hàng',
      product: 'sản phẩm',
      products: 'sản phẩm',
      reviews: 'đánh giá',
      accounts: 'tài khoản',
      returns: 'yêu cầu đổi trả',
      return_exchange: 'yêu cầu đổi trả',
    };
    const labels: Record<string, string> = {
      orders: 'Đơn hàng',
      product: 'Sản phẩm',
      products: 'Sản phẩm',
      reviews: 'Đánh giá',
      accounts: 'Tài khoản',
      returns: 'Đổi trả & CSKH',
      return_exchange: 'Đổi trả & CSKH',
    };
    const action = verbs[log.action || ''] || log.action || 'Thao tác';
    const target = modules[log.module || ''] || log.module || '';
    let desc = `${action} ${target}`.trim();
    if (log.target_id) {
      desc += ` #${String(log.target_id).slice(0, 8)}`;
    }
    return {
      time: date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' }),
      actor: log.actor_name || log.actor_id || 'Hệ thống',
      desc,
      module: labels[log.module || ''] || 'Hệ thống',
    };
  }

  /**
   * Coerces RPC KPI values so "NaN" strings never reach the template.
   */
  private safeNumber(value: unknown): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
}
