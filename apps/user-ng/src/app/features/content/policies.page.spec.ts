import { createStorefrontPage } from '../../../testing/storefront-testing';
import { isPolicyTab, PoliciesPage } from './policies.page';

describe('PoliciesPage', () => {
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(PoliciesPage);
    expect(page).toBeTruthy();
  });

  it('guards ?tab= and keeps the active panel on a signal', async () => {
    expect(isPolicyTab('returns')).toBe(true);
    expect(isPolicyTab('nope')).toBe(false);
    const page = await createStorefrontPage(PoliciesPage);
    expect(page.tab()).toBe('returns');
    page.selectTab('privacy');
    expect(page.tab()).toBe('privacy');
  });
});
