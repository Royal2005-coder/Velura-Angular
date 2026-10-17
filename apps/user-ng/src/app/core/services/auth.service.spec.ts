import { TestBed } from '@angular/core/testing';
import { AuthService } from './auth.service';

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
});
