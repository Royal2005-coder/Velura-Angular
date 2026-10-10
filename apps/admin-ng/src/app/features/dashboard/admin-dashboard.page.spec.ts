import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, Subject, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminDashboardPage } from './admin-dashboard.page';
import { AnalyticsModel, type AnalyticsDashboard } from '../../core/analytics-model.service';
import { AdminSessionService } from '../../core/admin-session.service';
import { AdminRefreshService } from '../../core/admin-refresh.service';
import type { AdminManagementGroup } from '../../core/admin-api.service';

function snapshot(): AnalyticsDashboard {
  return {
    range: 'week', from: '2026-09-27T17:00:00Z', toExclusive: '2026-10-04T17:00:00Z', previousFrom: '2026-09-20T17:00:00Z', previousToExclusive: '2026-09-27T17:00:00Z',
    operations: { pendingOrders: 2, paymentErrors: null },
    business: { revenue: 123, orderCount: 2, averageOrderValue: 61.5, completionRate: null, customers: 2, promotionRevenue: null, promotionRevenueShare: null, pendingReviews: null, comparisons: { revenuePct: null }, revenueTrend: [], bestSellers: [], categoryContributions: [] },
    management: { groups: [], lastSyncedAt: '2026-10-03T10:00:00Z' },
    meta: { source: 'analytics.star', updated_at: '2026-10-03T10:00:00Z', generatedAt: '2026-10-03T10:00:00Z', freshness: 'stale', validated: true, reconciled: true, pendingEvents: 0, operationsSource: 'oltp.live-queues', openDefinitions: [] },
  };
}
function modelStub() {
  return {
    dashboard: vi.fn((_params: Record<string, string>) => of(snapshot())),
    refresh: vi.fn(() => of({ status: 'succeeded' as const, success: true as const, snapshotAt: '2026-10-04T00:00:00Z' })),
    recommend: vi.fn((_params: Record<string, string>) => of({ source: 'facts', availability: 'ready', lines: ['Observed evidence'], narrative: [] as string[] })),
  };
}
let fixture: ComponentFixture<AdminDashboardPage> | undefined;
let shellRefresh = () => {};
async function createPage(model: Pick<AnalyticsModel, 'dashboard' | 'refresh' | 'recommend'>, role = 'super_admin') {
  sessionStorage.clear(); localStorage.clear();
  TestBed.resetTestingModule();
  await TestBed.configureTestingModule({
    imports: [AdminDashboardPage],
    providers: [provideRouter([]), { provide: AnalyticsModel, useValue: model },
      { provide: AdminRefreshService, useValue: { register: (callback: () => void) => { shellRefresh = callback; } } }],
  }).compileComponents();
  TestBed.inject(AdminSessionService).applyAuthContext({ role, isAdmin: true, allowedModules: role === 'super_admin' ? ['*'] : ['dashboard', 'orders'] });
  fixture = TestBed.createComponent(AdminDashboardPage);
  fixture.detectChanges();
  return fixture.componentInstance;
}
afterEach(() => { fixture?.destroy(); fixture = undefined; vi.useRealTimers(); });

