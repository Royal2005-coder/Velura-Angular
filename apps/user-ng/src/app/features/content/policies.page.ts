import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { useBodyClass } from '../../core/utils/body-class';

export const POLICY_TABS = ['returns', 'privacy', 'shipping', 'terms', 'faq', 'member'] as const;

export type PolicyTab = (typeof POLICY_TABS)[number];

/**
 * Type guard for `?tab=` query values from the storefront URL.
 */
export function isPolicyTab(value: string | null): value is PolicyTab {
  return value !== null && (POLICY_TABS as readonly string[]).includes(value);
}

@Component({
  selector: 'app-policies-page',
  host: { class: 'page-policies' },
  templateUrl: './policies.page.html',
})
export class PoliciesPage {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  readonly tab = signal<PolicyTab>('returns');

  constructor() {
    useBodyClass('page-policies');
    const requested = this.route.snapshot.queryParamMap.get('tab');
    if (isPolicyTab(requested)) {
      this.tab.set(requested);
    }
  }

  /**
   * Selects a policy panel and keeps `?tab=` in sync for shareable URLs.
   */
  selectTab(value: PolicyTab): void {
    this.tab.set(value);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab: value },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }
}
