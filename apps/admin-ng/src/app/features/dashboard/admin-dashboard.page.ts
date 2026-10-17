import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { AnalyticsModel, type AnalyticsDashboard } from '../../core/analytics-model.service';
import { AdminSessionService } from '../../core/admin-session.service';
import { AdminRefreshService } from '../../core/admin-refresh.service';
import { adminErrorMessage } from '../../core/admin-http';
import type { AdminInsightRange, AdminManagementAction, AdminManagementGroup } from '../../core/admin-api.service';
import { AdminIcon } from '../../shared/admin-icon';

const TITLES = ['Hiệu quả bán hàng và doanh thu','Điểm nghẽn đơn hàng và SLA','Sản phẩm bán chạy và than phiền',
  'Đơn đã giao chưa có đánh giá','Mức hài lòng CSKH','Khuyến mãi và voucher','Đổi trả theo danh mục',
  'Giảm giá và mức độ hài lòng','Giữ chân và giá trị khách hàng'];

/** Five evidence layers share one loaded snapshot; failures cannot replace it or its period. */
@Component({ selector: 'app-admin-dashboard-page', imports: [RouterLink, AdminIcon], templateUrl: './admin-dashboard.page.html' })
export class AdminDashboardPage {
  private readonly model = inject(AnalyticsModel);
  private readonly session = inject(AdminSessionService);
  private request = new Subscription();
  private narrativeRequest = new Subscription();
  private cooldownTimer: number | null = null;
  readonly data = signal<AnalyticsDashboard | null>(null);
  readonly tab = signal<'operations' | 'business'>('operations');
  readonly range = signal<AdminInsightRange>('week');
  readonly productId = signal<string | null>(null);
  readonly categoryId = signal<string | null>(null);
  readonly loading = signal(false);
  readonly syncing = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly refreshCooldown = signal(false);
  readonly refreshMessage = signal('');
  readonly recommendation = signal<string[]>([]);
  readonly recommendationLoading = signal(false);
  readonly recommendationError = signal<string | null>(null);
  readonly recommendationSource = signal('facts');
  readonly viewerOnly = computed(() => this.session.session()?.roleCode === 'admin_viewer');
  readonly canMutate = computed(() => this.session.session()?.roleCode === 'super_admin' && this.session.canAccessModule('dashboard'));
  readonly canRefresh = computed(() => this.canMutate() && !this.loading() && !this.syncing() && !this.refreshCooldown());
  readonly hasLoadedOnce = computed(() => this.data() !== null);
  readonly business = computed(() => this.data()?.business);
  readonly managementGroups = computed(() => TITLES.map((title, index): AdminManagementGroup => {
    const id = `AD_DB_${String(index+1).padStart(2,'0')}` as AdminManagementGroup['id'];
    const group = this.data()?.management.groups.find(candidate => candidate.id === id);
    if (group && group.availability !== 'insufficient_data' && [group.phenomenon,group.scope,group.magnitude,group.consequence].every(value => typeof value === 'string' && value.trim().length > 0)) return group;
    return { id, title, availability: 'insufficient_data', severity: 'watch', dataNote: group?.dataNote || 'Chưa có dữ liệu nguồn đã đối chiếu.' };
  }));
  readonly managementWarnings = computed(() => this.managementGroups().filter(group => group.availability !== 'insufficient_data' && group.severity !== 'ok'));
  readonly operations = computed(() => [
    { key: 'pendingOrders', label: 'Đơn chờ xử lý', route: '/orders', module: 'orders' },
    { key: 'paymentErrors', label: 'Lỗi thanh toán', route: '/orders', module: 'orders' },
    { key: 'openReturns', label: 'Đổi trả đang mở', route: '/returns', module: 'returns' },
    { key: 'openSupportTickets', label: 'Phiếu hỗ trợ đang mở', route: '/returns', module: 'returns' },
    { key: 'lowStockProducts', label: 'Sản phẩm dưới ngưỡng tồn', route: '/products', module: 'products' },
    { key: 'urgentReviews', label: 'Đánh giá 1–2 sao', route: '/reviews', module: 'reviews' },
  ].map(row => ({ ...row, value: this.data()?.operations[row.key] ?? null })));
  readonly chartBars = computed(() => {
    const points = this.business()?.revenueTrend || [];
    const peak = Math.max(...points.map(point => point.revenue ?? 0),1);
    return points.map(point => ({ ...point, revenuePct: point.revenue === null ? null : Math.round(point.revenue/peak*100) }));
  });
  readonly loadedPeriodLabel = computed(() => this.periodCopy(this.data()?.range));
  readonly generatedAt = computed(() => this.timestamp(this.data()?.meta.generatedAt));
  readonly lastSyncedAt = computed(() => this.timestamp(this.data()?.management.lastSyncedAt));
  readonly sourceLabel = computed(() => !this.data() ? 'Chưa xác định nguồn' : this.data()?.meta.validated ? 'OLAP analytics.star.v3' : 'OLTP: chỉ hàng đợi vận hành');
  readonly filterChips = computed(() => [
    ...(this.productId() ? [{ key: 'product' as const, label: 'Lọc sản phẩm' }] : []),
    ...(this.categoryId() ? [{ key: 'category' as const, label: 'Lọc danh mục' }] : []),
  ]);
  readonly evidenceRows = computed(() => {
    const result: Array<{ key: string; value: number | null }> = [];
    const visit = (value: unknown, path: string): void => {
      if (value === null || (typeof value === 'number' && Number.isFinite(value))) {
        result.push({ key: path, value });
      } else if (Array.isArray(value)) {
        value.forEach((row: unknown, index: number) => visit(row, `${path}[${index}]`));
      } else if (typeof value === 'object') {
        for (const [key, row] of Object.entries(value)) visit(row, `${path}.${key}`);
      }
    };
    for (const [key, value] of Object.entries(this.data()?.management.evidence || {})) visit(value, key);
    return result;
  });

