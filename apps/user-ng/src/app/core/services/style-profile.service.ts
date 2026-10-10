import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { Observable, defer, map, of, switchMap } from 'rxjs';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';
import { guestSessionId, rotateGuestSession } from '../utils/guest-session';
import type { StyleProfileRecommendations, StyleQuizAnswers, StyleQuizRecord } from '../models/style-profile.interface';

/** Guest snapshot belongs to this tab's API identity; member profiles are stored only by the server. */
interface GuestProfileSnapshot { sessionId: string; answers: StyleQuizAnswers; claimedBy?: string; }
/** Successful quiz writes must be acknowledged before marking completion or changing personalization. */
interface QuizResponse { success: boolean; quiz?: StyleQuizRecord | null; migrated?: boolean; }

const SNAPSHOT_KEY = 'velura_session_style_profile';

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
