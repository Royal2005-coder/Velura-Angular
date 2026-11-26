import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';
import { ChatbotService } from './chatbot.service';

describe('ChatbotService guest tab isolation', () => {
  const configure = (opts: { sessionValue?: { userId: string } | null; kickOutLocked?: ReturnType<typeof vi.fn>; navigate?: ReturnType<typeof vi.fn> } = {}): ChatbotService => {
    TestBed.configureTestingModule({
      providers: [
        ChatbotService,
        { provide: ApiService, useValue: { get: vi.fn(), post: vi.fn(), delete: vi.fn() } },
        {
          provide: AuthService,
          useValue: {
            session: signal(opts.sessionValue ?? null),
            kickOutLocked: opts.kickOutLocked ?? vi.fn().mockReturnValue(true),
            signOut: vi.fn(),
          },
        },
        { provide: Router, useValue: { navigate: opts.navigate ?? vi.fn() } },
      ],
    });
    return TestBed.inject(ChatbotService);
  };

  beforeEach(() => {
    TestBed.resetTestingModule();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('does not resume a legacy persistent guest chat', () => {
    localStorage.setItem('velura_chat_guest_id', crypto.randomUUID());
    localStorage.setItem('velura_chat_session_id', crypto.randomUUID());
    localStorage.setItem('velura_chat_session_owner', 'guest:old');

    const chat = configure();

    expect(chat.savedSessionId()).toBe('');
    expect(localStorage.getItem('velura_chat_guest_id')).toBeNull();
    expect(localStorage.getItem('velura_chat_session_id')).toBeNull();
  });

  it('creates a different guest and empty chat after a reload without relying on storage cleanup', () => {
    const first = configure();
    const firstGuest = first.guestId();
    first.saveSessionId(crypto.randomUUID());
    expect(first.savedSessionId()).not.toBe('');

    TestBed.resetTestingModule();
    const next = configure();

    expect(next.guestId()).not.toBe(firstGuest);
    expect(next.savedSessionId()).toBe('');
    expect(sessionStorage.getItem('velura_chat_guest_id')).toBeNull();
  });

  it('uses sessionStorage member token and kicks out locked accounts on 423 in sendMessage', async () => {
    sessionStorage.setItem('velura_token', 'member-session-jwt');
    const kickOutLocked = vi.fn().mockReturnValue(true);
    const navigate = vi.fn();
    const chat = configure({ sessionValue: { userId: 'u1' }, kickOutLocked, navigate });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 'ACCOUNT_LOCKED', message: 'Tài khoản bị khóa.' } }), {
        status: 423,
        headers: { 'content-type': 'application/json' },
      }),
    );

    try {
      await expect(
        firstValueFrom(chat.sendMessage({ guestId: chat.guestId(), mode: 'user', message: 'Xin chào' })),
      ).rejects.toThrow();
      const [, init] = fetchSpy.mock.calls[0];
      const headers = init?.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer member-session-jwt');
      expect(kickOutLocked).toHaveBeenCalledWith('Tài khoản bị khóa.');
      expect(navigate).toHaveBeenCalledWith(['/auth/signin'], { queryParams: { locked: '1' }, replaceUrl: true });
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
