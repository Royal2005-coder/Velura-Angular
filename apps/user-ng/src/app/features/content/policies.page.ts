import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { Location } from '@angular/common';
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
  private readonly location = inject(Location);
  readonly tab = signal<PolicyTab>('returns');

  constructor() {
    useBodyClass('page-policies');
    const requested = this.route.snapshot.queryParamMap.get('tab');
    if (isPolicyTab(requested)) {
      this.tab.set(requested);
    }

    // Keep active tab in sync when user navigates using browser back / forward
    this.location.onUrlChange((url) => {
      try {
        const search = url.includes('?') ? url.split('?')[1] : '';
        const params = new URLSearchParams(search);
        const tabParam = params.get('tab');
        if (isPolicyTab(tabParam) && this.tab() !== tabParam) {
          this.tab.set(tabParam);
        }
      } catch {
        // Safe fallback
      }
    });
  }

  /**
   * Selects a policy panel and keeps `?tab=` in sync for shareable URLs
   * without triggering router navigation (which forces scroll-to-top).
   */
  selectTab(value: PolicyTab): void {
    this.tab.set(value);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('tab', value);
      this.location.replaceState(url.pathname, url.searchParams.toString());
    }
  }
}
