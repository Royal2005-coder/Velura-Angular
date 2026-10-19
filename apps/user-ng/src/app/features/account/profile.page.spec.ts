import { delay, of } from 'rxjs';
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

  it('renders every completed Style Quiz answer in Style Profile', async () => {
    await createStorefrontPage(AccountProfilePage, { get: (path: string) => of(path === '/api/user/style-quiz'
      ? { quiz: {
        body_shape: 'Apple', style_tags: ['Minimalist', 'Boho'], height_cm: 162, weight_kg: 52,
        chest_cm: 84, waist_cm: 64, hip_cm: 90, skin_tone: 'Neutral', age_group: '25-34',
        budget_range: '700k_1.5m', favorite_colors: ['Kem', 'Hồng đất'],
        preferred_occasions: ['Office', 'Travel'], favorite_brands: [],
      } }
      : {}).pipe(delay(0)) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const root: HTMLElement = lastStorefrontFixture().nativeElement;

    expect(root.querySelector('#js-sp-style-tags')?.textContent).toContain('Minimalist');
    expect(root.querySelector('#js-sp-colors')?.textContent).toContain('Kem');
    expect(root.querySelector('#js-sp-colors')?.textContent).toContain('Hồng đất');
    expect(root.querySelector('#js-sp-occasions')?.textContent).toContain('Office');
    expect(root.querySelector('#js-sp-occasions')?.textContent).toContain('Travel');
    expect(root.querySelector('#js-sp-budget')?.textContent).toContain('700.000đ – 1.500.000đ');
    expect(root.querySelector('#js-sp-brands')?.textContent).toContain('Chưa thu thập trong Style Quiz');
    expect(root.querySelector('#js-tip-style')?.textContent).toContain('Minimalist, Boho');
    expect(root.querySelector('#js-tip-body')?.textContent).toContain('Apple');
    expect(root.querySelector('#js-tip-colors')?.textContent).toContain('Kem, Hồng đất');
    expect(root.querySelector('#js-tip-items')?.textContent).toContain('Office, Travel');
  });
});
