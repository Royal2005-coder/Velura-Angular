import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

/** Operations supported by the configured image worker; unavailable weights never imply a successful result. */
export type AiTask =
  'image_quality' | 'image_embedding' | 'virtual_try_on' | 'product_image_enhance';
/** Owner-private, expiring async image job. */
export interface AiJob {
  id: string;
  task: AiTask;
  status: 'queued' | 'running' | 'success' | 'validation_failed' | 'failed' | 'cancelled';
  created_at: string;
  expires_at: string;
  gate?: { valid?: boolean; reasons?: string[]; metrics?: Record<string, number> };
  error?: string;
  matches?: { product_id: string; score: number }[];
}
/** Runtime readiness is authoritative, including the installed model and catalog vector index. */
export interface AiCapabilities {
  enabled: boolean;
  local_only: boolean;
  max_upload_bytes: number;
  private_ttl_seconds: number;
  tasks: { task: AiTask; enabled: boolean; reason?: string }[];
  studio_assets?: { id: string; label: string; preview_url?: string }[];
}
/** Explicitly consented input; product and studio IDs are validated against server allowlists. */
export interface AiJobInput {
  catalog_index?: boolean;
  task: AiTask;
  person_check?: boolean;
  background?: 'white' | 'transparent';
  brightness?: boolean;
  sharpness?: boolean;
  image_asset_id?: string;
  person_asset_id?: string;
  product_id?: string;
  variant_id?: string;
  mode?: 'personal' | 'studio';
  studio_asset_id?: string;
  consent: true;
  confirmed: true;
  idempotency_key: string;
}
/** Image HTTP Model; private URLs must be retrieved through authenticated requests, not public img links. */
@Injectable({ providedIn: 'root' })
export class AdminAiEngineService {
  /** Recovers an owner-private submission when the browser lost the create response. */
  recover(key: string): Observable<{ job: AiJob }> {
    return this.http.get<{ job: AiJob }>(
      `${this.base}/api/ai/jobs?idempotency_key=${encodeURIComponent(key)}`,
    );
  }
  private readonly http = inject(HttpClient);
  private readonly base = environment.apiUrl || window.location.origin;
  /** Reads actual worker availability. */
  capabilities(): Observable<AiCapabilities> {
    return this.http.get<AiCapabilities>(`${this.base}/api/ai/capabilities`);
  }
  /** Uploads one consented image to short-lived private storage. */
  upload(file: File): Observable<{ asset_id: string; expires_at: string }> {
    const body = new FormData();
    body.append('file', file);
    return this.http.post<{ asset_id: string; expires_at: string }>(
      `${this.base}/api/ai/uploads`,
      body,
    );
  }
  /** Queues a single operation; caller must keep the key for retry. */
  create(body: AiJobInput): Observable<{ job: AiJob }> {
    return this.http.post<{ job: AiJob }>(`${this.base}/api/ai/jobs`, body);
  }
  /** Reconciles server state without inferring success from elapsed time. */
  job(id: string): Observable<{ job: AiJob }> {
    return this.http.get<{ job: AiJob }>(`${this.base}/api/ai/jobs/${encodeURIComponent(id)}`);
  }
  /** Cancels work and prevents a late response from replacing a newer UI task. */
  cancel(id: string): Observable<unknown> {
    return this.http.delete(`${this.base}/api/ai/jobs/${encodeURIComponent(id)}`);
  }
  /** Retrieves an owner-private successful result. */
  result(id: string): Observable<Blob> {
    return this.http.get(`${this.base}/api/ai/jobs/${encodeURIComponent(id)}/result`, {
      responseType: 'blob',
    });
  }
}
