import { createAdminPage } from '../../../testing/admin-testing';
import { AdminDashboardPage } from './admin-dashboard.page';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { AdminSessionService } from '../../core/admin-session.service';
import { AdminManagementGroup } from '../../core/admin-api.service';

describe('AdminDashboardPage', () => {
  it('creates the ViewModel with a stub AdminApiService', async () => {
    const page = await createAdminPage(AdminDashboardPage);
    expect(page).toBeTruthy();
  });

  it('derives operations tab and alert total from dashboard signals', async () => {
    const page = await createAdminPage(AdminDashboardPage);
    expect(page.loading()).toBe(false);
    expect(page.tab()).toBe('operations');
    expect(page.alertTotal()).toBe(0);
    page.setTab('business');
    expect(page.tab()).toBe('business');
  });

  it('builds chart bars without opening a custom date range', async () => {
    const page = await createAdminPage(AdminDashboardPage);
    page.data.set({
      ...page.data(),
      business: {
        ...page.data().business,
        revenueTrend: [
          { date: '2026-07-01', dateStr: '01/07', revenue: 50, orderCount: 1 },
          { date: '2026-07-02', dateStr: '02/07', revenue: 100, orderCount: 2 },
        ],
      },
    });
    expect(page.chartBars()[1].revenuePct).toBe('100%');
    page.drillProduct('p1');
    expect(page.productId()).toBe('p1');
    expect(page.range()).toBe('week');
    expect(page.tab()).toBe('business');
  });

  it('labels OLTP vs OLAP sources and withholds VoC planning from tiny samples', async () => {
    const page = await createAdminPage(AdminDashboardPage);
    expect(page.sourceLabel()).toBe('chưa xác định nguồn');
    expect(page.voiceReliable()).toBe(false);
    page.data.set({
      ...page.data(),
      meta: {
        source: 'oltp.rpc',
        samples: { reviews: 1, csat: 0, deliveredOrders: 1 },
        reliable: { reviews: false, csat: false },
      },
    });
    expect(page.sourceLabel()).toContain('OLTP');
    expect(page.voiceReliable()).toBe(false);
    page.data.set({
      ...page.data(),
      meta: {
        source: 'analytics.star',
        samples: { reviews: 40, csat: 20, deliveredOrders: 80 },
        reliable: { reviews: true, csat: true },
      },
    });
    expect(page.sourceLabel()).toContain('OLAP');
    expect(page.voiceReliable()).toBe(true);
  });

  it('keeps all nine groups visible without inventing a measured zero or narrative', async () => {
    const page = await createAdminPage(AdminDashboardPage);
    expect(page.managementGroups()).toHaveLength(9);
    expect(page.managementGroups().every((group) => group.availability === 'insufficient_data' && !group.phenomenon && !group.magnitude)).toBe(true);
    expect(page.managementWarnings()).toEqual([]);
  });

  it('requires all four evidence components before displaying a ready insight', async () => {
    const page = await createAdminPage(AdminDashboardPage);
    const group: AdminManagementGroup = { id: 'AD_DB_02', title: 'SLA', availability: 'ready', severity: 'critical', phenomenon: 'Quá hạn', scope: 'Hàng đợi', magnitude: 'Ngưỡng đã đối chiếu', consequence: 'Kiểm tra đơn' };
    page.data.set({ ...page.data(), management: { groups: [group] } });
    expect(page.managementGroups()[1].availability).toBe('ready');
    expect(page.managementWarnings()).toHaveLength(1);
    page.data.set({ ...page.data(), management: { groups: [{ ...group, consequence: undefined }] } });
    expect(page.managementGroups()[1].availability).toBe('insufficient_data');
  });

  it('throttles manual and shell refresh for ten seconds', async () => {
    const dashboard = vi.fn(() => of({ operations: {}, business: {} }));
    const page = await createAdminPage(AdminDashboardPage, { dashboard });
    vi.useFakeTimers();
    try {
      page.refresh(); page.refresh();
      expect(dashboard).toHaveBeenCalledTimes(2);
      expect(page.canRefresh()).toBe(false);
      vi.advanceTimersByTime(10000); page.refresh();
      expect(dashboard).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });

  it('keeps verified figures and their actual period when a new-period request fails', async () => {
    const dashboard = vi.fn().mockReturnValueOnce(of({ business: { revenue: 123 }, operations: {}, meta: { generatedAt: '2026-10-03T10:00:00Z' } })).mockReturnValueOnce(throwError(() => new Error('Offline')));
    const page = await createAdminPage(AdminDashboardPage, { dashboard });
    const verifiedTime = page.generatedAt();
    page.setRange('month');
    expect(page.data().business.revenue).toBe(123);
    expect(page.loadedPeriodLabel()).toBe('7 ngày gần nhất');
    expect(page.generatedAt()).toBe(verifiedTime);
    expect(page.loadError()).toBeTruthy();
  });

  it('does not invent report or warehouse timestamps when the API supplies none', async () => {
    const page = await createAdminPage(AdminDashboardPage);
    expect(page.generatedAt()).toBe('');
    expect(page.lastSyncedAt()).toBe('');
  });

  it('gates local drill actions by target read permission and viewer remains read only', async () => {
    const page = await createAdminPage(AdminDashboardPage);
    const session = TestBed.inject(AdminSessionService);
    session.applyAuthContext({ role: 'admin_viewer', isAdmin: true, allowedModules: ['orders'] });
    expect(page.viewerOnly()).toBe(true);
    expect(page.canOpenManagementAction({ label: 'Xem', route: '/orders', module: 'orders' })).toBe(true);
    expect(page.canOpenManagementAction({ label: 'Xem', route: '/returns', module: 'returns' })).toBe(false);
    expect(page.canOpenManagementAction({ label: 'Xem', route: 'https://other.test', module: 'orders' })).toBe(false);
    expect(page.canOpenManagementAction({ label: 'Xem', route: '/orders/../accounts', module: 'orders' })).toBe(false);
    expect(session.canMutate('orders')).toBe(false);
  });
});
