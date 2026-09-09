import { createStorefrontPage } from '../../../testing/storefront-testing';
import { FeaturePage } from './feature.page';

describe('FeaturePage', () => {
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(FeaturePage);
    expect(page).toBeTruthy();
  });

  it('reads title from route data via toSignal', async () => {
    const page = await createStorefrontPage(FeaturePage);
    expect(page.title()).toBe('Velura');
  });
});
