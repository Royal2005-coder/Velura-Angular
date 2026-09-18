import { TestBed } from '@angular/core/testing';
import { createAdminPage } from '../../../testing/admin-testing';
import { AdminSessionService } from '../../core/admin-session.service';
import { AdminLoginPage, formatCountdown } from './admin-login.page';

describe('AdminLoginPage', () => {
  it('creates the ViewModel with a stub AdminApiService', async () => {
    const page = await createAdminPage(AdminLoginPage);
    expect(page).toBeTruthy();
  });

  it('rejects an empty form in the ViewModel without calling signIn', async () => {
    const page = await createAdminPage(AdminLoginPage);
    page.submit();
    expect(page.errorMessage()).toBe('Vui lòng nhập đầy đủ email và mật khẩu.');
    expect(page.submitting()).toBe(false);
  });

  it('clears a leftover HQ session before verifying another account', async () => {
    const page = await createAdminPage(AdminLoginPage);
    const session = TestBed.inject(AdminSessionService);
    session.setToken('leftover-super-admin');
    page.form.setValue({ email: 'product@velura.vn', password: 'secret-pass' });
    page.submit();
    expect(session.token()).toBe('');
    expect(page.errorMessage()).toBe('Không nhận được phiên đăng nhập.');
  });

  it('formats the AUTH-02 lock countdown as mm:ss', () => {
    expect(formatCountdown(15 * 60 * 1000)).toBe('15:00');
    expect(formatCountdown(65_000)).toBe('01:05');
  });
});

describe('AdminSessionService RBAC landing', () => {
  it('lands product, order, and CSKH operators on their module', async () => {
    await createAdminPage(AdminLoginPage);
    const session = TestBed.inject(AdminSessionService);
    session.applyAuthContext({
      role: 'admin_operator_sanpham',
      roleName: 'Admin sản phẩm',
      isAdmin: true,
      allowedPages: ['products'],
      user: { id: 'p1', email: 'product@velura.vn' },
    });
    expect(session.firstRoute()).toBe('/products');
    expect(session.canOpen('orders')).toBe(false);
    expect(session.canOpen('dashboard')).toBe(false);

    session.applyAuthContext({
      role: 'admin_operator_donhang',
      roleName: 'Admin đơn hàng',
      isAdmin: true,
      allowedPages: ['orders'],
      user: { id: 'o1', email: 'order@velura.vn' },
    });
    expect(session.firstRoute()).toBe('/orders');
    expect(session.canOpen('products')).toBe(false);

    session.applyAuthContext({
      role: 'admin_operator_cskh_dt',
      roleName: 'Admin CSKH',
      isAdmin: true,
      allowedPages: ['returns-cskh'],
      allowedModules: ['returns', 'orders'],
      user: { id: 'c1', email: 'cskh-test@velura.vn' },
    });
    expect(session.firstRoute()).toBe('/returns');
    expect(session.canAccessModule('orders')).toBe(true);
    expect(session.canOpen('accounts')).toBe(false);
  });
});