describe('AdminDashboardPage evidence and refresh behavior', () => {
  it('renders unavailable measurements distinctly from real zeros', async () => {
    const model = modelStub();
    const data = snapshot(); data.business.revenue = null; data.operations['pendingOrders'] = 0;
    model.dashboard.mockReturnValue(of(data));
    const page = await createPage(model);
    expect(page.num(null)).toBe('Không khả dụng');
    expect(page.money(null)).toBe('Không khả dụng');
    expect(page.num(0)).toBe('0');
    expect(page.trend(null)).toBe('Chưa có mẫu số kỳ trước');
    expect(page.operations().find(row => row.key === 'paymentErrors')?.value).toBeNull();
    page.setTab('business'); fixture?.detectChanges();
    expect(fixture?.nativeElement.textContent).toContain('Không khả dụng');
    expect(page.business()?.revenue).toBeNull();
  });

  it('does not turn null chart observations into a zero bar', async () => {
    const data = snapshot();
    data.business.revenueTrend = [
      { date: '2026-10-01', dateStr: '01/10', revenue: null, orderCount: null },
      { date: '2026-10-02', dateStr: '02/10', revenue: 50, orderCount: 1 },
      { date: '2026-10-03', dateStr: '03/10', revenue: 100, orderCount: 2 },
    ];
    const model = modelStub(); model.dashboard.mockReturnValue(of(data));
    const page = await createPage(model);
    expect(page.chartBars().map(row => row.revenuePct)).toEqual([null, 50, 100]);
  });

  it('keeps the verified figures, timestamps and actual loaded period when another period fails', async () => {
    const model = modelStub(); model.dashboard.mockReturnValueOnce(of(snapshot())).mockReturnValueOnce(throwError(() => new Error('Offline')));
    const page = await createPage(model);
    const loaded = page.data(); const updated = page.generatedAt();
    page.setRange('month');
    expect(page.data()).toBe(loaded);
    expect(page.loadedPeriodLabel()).toBe('7 ngày gần nhất');
    expect(page.generatedAt()).toBe(updated);
    expect(page.loadError()).toBeTruthy();
    expect(model.dashboard).toHaveBeenLastCalledWith({ range: 'month' });
    expect(model.refresh).not.toHaveBeenCalled();
  });

  it('failed refresh preserves the prior snapshot and reports failure rather than success', async () => {
    vi.useFakeTimers();
    const model = modelStub(); model.refresh.mockReturnValue(throwError(() => new Error('Reconciliation failed')));
    const page = await createPage(model);
    const loaded = page.data(); const updated = page.generatedAt();
    page.refresh();
    expect(page.data()).toBe(loaded);
    expect(page.generatedAt()).toBe(updated);
    expect(page.syncing()).toBe(false);
    expect(page.loadError()).toBeTruthy();
    expect(page.refreshMessage()).toContain('thất bại');
    expect(model.dashboard).toHaveBeenCalledTimes(1);
  });

  it('blocks repeat manual and shell synchronization for ten seconds', async () => {
    vi.useFakeTimers();
    const model = modelStub(); const page = await createPage(model);
    page.refresh(); page.refresh(); shellRefresh();
    expect(model.refresh).toHaveBeenCalledTimes(1);
    expect(page.canRefresh()).toBe(false);
    vi.advanceTimersByTime(9_999); page.refresh();
    expect(model.refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1); shellRefresh();
    expect(model.refresh).toHaveBeenCalledTimes(2);
  });

  it('viewers can reload and drill down but never call synchronization or AI mutations', async () => {
    const model = modelStub(); const page = await createPage(model, 'admin_viewer');
    page.refresh(); page.loadRecommendation(); shellRefresh(); page.drillProduct('product-id');
    expect(model.refresh).not.toHaveBeenCalled(); expect(model.recommend).not.toHaveBeenCalled();
    expect(model.dashboard).toHaveBeenLastCalledWith({ range: 'week', productId: 'product-id' });
    expect(page.viewerOnly()).toBe(true);
    expect(page.canOpenManagementAction({ label: 'Xem', route: '/orders', module: 'orders' })).toBe(true);
    expect(page.canOpenManagementAction({ label: 'Xem', route: '/returns', module: 'returns' })).toBe(false);
    for (const route of ['https://other.test', '/orders/../accounts', '/orders//other', '/orders?override=true']) {
      expect(page.canOpenManagementAction({ label: 'Xem', route, module: 'orders' })).toBe(false);
    }
  });

  it('requires complete evidence before presenting a ready rule and shows missing domains as unavailable', async () => {
    const group: AdminManagementGroup = { id: 'AD_DB_02', title: 'SLA', availability: 'ready', severity: 'critical', phenomenon: 'Observed queue', scope: 'Measured cohort', magnitude: 'Verified threshold', consequence: 'Review orders' };
    const data = snapshot(); data.management.groups = [group];
    const model = modelStub(); model.dashboard.mockReturnValue(of(data));
    const page = await createPage(model);
    expect(page.managementGroups().find(item => item.id === 'AD_DB_02')?.availability).toBe('ready');
    expect(page.managementGroups().find(item => item.id === 'AD_DB_09')?.availability).toBe('insufficient_data');
    page.data.set({ ...data, management: { groups: [{ ...group, consequence: undefined }] } });
    expect(page.managementWarnings()).toEqual([]);
    expect(page.managementGroups().find(item => item.id === 'AD_DB_02')?.availability).toBe('insufficient_data');
  });

  it('does not invent snapshot timestamps or send unvalidated metrics for AI narration', async () => {
    const data = snapshot(); data.meta = { ...data.meta, validated: false, reconciled: false, source: 'unavailable', freshness: 'unavailable', updated_at: null, generatedAt: null };
    data.management = { groups: [] }; data.business.revenue = null;
    const model = modelStub(); model.dashboard.mockReturnValue(of(data));
    const page = await createPage(model); page.loadRecommendation();
    expect(page.generatedAt()).toBe(''); expect(page.lastSyncedAt()).toBe('');
    expect(model.recommend).not.toHaveBeenCalled();
    expect(page.sourceLabel()).toContain('chỉ hàng đợi vận hành');
  });

  it('AI failure leaves verified KPI and rule evidence visible', async () => {
    const model = modelStub(); model.recommend.mockReturnValue(throwError(() => new Error('Inference unavailable')));
    const page = await createPage(model); const loaded = page.data(); page.loadRecommendation();
    expect(page.data()).toBe(loaded); expect(page.business()?.revenue).toBe(123);
    expect(page.recommendationError()).toBeTruthy(); expect(page.recommendationLoading()).toBe(false);
  });

  it('cancels an obsolete period read so late results cannot replace the current snapshot', async () => {
    const pending = new Subject<AnalyticsDashboard>();
    const model = modelStub(); model.dashboard.mockReturnValueOnce(pending).mockReturnValueOnce(of({ ...snapshot(), range: 'month' }));
    const page = await createPage(model); page.setRange('month'); pending.next(snapshot());
    expect(page.data()?.range).toBe('month'); expect(page.loadedPeriodLabel()).toBe('30 ngày gần nhất');
  });
});
