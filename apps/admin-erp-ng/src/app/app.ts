import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

/**
 * Root shell for the ERP admin SPA.
 */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  template: '<router-outlet />',
})
export class App {}
