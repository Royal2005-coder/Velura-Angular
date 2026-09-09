import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';

export interface ChatMessage {
  message_id: string;
  session_id?: string;
  sender: 'bot' | 'user' | 'agent';
  text: string;
  created_at: string;
  product_ids?: string[];
  metadata?: {
    local_greeting?: boolean;
    typing?: boolean;
    error?: boolean;
    product_ids?: string[];
    blog_ids?: string[];
    attachment?: ChatAttachment | null;
    agent_joined?: boolean;
  };
}

export interface ChatAttachment {
  type: string;
  data: string;
  filename: string;
  mimeType: string;
}

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

export interface ChatSession {
  session_id: string;
  title?: string;
  updated_at?: string;
  last_message_preview?: string;
  handoff_status?: string;
}

export interface ChatSendResponse {
  session?: { session_id?: string };
  messages?: ChatMessage[];
  products?: ChatProduct[];
  blogs?: ChatBlog[];
  handoff?: { ticketId?: string; status?: string } | null;
}

const GUEST_ID_KEY = 'velura_chat_guest_id';
const SESSION_ID_KEY = 'velura_chat_session_id';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Chat model. Talks to the original `/api/v1/chat` contract used by port 3002.
 */
@Injectable({ providedIn: 'root' })
export class ChatbotService {
  private readonly api = inject(ApiService);

  /**
   * Sends a storefront chat turn to `/api/v1/chat/messages`.
   */
  sendMessage(payload: {
    sessionId?: string;
    guestId: string;
    mode: string;
    message: string;
    attachment?: ChatAttachment | null;
  }): Observable<ChatSendResponse> {
    return this.api.post<ChatSendResponse>('/api/v1/chat/messages', payload);
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

  /**
   * Deletes one chat session using the original DELETE body.
   */
  deleteSession(sessionId: string, guestId: string): Observable<unknown> {
    return this.api.delete(`/api/v1/chat/${encodeURIComponent(sessionId)}`, { guestId });
  }

  /**
   * Reuses the vanilla UUID guest-id localStorage key.
   */
  guestId(): string {
    const existing = localStorage.getItem(GUEST_ID_KEY);
    if (existing && UUID_RE.test(existing)) {
      return existing;
    }
    const created = crypto.randomUUID();
    localStorage.setItem(GUEST_ID_KEY, created);
    return created;
  }

  /**
   * Persists the active session id using the original chatbot key.
   */
  saveSessionId(sessionId: string): void {
    if (sessionId) {
      localStorage.setItem(SESSION_ID_KEY, sessionId);
    } else {
      localStorage.removeItem(SESSION_ID_KEY);
    }
  }

  /**
   * Clears the current session so a new chat starts like vanilla `initChatbot`.
   */
  clearSessionId(): void {
    localStorage.removeItem(SESSION_ID_KEY);
  }
}
