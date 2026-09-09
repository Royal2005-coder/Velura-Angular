import { Component, signal } from '@angular/core';
import { useBodyClass } from '../../core/utils/body-class';

@Component({
  selector: 'app-contact-page',
  templateUrl: './contact.page.html',
})
export class ContactPage {
  readonly sent = signal(false);

  constructor() {
    useBodyClass('page-contact');
  }

  /**
   * Toggles one original FAQ accordion item.
   */
  onFaqClick(event: Event): void {
    const header = (event.target as HTMLElement).closest<HTMLElement>('.js-accordion-header');
    if (!header) {
      return;
    }
    const item = header.closest('.accordion-item');
    const expanded = header.getAttribute('aria-expanded') === 'true';
    document.querySelectorAll('.contact-faq__list .accordion-item').forEach((node) => {
      node.querySelector('.js-accordion-header')?.setAttribute('aria-expanded', 'false');
      node.classList.remove('is-open');
    });
    if (!expanded) {
      header.setAttribute('aria-expanded', 'true');
      item?.classList.add('is-open');
    }
  }

  /**
   * Submits the original contact form locally.
   */
  submit(event: Event): void {
    event.preventDefault();
    this.sent.set(true);
  }
}
