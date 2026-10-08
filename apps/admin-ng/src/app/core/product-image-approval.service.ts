import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

/** A reviewed immutable image URL, not yet published; the product save consumes its version-bound approval. */
export interface ProductImageApproval {
  approvalId: string;
  url: string;
  sourceRevision: string;
  processingVersion: string;
  expiresAt: string;
}
/** Server verifies the selected job/bytes belong to this administrator and match the expected product version. */
export interface ProductImageApprovalInput {
  productId: string | null;
  expectedVersion: number;
  jobId: string;
  selection: 'original' | 'enhanced';
  reviewConfirmed: true;
}
/** Scoped image Model; components never upload approved output again or publish it automatically. */
@Injectable({ providedIn: 'root' })
export class ProductImageApprovalService {
  private readonly http = inject(HttpClient);
  private readonly base = environment.apiUrl || window.location.origin;

  /** Stage an explicit reviewed selection; only the later product mutation publishes the returned URL. */
  approve(body: ProductImageApprovalInput): Observable<ProductImageApproval> {
    return this.http.post<ProductImageApproval>(`${this.base}/api/v1/admin/image-enhancement-approvals`, body);
  }
}
