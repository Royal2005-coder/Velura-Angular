import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of, Subject, throwError } from 'rxjs';
import { StyleProfileService } from './style-profile.service';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';
import type { UserSession } from '../models/user-session.interface';
import type { StyleQuizAnswers, StyleProfileRecommendations } from '../models/style-profile.interface';

const ANSWERS: StyleQuizAnswers = { height_cm: 162, weight_kg: 52, chest_cm: 84, waist_cm: 64, hip_cm: 90, body_shape: 'Pear', skin_tone: 'Neutral', style_tags: ['Classic'], preferred_occasions: [], favorite_brands: ['Velura'], budget_range: '300k_700k', age_group: '25-34', favorite_colors: [] };
const session = signal<UserSession | null>(null);
const get = vi.fn();
const post = vi.fn();

function member(id: string): UserSession { return { userId: id, email: null, fullName: null, phone: null, avatarUrl: null }; }
function model(): StyleProfileService {
  TestBed.configureTestingModule({ providers: [
    { provide: ApiService, useValue: { get, post } },
    { provide: AuthService, useValue: { session } },
  ] });
  return TestBed.inject(StyleProfileService);
}

describe('StyleProfileService account and guest isolation', () => {
  beforeEach(() => { localStorage.clear(); sessionStorage.clear(); session.set(null); get.mockReset(); post.mockReset(); post.mockReturnValue(of({ success: true })); });
  afterEach(() => TestBed.resetTestingModule());

  it('stores accepted guest measurements only in this tab and never restores persistent legacy data', async () => {
    localStorage.setItem('velura_guest_quiz_data', JSON.stringify({ ...ANSWERS, body_shape: 'Previous customer' }));
    const profile = model();
    expect(profile.guestAnswers()).toBeNull();
    expect(localStorage.getItem('velura_guest_quiz_data')).toBeNull();
    await firstValueFrom(profile.saveQuiz(ANSWERS));
    expect(profile.guestAnswers()?.body_shape).toBe('Pear');
    expect(localStorage.getItem('velura_guest_quiz_data')).toBeNull();
    sessionStorage.setItem('velura_guest_session_id', 'another-tab');
    expect(profile.guestAnswers()).toBeNull();
  });

  it('preserves the previously accepted guest quiz when a replacement save fails', async () => {
    const profile = model();
    await firstValueFrom(profile.saveQuiz(ANSWERS));
    post.mockReturnValue(throwError(() => new Error('Network unavailable')));
    await expect(firstValueFrom(profile.saveQuiz({ ...ANSWERS, body_shape: 'Rectangle' }))).rejects.toThrow('Network unavailable');
    expect(profile.guestAnswers()?.body_shape).toBe('Pear');
    expect(profile.revision()).toBe(1);
  });

  it('does not accept a late save after the authorization scope changes', async () => {
    const pending = new Subject<{ success: boolean }>();
    post.mockReturnValue(pending);
    const profile = model();
    const saved = firstValueFrom(profile.saveQuiz(ANSWERS));
    session.set(member('B'));
    pending.next({ success: true });
    await expect(saved).rejects.toThrow('Phiên người dùng đã thay đổi');
    expect(profile.revision()).toBe(0);
    session.set(null);
    expect(profile.guestAnswers()).toBeNull();
  });

  it('preserves the member profile and never writes member measurements into the guest snapshot', async () => {
    const profile = model();
    await firstValueFrom(profile.saveQuiz(ANSWERS));
    session.set(member('A'));
    get.mockReturnValue(of({ success: true, quiz: { body_shape: 'Rectangle' } }));
    post.mockClear();
    await firstValueFrom(profile.migrateGuestProfile());
    expect(post).not.toHaveBeenCalled();
    await firstValueFrom(profile.saveQuiz({ ...ANSWERS, body_shape: 'Rectangle' }));
    session.set(null);
    expect(profile.guestAnswers()).toBeNull();
  });

  it('retains a failed migration for its first member but cannot apply it to another account', async () => {
    const profile = model();
    await firstValueFrom(profile.saveQuiz(ANSWERS));
    session.set(member('A'));
    get.mockReturnValue(of({ success: true, quiz: null }));
    post.mockReturnValue(throwError(() => new Error('Save failed')));
    await expect(firstValueFrom(profile.migrateGuestProfile())).rejects.toThrow('Save failed');
    post.mockReturnValue(of({ success: true, migrated: true }));
    await firstValueFrom(profile.migrateGuestProfile());
    expect(post).toHaveBeenLastCalledWith('/api/user/style-quiz/migrate', ANSWERS);
    // Repeat a failed claim, then switch to B before retrying it.
    session.set(null);
    await firstValueFrom(profile.saveQuiz(ANSWERS));
    session.set(member('A'));
    post.mockReturnValue(throwError(() => new Error('Save failed')));
    await expect(firstValueFrom(profile.migrateGuestProfile())).rejects.toThrow('Save failed');
    session.set(member('B'));
    post.mockClear();
    await firstValueFrom(profile.migrateGuestProfile());
    expect(post).not.toHaveBeenCalled();
  });

  it('treats actual backend storage failure as an error and never uploads a fallback profile', async () => {
    const profile = model();
    await firstValueFrom(profile.saveQuiz(ANSWERS));
    post.mockClear();
    get.mockReturnValue(of({ success: true, quiz: null, source: 'db_error' } satisfies StyleProfileRecommendations));
    await expect(firstValueFrom(profile.loadRecommendations())).rejects.toThrow('Chưa tải được gợi ý');
    expect(post).not.toHaveBeenCalled();
  });

  it('validates current numeric quiz controls and requires an acknowledged successful write', async () => {
    const profile = model();
    await expect(firstValueFrom(profile.saveQuiz({ ...ANSWERS, height_cm: Number.NaN }))).rejects.toThrow('Chiều cao');
    expect(post).not.toHaveBeenCalled();
    post.mockReturnValue(of({ success: false }));
    await expect(firstValueFrom(profile.saveQuiz(ANSWERS))).rejects.toThrow('Chưa lưu được');
    expect(profile.revision()).toBe(0);
  });
});