  constructor() {
    const destroyRef = inject(DestroyRef);
    destroyRef.onDestroy(() => { this.request.unsubscribe(); this.narrativeRequest.unsubscribe(); clearTimeout(this.cooldownTimer ?? undefined); });
    inject(AdminRefreshService).register(() => { if (this.canMutate()) this.refresh(); else this.reload(); }, destroyRef);
    this.reload();
  }
  /** Switch the existing operational/business views without rereading data. */
  setTab(tab: 'operations' | 'business'): void { this.tab.set(tab); }
  /** Read another fixed period; do not mutate the warehouse. */
  setRange(range: AdminInsightRange): void {
    if (range === this.range()) return;
    this.range.set(range); this.clearRecommendation(); this.reload();
  }
  /** Read the selected persisted snapshot, retaining the last good snapshot on failure. */
  reload(): void {
    this.request.unsubscribe(); this.loading.set(true); this.loadError.set(null);
    this.request = this.model.dashboard(this.params()).subscribe({
      next: result => {
        this.data.set(result); this.loading.set(false);
        this.refreshMessage.set(result.meta.validated ? 'Đã đọc bản dữ liệu đã đối chiếu.' : 'KPI kinh doanh chưa khả dụng; hàng đợi vận hành vẫn đọc trực tiếp.');
      },
      error: (error: unknown) => { this.loading.set(false); this.loadError.set(adminErrorMessage(error,'Không thể đọc báo cáo.')); this.refreshMessage.set('Giữ nguyên bản đã xác minh gần nhất, không báo đồng bộ thành công.'); },
    });
  }
  /** Explicit mutation only; the server independently persists cooldown and checks permission. */
  refresh(): void {
    if (!this.canRefresh()) return;
    this.syncing.set(true); this.refreshCooldown.set(true); this.refreshMessage.set('Đang đồng bộ và đối chiếu nguồn…');
    this.cooldownTimer = window.setTimeout(() => { this.refreshCooldown.set(false); this.cooldownTimer = null; },10_000);
    this.request.unsubscribe();
    this.request = this.model.refresh().subscribe({
      next: result => {
        this.syncing.set(false);
        if (result.success !== true || result.status !== 'succeeded') { this.loadError.set('Đồng bộ không thành công; giữ bản gần nhất.'); this.refreshMessage.set('Đồng bộ thất bại; bản đã xác minh gần nhất được giữ nguyên.'); return; }
        this.clearRecommendation(); this.reload();
      },
      error: (error: unknown) => { this.syncing.set(false); this.loadError.set(adminErrorMessage(error,'Đồng bộ thất bại.')); this.refreshMessage.set('Đồng bộ thất bại; bản đã xác minh gần nhất được giữ nguyên.'); },
    });
  }
  /** AI absence/failure does not hide any KPI or rule card. */
  loadRecommendation(): void {
    if (!this.canMutate() || this.recommendationLoading() || this.loading() || this.loadError() || !this.data()?.meta.validated) return;
    this.recommendationLoading.set(true); this.recommendationError.set(null);
    this.narrativeRequest = this.model.recommend(this.params()).subscribe({
      next: result => { this.recommendationLoading.set(false); this.recommendationSource.set(result.source); this.recommendation.set(result.narrative.length ? result.narrative : result.lines); },
      error: (error: unknown) => { this.recommendationLoading.set(false); this.recommendationError.set(adminErrorMessage(error,'Diễn giải không khả dụng; KPI đã xác minh vẫn hiển thị.')); },
    });
  }
  /** Target module authorization remains canonical in the session and backend. */
  canOpenModule(module: string): boolean { return this.session.canAccessModule(module); }
  /** Accept only known local module routes; no external or path-traversal actions. */
  canOpenManagementAction(action: AdminManagementAction): boolean {
    const routes: Record<AdminManagementAction['module'], string> = { orders:'/orders',returns:'/returns',products:'/products',reviews:'/reviews',promotions:'/promotions',pricing:'/pricing',accounts:'/accounts' };
    return this.canOpenModule(action.module) && !/[?#]/.test(action.route) && !action.route.includes('..') && !action.route.includes('//') &&
      (action.route === routes[action.module] || action.route.startsWith(routes[action.module]+'/'));
  }
  /** Product drilldown retains the selected fixed period and permits read-only viewers. */
  drillProduct(id: string | undefined): void { if (!id) return; this.productId.set(id); this.categoryId.set(null); this.tab.set('business'); this.clearRecommendation(); this.reload(); }
  /** Category drilldown retains the selected fixed period. */
  drillCategory(id: string | undefined): void { if (!id) return; this.categoryId.set(id); this.productId.set(null); this.tab.set('business'); this.clearRecommendation(); this.reload(); }
  /** Clear one dimension without initiating synchronization. */
  clearFilter(key: 'product' | 'category'): void { if (key==='product') this.productId.set(null); else this.categoryId.set(null); this.clearRecommendation(); this.reload(); }
  /** Null observations are visually distinct from a measured zero. */
  num(value: number | null | undefined): string { return value === null || value === undefined || !Number.isFinite(value) ? 'Không khả dụng' : value.toLocaleString('vi-VN',{maximumFractionDigits:2}); }
  /** Preserve null instead of coercing it to free revenue. */
  money(value: number | null | undefined): string { return value === null || value === undefined || !Number.isFinite(value) ? 'Không khả dụng' : value.toLocaleString('vi-VN',{style:'currency',currency:'VND'}); }
  /** A zero comparison denominator is not a zero-percent trend. */
  trend(value: number | null | undefined): string { return value === null || value === undefined || !Number.isFinite(value) ? 'Chưa có mẫu số kỳ trước' : `${value>0?'↑':value<0?'↓':'→'} ${Math.abs(value)}% so với kỳ trước`; }
  /** Fixed windows use rolling day counts, not an invented calendar-month definition. */
  periodCopy(range: string | undefined): string { return range === 'day' ? 'hôm nay' : range === 'month' ? '30 ngày gần nhất' : range === 'week' ? '7 ngày gần nhất' : 'chưa có kỳ đã xác minh'; }
  private timestamp(value: string | null | undefined): string {
    if (!value || !Number.isFinite(Date.parse(value))) return '';
    return new Date(value).toLocaleString('vi-VN',{timeZone:'Asia/Ho_Chi_Minh'});
  }
  private params(): Record<string,string> {
    const params: Record<string,string> = { range:this.range() };
    const product = this.productId(), category = this.categoryId();
    if (product) params['productId']=product; if (category) params['categoryId']=category;
    return params;
  }
  private clearRecommendation(): void { this.narrativeRequest.unsubscribe(); this.recommendationLoading.set(false); this.recommendation.set([]); this.recommendationError.set(null); }
}
