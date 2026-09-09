import { createStorefrontPage } from '../../../testing/storefront-testing';
import { HomePage } from './home.page';

describe('HomePage', () => {
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(HomePage);
    expect(page).toBeTruthy();
  });

  it('loads featured catalog into signals from the CatalogService stub', async () => {
    const page = await createStorefrontPage(HomePage);
    expect(page.loading()).toBe(false);
    expect(page.loadError()).toBeNull();
    expect(page.products().length).toBeGreaterThan(0);
    expect(page.categories().some((row) => row.slug === 'ao')).toBe(true);
  });
});
