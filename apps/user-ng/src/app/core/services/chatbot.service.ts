import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';
import { environment } from '../../../environments/environment';
import { guestSessionId } from '../utils/guest-session';
import { showToast } from '../utils/toast';

/** Server-owned conversation routing; every non-AI state suppresses new AI output. */
export type ChatHandoffStatus = 'ai' | 'requested' | 'assigned' | 'closed';
/** Public turn; only the owning customer may receive their exact quarantined author copy. */
export interface ChatMessage {
  message_id: string;
  session_id?: string;
  sender: 'bot' | 'user' | 'agent';
  text: string;
  created_at: string;
  product_ids?: string[];
  moderation_status?: 'pending' | 'visible' | 'restricted';
  metadata?: {
    local_greeting?: boolean;
    /** Browser-only author copy shown while the server moderates this exact outbound turn. */
    local_pending?: boolean;
    /** Server-authorized copy of this customer's own quarantined text. */
    author_copy?: boolean;
    typing?: boolean;
    error?: boolean;
    product_ids?: string[];
    blog_ids?: string[];
    attachment?: ChatAttachment | null;
    agent_joined?: boolean;
    system?: boolean;
    speaker?: 'SYSTEM' | 'HUMAN' | 'AI' | 'CUSTOMER';
    agent_name?: string;
    otp_required?: boolean;
  };
}

export interface ChatAttachment {
  type: string;
  data: string;
  filename: string;
  mimeType: string;
}

/** Live catalog card; a missing variant cannot be replaced with a product ID at checkout. */
export interface ChatProduct {
  product_id: string;
  name: string;
  image_url?: string;
  base_price?: number;
  sale_price?: number;
  price?: number;
  detail_url?: string;
  variant?: {
    variant_id?: string;
    color?: string;
    size?: string;
    stock_quantity?: number;
  } | null;
}

export interface ChatBlog {
  blog_id: string;
  slug?: string;
  title: string;
  excerpt?: string;
  image_url?: string;
  author?: string;
  read_minutes?: number;
}

/** Owned conversation history with server-controlled lifecycle routing. */
export interface ChatSession {
  session_id: string;
  title?: string;
  updated_at?: string;
  last_message_preview?: string;
  handoff_status?: ChatHandoffStatus;
}

/** Authoritative filtered transcript and current catalog state returned after reads or committed actions. */
export interface ChatSendResponse {
  session?: {
    session_id?: string;
    handoff_status?: ChatHandoffStatus;
    metadata?: {
      handoff_summary?: { problem?: string; wanted?: string; source_sequence?: number };
      summary_confirmation?: { confirmed?: boolean; source_seq?: number; at?: string };
      outcome?: { resolution?: string; rating?: number };
      rating?: number;
      previous_session_id?: string;
    };
  };
  messages?: ChatMessage[];
  products?: ChatProduct[];
  blogs?: ChatBlog[];
  handoff?: { ticketId?: string; status?: ChatHandoffStatus } | null;
}

const GUEST_ID_KEY = 'velura_chat_guest_id';
const SESSION_ID_KEY = 'velura_chat_session_id';
const SESSION_OWNER_KEY = 'velura_chat_session_owner';

/**
 * Stable logical owner key for chat identity checks so background role/profile
 * refreshes on the same signed-in member never reset an active conversation.
 */
export function chatIdentityKey(session: { userId?: string | null; email?: string | null } | null | undefined): string {
  if (!session) return 'guest';
  return `member:${session.userId || session.email || 'auth'}`;
}

/**
 * Chat model. Talks to the original `/api/v1/chat` contract used by port 3002.
 */
