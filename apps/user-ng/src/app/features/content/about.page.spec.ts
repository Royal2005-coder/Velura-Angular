import { createStorefrontPage, lastStorefrontFixture } from '../../../testing/storefront-testing';
import { AboutPage } from './about.page';

describe('AboutPage', () => {
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(AboutPage);
    expect(page).toBeTruthy();
  });

  it('renders core value cards with icons, titles and descriptions', async () => {
    await createStorefrontPage(AboutPage);
    const fixture = lastStorefrontFixture();
    const cards = fixture.nativeElement.querySelectorAll('.about-values .value-card');
    expect(cards.length).toBe(3);

    const titles = Array.from(cards).map(
      (card) => (card as HTMLElement).querySelector('.value-card__title')?.textContent?.trim(),
    );
    expect(titles).toEqual(['Bền vững', 'Cá nhân hóa', 'Thanh lịch']);

    const icons = fixture.nativeElement.querySelectorAll('.about-values .value-card__icon-wrapper svg');
    expect(icons.length).toBe(3);
  });
});
