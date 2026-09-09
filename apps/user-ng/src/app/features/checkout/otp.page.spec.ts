import { createStorefrontPage } from '../../../testing/storefront-testing';
import { CheckoutOtpPage } from './otp.page';

describe('CheckoutOtpPage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(CheckoutOtpPage);
    expect(page).toBeTruthy();
    expect(page.seconds()).toBe(300);
    expect(page.digits().join('')).toBe('');
  });
});
