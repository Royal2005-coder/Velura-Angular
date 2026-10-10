import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import type { AdminChatMessageRow, AdminChatMessagesPayload, AdminChatSessionRow } from './admin-api.service';

/** Staff correction of classification labels; never applied to accounts or automatic model training. */
export interface AdminChatClassification {
  intent: 'facts' | 'catalog' | 'policy_problem' | 'order' | 'human';
  level: 'L0' | 'L1' | 'L2' | 'L3';
  issue: 'general' | 'catalog' | 'sizing' | 'delivery' | 'return' | 'payment' | 'cancellation';
  sentiment: 'positive' | 'neutral' | 'negative';
  risk: 'green' | 'yellow' | 'orange' | 'red';
  moderation: 'none' | 'abuse' | 'threat' | 'illegal' | 'sensitive';
}

/** Public turns expose filtered text only; originals require a separate audited supervisor request. */
export interface AdminReviewedChatMessage extends AdminChatMessageRow {
  moderation_status?: 'pending' | 'visible' | 'restricted';
  metadata?: {
    product_ids?: string[];
    risk?: string;
    moderated?: boolean;
    system?: boolean;
    speaker?: string;
    classification?: AdminChatClassification;
  };
}

/** Supervisor-only handling remains enforced by the API; this metadata is a UI permission hint. */
export type AdminReviewedChatSession = AdminChatSessionRow;

/** Confirmed human decisions update the case without training a model or issuing financial benefits. */
export interface AdminChatReviewInput {
  action: 'correction' | 'outcome' | 'supervisor' | 'moderate' | 'refilter' | 'summary' | 'resolve' | 'reopen' | 'offer' | 'report_retry';
  text: string;
  messageId?: string;
  classification?: AdminChatClassification;
  risk?: 'yellow' | 'orange' | 'red';
  confirmed: true;
  summary?: { problem: string; wanted: string; failed_approaches: string[] };
  outcome?: { resolution: string; finalSentiment: 'positive' | 'neutral' | 'negative' };
  offerId?: string;
  reportId?: string;
  filteredText?: string;
}

/** The server audits each supervisor original-content access. Never cache this response. */
export interface AdminChatOriginal {
  message_id: string;
  original_text: string;
  risk: string;
  reason: string;
  original_metadata?: { attachment?: { data?: string; filename?: string; mimeType?: string } };
}

/** Restricted review HTTP Model used by the existing Returns/CSKH page. */
@Injectable({ providedIn: 'root' })
export class AdminChatReviewService {
  private readonly http = inject(HttpClient);
  private readonly base = environment.apiUrl;

  /** Persists confirmed review decisions; HTTP failure never implies a saved correction or offer. */
  review(sessionId: string, body: AdminChatReviewInput): Observable<AdminChatMessagesPayload> {
    return this.http.post<AdminChatMessagesPayload>(`${this.base}/api/v1/admin/chat-sessions/${encodeURIComponent(sessionId)}/review`, body);
  }

  /** Retrieves the audited original only after the caller explicitly confirms privileged access. */
  original(sessionId: string, messageId: string): Observable<AdminChatOriginal> {
    return this.http.get<AdminChatOriginal>(`${this.base}/api/v1/admin/chat-sessions/${encodeURIComponent(sessionId)}/moderated/${encodeURIComponent(messageId)}`);
  }
}
