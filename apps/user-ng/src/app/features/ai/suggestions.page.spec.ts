import { createStorefrontPage } from '../../../testing/storefront-testing';
import { AiSuggestionsPage } from './suggestions.page';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Subject, throwError } from 'rxjs';
import { StyleProfileService } from '../../core/services/style-profile.service';
import { AuthService } from '../../core/services/auth.service';
import type { StyleProfileRecommendations } from '../../core/models/style-profile.interface';
import type { UserSession } from '../../core/models/user-session.interface';

describe('AiSuggestionsPage', () => {
  afterEach(() => TestBed.resetTestingModule());
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(AiSuggestionsPage);
    expect(page).toBeTruthy();
  });
  it('renders a retryable API error without claiming that the customer has no quiz', async () => {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({ imports: [AiSuggestionsPage], providers: [
      provideRouter([]),
      { provide: StyleProfileService, useValue: { revision: signal(0), loadRecommendations: () => throwError(() => new Error('Không tải được hồ sơ.')) } },
    ] }).compileComponents();
    const fixture = TestBed.createComponent(AiSuggestionsPage);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain('Không tải được hồ sơ.');
    expect(fixture.nativeElement.textContent).not.toContain('Bạn chưa thực hiện Style Quiz');
    fixture.destroy();
  });

  it('ignores late recommendations from the previous account and clears its open outfit', async () => {
    TestBed.resetTestingModule();
    const old = new Subject<StyleProfileRecommendations>();
    const fresh = new Subject<StyleProfileRecommendations>();
    const session = signal<UserSession | null>({ userId: 'A', fullName: 'A', email: null, phone: null, avatarUrl: null });
    const load = vi.fn().mockReturnValueOnce(old).mockReturnValueOnce(fresh);
    await TestBed.configureTestingModule({ imports: [AiSuggestionsPage], providers: [
      provideRouter([]),
      { provide: AuthService, useValue: { session, isLoggedIn: () => !!session() } },
      { provide: StyleProfileService, useValue: { revision: signal(0), loadRecommendations: load } },
    ] }).compileComponents();
    const fixture = TestBed.createComponent(AiSuggestionsPage);
    const page = fixture.componentInstance;
    fixture.detectChanges();
    page.openCombo({ name: 'Previous private outfit', products: [] });
    session.set({ userId: 'B', fullName: 'B', email: null, phone: null, avatarUrl: null });
    old.next({ quiz: { body_shape: 'Pear' }, combos: [{ name: 'A only', products: [] }] });
    expect(page.hasQuiz()).toBe(false);
    fixture.detectChanges();
    expect(page.selectedCombo()).toBeNull();
    expect(page.combos()).toEqual([]);
    fresh.next({ quiz: { body_shape: 'Rectangle' }, combos: [{ name: 'B only', products: [] }] });
    expect(page.combos().map((combo) => combo.name)).toEqual(['B only']);
    fixture.destroy();
  });

  it('defaults to Tất cả tab with total product count and filters by category', async () => {
    TestBed.resetTestingModule();
    const recommendations = new Subject<StyleProfileRecommendations>();
    await TestBed.configureTestingModule({ imports: [AiSuggestionsPage], providers: [
      provideRouter([]),
      { provide: AuthService, useValue: { session: signal(null), isLoggedIn: () => false } },
      { provide: StyleProfileService, useValue: { revision: signal(0), loadRecommendations: () => recommendations } },
    ] }).compileComponents();
    const fixture = TestBed.createComponent(AiSuggestionsPage);
    const page = fixture.componentInstance;
    fixture.detectChanges();

    recommendations.next({
      quiz: { body_shape: 'Hourglass', style_tags: ['Minimalist'] },
      combos: [],
      categories: [
        {
          category_id: 'cat-pants',
          category_name: 'Quần',
          products: [
            { product_id: 'p1', name: 'Quần tây lụa', base_price: 500000 } as any,
            { product_id: 'p2', name: 'Quần culottes', base_price: 600000 } as any,
          ],
        },
        {
          category_id: 'cat-shirts',
          category_name: 'Áo',
          products: [
            { product_id: 'p3', name: 'Áo sơ mi voan', base_price: 450000 } as any,
          ],
        },
      ],
    });
    fixture.detectChanges();

    expect(page.allProductsCount()).toBe(3);
    expect(page.activeCategoryId()).toBe('all');
    expect(page.profileProducts().length).toBe(3);

    page.selectCategory('cat-pants');
    fixture.detectChanges();
    expect(page.activeCategoryId()).toBe('cat-pants');
    expect(page.profileProducts().length).toBe(2);

    page.selectCategory('all');
    fixture.detectChanges();
    expect(page.activeCategoryId()).toBe('all');
    expect(page.profileProducts().length).toBe(3);
    fixture.destroy();
  });

  it('paginates suggested products into 8 per page and resets on category change', async () => {
    TestBed.resetTestingModule();
    const recommendations = new Subject<StyleProfileRecommendations>();
    await TestBed.configureTestingModule({ imports: [AiSuggestionsPage], providers: [
      provideRouter([]),
      { provide: AuthService, useValue: { session: signal(null), isLoggedIn: () => false } },
      { provide: StyleProfileService, useValue: { revision: signal(0), loadRecommendations: () => recommendations } },
    ] }).compileComponents();
    const fixture = TestBed.createComponent(AiSuggestionsPage);
    const page = fixture.componentInstance;
    fixture.detectChanges();

    const mockProducts = Array.from({ length: 18 }, (_, i) => ({
      product_id: `prod-${i + 1}`,
      name: `Sản phẩm ${i + 1}`,
      base_price: 300000 + i * 10000,
    } as any));

    recommendations.next({
      quiz: { body_shape: 'Hourglass', style_tags: ['Minimalist'] },
      combos: [],
      categories: [
        { category_id: 'cat-all', category_name: 'Đầm', products: mockProducts },
      ],
    });
    fixture.detectChanges();

    expect(page.profileProducts().length).toBe(18);
    expect(page.totalPages()).toBe(3);
    expect(page.currentPage()).toBe(1);
    expect(page.paginatedProducts().length).toBe(8);
    expect(page.paginatedProducts()[0].product_id).toBe('prod-1');

    page.nextPage();
    fixture.detectChanges();
    expect(page.currentPage()).toBe(2);
    expect(page.paginatedProducts().length).toBe(8);
    expect(page.paginatedProducts()[0].product_id).toBe('prod-9');

    page.goToPage(3);
    fixture.detectChanges();
    expect(page.currentPage()).toBe(3);
    expect(page.paginatedProducts().length).toBe(2);

    page.prevPage();
    fixture.detectChanges();
    expect(page.currentPage()).toBe(2);

    // Switching category resets page to 1
    page.selectCategory('cat-all');
    fixture.detectChanges();
    expect(page.currentPage()).toBe(1);

    fixture.destroy();
  });
});
