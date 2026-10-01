import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { PurchaseDemoStore } from '../services/purchase-demo.store';

/** Canonical entry points keep Guest and authenticated account journeys separate, preserving order links. */
export const purchaseFlowGuard: CanActivateFn = (route) => {
  const model = inject(PurchaseDemoStore);
  const router = inject(Router);
  const audience = route.data['audience'];
  const area = route.data['area'];
  const checkout = model.member() ? '/checkout/user' : '/checkout/guest';
  const section = route.routeConfig?.path?.endsWith('returns') ? 'returns' : 'orders';
  const orders = `${model.member() ? '/account' : '/guest'}/${section}`;
  if (audience === 'entry' || (audience === 'user') !== model.member()) {
    const id = route.paramMap.get('id') || route.queryParamMap.get('order');
    return router.createUrlTree([area === 'checkout' ? checkout : orders], {
      queryParams: { ...route.queryParams, ...(id ? { order: id } : {}) },
    });
  }
  return true;
};
