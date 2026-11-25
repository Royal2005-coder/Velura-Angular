import { Injectable, computed, signal } from '@angular/core';
import { UserSession } from '../models/user-session.interface';
import { clearOAuthReturnUrl } from '../utils/auth-return-url';
import { rotateGuestSession } from '../utils/guest-session';

const GUEST_STYLE_QUIZ_WELCOME_SEEN_KEY = 'velura_guest_style_quiz_welcome_seen';

/**
 * Session ViewModel store. No HTTP. Auth API belongs in a dedicated command service later.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly sessionState = signal<UserSession | null>(this.readSession());

  readonly session = this.sessionState.asReadonly();
  readonly isLoggedIn = computed(() => this.sessionState() !== null);

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (event) => {
        if (event.key === 'velura_token' || event.key === 'velura_user') {
          this.refresh();
        }
      });
    }
  }
  /**
   * Persists the original token/user payload then refreshes header state.
   */
  applySession(token?: string, user?: Record<string, unknown>): void {
    if (token) {
      localStorage.setItem('velura_token', token);
    }
    if (user) {
      localStorage.setItem('velura_user', JSON.stringify(user));
    }
    this.refresh();
  }

  /**
   * Reloads session from localStorage after login/logout.
   *
   * The storage event can fire for an unrelated token rewrite; only emit a
   * changed value so effects (and VTO identity checks) do not loop.
   */
  refresh(): void {
    const next = this.readSession();
    const current = this.sessionState();
    if (current === next) return;
    if (
      current &&
      next &&
      current.userId === next.userId &&
      current.email === next.email &&
      current.fullName === next.fullName &&
      current.phone === next.phone &&
      current.avatarUrl === next.avatarUrl &&
      current.role === next.role &&
      current.isNewUser === next.isNewUser
    ) {
      return;
    }
    this.sessionState.set(next);
  }

  /** Synchronizes the server-authoritative role without replacing local profile fields. */
  syncRole(role: string | null | undefined): void {
    if (!role) return;
    const raw = localStorage.getItem('velura_user');
    if (raw) {
      try {
        const user = JSON.parse(raw) as Record<string, unknown>;
        user['role'] = role;
        localStorage.setItem('velura_user', JSON.stringify(user));
      } catch {
        // Keep the in-memory session authoritative when stale storage is malformed.
      }
    }
    const session = this.sessionState();
    if (session) this.sessionState.set({ ...session, role });
  }

  /**
   * Claims the Style Quiz promotion once for each guest tab or once for a newly activated member.
   * Existing members never receive the onboarding promotion, while a new member remains eligible
   * independently from a guest impression that happened before registration.
   */
  consumeStyleQuizWelcome(): boolean {
    const session = this.sessionState();
    if (!session) {
      if (typeof sessionStorage === 'undefined') return false;
      if (sessionStorage.getItem(GUEST_STYLE_QUIZ_WELCOME_SEEN_KEY) === '1') return false;
      sessionStorage.setItem(GUEST_STYLE_QUIZ_WELCOME_SEEN_KEY, '1');
      return true;
    }
    if (!session.isNewUser || session.role !== 'member') {
      return false;
    }
    const raw = localStorage.getItem('velura_user');
    if (raw) {
      try {
        const user = JSON.parse(raw) as Record<string, unknown>;
        user['is_new_user'] = false;
        localStorage.setItem('velura_user', JSON.stringify(user));
      } catch {
        localStorage.removeItem('velura_user');
      }
    }
    this.sessionState.set({ ...session, isNewUser: false });
    return true;
  }

  /**
   * Clears the persisted user session and leftover OAuth/storage keys.
   */
  signOut(): void {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('velura_token');
      localStorage.removeItem('velura_user');
      localStorage.removeItem('velura-user-oauth-pkce-code-verifier');
      localStorage.removeItem('velura-oauth-pkce-code-verifier');
      localStorage.removeItem('velura-user-oauth-state');
    }
    clearOAuthReturnUrl();
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem('velura_token');
      sessionStorage.removeItem('velura_user');
    }
    rotateGuestSession();
    this.sessionState.set(null);
  }

  private readSession(): UserSession | null {
    const token = (typeof localStorage !== 'undefined' ? localStorage.getItem('velura_token') : null)
      || (typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('velura_token') : null);
    if (!token) {
      return null;
    }
    const raw = (typeof localStorage !== 'undefined' ? localStorage.getItem('velura_user') : null)
      || (typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('velura_user') : null);
    let parsed: Record<string, unknown> = {};
    if (raw) {
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        parsed = {};
      }
    }
    if (!parsed['user_id'] && !parsed['id']) {
      try {
        const payloadBase64 = token.split('.')[1];
        if (payloadBase64 && typeof atob !== 'undefined') {
          const decoded = JSON.parse(atob(payloadBase64.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;
          if (decoded && typeof decoded === 'object') {
            parsed = { ...decoded, ...parsed };
          }
        }
      } catch {
        // ignore invalid token structure
      }
    }
    const userId = String(parsed['user_id'] || parsed['id'] || parsed['sub'] || '');
    if (!userId) {
      return null;
    }
    const nested = parsed['profile'] && typeof parsed['profile'] === 'object' ? (parsed['profile'] as Record<string, unknown>) : {};
    const fullNameCandidate = parsed['full_name'] || parsed['fullName'] || parsed['name'] || nested['full_name'];
    const avatarCandidate = parsed['avatar'] || parsed['avatar_url'] || nested['avatar'];
    return {
      userId,
      email: typeof parsed['email'] === 'string' ? parsed['email'] : null,
      fullName: typeof fullNameCandidate === 'string' ? fullNameCandidate : null,
      phone: typeof parsed['phone'] === 'string' ? parsed['phone'] : null,
      avatarUrl: typeof avatarCandidate === 'string' ? avatarCandidate : null,
      role: typeof parsed['role'] === 'string' ? parsed['role'] : null,
      isNewUser: parsed['is_new_user'] === true,
    };
  }
}
