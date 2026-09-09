import { Type } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { AdminApiService, AdminDashboardSummary } from '../app/core/admin-api.service';

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

const list = <T,>(rows: T[] = []) => of({ rows, count: rows.length });

/**
 * Admin Model stub. Every list method returns `{ rows, count }` like production JSON.
 */
export function stubAdminApi(): AdminApiService {
  const dashboard = () => of(emptyDashboard());
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
      me,
      signIn: () => of({ token: '' }),
      exchangePkce: () => of({ token: '' }),
      requestPasswordReset: () => of({}),
      listLowStock: () => list(),
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
 */
export async function createAdminPage<T>(page: Type<T>): Promise<T> {
  lastFixture?.destroy();
  lastFixture = undefined;
  sessionStorage.clear();
  localStorage.clear();
  TestBed.resetTestingModule();
  await TestBed.configureTestingModule({
    imports: [page],
    providers: [
      provideRouter([]),
      { provide: AdminApiService, useValue: stubAdminApi() },
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

export { emptyDashboard };
