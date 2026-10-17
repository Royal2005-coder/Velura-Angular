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

  it('replaces the member loading placeholder with loaded account information', async () => {
    await createStorefrontPage(AccountProfilePage, { get: (path: string) => of(path === '/api/user/profile'
      ? { full_name: 'Test2', phone: '0855808333', email: '' }
      : {}) });
    const root: HTMLElement = lastStorefrontFixture().nativeElement;

    expect(root.querySelector('.profile-avatar-name')?.textContent).toContain('Test2');
    expect(root.querySelector('.profile-avatar-meta')?.textContent).toContain('0855808333');
    expect(root.querySelector('.profile-avatar-meta')?.textContent).not.toContain('Đang tải');
  });

  it('keeps spending analytics and exposes the loyalty wallet in its own tab', async () => {
    const page = await createStorefrontPage(AccountProfilePage);
    const fixture = lastStorefrontFixture();

    expect(fixture.nativeElement.querySelector('[data-tab="analytics"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-tab="loyalty"]')?.textContent).toContain('Point');

    page.tab.set('loyalty');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('#tab-loyalty app-loyalty-wallet')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('#tab-offers app-loyalty-wallet')).toBeNull();
  });
});
