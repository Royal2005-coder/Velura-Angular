import { afterNextRender, Component, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { useBodyClass } from '../../core/utils/body-class';

type PolicyTab = 'returns' | 'privacy' | 'shipping' | 'terms' | 'faq' | 'member';

@Component({
  selector: 'app-policies-page',
  host: { class: 'page-policies' },
  templateUrl: './policies.page.html',
})
export class PoliciesPage {
  private readonly route = inject(ActivatedRoute);
  readonly tab = signal<PolicyTab>('returns');

  constructor() {
    useBodyClass('page-policies');
    const requested = this.route.snapshot.queryParamMap.get('tab') as PolicyTab | null;
    if (requested) {
      this.tab.set(requested);
    }
    afterNextRender(() => this.sync());
  }

  /**
   * Reads the original data-policy-tab attribute from a sidebar button.
   */
  onTabClick(event: Event): void {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-policy-tab]');
    const value = button?.getAttribute('data-policy-tab') as PolicyTab | null;
    if (!value) {
      return;
    }
    this.tab.set(value);
    this.sync();
  }

  private sync(): void {
    const current = this.tab();
    document.querySelectorAll<HTMLElement>('[data-policy-tab]').forEach((node) => {
      node.classList.toggle('is-active', node.getAttribute('data-policy-tab') === current);
      node.setAttribute('aria-selected', node.getAttribute('data-policy-tab') === current ? 'true' : 'false');
    });
    document.querySelectorAll<HTMLElement>('.js-policy-panel').forEach((panel) => {
      panel.classList.toggle('is-active', panel.id === `policy-panel-${current}`);
    });
  }
}
