import { Injectable, inject } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { RouterStateSnapshot, TitleStrategy } from '@angular/router';
import { adminErpNavItemForNavKey } from './admin-erp-navigation';

/**
 * Resolves titles from the workspace registry so route data and sidebar labels cannot drift.
 */
@Injectable({ providedIn: 'root' })
export class AdminErpTitleStrategy extends TitleStrategy {
  private readonly title = inject(Title);

  /**
   * Uses the deepest `navKey` in the activated route tree.
   */
  override updateTitle(snapshot: RouterStateSnapshot): void {
    let current = snapshot.root;
    let navKey = '';
    while (current.firstChild) {
      current = current.firstChild;
      const candidate = current.data['navKey'];
      if (typeof candidate === 'string') {
        navKey = candidate;
      }
    }
    const item = adminErpNavItemForNavKey(navKey);
    this.title.setTitle(item ? `${item.title} — Velura ERP` : 'Velura ERP');
  }
}
