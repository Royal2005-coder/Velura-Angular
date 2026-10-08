import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { AiEngineService } from './ai-engine.service';
import type { ProductSummary } from '../models/product.interface';

/** User-editable semantic attributes, not a stored image or inferred personal identity. */
export interface VisualAttributes { category: string | null; color: string | null; fit: string | null; material: string | null; style: string | null; }
/** Catalog filters are applied before semantic ranking. */
export interface VisualFilters { product_ids?: string[]; category_id?: string; min_price?: number; max_price?: number; color?: string; size?: string; body_shape?: string; }
/** Actual matches and explicitly separate featured suggestions. */
export interface VisualResult {
  refinement_token: string; attributes: VisualAttributes; keywords: string;
  matches: Array<ProductSummary & { similarity: number; rank_score?: number }>;
  featured: ProductSummary[]; catalog_version: string; personalized: boolean;
}
/** Camera/decode/crop and HTTP stay in the Model, never a page. */
@Injectable({ providedIn: 'root' })
export class VisualSearchModel {
  private readonly http = inject(HttpClient);
  private readonly image = inject(AiEngineService);
  private readonly base = `${environment.apiUrl || window.location.origin}/api/user/visual-search`;
  /** Read/sniff/decode a single bounded JPG/PNG/WEBP before displaying its preview. */
  async validate(file: File): Promise<void> {
    if (!file.size || file.size > 5 * 1024 * 1024) throw new Error('Chọn ảnh có dung lượng không quá 5 MB.');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Chỉ nhận JPG, PNG hoặc WEBP.');
    const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const png = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    const webp = String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
    if (!((file.type === 'image/png' && png) || (file.type === 'image/jpeg' && jpeg) || (file.type === 'image/webp' && webp))) throw new Error('Tệp không phải ảnh hợp lệ.');
    let bitmap: ImageBitmap | undefined;
    try {
      bitmap = await createImageBitmap(file);
      if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 20000000) throw new Error('Ảnh quá lớn.');
    } catch { throw new Error('Không đọc được ảnh. Chọn ảnh rõ nét khác, tối đa 20 megapixel.'); }
    finally { bitmap?.close(); }
  }
  /** Crop only the confirmed local garment region, then recheck the upload size. */
  async crop(file: File, crop: { x: number; y: number; width: number; height: number }): Promise<File> {
    const result = await this.image.crop(file, crop);
    await this.validate(result);
    return result;
  }
  /** Camera requires browser permission and a secure context; denial is a visible failure. */
  camera(): Promise<MediaStream> {
    return navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  }
  /** Capture one decoded camera frame without storing it in persistent browser storage. */
  async capture(video: HTMLVideoElement): Promise<File> {
    if (!video.videoWidth || !video.videoHeight) throw new Error('Máy ảnh chưa sẵn sàng.');
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Không chụp được ảnh.');
    context.drawImage(video, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Không chụp được ảnh.')), 'image/jpeg', 0.9));
    const file = new File([blob], 'camera.jpg', { type: 'image/jpeg' });
    await this.validate(file); return file;
  }
  /** Submit consent and exactly one cropped preview; transport retry is deliberately disabled. */
  search(file: File, requestId: string, filters: VisualFilters): Observable<VisualResult> {
    const body = new FormData();
    body.append('file', file);
    body.append('metadata', JSON.stringify({ request_id: requestId, filters, consent: true, confirmed: true }));
    return this.http.post<VisualResult>(this.base, body);
  }
  /** Requery attributes/keywords/filters using only the owner-bound source-free token. */
  refine(result: VisualResult, requestId: string, attributes: VisualAttributes, keywords: string, filters: VisualFilters): Observable<VisualResult> {
    return this.http.post<VisualResult>(`${this.base}/refine`, { refinement_token: result.refinement_token, request_id: requestId, attributes, keywords, filters });
  }
  /** Stop server work as well as ignoring late callbacks. */
  cancel(requestId: string): Observable<unknown> { return this.http.delete(`${this.base}/requests/${requestId}`); }
}