@Injectable({ providedIn: 'root' })
export class ChatbotService {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  readonly activeHandoff = signal<ChatHandoffStatus>('ai');
  readonly activeSession = signal('');
  private readonly auth = inject(AuthService);
  private readonly pageGuestId = crypto.randomUUID();
  private guestSessionId = '';
  constructor() {
    // Guest chat identity/session must not outlive this browser tab. sessionStorage
    // alone doesn't guarantee that: it survives reloads by design, and browsers copy
    // it into tabs opened via duplicate/reopen-closed-tab. So on every real page load
    // (this service is a root singleton constructed once per load) we drop any saved
    // guest identity unless a member is logged in, forcing a fresh guestId per load.
    if (typeof sessionStorage !== 'undefined' && !this.auth.session()) {
      sessionStorage.removeItem(GUEST_ID_KEY);
      sessionStorage.removeItem(SESSION_ID_KEY);
      sessionStorage.removeItem(SESSION_OWNER_KEY);
    }
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(GUEST_ID_KEY);
      localStorage.removeItem(SESSION_ID_KEY);
      localStorage.removeItem(SESSION_OWNER_KEY);
    }
    let identityKey = chatIdentityKey(this.auth.session());
    effect(() => {
      const nextKey = chatIdentityKey(this.auth.session());
      if (nextKey === identityKey) return;
      identityKey = nextKey;
      untracked(() => { this.activeHandoff.set('ai'); this.activeSession.set(''); this.clearSessionId(); });
    });
  }

  /**
   * Streams processing events, exposing only the server-reviewed committed response; unsubscribe aborts transport.
   */
  sendMessage(payload: {
    sessionId?: string;
    guestId: string;
    mode: string;
    message: string;
    attachment?: ChatAttachment | null;
    orderId?: string;
    guestAccessToken?: string;
  }): Observable<ChatSendResponse> {
    return new Observable<ChatSendResponse>(subscriber => {
      const controller = new AbortController();
      const identityKey = chatIdentityKey(this.auth.session());
      const token =
        (typeof localStorage !== 'undefined' ? localStorage.getItem('velura_token') : null) ||
        (typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('velura_token') : null);
      const headers: Record<string, string> = {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        'X-Guest-Session-ID': guestSessionId(),
      };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const receive = async (): Promise<void> => {
        const response = await fetch(`${environment.apiUrl || window.location.origin}/api/v1/chat/messages`, {
          method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal,
        });
        if (identityKey !== chatIdentityKey(this.auth.session())) throw new Error('Chat identity changed');
        if (!response.ok) {
          let payloadBody: Record<string, unknown> | null = null;
          try {
            const parsed = await response.json() as unknown;
            if (parsed && typeof parsed === 'object') payloadBody = parsed as Record<string, unknown>;
          } catch {}
          const nested = payloadBody?.['error'] && typeof payloadBody['error'] === 'object'
            ? (payloadBody['error'] as Record<string, unknown>)
            : null;
          const errorCode = typeof nested?.['code'] === 'string' ? nested['code'] : typeof payloadBody?.['code'] === 'string' ? payloadBody['code'] : '';
          const errorMsg = (typeof nested?.['message'] === 'string' && nested['message'])
            || (typeof payloadBody?.['message'] === 'string' && payloadBody['message'])
            || '';
          if (token && (response.status === 423 || errorCode === 'ACCOUNT_LOCKED')) {
            const msg = errorMsg.trim() || 'Tài khoản của bạn đã bị khóa. Vui lòng liên hệ CSKH để được hỗ trợ.';
            if (this.auth.kickOutLocked?.(msg)) {
              showToast(msg);
              void this.router.navigate(['/auth/signin'], { queryParams: { locked: '1' }, replaceUrl: true });
            }
            throw new Error(msg);
          }
          if (token && response.status === 401) {
            this.auth.signOut?.();
          }
          throw new Error(errorMsg || 'Chat request failed');
        }
        if (!response.headers.get('content-type')?.includes('text/event-stream')) {
          const data = await response.json() as ChatSendResponse;
          if (identityKey === chatIdentityKey(this.auth.session())) subscriber.next(data);
          subscriber.complete();
          return;
        }
        if (!response.body) throw new Error('Chat stream unavailable');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let received = false;
        try {
          while (!subscriber.closed) {
            const chunk = await reader.read();
            buffer += decoder.decode(chunk.value, { stream: !chunk.done });
            buffer = buffer.replace(/\r\n/g, '\n');
            let boundary: number;
            while ((boundary = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const lines = frame.split('\n');
              const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
              if (event === 'error') throw new Error('Chat stream failed');
              if (event !== 'response') continue;
              const data = JSON.parse(lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')) as ChatSendResponse;
              if (identityKey !== chatIdentityKey(this.auth.session())) throw new Error('Chat identity changed');
              if (received) throw new Error('Duplicate chat response');
              received = true;
              subscriber.next(data);
            }
            if (chunk.done) break;
          }
          if (!received && !subscriber.closed) throw new Error('Chat stream interrupted');
          subscriber.complete();
        } finally {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      };
      void receive().catch(() => { if (!subscriber.closed) subscriber.error(new Error('Chưa nhận được phản hồi. Vui lòng tải lại hội thoại.')); });
      return () => controller.abort();
    });
  }

  /**
   * Loads guest/member chat sessions for the history sidebar.
   */
  listSessions(guestId: string): Observable<{ rows?: ChatSession[] }> {
    return this.api.get<{ rows?: ChatSession[] }>(`/api/v1/chat/sessions?guestId=${encodeURIComponent(guestId)}&limit=50`);
  }

  /**
   * Loads messages and hydrated product cards for one session.
   */
  listMessages(sessionId: string, guestId: string): Observable<ChatSendResponse> {
    return this.api.get<ChatSendResponse>(
      `/api/v1/chat/${encodeURIComponent(sessionId)}/messages?guestId=${encodeURIComponent(guestId)}&limit=150`,
    );
  }

  /** Reopens the owned closed case or records its customer rating; server validates lifecycle state. */
  lifecycle(sessionId: string, body: { guestId: string; action: 'reopen' | 'rating' | 'confirm_summary'; text?: string; rating?: number; confirmed?: boolean; sourceSequence?: number }): Observable<ChatSendResponse> {
    return this.api.post<ChatSendResponse>(`/api/v1/chat/${encodeURIComponent(sessionId)}/lifecycle`, body);
  }

  /**
   * Deletes one chat session using the original DELETE body.
   */
  deleteSession(sessionId: string, guestId: string): Observable<unknown> {
    return this.api.delete(`/api/v1/chat/${encodeURIComponent(sessionId)}`, { guestId });
  }

  /** Keeps an anonymous owner only in this page instance, so reload and a new tab start fresh. */
  guestId(): string {
    return this.pageGuestId;
  }

  /** Keeps guest sessions in memory; only signed-in members may resume from session storage. */
  saveSessionId(sessionId: string): void {
    if (!this.auth.session()) {
      this.guestSessionId = sessionId;
      return;
    }
    if (sessionId) {
      sessionStorage.setItem(SESSION_ID_KEY, sessionId);
      sessionStorage.setItem(SESSION_OWNER_KEY, this.ownerKey());
    } else {
      sessionStorage.removeItem(SESSION_ID_KEY);
      sessionStorage.removeItem(SESSION_OWNER_KEY);
    }
  }

  /** Resumes only the session saved by the current member or guest identity; API rechecks ownership. */
  savedSessionId(): string {
    if (!this.auth.session()) return this.guestSessionId;
    return sessionStorage.getItem(SESSION_OWNER_KEY) === this.ownerKey() ? sessionStorage.getItem(SESSION_ID_KEY) || '' : '';
  }

  private ownerKey(): string {
    return this.auth.session()?.userId ? `member:${this.auth.session()!.userId}` : `guest:${this.guestId()}`;
  }

  /**
   * Clears the current session so a new chat starts like vanilla `initChatbot`.
   */
  clearSessionId(): void {
    this.guestSessionId = '';
    sessionStorage.removeItem(SESSION_ID_KEY);
    sessionStorage.removeItem(SESSION_OWNER_KEY);
  }
}
