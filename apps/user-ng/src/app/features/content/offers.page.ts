import { Component } from '@angular/core';
import { HOT_BANNERS } from '../../core/models/hot-banner';

@Component({
  selector: 'app-offers-page',
  templateUrl: './offers.page.html',
})
export class OffersPage {
  readonly banners = HOT_BANNERS;
}
