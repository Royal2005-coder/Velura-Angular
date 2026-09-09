import { afterNextRender, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ApiService } from '../../core/services/api.service';
import { useBodyClass } from '../../core/utils/body-class';

@Component({
  selector: 'app-style-quiz-page',
  imports: [RouterLink],
  host: { class: 'page-quiz-flow' },
  templateUrl: './style-quiz.page.html',
})
export class StyleQuizPage {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);

  readonly step = signal(1);
  readonly showSummary = signal(false);
  readonly analyzing = signal(false);
  readonly analyzingMessage = signal('Đang xử lý dữ liệu số đo hình thể...');
  readonly height = signal(162);
  readonly weight = signal(52);
  readonly displayStep = computed(() => (this.showSummary() ? 8 : this.step()));
  readonly progressPercent = computed(() => (this.showSummary() ? 100 : (this.step() / 8) * 100));
  readonly nextLabel = computed(() => (this.showSummary() ? 'Hoàn tất & Phân tích' : this.step() === 8 ? 'Xem tóm tắt' : 'Tiếp tục'));

  constructor() {
    useBodyClass('page-quiz-flow');
    afterNextRender(() => this.syncStepDom());
  }

  /**
   * Handles original quiz option cards via event delegation.
   */
  onQuizClick(event: Event): void {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-value]');
    if (!target) {
      return;
    }
    const group = target.closest<HTMLElement>('[data-group]');
    if (!group) {
      return;
    }
    const multi = group.getAttribute('data-multi') === 'true';
    if (multi) {
      target.classList.toggle('is-selected');
      return;
    }
    group.querySelectorAll('[data-value]').forEach((node) => node.classList.remove('is-selected'));
    target.classList.add('is-selected');
  }

  /**
   * Mirrors original height/weight slider labels.
   */
  onQuizInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.id === 'input-height') {
      this.height.set(Number(input.value));
      const label = document.getElementById('height-val');
      if (label) {
        label.textContent = String(this.height());
      }
    }
    if (input.id === 'input-weight') {
      this.weight.set(Number(input.value));
      const label = document.getElementById('weight-val');
      if (label) {
        label.textContent = String(this.weight());
      }
    }
  }

  /**
   * Moves to the previous quiz step.
   */
  prev(): void {
    if (this.showSummary()) {
      this.showSummary.set(false);
      this.syncStepDom();
      return;
    }
    this.step.update((step) => Math.max(1, step - 1));
    this.syncStepDom();
  }

  /**
   * Moves forward or submits the original style-quiz payload.
   */
  next(): void {
    if (this.showSummary()) {
      this.submitQuiz();
      return;
    }
    if (this.step() === 8) {
      this.showSummary.set(true);
      this.fillSummary();
      this.syncStepDom();
      return;
    }
    this.step.update((step) => Math.min(8, step + 1));
    this.syncStepDom();
  }

  private syncStepDom(): void {
    const summary = this.showSummary();
    document.querySelectorAll<HTMLElement>('.quiz-step-content').forEach((node) => {
      if (node.id === 'js-step-summary') {
        node.classList.toggle('is-active', summary);
        return;
      }
      const step = Number(node.getAttribute('data-quiz-step') || '0');
      node.classList.toggle('is-active', !summary && step === this.step());
    });
  }

  private selectedValue(group: string): string {
    return document.querySelector(`[data-group="${group}"] .is-selected`)?.getAttribute('data-value') || '';
  }

  private selectedValues(group: string): string[] {
    return Array.from(document.querySelectorAll(`[data-group="${group}"] .is-selected`)).map(
      (node) => node.getAttribute('data-value') || '',
    );
  }

  private fillSummary(): void {
    const setText = (id: string, value: string) => {
      const node = document.getElementById(id);
      if (node) {
        node.textContent = value;
      }
    };
    const vong1 = (document.getElementById('input-vong1') as HTMLInputElement | null)?.value || '';
    const vong2 = (document.getElementById('input-vong2') as HTMLInputElement | null)?.value || '';
    const vong3 = (document.getElementById('input-vong3') as HTMLInputElement | null)?.value || '';
    setText('summary-gender-age', `${this.selectedValue('context') || '—'} • ${this.selectedValue('age') || '—'}`);
    setText('summary-height-weight', `${this.height()} cm / ${this.weight()} kg`);
    setText('summary-measurements', `${vong1} / ${vong2} / ${vong3} cm`);
    setText('summary-body-shape', this.selectedValue('body-shape') || '—');
    setText('summary-skin-tone', this.selectedValue('skin-tone') || '—');
    setText('summary-main-style', this.selectedValues('main-style').join(', ') || '—');
    setText('summary-budget', this.selectedValue('budget') || '—');
    const colors = document.querySelector('#summary-colors .quiz-summary-colors-list');
    if (colors) {
      colors.textContent = this.selectedValues('colors').join(', ') || '—';
    }
  }

  private submitQuiz(): void {
    this.analyzing.set(true);
    const payload = {
      height_cm: this.height(),
      weight_kg: this.weight(),
      chest_cm: Number((document.getElementById('input-vong1') as HTMLInputElement | null)?.value || 0),
      waist_cm: Number((document.getElementById('input-vong2') as HTMLInputElement | null)?.value || 0),
      hip_cm: Number((document.getElementById('input-vong3') as HTMLInputElement | null)?.value || 0),
      body_shape: this.selectedValue('body-shape') || 'Hourglass',
      skin_tone: this.selectedValue('skin-tone') || 'Neutral',
      style_tags: this.selectedValues('main-style'),
      preferred_occasions: [this.selectedValue('context')].filter(Boolean),
      favorite_brands: ['Velura'],
      budget_range: this.selectedValue('budget') || '300k_700k',
      age_group: this.selectedValue('age') || '25-34',
      favorite_colors: this.selectedValues('colors'),
    };
    localStorage.setItem('velura_guest_quiz_completed', 'true');
    localStorage.setItem('velura_guest_quiz_data', JSON.stringify(payload));
    localStorage.setItem('velura_suggestions_enabled', 'true');
    this.api.post<unknown>('/api/user/style-quiz', payload).subscribe({
      next: () => void this.router.navigateByUrl('/ai/suggestions?isNewQuiz=true'),
      error: () => void this.router.navigateByUrl('/ai/suggestions?isNewQuiz=true'),
    });
  }
}
