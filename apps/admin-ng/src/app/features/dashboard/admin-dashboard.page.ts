import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AdminApiService, AdminAuditRow, AdminDashboardSummary } from '../../core/admin-api.service';
import { adminErrorMessage } from '../../core/admin-http';
import { AdminIcon } from '../../shared/admin-icon';

type DashboardTab = 'operations' | 'business';
type DashboardRange = 'day' | 'week' | 'month' | 'custom';

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
  },
  recentLogs: [],
  periodDays: 7,
});

@Component({
  selector: 'app-admin-dashboard-page',
  imports: [RouterLink, AdminIcon],
  templateUrl: './admin-dashboard.page.html',
})
export class AdminDashboardPage {
  private readonly api = inject(AdminApiService);

  readonly tab = signal<DashboardTab>('operations');
  readonly range = signal<DashboardRange>('week');
  readonly customOpen = signal(false);
  readonly fromDate = signal(this.isoDaysAgo(6));
  readonly toDate = signal(this.isoDaysAgo(0));
  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly data = signal<AdminDashboardSummary>(emptyDashboard());
  readonly generatedAt = signal('');

  readonly ops = computed(() => this.data().operations);
  readonly business = computed(() => this.data().business);
  readonly logs = computed(() => this.data().recentLogs || []);
  readonly alertTotal = computed(() => {
    const ops = this.ops();
    return this.safeNumber(ops.openReturns) + this.safeNumber(ops.paymentErrors) + this.safeNumber(ops.lowStockProducts) + this.safeNumber(ops.openSupportTickets);
  });
  readonly categories = computed(() => this.business().categoryContributions || []);
  readonly bestSellers = computed(() =>
    (this.business().bestSellers || []).map((item, index) => ({
      ...item,
      rank: String(index + 1).padStart(2, '0'),
    })),
  );
  readonly recentActivity = computed(() => this.logs().slice(0, 5).map((log) => ({ log, copy: this.logCopy(log) })));
  readonly healthOrders = computed(() => this.health(this.ops().pendingOrders > 0 || this.ops().paymentErrors > 0));
  readonly healthProducts = computed(() => this.health(false, this.ops().lowStockProducts > 0));
  readonly healthReviews = computed(() => this.health(this.business().pendingReviews > 0));
  readonly healthReturns = computed(() => this.health(this.ops().openReturns > 0 || this.ops().openSupportTickets > 0));

  constructor() {
    this.reload();
  }

  /**
   * Switches the original Quản trị / Kinh doanh tabs.
   */
  setTab(tab: DashboardTab): void {
    this.tab.set(tab);
  }

  /**
   * Applies the original day/week/month range buttons.
   */
  setRange(range: DashboardRange): void {
    this.range.set(range);
    this.customOpen.set(range === 'custom');
    if (range !== 'custom') {
      this.reload();
    }
  }

  /**
   * Reloads `/api/admin/dashboard` with the active period.
   */
  reload(): void {
    this.loading.set(true);
    this.loadError.set(null);
    const params: Record<string, string> =
      this.range() === 'custom'
        ? { from: this.fromDate(), to: this.toDate() }
        : { range: this.range() };
    this.api.dashboard(params).subscribe({
      next: (summary) => {
        this.data.set({ ...emptyDashboard(), ...summary, operations: { ...emptyDashboard().operations, ...summary.operations }, business: { ...emptyDashboard().business, ...summary.business } });
        const generated = summary.meta?.generatedAt ? new Date(summary.meta.generatedAt) : new Date();
        this.generatedAt.set(
          generated.toLocaleString('vi-VN', {
            timeZone: 'Asia/Ho_Chi_Minh',
            hour: '2-digit',
            minute: '2-digit',
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
          }),
        );
        this.loading.set(false);
      },
      error: (error: unknown) => {
        this.loadError.set(adminErrorMessage(error, 'Không thể tải dữ liệu dashboard'));
        this.loading.set(false);
      },
    });
  }

  /**
   * Applies the original custom date form.
   */
  applyCustom(event: Event): void {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    const from = (form.elements.namedItem('from') as HTMLInputElement | null)?.value || this.fromDate();
    const to = (form.elements.namedItem('to') as HTMLInputElement | null)?.value || this.toDate();
    this.fromDate.set(from);
    this.toDate.set(to);
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
      return { tone: 'danger', label: 'Rủi ro' };
    }
    if (warning) {
      return { tone: 'warning', label: 'Cần chú ý' };
    }
    return { tone: 'success', label: 'Tốt' };
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

  private isoDaysAgo(days: number): string {
    const now = new Date();
    const vietnam = new Date(now.getTime() + 7 * 60 * 60 * 1000 - days * 24 * 60 * 60 * 1000);
    return vietnam.toISOString().slice(0, 10);
  }

  /**
   * Coerces RPC KPI values so "NaN" strings never reach the template.
   */
  private safeNumber(value: unknown): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
}
