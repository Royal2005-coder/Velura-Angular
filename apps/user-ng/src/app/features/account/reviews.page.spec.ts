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

  it('shows every delivered product selector after the first item is selected', async () => {
    const page = await createStorefrontPage(AccountReviewsPage);
    const item = { orderId: 'delivered', orderCode: 'VLR1', productId: 'p1', productName: 'Shirt', unitPrice: 100000 };
    page.eligibleItems.set([item, { ...item, productId: 'p2', productName: 'Skirt' }]);
    page.selectItem(item);
    page.comment.set('First item');
    page.selectItem(page.eligibleItems()[1]);
    expect(page.productId()).toBe('p2');
    expect(page.comment()).toBe('');
    expect(page.images()).toEqual([]);
  });

  it('rejects active-content and credential-bearing image URLs', async () => {
    const page = await createStorefrontPage(AccountReviewsPage);
    for (const url of ['javascript:alert(1)', 'data:image/svg+xml,test', 'https://user:pass@example.test/a.png']) {
      page.imageUrlInput.set(url);
      page.addImage();
    }
    expect(page.images()).toEqual([]);
    expect(page.submitError()).toContain('HTTPS');
  });
});
