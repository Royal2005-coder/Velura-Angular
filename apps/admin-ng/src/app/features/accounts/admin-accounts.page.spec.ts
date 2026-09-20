import { createAdminPage } from '../../../testing/admin-testing';
import { AdminAccountsPage } from './admin-accounts.page';

describe('AdminAccountsPage', () => {
  it('creates the ViewModel with a stub AdminApiService', async () => {
    const page = await createAdminPage(AdminAccountsPage);
    expect(page).toBeTruthy();
  });

  it('exposes loading, empty, and filter signals instead of template filters', async () => {
    const page = await createAdminPage(AdminAccountsPage);
    expect(page.loading()).toBe(false);
    expect(page.rows()).toEqual([]);
    expect(page.loadError()).toBeNull();
    page.query.set('linh');
    page.roleFilter.set('member');
    expect(page.query()).toBe('linh');
    expect(page.roleFilter()).toBe('member');
  });

  it('shows a skeleton only on first load, then dims the existing table while refetching', async () => {
    const page = await createAdminPage(AdminAccountsPage);

    // Lần tải đầu đã xong trong ctor, nên từ đây trở đi là tải lại.
    page.loading.set(true);
    expect(page.showSkeleton()).toBe(false);
    expect(page.isRefreshing()).toBe(true);

    // Còn khi chưa từng tải xong thì mới vẽ khung xương.
    page.hasLoadedOnce.set(false);
    expect(page.showSkeleton()).toBe(true);
    expect(page.isRefreshing()).toBe(false);
  });

  it('hides KPI counts behind a dash until the real numbers arrive', async () => {
    const page = await createAdminPage(AdminAccountsPage);

    page.hasLoadedOnce.set(false);
    expect(page.kpi(0)).toBe('—');

    page.hasLoadedOnce.set(true);
    expect(page.kpi(149)).toBe('149');
  });

  it('labels an unverified account as such instead of calling it temporarily locked', async () => {
    const page = await createAdminPage(AdminAccountsPage);

    const unverified = { user_id: 'u1', is_active: false, lock_type: null };
    expect(page.statusKey(unverified)).toBe('unverified');
    expect(page.statusLabel(unverified)).toBe('Chưa xác thực');

    const locked = { user_id: 'u2', is_active: false, lock_type: 'temporary' };
    expect(page.statusLabel(locked)).toBe('Khóa tạm thời');
  });
});
