import { Injectable, computed, signal } from '@angular/core';
import { UserSession } from '../models/user-session.interface';
import { rotateGuestSession } from '../utils/guest-session';

/**
 * Session ViewModel store. No HTTP. Auth API belongs in a dedicated command service later.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly sessionState = signal<UserSession | null>(this.readSession());

  readonly session = this.sessionState.asReadonly();
  readonly isLoggedIn = computed(() => this.sessionState() !== null);

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
   */
  refresh(): void {
    this.sessionState.set(this.readSession());
  }

  /**
   * Consumes the one-time welcome flag created by successful member registration.
   * The persisted payload is cleared before the banner opens so refresh/login cannot replay it.
   */
  consumeNewMemberWelcome(): boolean {
    const session = this.sessionState();
    if (!session?.isNewUser || session.role !== 'member') {
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
    localStorage.removeItem('velura_token');
    localStorage.removeItem('velura_user');
    localStorage.removeItem('velura-user-oauth-pkce-code-verifier');
    localStorage.removeItem('velura-oauth-pkce-code-verifier');
    sessionStorage.removeItem('velura_token');
    sessionStorage.removeItem('velura_user');
    rotateGuestSession();
    this.sessionState.set(null);
  }

  private readSession(): UserSession | null {
    const token = localStorage.getItem('velura_token');
    const raw = localStorage.getItem('velura_user');
    if (!token || !raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const nested = parsed['profile'] && typeof parsed['profile'] === 'object' ? (parsed['profile'] as Record<string, unknown>) : {};
      const fullNameCandidate = parsed['full_name'] || parsed['fullName'] || parsed['name'] || nested['full_name'];
      const avatarCandidate = parsed['avatar'] || parsed['avatar_url'] || nested['avatar'];
      return {
        userId: String(parsed['user_id'] || parsed['id'] || ''),
        email: typeof parsed['email'] === 'string' ? parsed['email'] : null,
        fullName: typeof fullNameCandidate === 'string' ? fullNameCandidate : null,
        phone: typeof parsed['phone'] === 'string' ? parsed['phone'] : null,
        avatarUrl: typeof avatarCandidate === 'string' ? avatarCandidate : null,
        role: typeof parsed['role'] === 'string' ? parsed['role'] : null,
        isNewUser: parsed['is_new_user'] === true,
      };
    } catch {
      return null;
    }
  }
}
