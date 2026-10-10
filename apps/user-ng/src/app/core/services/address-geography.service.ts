import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, map, shareReplay, throwError, timeout } from 'rxjs';
import type { GeographyDataset, GeographyMode } from '../models/address-geography';

/** Loads attributed administrative snapshots from this storefront's own origin. */
@Injectable({ providedIn: 'root' })
export class AddressGeographyService {
  private readonly http = inject(HttpClient);
  private readonly cache = new Map<GeographyMode, Observable<GeographyDataset>>();

  /** Cache successful snapshots; failed loads remain retryable without stale values. */
  load(mode: GeographyMode): Observable<GeographyDataset> {
    const cached = this.cache.get(mode);
    if (cached) return cached;
    const request = this.http.get<GeographyDataset>(`/assets/geography/vietnam-${mode}-2025.json`).pipe(
      timeout(10000),
      map((data) => {
        if (data.mode !== mode || !Array.isArray(data.provinces) || !data.provinces.length) {
          throw new Error('Danh mục địa chỉ chưa sẵn sàng.');
        }
        return data;
      }),
      catchError((error: unknown) => {
        this.cache.delete(mode);
        return throwError(() => error);
      }),
      shareReplay({ bufferSize: 1, refCount: true }),
    );
    this.cache.set(mode, request);
    return request;
  }
}
