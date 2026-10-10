import { createStorefrontPage } from '../../../testing/storefront-testing';
import { ProductListPage } from './product-list.page';

describe('ProductListPage', () => {
  it('keeps visual candidates based on catalog filters independently of previous image matches', async () => {
    const page = await createStorefrontPage(ProductListPage);
    const originalIds = page.imageSearchCandidates();
    expect(originalIds.length).toBe(1);
    page.applyImageMatches([]);
    expect(page.productCount()).toBe(0);
    expect(page.imageSearchCandidates()).toEqual(originalIds);
    page.searchQuery.set('không-tồn-tại-xyz');
    expect(page.imageSearchCandidates()).toEqual([]);
  });
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(ProductListPage);
    expect(page).toBeTruthy();
  });

  it('keeps filter state on signals — template must not call .filter()', async () => {
    const page = await createStorefrontPage(ProductListPage);
    expect(page.loading()).toBe(false);
    expect(page.productCount()).toBe(1);
    page.searchQuery.set('không-tồn-tại-xyz');
    expect(page.productCount()).toBe(0);
    page.searchQuery.set('linen');
    expect(page.productCount()).toBe(1);
    expect(page.activeCategoryLabel()).toContain('linen');
  });
});
