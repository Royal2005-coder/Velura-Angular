import { createAdminPage } from '../../../testing/admin-testing';
import { AdminReturnsPage } from './admin-returns.page';

describe('AdminReturnsPage', () => {
  it('creates the ViewModel with a stub AdminApiService', async () => {
    const page = await createAdminPage(AdminReturnsPage);
    expect(page).toBeTruthy();
  });

  it('exposes loading, empty, and zone signals instead of template filters', async () => {
    const page = await createAdminPage(AdminReturnsPage);
    expect(page.loading()).toBe(false);
    expect(page.returns()).toEqual([]);
    expect(page.loadError()).toBeNull();
    page.zone.set('returns');
    expect(page.zone()).toBe('returns');
    expect(page.canLookupOrders()).toBe(false);
  });

  it('shows the customer return type instead of an empty request column', async () => {
    const page = await createAdminPage(AdminReturnsPage);
    expect(page.returnKind({ return_id: '1', return_type: 'refund' })).toBe('Hoàn tiền');
    expect(page.returnKind({ return_id: '2', return_type: 'exchange' })).toBe('Đổi hàng');
    expect(page.showReturnAction({ return_id: '1', return_type: 'refund' }, 'refund')).toBe(true);
    expect(page.showReturnAction({ return_id: '1', return_type: 'refund' }, 'exchange')).toBe(false);
  });
});
