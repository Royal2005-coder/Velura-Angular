import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import {
  AdminErpApiService,
  AdminMemberDetail,
  AdminMemberOverview,
  AdminMemberRow,
} from '../../core/admin-erp-api.service';
import { AdminErpSessionService, type AdminAuthMe } from '../../core/admin-erp-session.service';
import { AdminErpMembersPage } from './admin-erp-members.page';

const ROWS: AdminMemberRow[] = [
  {
    user_id: 'u-1',
    full_name: 'Nguyễn Văn A',
    email: 'a@velura.test',
    is_active: true,
    wallet_exists: true,
    balance_milli_points: 90_900_000,
    debt_milli_points: 0,
    accrual_locked: false,
    warning_flags: 0,
    referral_code: 'VLRAAAA1111',
    ledger_entries: 6,
    last_ledger_at: '2026-10-25T12:16:26Z',
    vouchers_available: 1,
  },
  {
    user_id: 'u-2',
    full_name: 'Lê Văn C',
    phone: '0900000003',
    is_active: true,
    wallet_exists: true,
    balance_milli_points: 100_000,
    debt_milli_points: 300_000,
    accrual_locked: true,
    warning_flags: 2,
    ledger_entries: 2,
  },
];

const OVERVIEW: AdminMemberOverview = {
  members: 129,
  with_wallet: 7,
  total_points_milli: 92_430_000,
  negative_accounts: 1,
  locked_accounts: 1,
  referrals_pending: 1,
  referrals_successful: 0,
  vouchers_available: 1,
  ledger_entries: 6,
  zero_entries: 2,
};

const DETAIL: AdminMemberDetail = {
  user: { user_id: 'u-2', full_name: 'Lê Văn C', phone: '0900000003', is_active: true, created_at: '2026-09-01T00:00:00Z' },
  account: {
    balance_milli_points: 100_000,
    debt_milli_points: 300_000,
    points_balance: -200,
    warning_flags: 2,
    accrual_locked: true,
    referral_code: 'VLRCCCC2222',
    updated_at: '2026-10-20T00:00:00Z',
  },
  totals: {
    earned_milli: 100_000,
    reversed_milli: 300_000,
    ledger_entries: 2,
    zero_entries: 1,
    delivered_orders: 3,
    refunded_returns: 1,
  },
  trail: [
    {
      ledger_id: 'l-2',
      kind: 'clawback',
      amount_milli_points: -300_000,
      balance_after_milli_points: 100_000,
      note: 'Thu hồi Point theo hàng trả',
      created_at: '2026-10-20T00:00:00Z',
      order_id: 'o-1',
      order_code: 'VLR0001',
      order_status: 'delivered',
      return_id: 'r-1',
      return_status: 'REFUNDED',
    },
    {
      ledger_id: 'l-1',
      kind: 'earn',
      amount_milli_points: 0,
      balance_after_milli_points: 100_000,
      note: 'Thưởng 5% khi giao thành công',
      created_at: '2026-10-18T00:00:00Z',
      order_id: 'o-1',
      order_code: 'VLR0001',
      order_status: 'delivered',
    },
  ],
  referrals: [
    {
      referral_id: 'ref-1',
      role: 'referrer',
      counterpart_name: 'Trần Thị B',
      status: 'pending',
      created_at: '2026-10-16T00:00:00Z',
    },
  ],
  vouchers: [
    {
      member_voucher_id: 'mv-1',
      voucher_id: 'v-1',
      code: 'VLRGIFT0001',
      benefit: 'referred_signup',
      status: 'available',
      issued_at: '2026-10-16T00:00:00Z',
      expires_at: '2026-12-16T00:00:00Z',
    },
  ],
};

function context(capabilities: Record<string, string[]>): AdminAuthMe {
  return {
    role: 'super_admin',
    roleName: 'Quản trị',
    isAdmin: true,
    allowedPages: ['members', 'dashboard', 'logs'],
    allowedModules: ['members'],
    capabilities,
    user: { id: 'u1', email: 'root@velura.test' },
    profile: { user_id: 'u1', email: 'root@velura.test', full_name: 'Root', is_active: true },
  } as AdminAuthMe;
}

