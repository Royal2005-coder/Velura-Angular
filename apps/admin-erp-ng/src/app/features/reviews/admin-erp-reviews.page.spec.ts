import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Observable, of, throwError } from 'rxjs';
import { AdminErpApiService, AdminReviewRow } from '../../core/admin-erp-api.service';
import { AdminListPayload } from '../../core/admin-erp-http';
import { AdminErpSessionService } from '../../core/admin-erp-session.service';
import { AdminErpReviewsPage } from './admin-erp-reviews.page';

const reviews: AdminReviewRow[] = [
  {
    review_id: 'r1',
    status: 'pending',
    rating: 2,
    comment: 'Hàng lừa đảo, chất lượng quá tệ',
    product: { name: 'Lụa Hà Nội', sku: 'VL-01' },
    user_id: 'u1',
    order_id: 'o1',
    submitted_at: '2026-10-20T03:00:00Z',
    is_flagged_urgent: true,
    version: 3,
  },
  {
    review_id: 'r2',
    status: 'approved',
    rating: 5,
    comment: 'Rất đẹp',
    product: { name: 'Áo dài', sku: 'VL-02' },
    user_id: 'u2',
    submitted_at: '2026-10-21T03:00:00Z',
    version: 2,
  },
];

type ListReviewsFn = (params?: Record<string, string>) => Observable<AdminListPayload<AdminReviewRow>>;

describe('AdminErpReviewsPage', () => {
  async function boot(listReviews: ListReviewsFn, calls: Array<Record<string, string> | undefined> = []) {
    TestBed.resetTestingModule();
    const api = {
      listReviews: (params?: Record<string, string>) => {
        calls.push(params);
        return listReviews(params);
      },
      getReview: (reviewId: string) => of(reviews.find((row) => row.review_id === reviewId) || reviews[0]),
      listReviewAuditLogs: () => of({ rows: [], count: 0 }),
      suggestReviewReply: () => of({ replies: ['Cảm ơn bạn đã góp ý.'], source: 'ai' }),
      approveReview: () => of({}),
      hideReview: () => of({}),
      replyReview: () => of({}),
      escalateReview: () => of({}),
    };
    await TestBed.configureTestingModule({
      imports: [AdminErpReviewsPage],
      providers: [provideRouter([]), { provide: AdminErpApiService, useValue: api }],
    }).compileComponents();
    const session = TestBed.inject(AdminErpSessionService);
    session.applyAuthContext({
      role: 'admin_operator_danhgia_review',
      roleName: 'Admin đánh giá',
      isAdmin: true,
      allowedPages: ['reviews'],
      allowedModules: ['reviews'],
      capabilities: { reviews: ['read', 'update'] },
      user: { id: 'rev', email: 'review@velura.test' },
      profile: { user_id: 'rev', email: 'review@velura.test', full_name: 'Review', is_active: true },
    });
    const fixture = TestBed.createComponent(AdminErpReviewsPage);
    fixture.detectChanges();
    return fixture;
  }

  const listWithCounts: ListReviewsFn = (params) => {
    if (params?.['limit'] === '1') {
      const count = params?.['status'] === 'approved' ? 4 : params?.['status'] === 'rejected' ? 2 : params?.['urgent'] === 'true' ? 3 : 6;
      return of({ rows: [], count });
    }
    return of({ rows: reviews, count: reviews.length });
  };

  it('loads reviews and moderation counts', async () => {
    const fixture = await boot(listWithCounts);
    const page = fixture.componentInstance;

    expect(page.rows().length).toBe(2);
    expect(page.total()).toBe(2);
    expect(page.urgentCount()).toBe(3);
    expect(page.processedCount()).toBe(6);
    expect(page.hiddenCount()).toBe(2);
    expect(page.canMutate()).toBe(true);
  });

  it('sends filters and the urgent tab to the server', async () => {
    const calls: Array<Record<string, string> | undefined> = [];
    const fixture = await boot(listWithCounts, calls);
    const page = fixture.componentInstance;

    page.query.set('lua');
    page.ratingFilter.set('2');
    page.applyFilters();
    let listCall = calls.filter((params) => params?.['limit'] !== '1').at(-1);
    expect(listCall?.['q']).toBe('lua');
    expect(listCall?.['rating']).toBe('2');

    page.setTab('urgent');
    listCall = calls.filter((params) => params?.['limit'] !== '1').at(-1);
    expect(listCall?.['urgent']).toBe('true');
  });

  it('opens the review drawer and detects restricted words', async () => {
    const fixture = await boot(listWithCounts);
    const page = fixture.componentInstance;

    page.openDetail(reviews[0]);

    expect(page.selected()?.review_id).toBe('r1');
    expect(page.selectedRestrictedWords()).toContain('lừa đảo');
    expect(page.sentiment()?.label).toBeDefined();
  });

  it('requests AI reply suggestions and applies one', async () => {
    const fixture = await boot(listWithCounts);
    const page = fixture.componentInstance;

    page.openDetail(reviews[0]);
    page.openAction('reply');

    expect(page.aiSuggestions()).toEqual(['Cảm ơn bạn đã góp ý.']);
    page.applyAiSuggestion(page.aiSuggestions()[0]);
    expect(page.replyDraft()).toBe('Cảm ơn bạn đã góp ý.');
  });

  it('surfaces review API errors without fabricated rows', async () => {
    const fixture = await boot((params) => {
      if (params?.['limit'] === '1') return of({ rows: [], count: 0 });
      return throwError(() => new Error('reviews down'));
    });
    const page = fixture.componentInstance;

    expect(page.loadError()).toBe('reviews down');
    expect(page.rows()).toEqual([]);
    expect(page.loading()).toBe(false);
  });
});
