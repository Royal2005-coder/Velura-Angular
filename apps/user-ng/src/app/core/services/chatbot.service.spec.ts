import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';
import { ChatbotService } from './chatbot.service';

describe('ChatbotService guest tab isolation', () => {
  const configure = (): ChatbotService => {
    TestBed.configureTestingModule({
      providers: [
        ChatbotService,
        { provide: ApiService, useValue: { get: vi.fn(), post: vi.fn(), delete: vi.fn() } },
        { provide: AuthService, useValue: { session: signal(null) } },
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

  it('creates a different guest and empty chat after the tab session ends', () => {
    const first = configure();
    const firstGuest = first.guestId();
    first.saveSessionId(crypto.randomUUID());
    expect(first.savedSessionId()).not.toBe('');

    TestBed.resetTestingModule();
    sessionStorage.clear();
    const next = configure();

    expect(next.guestId()).not.toBe(firstGuest);
    expect(next.savedSessionId()).toBe('');
  });
});
