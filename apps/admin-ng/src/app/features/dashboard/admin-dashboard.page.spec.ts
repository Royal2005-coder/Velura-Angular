import { createAdminPage } from '../../../testing/admin-testing';
import { AdminDashboardPage } from './admin-dashboard.page';

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
});
