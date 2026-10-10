import { of } from 'rxjs';
import { createStorefrontPage, lastStorefrontFixture } from '../../../testing/storefront-testing';
import { AccountOrdersPage } from './orders.page';

describe('AccountOrdersPage', () => {
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(AccountOrdersPage);
    expect(page).toBeTruthy();
  });

  it('shows an order returned by the real member-orders API', async () => {
    await createStorefrontPage(AccountOrdersPage, {
      get: () =>
        of({
          orders: [
            {
              order_id: 'o1',
              order_code: 'VLR-REAL-1',
              status: 'confirmed',
              status_label: 'Đã xác nhận',
              total_amount: 450000,
              item_count: 2,
            },
          ],
        }),
    });
    const fixture = lastStorefrontFixture();
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain('VLR-REAL-1');
    expect(root.textContent).toContain('Đã xác nhận');
  });
});
