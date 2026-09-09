import { createStorefrontPage } from '../../../testing/storefront-testing';
import { AccountTrackPage } from './track.page';

describe('AccountTrackPage', () => {
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(AccountTrackPage);
    expect(page).toBeTruthy();
  });
});
