import { createStorefrontPage } from '../../../testing/storefront-testing';
import { AccountReturnsPage } from './returns.page';
import { isReturnableOrder, returnReasonText } from './return-window';

describe('AccountReturnsPage', () => {
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(AccountReturnsPage);
    expect(page).toBeTruthy();
  });

  it('offers a return only for a delivered order inside 30 days', () => {
    const now = new Date('2026-09-23T00:00:00.000Z');
    expect(isReturnableOrder({ status: 'delivered', delivered_at: '2026-09-01T00:00:00.000Z' }, now)).toBe(true);
    expect(isReturnableOrder({ status: 'pending', delivered_at: '2026-09-01T00:00:00.000Z' }, now)).toBe(false);
    expect(isReturnableOrder({ status: 'delivered', delivered_at: '2026-08-01T00:00:00.000Z' }, now)).toBe(false);
    expect(returnReasonText('size')).toBe('Không vừa kích cỡ');
  });
});
