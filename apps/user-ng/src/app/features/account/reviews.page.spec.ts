import { createStorefrontPage } from '../../../testing/storefront-testing';
import { AccountReviewsPage } from './reviews.page';

describe('AccountReviewsPage', () => {
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(AccountReviewsPage);
    expect(page).toBeTruthy();
  });

  it('stores and updates star rating on a signal', async () => {
    const page = await createStorefrontPage(AccountReviewsPage);
    expect(page.rating()).toBe(5);
    page.setRating(4);
    expect(page.rating()).toBe(4);
  });

  it('toggles review tags correctly', async () => {
    const page = await createStorefrontPage(AccountReviewsPage);
    expect(page.selectedTags().length).toBe(0);
    page.toggleTag('Đúng mô tả');
    expect(page.selectedTags()).toContain('Đúng mô tả');
    page.toggleTag('Đúng mô tả');
    expect(page.selectedTags()).not.toContain('Đúng mô tả');
  });

  it('switches between write and history tabs', async () => {
    const page = await createStorefrontPage(AccountReviewsPage);
    expect(page.activeTab()).toBe('write');
    page.activeTab.set('history');
    expect(page.activeTab()).toBe('history');
  });
});
