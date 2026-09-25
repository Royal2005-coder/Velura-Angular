import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, throwError } from 'rxjs';
import { environment } from '../../../environments/environment';
import { ApiErrorBody } from '../models/api-error.interface';
import { ApiRequestError } from '../models/api-request-error';

/**
 * HTTP model for the storefront SPA. Pages must not inject HttpClient.
 * JSON contracts live on the Node API (`apps/api`); this class only maps HTTP.
 * Trace a path change with `git log --show-notes --follow -- this file`.
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = environment.apiUrl || window.location.origin;

  /**
   * Performs a JSON GET against the Velura API.
   */
  get<T>(path: string): Observable<T> {
    return this.http.get<T>(`${this.baseUrl}${path}`).pipe(catchError((error) => this.mapError(error)));
  }

  /**
   * Performs a JSON POST against the Velura API.
   */
  post<T>(path: string, body: unknown): Observable<T> {
    return this.http
      .post<T>(`${this.baseUrl}${path}`, body)
      .pipe(catchError((error) => this.mapError(error)));
  }

  /**
   * Performs a JSON PATCH against the Velura API.
   */
  patch<T>(path: string, body: unknown): Observable<T> {
    return this.http
      .patch<T>(`${this.baseUrl}${path}`, body)
      .pipe(catchError((error) => this.mapError(error)));
  }

  /**
   * Performs a JSON DELETE against the Velura API.
   */
  delete<T>(path: string, body?: unknown): Observable<T> {
    const options = body === undefined ? {} : { body };
    return this.http.delete<T>(`${this.baseUrl}${path}`, options).pipe(catchError((error) => this.mapError(error)));
  }

  private mapError(error: unknown): Observable<never> {
    if (error instanceof HttpErrorResponse) {
      const body = error.error as {
        error?: ApiErrorBody;
        message?: string;
        code?: string;
        items?: Array<{
          variant_id?: string;
          product_name?: string;
          color?: string;
          size?: string;
          available?: number;
          requested?: number;
        }>;
        details?: unknown;
      } | null;

      const code = body?.error?.code || body?.code || null;
      const details = body?.error?.details || (body?.items ? { items: body.items } : body?.details);
      let message = body?.error?.message || body?.message;

      if (code === 'INSUFFICIENT_STOCK' && Array.isArray(body?.items) && body.items.length > 0) {
        const itemDescriptions = body.items.map((it) => {
          const variantInfo = [it.color, it.size].filter(Boolean).join(' / ');
          return `${it.product_name || 'Sản phẩm'}${variantInfo ? ` (${variantInfo})` : ''}: còn ${it.available ?? 0} sản phẩm (bạn đặt ${it.requested ?? 0})`;
        }).join('; ');
        message = `Một số sản phẩm không đủ tồn kho: ${itemDescriptions}. Vui lòng giảm số lượng hoặc chọn màu/size khác.`;
      } else if (!message) {
        message = error.message || 'Lỗi API';
      }

      return throwError(() => new ApiRequestError(message, error.status, code, details));
    }
    return throwError(() => error);
  }
}
