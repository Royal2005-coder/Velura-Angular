import { Injectable, computed, signal } from '@angular/core';
import { UserSession } from '../models/user-session.interface';

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
   * Clears the persisted user session.
   */
  signOut(): void {
    localStorage.removeItem('velura_token');
    localStorage.removeItem('velura_user');
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
      return {
        userId: String(parsed['user_id'] || parsed['id'] || ''),
        email: typeof parsed['email'] === 'string' ? parsed['email'] : null,
        fullName: typeof parsed['full_name'] === 'string' ? parsed['full_name'] : null,
        phone: typeof parsed['phone'] === 'string' ? parsed['phone'] : null,
      };
    } catch {
      return null;
    }
  }
}
