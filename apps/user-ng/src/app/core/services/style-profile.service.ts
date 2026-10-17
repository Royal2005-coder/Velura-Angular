import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { Observable, defer, map, of, switchMap } from 'rxjs';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';
import { guestSessionId, rotateGuestSession } from '../utils/guest-session';
import type { StyleProfileRecommendations, StyleQuizAnswers, StyleQuizDraft, StyleQuizRecord } from '../models/style-profile.interface';

/** Guest snapshot belongs to this tab's API identity; member profiles are stored only by the server. */
interface GuestProfileSnapshot { sessionId: string; answers: StyleQuizAnswers; claimedBy?: string; }
/** Successful quiz writes must be acknowledged before marking completion or changing personalization. */
interface QuizResponse { success: boolean; quiz?: StyleQuizRecord | null; migrated?: boolean; }

const SNAPSHOT_KEY = 'velura_session_style_profile';
const DRAFT_KEY = 'velura_session_style_quiz_draft';

/** Shared Style Profile Model, preserving member data and rejecting callbacks from another account. */
@Injectable({ providedIn: 'root' })
export class StyleProfileService {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  /** Refresh dependent personalization only after the server accepts a profile change. */
  readonly revision = signal(0);

  constructor() {
    // Old persistent body measurements have no tab provenance and must never be uploaded automatically.
    localStorage.removeItem('velura_guest_quiz_data');
    localStorage.removeItem('velura_guest_quiz_completed');
    localStorage.removeItem('velura_suggestions_enabled');
    let previous = this.auth.session();
    effect(() => {
      const current = this.auth.session();
      if (previous && current !== previous) untracked(() => { this.clearGuest(); rotateGuestSession(); });
      previous = current;
    });
  }

