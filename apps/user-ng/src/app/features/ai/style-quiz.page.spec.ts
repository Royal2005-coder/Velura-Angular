import { createStorefrontPage } from '../../../testing/storefront-testing';
import { StyleQuizPage } from './style-quiz.page';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { Subject } from 'rxjs';
import { ApiService } from '../../core/services/api.service';

describe('StyleQuizPage', () => {
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(StyleQuizPage);
    expect(page).toBeTruthy();
  });

  it('keeps the summary recoverable and does not mark completion when saving fails', async () => {
    TestBed.resetTestingModule();
    localStorage.removeItem('velura_guest_quiz_completed');
    const request = new Subject<unknown>();
    const post = vi.fn(() => request);
    await TestBed.configureTestingModule({
      imports: [StyleQuizPage],
      providers: [provideRouter([]), { provide: ApiService, useValue: { post } }],
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
});
