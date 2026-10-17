import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

/** Catalog-only immutable generation input; absent material or care remains unknown. */
export interface CatalogSource {
  productId: string;
  version: number;
  revision: string;
  fields: Record<string, string>;
  photos: string[];
}
/** Exact quotes provide independently checkable factual evidence. */
export interface ContentClaim { text: string; sources: { field: string; quote: string }[]; }
/** Editable SEO draft contains no commercial or identity fields. */
export interface CatalogContent {
  title: ContentClaim; short: ContentClaim; long: ContentClaim;
  highlights: ContentClaim[]; styling: ContentClaim[]; care: ContentClaim[];
  seoTitle: ContentClaim; metaDescription: ContentClaim; proposedSlug: string;
  primaryKeywords: ContentClaim[]; secondaryKeywords: ContentClaim[];
  alt: { photo: string; claim: ContentClaim }[]; tags: ContentClaim[];
}
/** The original source/generation remains readable after review and publication. */
export interface CatalogDraft {
  id: string; product_id: string; source: CatalogSource; generated: CatalogContent;
  reviewed: CatalogContent | null; status: 'draft' | 'approved' | 'rejected' | 'published';
  version: number; created_at: string;
  metadata: { model: string; schema: string; prompt: string; sourceRevision: string };
}
/** Each product succeeds or fails independently; complete means all items reached a finite outcome. */
export interface CatalogBatch {
  id: string; status: 'queued' | 'running' | 'complete'; completed: number; total: number;
  items: { id: string; product_id: string; status: 'queued' | 'running' | 'success' | 'failed'; draft_id: string | null; error: string | null }[];
}
/** Authenticated HTTP Model for the scoped admin review component. */
@Injectable({ providedIn: 'root' })
export class AdminCatalogContentService {
  private readonly http = inject(HttpClient);
  private readonly url = `${environment.apiUrl || window.location.origin}/api/v1/admin/catalog-content`;
  /** Single and bulk generation share one durable idempotent queue. */
  generate(products: { productId: string; expectedVersion: number }[], idempotencyKey: string): Observable<CatalogBatch> {
    return this.http.post<CatalogBatch>(`${this.url}/batches`, { products, idempotencyKey });
  }
  /** Reads finite per-item progress. */
  batch(id: string): Observable<CatalogBatch> { return this.http.get<CatalogBatch>(`${this.url}/batches/${encodeURIComponent(id)}`); }
  /** Reads source context and review history for a saved product. */
  drafts(product: string): Observable<{ drafts: CatalogDraft[]; source: CatalogSource }> {
    return this.http.get<{ drafts: CatalogDraft[]; source: CatalogSource }>(`${this.url}/products/${encodeURIComponent(product)}/drafts`);
  }
  /** Saves edits or records an explicit approval/rejection without changing live content. */
  review(draft: CatalogDraft, content: unknown, decision: 'save' | 'approve' | 'reject'): Observable<CatalogDraft> {
    return this.http.post<CatalogDraft>(`${this.url}/drafts/${encodeURIComponent(draft.id)}/review`, { content, decision, expectedVersion: draft.version });
  }
  /** Explicit publication requires both immutable source version and latest review version. */
  publish(draft: CatalogDraft): Observable<CatalogDraft> {
    return this.http.post<CatalogDraft>(`${this.url}/drafts/${encodeURIComponent(draft.id)}/publish`, { expectedVersion: draft.source.version, expectedDraftVersion: draft.version });
  }
  /** Stores operator-confirmed facts separately from generated marketing copy. */
  facts(product: string, expectedVersion: number, fields: Record<string, string[]>): Observable<CatalogSource> {
    return this.http.put<CatalogSource>(`${this.url}/products/${encodeURIComponent(product)}/facts`, { expectedVersion, fields });
  }
}