describe('AdminErpMembersPage', () => {
  interface Harness {
    page: AdminErpMembersPage;
    listCalls: Record<string, string>[];
    locks: { userId: string; body: { locked: boolean; reason: string } }[];
  }

  function boot(
    capabilities: Record<string, string[]> = { members: ['read', 'update'] },
    query: Record<string, string> = {},
    failure?: unknown,
  ): Harness {
    TestBed.resetTestingModule();
    const listCalls: Record<string, string>[] = [];
    const locks: { userId: string; body: { locked: boolean; reason: string } }[] = [];
    const params = convertToParamMap(query);
    const api = {
      listMembers: (values: Record<string, string> = {}) => {
        listCalls.push(values);
        return of({ rows: ROWS, count: 2 });
      },
      memberOverview: () => of(OVERVIEW),
      memberDetail: (userId: string) => of({ ...DETAIL, user: { ...DETAIL.user, user_id: userId } }),
      setMemberAccrualLock: (userId: string, body: { locked: boolean; reason: string }) => {
        locks.push({ userId, body });
        return failure ? throwError(() => failure) : of({ user_id: userId, accrual_locked: body.locked, changed: true });
      },
    };
    TestBed.configureTestingModule({
      imports: [AdminErpMembersPage],
      providers: [
        provideRouter([]),
        { provide: AdminErpApiService, useValue: api },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: params }, queryParamMap: of(params) } },
      ],
    });
    TestBed.inject(AdminErpSessionService).applyAuthContext(context(capabilities));
    const fixture = TestBed.createComponent(AdminErpMembersPage);
    fixture.detectChanges();
    return { page: fixture.componentInstance, listCalls, locks };
  }

  it('loads the roster and derives tab counts from the wallet overview', () => {
    const { page, listCalls } = boot();

    expect(page.rows().length).toBe(2);
    expect(page.total()).toBe(2);
    expect(page.canRead()).toBe(true);
    expect(page.canUpdate()).toBe(true);
    expect(page.tabs().map((tab) => tab.count)).toEqual([129, 7, 122, 1, 1]);
    expect(listCalls[0]['wallet']).toBe('all');
    expect(listCalls[0]['sort']).toBe('balance');
    expect(page.pointsLabel(ROWS[0])).toBe('90.900 điểm');
    expect(page.state(ROWS[1]).label).toBe('Khoá tích luỹ');
  });

  it('applies a deep link to the wallet tab and opens the focused member', () => {
    const { page, listCalls } = boot({ members: ['read'] }, { wallet: 'negative', focus: 'u-2' });

    expect(page.wallet()).toBe('negative');
    expect(listCalls[0]['wallet']).toBe('negative');
    expect(page.detail()?.user.user_id).toBe('u-2');
    expect(page.detailState().label).toBe('Khoá tích luỹ');
    expect(page.detailWarningText()).toContain('Tích luỹ đang bị khoá');
  });

  it('ignores a hand-typed filter the screen does not support', () => {
    const { page } = boot({ members: ['read'] }, { wallet: 'everything' });
    expect(page.wallet()).toBe('all');
  });

  it('requires an auditable reason before toggling accrual, and never calls the RPC without one', () => {
    const { page, locks } = boot();
    page.openDetail('u-2');
    page.lockReason.set('ngắn');
    page.saveLock(false);

    expect(locks.length).toBe(0);
    expect(page.lockError()).toContain('tối thiểu');

    page.lockReason.set('Đã xác minh với khách qua hotline');
    page.saveLock(false);

    expect(locks.length).toBe(1);
    expect(locks[0].userId).toBe('u-2');
    expect(locks[0].body.locked).toBe(false);
    expect(page.notice()).toContain('mở khoá');
  });

  it('refuses to toggle accrual without the update capability', () => {
    const { page, locks } = boot({ members: ['read'] });
    page.openDetail('u-2');
    page.lockReason.set('Đã xác minh với khách qua hotline');
    page.saveLock(true);

    expect(page.canUpdate()).toBe(false);
    expect(locks.length).toBe(0);
  });

  it('shows the server message when the lock RPC refuses, and keeps the drawer open', () => {
    const denied = new HttpErrorResponse({
      status: 403,
      error: { error: { code: 'RBAC_DENIED', message: 'Vai trò hiện tại không được thao tác trên điểm thành viên.' } },
    });
    const { page } = boot({ members: ['read', 'update'] }, {}, denied);
    page.openDetail('u-2');
    page.lockReason.set('Đã xác minh với khách qua hotline');
    page.saveLock(true);

    expect(page.lockError()).toContain('không được thao tác');
    expect(page.detail()).not.toBeNull();
    expect(page.lockBusy()).toBe(false);
  });

  it('keeps the counters when the roster request fails', () => {
    TestBed.resetTestingModule();
    const params = convertToParamMap({});
    const api = {
      listMembers: () => throwError(() => new HttpErrorResponse({ status: 500, error: {} })),
      memberOverview: () => of(OVERVIEW),
      memberDetail: () => of(DETAIL),
      setMemberAccrualLock: () => of({}),
    };
    TestBed.configureTestingModule({
      imports: [AdminErpMembersPage],
      providers: [
        provideRouter([]),
        { provide: AdminErpApiService, useValue: api },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: params }, queryParamMap: of(params) } },
      ],
    });
    TestBed.inject(AdminErpSessionService).applyAuthContext(context({ members: ['read'] }));
    const fixture = TestBed.createComponent(AdminErpMembersPage);
    fixture.detectChanges();

    const page = fixture.componentInstance;
    expect(page.loadError()).not.toBeNull();
    expect(page.overview().members).toBe(129);
    expect(page.rows()).toEqual([]);
  });
});
