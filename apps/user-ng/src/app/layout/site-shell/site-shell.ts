import { Component, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Router, RouterLink, RouterOutlet } from '@angular/router';
import { OffersService } from '../../core/services/offers.service';
import { SiteFooter } from '../site-footer/site-footer';
import { SiteHeader } from '../site-header/site-header';

@Component({
  selector: 'app-site-shell',
  imports: [RouterOutlet, RouterLink, SiteHeader, SiteFooter],
  templateUrl: './site-shell.html',
})
export class SiteShell {
  private readonly router = inject(Router);
  readonly banners = toSignal(inject(OffersService).highlights(), { initialValue: [] });
  readonly quizOpen = signal(false);
  readonly chatOpen = signal(false);
  readonly chatInput = signal('');

  readonly quickSuggestions = [
    'Tư vấn outfit đi tiệc sang trọng',
    'Gợi ý chọn size đầm chuẩn dáng',
    'Chính sách đổi trả trong 30 ngày',
  ];

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

  /**
   * Submits quick question or opens full chatbot page with query.
   */
  submitChatQuery(text?: string): void {
    const q = (text ?? this.chatInput()).trim();
    this.chatOpen.set(false);
    this.chatInput.set('');
    if (q) {
      void this.router.navigate(['/chatbot'], { queryParams: { q } });
    } else {
      void this.router.navigate(['/chatbot']);
    }
  }
}
