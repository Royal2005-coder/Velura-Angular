import { Component, signal } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';
import { HOT_BANNERS } from '../../core/models/hot-banner';
import { SiteFooter } from '../site-footer/site-footer';
import { SiteHeader } from '../site-header/site-header';

@Component({
  selector: 'app-site-shell',
  imports: [RouterOutlet, RouterLink, SiteHeader, SiteFooter],
  templateUrl: './site-shell.html',
})
export class SiteShell {
  readonly banners = HOT_BANNERS;
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
