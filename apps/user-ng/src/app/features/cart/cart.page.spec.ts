import { createStorefrontPage } from '../../../testing/storefront-testing';
import { CartPage } from './cart.page';

describe('CartPage', () => {
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(CartPage);
    expect(page).toBeTruthy();
  });

  it('starts empty: computed pager and selection stay at the empty-cart contract', async () => {
    const page = await createStorefrontPage(CartPage);
    expect(page.groupedCount()).toBe(0);
    expect(page.showPagination()).toBe(false);
    expect(page.allSelected()).toBe(false);
    expect(page.selectedSubtotal()).toBe(0);
    expect(page.totalPages()).toBe(1);
  });
});
