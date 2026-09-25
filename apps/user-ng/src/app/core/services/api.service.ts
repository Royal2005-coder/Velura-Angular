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
      const body = error.error as { error?: ApiErrorBody } | null;
      const message = body?.error?.message || error.message || 'Lỗi API';
      return throwError(() => new ApiRequestError(message, error.status, body?.error?.code || null, body?.error?.details));
    }
    return throwError(() => error);
  }
}
