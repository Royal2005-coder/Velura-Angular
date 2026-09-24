import { Injectable, inject } from '@angular/core';
import { Observable, catchError, map, of, shareReplay } from 'rxjs';
import { ApiService } from './api.service';
import type { OfferCampaign, OffersResponse } from '../models/offer.interface';

/** Thanh tin và khối banner đọc lại sau chừng này, đủ để admin tạm dừng là khách thấy sớm. */
const CACHE_MS = 5 * 60 * 1000;

const EMPTY: OffersResponse = {
  success: false,
  generated_at: '',
  is_member: false,
  featured: [],
  campaigns: [],
  vouchers: [],
  birthday_prompt: null,
};

/**
 * Nguồn duy nhất cho ưu đãi hiển thị ở trang chủ, khung tin nổi và trang tài khoản.
 *
 * Trước đây ba chỗ đó đọc chung một mảng `HOT_BANNERS` viết cứng, nên chiến dịch admin
 * đã tạm dừng hoặc hết hạn vẫn được quảng cáo, còn chiến dịch mới thì không hiện. Giờ
 * mọi chỗ đọc `/api/user/offers`, cùng quy tắc vòng đời với bảng chiến dịch bên admin.
 *
 * Lỗi mạng trả về danh sách rỗng thay vì ném lỗi: thanh tin khuyến mãi không đáng làm
 * hỏng trang chủ.
 */
@Injectable({ providedIn: 'root' })
export class OffersService {
  private readonly api = inject(ApiService);
  private cached$: Observable<OffersResponse> | null = null;
  private cachedAt = 0;

  load(): Observable<OffersResponse> {
    if (!this.cached$ || Date.now() - this.cachedAt > CACHE_MS) {
      this.cachedAt = Date.now();
      this.cached$ = this.api.get<OffersResponse>('/api/user/offers').pipe(
        catchError(() => {
          // Lần sau thử lại, không giữ kết quả lỗi suốt năm phút.
          this.cached$ = null;
          return of(EMPTY);
        }),
        shareReplay({ bufferSize: 1, refCount: false }),
      );
    }
    return this.cached$;
  }

  /**
   * Chiến dịch để quảng bá: chiến dịch admin đánh dấu nổi bật, không có thì mọi chiến
   * dịch đang chạy.
   */
  highlights(): Observable<OfferCampaign[]> {
    return this.load().pipe(map((response) => (response.featured?.length ? response.featured : response.campaigns ?? [])));
  }

  /** Bỏ bộ nhớ đệm, ví dụ sau khi khách đăng nhập để thấy mã dành riêng. */
  invalidate(): void {
    this.cached$ = null;
  }
}
