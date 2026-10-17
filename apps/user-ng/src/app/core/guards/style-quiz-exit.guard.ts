import type { CanDeactivateFn, UrlTree } from '@angular/router';
import type { Observable } from 'rxjs';

/** Minimal contract that keeps the lazy Style Quiz component out of the eager route bundle. */
interface ProtectedStyleQuizPage {
  confirmDeactivate(): boolean | Observable<boolean | UrlTree>;
}

/** Waits for the guest's explicit modal choice before navigation can continue. */
export const styleQuizExitGuard: CanDeactivateFn<ProtectedStyleQuizPage> = (component) => component.confirmDeactivate();
