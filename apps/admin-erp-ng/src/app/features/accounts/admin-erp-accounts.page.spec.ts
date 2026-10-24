import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Observable, of, throwError } from 'rxjs';
import {
  AdminAccountRow,
  AdminErpApiService,
  AdminRoleRequestRow,
} from '../../core/admin-erp-api.service';
import { AdminListPayload } from '../../core/admin-erp-http';
import { AdminErpSessionService } from '../../core/admin-erp-session.service';
import { AdminErpAccountsPage } from './admin-erp-accounts.page';

const accounts: AdminAccountRow[] = [
  {
    user_id: 'u1',
    full_name: 'Nguyễn An',
    email: 'an@velura.test',
    role: 'member',
    is_active: true,
    is_verified: true,
    version: 2,
    created_at: '2026-10-01T03:00:00Z',
  },
  {
    user_id: 'u2',
    full_name: 'Trần Bình',
    email: 'binh@velura.test',
    role: 'admin',
    admin_role: 'admin_operator_sanpham',
    is_active: false,
    is_verified: true,
    lock_type: 'temporary',
    lock_reason: 'Vi phạm quy trình nội bộ nhiều lần',
    version: 4,
  },
];

const requests: AdminRoleRequestRow[] = [
  { request_id: 'req-1', target_user_id: 'u1', requested_role: 'admin_operator_donhang', status: 'pending', version: 1 },
];

type ListAccountsFn = (params?: Record<string, string>) => Observable<AdminListPayload<AdminAccountRow>>;

describe('AdminErpAccountsPage', () => {
  async function boot(listAccounts: ListAccountsFn, calls: Array<Record<string, string> | undefined> = []) {
    TestBed.resetTestingModule();
    const api = {
      listAccounts: (params?: Record<string, string>) => {
        calls.push(params);
        return listAccounts(params);
      },
      listRoleRequests: (params?: Record<string, string>) =>
        of({ rows: params?.['limit'] === '1' ? [] : requests, count: params?.['limit'] === '1' ? 1 : requests.length }),
      listAccountAuditLogs: () => of({ rows: [], count: 0 }),
    };
    await TestBed.configureTestingModule({
      imports: [AdminErpAccountsPage],
      providers: [provideRouter([]), { provide: AdminErpApiService, useValue: api }],
    }).compileComponents();
    const session = TestBed.inject(AdminErpSessionService);
    session.applyAuthContext({
      role: 'super_admin',
      roleName: 'Super admin',
      isAdmin: true,
      allowedPages: ['accounts'],
      allowedModules: ['*'],
      capabilities: { accounts: ['read', 'update', 'create'] },
      user: { id: 'root', email: 'root@velura.test' },
      profile: { user_id: 'root', email: 'root@velura.test', full_name: 'Root', is_active: true },
    });
    const fixture = TestBed.createComponent(AdminErpAccountsPage);
    fixture.detectChanges();
    return fixture;
  }

  const listWithCounts: ListAccountsFn = (params) => {
    if (params?.['limit'] === '1') {
      const count =
        params?.['role'] === 'member'
          ? 7
          : params?.['role'] === 'admin'
            ? 3
            : params?.['lockState'] === 'locked'
              ? 1
              : params?.['lockState'] === 'unverified'
                ? 2
                : 10;
      return of({ rows: [], count });
    }
    return of({ rows: accounts, count: accounts.length });
  };

  it('loads accounts and count chips from the API', async () => {
    const fixture = await boot(listWithCounts);
    const page = fixture.componentInstance;

    expect(page.rows().length).toBe(2);
    expect(page.total()).toBe(2);
    expect(page.allCount()).toBe(10);
    expect(page.memberCount()).toBe(7);
    expect(page.adminCount()).toBe(3);
    expect(page.lockedCount()).toBe(1);
    expect(page.unverifiedCount()).toBe(2);
  });

  it('sends search, role and status filters to the server list', async () => {
    const calls: Array<Record<string, string> | undefined> = [];
    const fixture = await boot(listWithCounts, calls);
    const page = fixture.componentInstance;

    page.query.set('an');
    page.roleFilter.set('member');
    page.statusFilter.set('active');
    page.applyFilters();

    const listCall = calls.filter((params) => params?.['limit'] !== '1').at(-1);
    expect(listCall?.['q']).toBe('an');
    expect(listCall?.['role']).toBe('member');
    expect(listCall?.['isActive']).toBe('true');
  });

  it('opens the account detail drawer and capability-gated action modal', async () => {
    const fixture = await boot(listWithCounts);
    const page = fixture.componentInstance;

    page.openDetail(accounts[1]);
    expect(page.selected()?.user_id).toBe('u2');
    expect(page.canMutate()).toBe(true);

    page.openAction('lock');
    expect(page.actionType()).toBe('lock');

    page.closeOverlays();
    expect(page.selected()).toBeNull();
    expect(page.actionType()).toBeNull();
  });

  it('opens a role request for approve/reject flow', async () => {
    const fixture = await boot(listWithCounts);
    const page = fixture.componentInstance;

    page.openRequest(requests[0]);

    expect(page.selectedRequest()?.request_id).toBe('req-1');
  });

  it('surfaces API errors without inventing rows', async () => {
    const fixture = await boot((params) => {
      if (params?.['limit'] === '1') {
        return of({ rows: [], count: 0 });
      }
      return throwError(() => new Error('accounts down'));
    });
    const page = fixture.componentInstance;

    expect(page.loadError()).toBe('accounts down');
    expect(page.rows()).toEqual([]);
    expect(page.loading()).toBe(false);
  });
});
