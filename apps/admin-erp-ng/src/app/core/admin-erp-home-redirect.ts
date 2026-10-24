import { Component } from '@angular/core';

/**
 * Rendered only while the home guard resolves the first workspace for the role.
 */
@Component({
  selector: 'app-admin-erp-home-redirect',
  template: '<p class="erp-sr-only">Đang chuyển hướng…</p>',
})
export class AdminErpHomeRedirectPage {}
