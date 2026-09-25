import { createAdminPage } from '../../../testing/admin-testing';
import { AdminReviewsPage } from './admin-reviews.page';

describe('AdminReviewsPage', () => {
  it('creates the ViewModel with a stub AdminApiService', async () => {
    const page = await createAdminPage(AdminReviewsPage);
    expect(page).toBeTruthy();
  });

  it('exposes loading and empty review signals', async () => {
    const page = await createAdminPage(AdminReviewsPage);
    expect(page.loading()).toBe(false);
    expect(page.rows()).toEqual([]);
    expect(page.loadError()).toBeNull();
  });

  it('detects restricted/spam words, analyzes sentiment and provides AI suggestions', async () => {
    const page = await createAdminPage(AdminReviewsPage);
    
    // Restricted words
    expect(page.detectRestrictedWords('Áo này đẹp lắm mấy má nhận xu')).toEqual(['mấy má', 'nhận xu']);
    expect(page.detectRestrictedWords('Chất lượng vải tốt, form đẹp')).toEqual([]);

    // Sentiment
    const pos = page.analyzeSentiment({ review_id: 'r1', rating: 5, comment: 'Sản phẩm quá tuyệt vời' });
    expect(pos.tone).toBe('positive');

    const neg = page.analyzeSentiment({ review_id: 'r2', rating: 1, comment: 'Hàng rách và lỗi chỉ thừa' });
    expect(neg.tone).toBe('negative');

    // AI suggestions
    const suggestions = page.generateAiSuggestions({ review_id: 'r1', rating: 5 }, pos);
    expect(suggestions.length).toBe(3);
    page.applyAiSuggestion(suggestions[0]);
    expect(page.replyDraft()).toBe(suggestions[0]);
  });
});
