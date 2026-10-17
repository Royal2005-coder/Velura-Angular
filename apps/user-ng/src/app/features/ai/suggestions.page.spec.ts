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
});
