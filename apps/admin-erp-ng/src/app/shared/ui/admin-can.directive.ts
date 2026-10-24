import { Directive, EmbeddedViewRef, TemplateRef, ViewContainerRef, effect, inject, input } from '@angular/core';
import { AdminErpAction, AdminErpSessionService } from '../../core/admin-erp-session.service';

const ACTIONS: readonly AdminErpAction[] = ['read', 'create', 'update', 'delete', 'approve'];

/**
 * Renders its host only when the current role has `module.action`.
 *
 * API enforcement remains canonical; this directive only prevents dead write UI.
 */
@Directive({
  selector: '[adminCan]',
})
export class AdminCanDirective {
  private readonly session = inject(AdminErpSessionService);
  private readonly template = inject(TemplateRef<unknown>);
  private readonly container = inject(ViewContainerRef);
  private view?: EmbeddedViewRef<unknown>;

  readonly adminCan = input.required<string>();

  constructor() {
    effect(() => {
      const [module, action] = splitCapability(this.adminCan());
      const allowed = Boolean(module && action && ACTIONS.includes(action) && this.session.can(action, module));
      if (allowed && !this.view) {
        this.view = this.container.createEmbeddedView(this.template);
      } else if (!allowed && this.view) {
        this.container.clear();
        this.view = undefined;
      }
    });
  }
}

function splitCapability(value: string): [string, AdminErpAction | null] {
  const index = value.lastIndexOf('.');
  if (index <= 0) {
    return ['', null];
  }
  const action = value.slice(index + 1) as AdminErpAction;
  return [value.slice(0, index), ACTIONS.includes(action) ? action : null];
}
