import { afterNextRender, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { useBodyClass } from '../../core/utils/body-class';

@Component({
  selector: 'app-about-page',
  imports: [RouterLink],
  host: { class: 'page-about' },
  templateUrl: './about.page.html',
})
export class AboutPage {
  constructor() {
    useBodyClass('page-about');
    afterNextRender(() => {
      document.querySelectorAll('[data-story-reveal]').forEach((node) => {
        node.classList.add('is-story-visible');
      });
    });
  }
}
