import { createAdminPage } from '../../../testing/admin-testing';
import { AdminPromotionsPage } from './admin-promotions.page';

describe('AdminPromotionsPage', () => {
  it('creates the ViewModel with a stub AdminApiService', async () => {
    const page = await createAdminPage(AdminPromotionsPage);
    expect(page).toBeTruthy();
  });

  it('exposes loading and empty campaign signals', async () => {
    const page = await createAdminPage(AdminPromotionsPage);
    expect(page.loading()).toBe(false);
    expect(page.promotions()).toEqual([]);
    expect(page.loadError()).toBeNull();
  });

  it('labels guest and member vouchers with the checkout audience', async () => {
    const page = await createAdminPage(AdminPromotionsPage);
    expect(page.voucherAudience({ voucher_id: '1', applicable_user_group: 'guest' })).toBe('Khách vãng lai');
    expect(page.voucherAudience({ voucher_id: '2', applicable_user_group: 'member' })).toBe('Thành viên');
    expect(page.voucherAudience({ voucher_id: '3' })).toBe('Mọi khách');
  });
});
