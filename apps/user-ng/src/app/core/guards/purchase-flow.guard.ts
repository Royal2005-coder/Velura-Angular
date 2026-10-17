import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

/** Canonical entry points keep Guest and authenticated account journeys separate, preserving order links. */
export const purchaseFlowGuard: CanActivateFn = (route) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const audience = route.data['audience'];
  const area = route.data['area'];
  const member = auth.isLoggedIn();
  const checkout = member ? '/checkout/user' : '/checkout/guest';
  const section = route.routeConfig?.path?.endsWith('returns') ? 'returns' : 'orders';
  const orders = `${member ? '/account' : '/guest'}/${section}`;
  if (audience === 'entry' || (audience === 'user') !== member) {
    const id = route.paramMap.get('id') || route.queryParamMap.get('order');
    return router.createUrlTree([area === 'checkout' ? checkout : orders], {
      queryParams: { ...route.queryParams, ...(id ? { order: id } : {}) },
    });
  }
  return true;
};
