import { of } from 'rxjs';
import { createStorefrontPage, lastStorefrontFixture } from '../../../testing/storefront-testing';
import { AccountProfilePage } from './profile.page';

describe('AccountProfilePage', () => {
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(AccountProfilePage);
    expect(page).toBeTruthy();
  });

  it('renders hostile saved-address fields as text instead of executable markup', async () => {
    const hostile = '<img src=x onerror="window.storedAddressAttack=1">';
    const hostileId = '\"><img src=x onerror="window.storedAddressAttack=2">';
    await createStorefrontPage(AccountProfilePage, { get: (path: string) => of(path === '/api/user/profile'
      ? { saved_addresses: [{ id: hostileId, name: hostile, phone: hostile, address: hostile, is_default: true }] }
      : {}) });
    const list: HTMLElement = lastStorefrontFixture().nativeElement.querySelector('.address-list');
    expect(list.textContent).toContain(hostile);
    expect(list.querySelector('img')).toBeNull();
    expect(list.querySelector('[onerror]')).toBeNull();
    expect(list.querySelector('.address-card')?.getAttribute('data-id')).toBe(hostileId);
  });
});
