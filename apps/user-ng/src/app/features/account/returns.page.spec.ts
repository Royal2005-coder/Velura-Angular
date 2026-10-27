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
    expect(isReturnableOrder({ status: 'delivered', delivered_at: '2026-08-24T00:00:00.000Z' }, now)).toBe(true);
    expect(isReturnableOrder({ status: 'delivered', delivered_at: '2026-08-24T00:00:00.000Z', is_exchange_replacement: true }, now)).toBe(false);
    expect(isReturnableOrder({ status: 'pending', delivered_at: '2026-08-24T00:00:00.000Z' }, now)).toBe(false);
    expect(isReturnableOrder({ status: 'delivered', delivered_at: '2026-08-23T23:59:59.000Z' }, now)).toBe(false);
    expect(returnReasonText('size')).toBe('Không vừa kích cỡ');
  });
});
