import { Type } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { AdminApiService, AdminDashboardSummary, AdminInsightsPayload } from '../app/core/admin-api.service';
import { emptyInsightBoard } from '../app/core/admin-insight-state';

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
});

const emptyInsights = (): AdminInsightsPayload => ({
  scope: 'hq',
  range: 'week',
  voice: {
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
    },
    orderFriction: { orderCount: 0, completedOrders: 0, cancelledOrders: 0, failedDelivery: 0, cancelReasons: [] },
  },
  board: emptyInsightBoard('hq'),
});

const list = <T,>(rows: T[] = []) => of({ rows, count: rows.length });

/**
 * Admin Model stub. Every list method returns `{ rows, count }` like production JSON.
 */
export function stubAdminApi(overrides: Record<string, unknown> = {}): AdminApiService {
  const dashboard = () => of(emptyDashboard());
  const insights = () => of(emptyInsights());
  const me = () =>
    of({
      role: 'member',
      isAdmin: false,
      allowedPages: ['welcome'],
      user: { id: 'u1', email: 'admin@velura.test' },
      profile: { full_name: 'Admin', email: 'admin@velura.test', role: 'member' },
    });
  return new Proxy(
    {
      dashboard,
      insights,
      me,
      signIn: () => of({ token: '' }),
      signOut: () => of({ success: true }),
      exchangePkce: () => of({ token: '' }),
      requestPasswordReset: () => of({}),
      changePassword: () => of({ success: true }),
      listLowStock: () => list(),
      ...overrides,
    } as unknown as AdminApiService,
    {
      get(target, prop) {
        if (typeof prop === 'symbol') {
          return Reflect.get(target, prop);
        }
        if (prop in target) {
          return Reflect.get(target, prop);
        }
        return () => list();
      },
    },
  );
}

let lastFixture: ComponentFixture<unknown> | undefined;

/**
 * Boots an admin page ViewModel with a stub AdminApiService (no HttpClient).
 * `apiOverrides` thay từng hàm của API giả cho ca test cần dữ liệu riêng.
 */
export async function createAdminPage<T>(page: Type<T>, apiOverrides: Record<string, unknown> = {}): Promise<T> {
  lastFixture?.destroy();
  lastFixture = undefined;
  sessionStorage.clear();
  localStorage.clear();
  TestBed.resetTestingModule();
  await TestBed.configureTestingModule({
    imports: [page],
    providers: [
      provideRouter([]),
      { provide: AdminApiService, useValue: stubAdminApi(apiOverrides) },
      {
        provide: ActivatedRoute,
        useValue: {
          snapshot: { paramMap: convertToParamMap({}), queryParamMap: convertToParamMap({}), data: { title: 'Admin', subtitle: 'test' } },
          paramMap: of(convertToParamMap({})),
          queryParamMap: of(convertToParamMap({})),
          data: of({ title: 'Admin', subtitle: 'test' }),
        },
      },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(page);
  lastFixture = fixture as ComponentFixture<unknown>;
  fixture.detectChanges();
  return fixture.componentInstance;
}

/** Fixture của trang vừa dựng bằng `createAdminPage`, để đọc DOM đã render. */
export function lastAdminFixture(): ComponentFixture<unknown> {
  if (!lastFixture) throw new Error('createAdminPage chưa được gọi');
  return lastFixture;
}

export { emptyDashboard };
