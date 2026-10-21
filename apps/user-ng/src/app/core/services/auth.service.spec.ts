import { TestBed } from '@angular/core/testing';
import { AuthService } from './auth.service';
import { guestSessionId } from '../utils/guest-session';

describe('AuthService', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    TestBed.resetTestingModule();
  });

  it('consumes a new member welcome flag exactly once', () => {
    localStorage.setItem('velura_token', 'token');
    localStorage.setItem('velura_user', JSON.stringify({
      user_id: 'member-1',
      role: 'member',
      is_new_user: true,
    }));
    const auth = TestBed.inject(AuthService);

    expect(auth.consumeNewMemberWelcome()).toBe(true);
    expect(auth.consumeNewMemberWelcome()).toBe(false);
    expect(JSON.parse(localStorage.getItem('velura_user') || '{}').is_new_user).toBe(false);
  });

  it('does not show the welcome banner for a normal member login', () => {
    localStorage.setItem('velura_token', 'token');
    localStorage.setItem('velura_user', JSON.stringify({
      user_id: 'member-1',
      role: 'member',
      is_new_user: false,
    }));
    const auth = TestBed.inject(AuthService);

    expect(auth.consumeNewMemberWelcome()).toBe(false);
  });

  it('rotates to a new guest identity immediately when a member signs out', () => {
    localStorage.setItem('velura_token', 'token');
    localStorage.setItem('velura_user', JSON.stringify({ user_id: 'member-1', role: 'member' }));
    const previousGuestId = guestSessionId();
    const auth = TestBed.inject(AuthService);

    auth.signOut();

    expect(auth.session()).toBeNull();
    expect(guestSessionId()).not.toBe(previousGuestId);
  });

  it('restores a session from sessionStorage and the JWT subject', () => {
    const payload = btoa(JSON.stringify({ sub: 'member-session', email: 'session@example.com' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    sessionStorage.setItem('velura_token', `header.${payload}.signature`);
    const auth = TestBed.inject(AuthService);

    expect(auth.session()?.userId).toBe('member-session');
    expect(auth.session()?.email).toBe('session@example.com');
    expect(auth.isLoggedIn()).toBe(true);
  });
});
