import { createStorefrontPage } from '../../../testing/storefront-testing';
import { ActivateAccountPage } from './activate-account.page';

describe('ActivateAccountPage', () => {
  it('creates the activation ViewModel with stubbed Models', async () => {
    const page = await createStorefrontPage(ActivateAccountPage);
    expect(page).toBeTruthy();
    expect(page.submitting()).toBe(false);
    expect(page.form.controls.password.value).toBe('');
  });
});
