import { createStorefrontPage } from '../../../testing/storefront-testing';
import { StyleQuizPage } from './style-quiz.page';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { firstValueFrom, of, Subject } from 'rxjs';
import { StyleProfileService } from '../../core/services/style-profile.service';

describe('StyleQuizPage', () => {
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(StyleQuizPage);
    expect(page).toBeTruthy();
  });

  it('keeps the summary recoverable and does not mark completion when saving fails', async () => {
    TestBed.resetTestingModule();
    localStorage.removeItem('velura_guest_quiz_completed');
    const request = new Subject<void>();
    const post = vi.fn(() => request);
    await TestBed.configureTestingModule({
      imports: [StyleQuizPage],
      providers: [provideRouter([]), { provide: StyleProfileService, useValue: {
        saveQuiz: post, guestDraft: () => null, saveGuestDraft: () => undefined,
      } }],
    }).compileComponents();
    const fixture = TestBed.createComponent(StyleQuizPage);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const page = fixture.componentInstance;
    page.showSummary.set(true);
    page.next();
    page.next();
    expect(post).toHaveBeenCalledTimes(1);
    request.error(new Error('Service unavailable'));
    fixture.detectChanges();
    expect(page.analyzing()).toBe(false);
    expect(page.showSummary()).toBe(true);
    expect(page.submitError()).toBe('Service unavailable');
    expect(localStorage.getItem('velura_guest_quiz_completed')).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain('Service unavailable');
    fixture.destroy();
  });

  it('blocks in-app navigation for an incomplete guest draft until a choice is made', async () => {
    const page = await createStorefrontPage(StyleQuizPage);
    page.draftDirty.set(true);
    const decision = page.confirmDeactivate();
    expect(decision).not.toBe(true);
    expect(page.exitPromptOpen()).toBe(true);
    const result = firstValueFrom(decision as Subject<boolean>);
    page.resolveExit('stay');
    await expect(result).resolves.toBe(false);
  });

  it('waits for signup choice and then allows the redirected navigation without reopening', async () => {
    const page = await createStorefrontPage(StyleQuizPage);
    page.draftDirty.set(true);
    const decision = page.confirmDeactivate();
    const result = firstValueFrom(decision as Subject<boolean>);

    page.resolveExit('signup');

    expect((await result).toString()).toContain('/auth/signup?claimStyleDraft=1');
    expect(page.exitPromptOpen()).toBe(false);
    expect(page.confirmDeactivate()).toBe(true);
  });

  it('restores a signed-in member previous answers instead of the HTML defaults', async () => {
    TestBed.resetTestingModule();
    localStorage.setItem('velura_token', 'member-token');
    localStorage.setItem('velura_user', JSON.stringify({ user_id: 'member-1', role: 'member' }));
    await TestBed.configureTestingModule({
      imports: [StyleQuizPage],
      providers: [provideRouter([]), { provide: StyleProfileService, useValue: {
        loadQuiz: () => of({
          height_cm: 175, weight_kg: 68, chest_cm: 91, waist_cm: 73, hip_cm: 96,
          body_shape: 'Rectangle', skin_tone: 'Cool', style_tags: ['Classic', 'Street'],
          preferred_occasions: ['Travel'], favorite_brands: [], budget_range: '700k_1.5m',
          age_group: '35-44', favorite_colors: ['Onyx', 'Camel'],
        }),
        saveQuiz: () => of(undefined), guestDraft: () => null, saveGuestDraft: () => undefined,
      } }],
    }).compileComponents();
    const fixture = TestBed.createComponent(StyleQuizPage);
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    const selected = (group: string) => Array.from(
      fixture.nativeElement.querySelectorAll(`[data-group="${group}"] .is-selected`),
    ).map((node) => (node as HTMLElement).getAttribute('data-value'));
    expect((fixture.nativeElement.querySelector('#input-height') as HTMLInputElement).value).toBe('175');
    expect((fixture.nativeElement.querySelector('#input-vong1') as HTMLInputElement).value).toBe('91');
    expect(selected('context')).toEqual(['Travel']);
    expect(selected('age')).toEqual(['35-44']);
    expect(selected('body-shape')).toEqual(['Rectangle']);
    expect(selected('skin-tone')).toEqual(['Cool']);
    expect(selected('main-style')).toEqual(['Classic', 'Street']);
    expect(selected('colors')).toEqual(['Onyx', 'Camel']);
    expect(selected('budget')).toEqual(['700k_1.5m']);
    expect(fixture.componentInstance.quizSaved()).toBe(true);
    fixture.destroy();
    localStorage.clear();
  });
});
