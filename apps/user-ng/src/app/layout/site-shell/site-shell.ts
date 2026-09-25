import { Component, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { RouterLink, RouterOutlet } from '@angular/router';
import { OffersService } from '../../core/services/offers.service';
import { SiteFooter } from '../site-footer/site-footer';
import { SiteHeader } from '../site-header/site-header';

@Component({
  selector: 'app-site-shell',
  imports: [RouterOutlet, RouterLink, SiteHeader, SiteFooter],
  templateUrl: './site-shell.html',
})
export class SiteShell {
  readonly banners = toSignal(inject(OffersService).highlights(), { initialValue: [] });
  readonly quizOpen = signal(false);
  readonly chatOpen = signal(false);

  /**
   * Closes the original Style Quiz invitation modal.
   */
  closeQuiz(): void {
    this.quizOpen.set(false);
  }

  /**
   * Toggles the original floating chatbot widget.
   */
  toggleChat(): void {
    this.chatOpen.update((open) => !open);
  }
}
