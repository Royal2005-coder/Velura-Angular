import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';
import { SessionSyncService } from '../services/session-sync.service';

/**
 * Protects member-only account routes. Validates live session lock status before granting entry.
 */
export const authGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const sessionSync = inject(SessionSyncService, { optional: true });
  if (!auth.isLoggedIn()) {
    return router.createUrlTree(['/auth/signin']);
  }
  return sessionSync ? sessionSync.syncNow(true) : true;
};
