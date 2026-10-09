import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

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
export interface StudioAsset {
  id: string;
  label: string;
  gender?: string;
  season?: string;
  occasion?: string;
  badge?: string;
  preview_url?: string;
}
/** Runtime readiness is authoritative, including the installed model and catalog vector index. */
export interface AiCapabilities {
  product_supported?: boolean;
  variant_supported?: boolean;
  garment_category?: 'upper_body' | 'lower_body' | 'dresses';
  enabled: boolean;
  local_only: boolean;
  max_upload_bytes: number;
  private_ttl_seconds: number;
  tasks: { task: AiTask; enabled: boolean; reason?: string }[];
  studio_assets?: StudioAsset[];
}
/** Explicitly consented input; product and studio IDs are validated against server allowlists. */
export interface AiJobInput {
  task: AiTask;
  /** Existing catalog filter candidates, applied before the visual top-match limit. */
  filters?: { product_ids: string[] };
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
export class AiEngineService {
  /** Retrieves an allowlisted synthetic studio model for explicit preview before try-on consent. */
  studioPreview(id: string): Observable<Blob> {
    return this.http.get(`${this.base}/api/user/ai/studio/${encodeURIComponent(id)}`, {
      responseType: 'blob',
    });
  }
  /** Recovers an owner-private submission after the create response was lost. */
  recover(key: string): Observable<{ job: AiJob }> {
    return this.http.get<{ job: AiJob }>(
      `${this.base}/api/user/ai/jobs?idempotency_key=${encodeURIComponent(key)}`,
    );
  }
  /** Crops a selected garment region locally before consented upload; bounds never include hidden pixels. */
  async crop(
    file: File,
    crop: { x: number; y: number; width: number; height: number },
  ): Promise<File> {
    const values = Object.values(crop);
    if (
      values.some((value) => !Number.isFinite(value)) ||
      crop.x < 0 ||
      crop.y < 0 ||
      crop.width <= 0 ||
      crop.height <= 0 ||
      crop.x + crop.width > 100 ||
      crop.y + crop.height > 100
    )
      throw new Error('INVALID_CROP');
    const bitmap = await createImageBitmap(file);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round((bitmap.width * crop.width) / 100));
      canvas.height = Math.max(1, Math.round((bitmap.height * crop.height) / 100));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('CROP_UNAVAILABLE');
      context.drawImage(
        bitmap,
        (bitmap.width * crop.x) / 100,
        (bitmap.height * crop.y) / 100,
        canvas.width,
        canvas.height,
        0,
        0,
        canvas.width,
        canvas.height,
      );
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (value) => (value ? resolve(value) : reject(new Error('CROP_FAILED'))),
          'image/png',
        ),
      );
      return new File([blob], 'search-crop.png', { type: 'image/png' });
    } finally {
      bitmap.close();
    }
  }
  private readonly http = inject(HttpClient);
  private readonly base = environment.apiUrl || window.location.origin;
  /** Reads actual worker availability. */
  capabilities(productId?: string, variantId?: string): Observable<AiCapabilities> {
    const query = productId
      ? `?product_id=${encodeURIComponent(productId)}&variant_id=${encodeURIComponent(variantId || '')}`
      : '';
    return this.http.get<AiCapabilities>(`${this.base}/api/user/ai/capabilities${query}`);
  }
  /** Uploads one consented image to short-lived private storage. */
  upload(file: File): Observable<{ asset_id: string; expires_at: string }> {
    const body = new FormData();
    body.append('file', file);
    return this.http.post<{ asset_id: string; expires_at: string }>(
      `${this.base}/api/user/ai/uploads`,
      body,
    );
  }
  /** Queues a single operation; caller must keep the key for retry. */
  create(body: AiJobInput): Observable<{ job: AiJob }> {
    return this.http.post<{ job: AiJob }>(`${this.base}/api/user/ai/jobs`, body);
  }
  /** Reconciles server state without inferring success from elapsed time. */
  job(id: string): Observable<{ job: AiJob }> {
    return this.http.get<{ job: AiJob }>(`${this.base}/api/user/ai/jobs/${encodeURIComponent(id)}`);
  }
  /** Cancels work and prevents a late response from replacing a newer UI task. */
  cancel(id: string): Observable<unknown> {
    return this.http.delete(`${this.base}/api/user/ai/jobs/${encodeURIComponent(id)}`);
  }
  /** Retrieves an owner-private successful result. */
  result(id: string): Observable<Blob> {
    return this.http.get(`${this.base}/api/user/ai/jobs/${encodeURIComponent(id)}/result`, {
      responseType: 'blob',
    });
  }
}
