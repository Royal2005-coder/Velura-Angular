import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { useBodyClass } from '../../core/utils/body-class';

@Component({
  selector: 'app-account-returns-page',
  imports: [RouterLink],
  host: { class: 'page-return' },
  templateUrl: './returns.page.html',
})
export class AccountReturnsPage {
  constructor() {
    useBodyClass('page-return');
  }
}
