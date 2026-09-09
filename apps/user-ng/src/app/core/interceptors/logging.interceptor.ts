import { HttpInterceptorFn } from '@angular/common/http';
import { catchError, tap, throwError } from 'rxjs';

/**
 * Logs outbound API calls without mutating business payloads.
 */
export const loggingInterceptor: HttpInterceptorFn = (req, next) => {
  const started = Date.now();
  return next(req).pipe(
    tap(() => {
      console.info(`[Velura API] ${req.method} ${req.url} ${Date.now() - started}ms`);
    }),
    catchError((error: unknown) => {
      console.error(`[Velura API] ${req.method} ${req.url} failed`, error);
      return throwError(() => error);
    }),
  );
};
