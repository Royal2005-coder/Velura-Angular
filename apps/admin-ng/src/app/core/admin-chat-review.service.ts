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

/** Ordinary transcripts omit restricted originals and classification context. */
export interface AdminReviewedChatMessage extends AdminChatMessageRow {
  moderation_status?: 'visible' | 'restricted';
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
export interface AdminReviewedChatSession extends AdminChatSessionRow {
  risk_level?: 'green' | 'yellow' | 'orange' | 'red';
  metadata?: {
    guest_email?: string;
    supervisor_required?: boolean;
    handoff_summary?: {
      summary?: string;
      problem?: string;
      wanted?: string;
      failed_approaches?: string[];
      verified_status?: string;
      risk?: string;
      sentiment?: string;
    };
  };
}

/** Moderation requires deliberate confirmation; corrections and outcomes are audit records only. */
export interface AdminChatReviewInput {
  action: 'correction' | 'outcome' | 'supervisor' | 'moderate';
  text: string;
  messageId?: string;
  classification?: AdminChatClassification;
  risk?: 'yellow' | 'orange' | 'red';
  confirmed?: boolean;
}

/** The server audits each supervisor original-content access. Never cache this response. */
export interface AdminChatOriginal {
  message_id: string;
  original_text: string;
  risk: string;
  reason: string;
}

/** Restricted review HTTP Model used by the existing Returns/CSKH page. */
@Injectable({ providedIn: 'root' })
export class AdminChatReviewService {
  private readonly http = inject(HttpClient);
  private readonly base = environment.apiUrl;

  /** Records a human correction/outcome or requests moderation/supervision, without training a model. */
  review(sessionId: string, body: AdminChatReviewInput): Observable<AdminChatMessagesPayload> {
    return this.http.post<AdminChatMessagesPayload>(`${this.base}/api/v1/admin/chat-sessions/${encodeURIComponent(sessionId)}/review`, body);
  }

  /** Retrieves the audited original only after the caller explicitly confirms privileged access. */
  original(sessionId: string, messageId: string): Observable<AdminChatOriginal> {
    return this.http.get<AdminChatOriginal>(`${this.base}/api/v1/admin/chat-sessions/${encodeURIComponent(sessionId)}/moderated/${encodeURIComponent(messageId)}`);
  }
}