  /** Save the existing quiz once; guest answers stay in this tab only after API acknowledgement. */
  saveQuiz(answers: StyleQuizAnswers): Observable<void> {
    return defer(() => {
      this.validateAnswers(answers);
      const session = this.auth.session();
      const id = guestSessionId();
      return this.api.post<QuizResponse>('/api/user/style-quiz', answers).pipe(map((response) => {
        this.assertScope(session, id);
        if (response.success !== true) throw new Error('Chưa lưu được hồ sơ phong cách. Hãy thử lại.');
        if (!session) sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ sessionId: id, answers } satisfies GuestProfileSnapshot));
        else this.clearGuest();
        this.revision.update((value) => value + 1);
      }));
    });
  }

  /** Restore only accepted answers from the current guest tab, never another member's measurements. */
  guestAnswers(): StyleQuizAnswers | null {
    if (this.auth.session()) return null;
    return this.readSnapshot();
  }

  /** Loads the signed-in member's previously accepted answers for editing the Style Quiz. */
  loadQuiz(): Observable<Partial<StyleQuizAnswers> | null> {
    return defer(() => {
      if (!this.auth.session()) return of(this.readSnapshot());
      return this.api.get<QuizResponse>('/api/user/style-quiz').pipe(map((response) => {
        if (response.success !== true) throw new Error('Chưa tải được Style Profile. Hãy thử lại.');
        return response.quiz ? this.normalizeQuiz(response.quiz) : null;
      }));
    });
  }

  /** Stores an incomplete guest quiz only in the current tab until registration claims it. */
  saveGuestDraft(draft: StyleQuizDraft): void {
    if (this.auth.session()) return;
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ sessionId: guestSessionId(), draft }));
  }

  /** Restores an incomplete draft only for the current guest tab. */
  guestDraft(): StyleQuizDraft | null {
    if (this.auth.session()) return null;
    try {
      const value = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || 'null') as { sessionId?: string; draft?: StyleQuizDraft } | null;
      return value?.sessionId === guestSessionId() && value.draft ? value.draft : null;
    } catch { return null; }
  }

  /** Claims the same-tab guest draft after signup without marking the quiz complete. */
  claimGuestDraft(): Observable<void> {
    return defer(() => {
      const session = this.auth.session();
      const raw = sessionStorage.getItem(DRAFT_KEY);
      if (!session || !raw) return of(undefined);
      let stored: { sessionId?: string; draft?: StyleQuizDraft } | null = null;
      try { stored = JSON.parse(raw) as { sessionId?: string; draft?: StyleQuizDraft }; } catch { return of(undefined); }
      if (stored?.sessionId !== guestSessionId() || !stored.draft) return of(undefined);
      return this.api.post<QuizResponse>('/api/user/style-quiz/draft', stored.draft.answers).pipe(map((response) => {
        if (response.success !== true) throw new Error('Chưa lưu được Style Quiz dang dở vào tài khoản.');
        sessionStorage.removeItem(DRAFT_KEY);
      }));
    });
  }

  /** Preserve an existing member profile; migrate a same-tab guest quiz only when the member has none. */
  migrateGuestProfile(): Observable<void> {
    return defer(() => {
      const session = this.auth.session();
      const answers = this.readSnapshot();
      if (!session || !answers) return of(undefined);
      const id = guestSessionId();
      sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ sessionId: id, answers, claimedBy: session.userId } satisfies GuestProfileSnapshot));
      return this.api.get<QuizResponse>('/api/user/style-quiz').pipe(
        switchMap((response) => {
          this.assertScope(session, id);
          if (response.success !== true) throw new Error('Chưa kiểm tra được hồ sơ thành viên. Hãy thử lại.');
          if (response.quiz) { this.clearGuest(); return of(undefined); }
          return this.api.post<QuizResponse>('/api/user/style-quiz/migrate', answers).pipe(map((saved) => {
            this.assertScope(session, id);
            if (saved.success !== true || saved.migrated !== true) throw new Error('Chưa chuyển được hồ sơ phong cách. Hãy thử lại.');
            this.clearGuest();
          }));
        }),
      );
    });
  }

  /** Fetch current personalization; failed storage reads are errors, never a successful missing-profile state. */
  loadRecommendations(): Observable<StyleProfileRecommendations> {
    return defer(() => {
      const session = this.auth.session();
      const id = guestSessionId();
      const read = () => this.api.get<StyleProfileRecommendations>('/api/user/recommendations/style-profile').pipe(map((response) => {
        this.assertScope(session, id);
        if (response.success === false || response.source === 'db_error') throw new Error('Chưa tải được gợi ý phong cách. Vui lòng thử lại.');
        return response;
      }));
      return this.migrateGuestProfile().pipe(switchMap(() => read()), switchMap((response) => {
        const answers = !session ? this.readSnapshot() : null;
        if (response.quiz || !answers) return of(response);
        // API restart can lose its guest-memory map. Restore only this tab's acknowledged snapshot.
        return this.api.post<QuizResponse>('/api/user/style-quiz', answers).pipe(switchMap((saved) => {
          this.assertScope(session, id);
          if (saved.success !== true) throw new Error('Chưa khôi phục được hồ sơ phong cách. Hãy thử lại.');
          return read();
        }));
      }));
    });
  }

  private clearGuest(): void { sessionStorage.removeItem(SNAPSHOT_KEY); }

  private readSnapshot(): StyleQuizAnswers | null {
    try {
      const raw = sessionStorage.getItem(SNAPSHOT_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as GuestProfileSnapshot;
      if (parsed.sessionId !== guestSessionId() || !parsed.answers) return null;
      if (parsed.claimedBy && parsed.claimedBy !== this.auth.session()?.userId) { this.clearGuest(); return null; }
      this.validateAnswers(parsed.answers);
      return parsed.answers;
    } catch { return null; }
  }

  private assertScope(session: ReturnType<AuthService['session']>, id: string): void {
    if (session !== this.auth.session() || id !== guestSessionId()) throw new Error('Phiên người dùng đã thay đổi. Vui lòng tải lại.');
  }

  private normalizeQuiz(quiz: StyleQuizRecord): Partial<StyleQuizAnswers> {
    const values = (value: string[] | string | null | undefined): string[] => {
      if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
      if (!value) return [];
      try {
        const parsed = JSON.parse(value) as unknown;
        if (Array.isArray(parsed)) return parsed.map((item) => String(item).trim()).filter(Boolean);
      } catch {
        // Legacy profiles may store comma-separated values rather than JSON arrays.
      }
      return value.split(',').map((item) => item.trim()).filter(Boolean);
    };
    const number = (value: number | null | undefined): number | undefined =>
      typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    const text = (value: string | null | undefined): string | undefined => value || undefined;
    return {
      height_cm: number(quiz.height_cm), weight_kg: number(quiz.weight_kg),
      chest_cm: number(quiz.chest_cm), waist_cm: number(quiz.waist_cm), hip_cm: number(quiz.hip_cm),
      body_shape: text(quiz.body_shape), skin_tone: text(quiz.skin_tone),
      style_tags: values(quiz.style_tags), preferred_occasions: values(quiz.preferred_occasions),
      favorite_brands: values(quiz.favorite_brands), budget_range: text(quiz.budget_range),
      age_group: text(quiz.age_group), favorite_colors: values(quiz.favorite_colors),
    };
  }

  private validateAnswers(answers: StyleQuizAnswers): void {
    // Bounds match the current quiz controls, not a new Personal Color/provider policy.
    const bounds: Array<[number, number, number, string]> = [
      [answers.height_cm, 100, 220, 'Chiều cao'], [answers.weight_kg, 30, 150, 'Cân nặng'],
      [answers.chest_cm, 50, 150, 'Vòng ngực'], [answers.waist_cm, 40, 130, 'Vòng eo'], [answers.hip_cm, 60, 160, 'Vòng hông'],
    ];
    for (const [value, min, max, label] of bounds) {
      if (!Number.isFinite(value) || (value !== 0 && (value < min || value > max))) throw new Error(`${label} cần nằm trong khoảng ${min}–${max}.`);
    }
    if (answers.height_cm === 0 || answers.weight_kg === 0) throw new Error('Nhập chiều cao và cân nặng.');
  }
}
