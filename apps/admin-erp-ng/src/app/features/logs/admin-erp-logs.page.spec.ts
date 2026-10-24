import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Observable, of, throwError } from 'rxjs';
import { AdminAuditRow, AdminErpApiService } from '../../core/admin-erp-api.service';
import { AdminListPayload } from '../../core/admin-erp-http';
import { AdminErpLogsPage } from './admin-erp-logs.page';

const rows: AdminAuditRow[] = [
  {
    audit_id: 'a1',
    timestamp: '2026-10-24T03:00:00Z',
    actor_name: 'Quản trị',
    actor_role: 'super_admin',
    module: 'orders',
    action: 'update',
    action_label: 'Cập nhật',
    target_id: 'order-1',
    result: 'success',
    ip_address: '127.0.0.1',
  },
  {
    audit_id: 'a2',
    timestamp: '2026-10-24T03:05:00Z',
    actor_name: 'Sản phẩm',
    actor_role: 'admin_operator_sanpham',
    module: 'products',
    action: 'update_failed',
    action_label: 'Cập nhật thất bại',
    target_id: 'product-1',
    result: 'failure',
    ip_address: '10.0.0.2',
  },
];

type ListFn = (params?: Record<string, string>) => Observable<AdminListPayload<AdminAuditRow>>;

describe('AdminErpLogsPage', () => {
  async function boot(list: ListFn, calls: Array<Record<string, string> | undefined> = []) {
    TestBed.resetTestingModule();
    const api = {
      listAuditLogs: (params?: Record<string, string>) => {
        calls.push(params);
        return list(params);
      },
    };
    await TestBed.configureTestingModule({
      imports: [AdminErpLogsPage],
      providers: [provideRouter([]), { provide: AdminErpApiService, useValue: api }],
    }).compileComponents();
    const fixture = TestBed.createComponent(AdminErpLogsPage);
    fixture.detectChanges();
    return fixture;
  }

  const listWithCounts: ListFn = (params) => {
    if (params?.['limit'] === '1') {
      const scope = params?.['scope'] || 'all';
      const count = scope === 'admin' ? 100 : scope === 'system' ? 15 : scope === 'ai' ? 5 : 120;
      return of({ rows: [], count });
    }
    return of({ rows, count: 120 });
  };

  it('loads server rows and tab counts without inventing data', async () => {
    const fixture = await boot(listWithCounts);
    const page = fixture.componentInstance;

    expect(page.loading()).toBe(false);
    expect(page.rows().length).toBe(2);
    expect(page.total()).toBe(120);
    expect(page.allCount()).toBe(120);
    expect(page.adminCount()).toBe(100);
    expect(page.systemCount()).toBe(15);
    expect(page.aiCount()).toBe(5);
    expect(page.failureCount()).toBe(1);
    expect(page.rangeLabel()).toContain('1 - 10 / 120');
  });

  it('sends search and module filters to the server page', async () => {
    const calls: Array<Record<string, string> | undefined> = [];
    const fixture = await boot(listWithCounts, calls);
    const page = fixture.componentInstance;

    page.query.set('lock');
    page.module.set('orders');
    page.applyFilters();

    const listCall = calls.filter((params) => params?.['limit'] !== '1').at(-1);
    expect(listCall?.['q']).toBe('lock');
    expect(listCall?.['module']).toBe('orders');
    expect(listCall?.['offset']).toBe('0');
  });

  it('sends the selected scope when switching tabs', async () => {
    const calls: Array<Record<string, string> | undefined> = [];
    const fixture = await boot(listWithCounts, calls);
    const page = fixture.componentInstance;

    page.setTab('admin');

    const listCall = calls.filter((params) => params?.['limit'] !== '1').at(-1);
    expect(listCall?.['scope']).toBe('admin');
  });

  it('opens and closes the audit drawer', async () => {
    const fixture = await boot(listWithCounts);
    const page = fixture.componentInstance;

    page.openRow(rows[0]);
    expect(page.selected()?.audit_id).toBe('a1');

    page.closeDrawer();
    expect(page.selected()).toBeNull();
  });

  it('surfaces API errors instead of showing fabricated rows', async () => {
    const fixture = await boot((params) => {
      if (params?.['limit'] === '1') {
        return of({ rows: [], count: 0 });
      }
      return throwError(() => new Error('audit down'));
    });
    const page = fixture.componentInstance;

    expect(page.loadError()).toBe('audit down');
    expect(page.rows()).toEqual([]);
    expect(page.loading()).toBe(false);
  });
});
