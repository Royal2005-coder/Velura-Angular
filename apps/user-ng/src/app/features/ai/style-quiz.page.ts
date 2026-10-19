import { afterNextRender, Component, computed, DestroyRef, HostListener, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink, UrlTree } from '@angular/router';
import { Observable, Subject } from 'rxjs';
import { StyleProfileService } from '../../core/services/style-profile.service';
import { AuthService } from '../../core/services/auth.service';
import type { StyleQuizAnswers, StyleQuizDraft } from '../../core/models/style-profile.interface';
import { useBodyClass } from '../../core/utils/body-class';
import { PersonalColorComponent } from './personal-color.component';

@Component({
  selector: 'app-style-quiz-page',
  imports: [RouterLink, PersonalColorComponent],
  host: { class: 'page-quiz-flow' },
  templateUrl: './style-quiz.page.html',
})
export class StyleQuizPage {
  private readonly profile = inject(StyleProfileService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  readonly step = signal(1);
  readonly showSummary = signal(false);
  readonly quizSaved = signal(false);
  readonly draftDirty = signal(false);
  readonly exitPromptOpen = signal(false);
  readonly analyzing = signal(false);
  readonly submitError = signal('');
  readonly fieldErrors = signal<Record<string, string>>({});
  readonly invalidFields = computed(() => Object.values(this.fieldErrors()).some(Boolean));
  readonly analyzingMessage = signal('Đang lưu thông tin bạn đã xác nhận…');
  readonly height = signal(162);
  readonly weight = signal(52);
  readonly displayStep = computed(() => (this.showSummary() ? 8 : this.step()));
  readonly progressPercent = computed(() => (this.showSummary() ? 100 : (this.step() / 8) * 100));
  readonly nextLabel = computed(() => (this.showSummary() ? this.quizSaved() ? 'Xem gợi ý' : 'Lưu hồ sơ & chọn phân tích màu' : this.step() === 8 ? 'Xem tóm tắt' : 'Tiếp tục'));
  private exitDecision: Subject<boolean | UrlTree> | null = null;
  private exitApproved = false;

  constructor() {
    useBodyClass('page-quiz-flow');
    afterNextRender(() => {
      this.restoreAnswers();
      this.syncStepDom();
    });
  }

  /** Warns the browser before a guest closes a tab containing an incomplete draft. */
  @HostListener('window:beforeunload', ['$event'])
  beforeUnload(event: BeforeUnloadEvent): void {
    if (!this.shouldProtectDraft()) return;
    event.preventDefault();
    event.returnValue = '';
  }

  /** Opens the in-app decision dialog before Angular leaves an incomplete guest quiz. */
  confirmDeactivate(): boolean | Observable<boolean | UrlTree> {
    if (this.exitApproved) return true;
    if (!this.shouldProtectDraft()) return true;
    if (this.exitDecision) return this.exitDecision.asObservable();
    this.persistDraft();
    this.exitPromptOpen.set(true);
    this.exitDecision = new Subject<boolean | UrlTree>();
    return this.exitDecision.asObservable();
  }

  /** Resolves the pending route with stay, session-save, or signup. */
  resolveExit(action: 'stay' | 'leave' | 'signup'): void {
    const decision = this.exitDecision;
    if (!decision) return;
    this.exitPromptOpen.set(false);
    if (action === 'stay') {
      decision.next(false);
    } else {
      this.exitApproved = true;
      if (action === 'signup') decision.next(this.router.parseUrl('/auth/signup?claimStyleDraft=1'));
      else decision.next(true);
    }
    decision.complete();
    this.exitDecision = null;
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
    this.quizSaved.set(false);
    this.draftDirty.set(true);
    const multi = group.getAttribute('data-multi') === 'true';
    if (multi) {
      target.classList.toggle('is-selected');
      this.persistDraft();
      return;
    }
    group.querySelectorAll('[data-value]').forEach((node) => node.classList.remove('is-selected'));
    target.classList.add('is-selected');
    this.persistDraft();
  }

  /**
   * Mirrors original height/weight slider labels.
   */
  onQuizInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.validateControl(input);
    if (['input-height', 'input-weight', 'input-vong1', 'input-vong2', 'input-vong3'].includes(input.id)) this.quizSaved.set(false);
    this.draftDirty.set(true);
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
    this.persistDraft();
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
    this.persistDraft();
    this.syncStepDom();
  }

  /**
   * Moves forward or submits the original style-quiz payload.
   */
  next(): void {
    if (this.analyzing()) return;
    document.querySelectorAll<HTMLInputElement>(`.quiz-step-content[data-quiz-step="${this.step()}"] input`).forEach((input) => this.validateControl(input));
    if (this.invalidFields()) return;
    if (this.showSummary()) {
      if (this.quizSaved()) void this.router.navigateByUrl('/ai/suggestions?isNewQuiz=true');
      else this.submitQuiz();
      return;
    }
    if (this.step() === 8) {
      this.showSummary.set(true);
      this.fillSummary();
      this.syncStepDom();
      return;
    }
    this.step.update((step) => Math.min(8, step + 1));
    this.draftDirty.set(true);
    this.persistDraft();
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

  private validateControl(input: HTMLInputElement): void {
    if (!['input-height', 'input-weight', 'input-vong1', 'input-vong2', 'input-vong3'].includes(input.id)) return;
    const labels: Record<string, string> = { 'input-height': 'Chiều cao', 'input-weight': 'Cân nặng', 'input-vong1': 'Vòng ngực', 'input-vong2': 'Vòng eo', 'input-vong3': 'Vòng hông' };
    const message = input.checkValidity() ? '' : `${labels[input.id]} cần nằm trong khoảng ${input.min}–${input.max}.`;
    this.fieldErrors.update((errors) => ({ ...errors, [input.id]: message }));
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
    if (this.analyzing()) return;
    this.analyzing.set(true);
    this.submitError.set('');
    const payload: StyleQuizAnswers = {
      height_cm: this.height(),
      weight_kg: this.weight(),
      chest_cm: Number((document.getElementById('input-vong1') as HTMLInputElement | null)?.value || 0),
      waist_cm: Number((document.getElementById('input-vong2') as HTMLInputElement | null)?.value || 0),
      hip_cm: Number((document.getElementById('input-vong3') as HTMLInputElement | null)?.value || 0),
      body_shape: this.selectedValue('body-shape'),
      skin_tone: this.selectedValue('skin-tone'),
      style_tags: this.selectedValues('main-style'),
      preferred_occasions: [this.selectedValue('context')].filter(Boolean),
      favorite_brands: [],
      budget_range: this.selectedValue('budget'),
      age_group: this.selectedValue('age'),
      favorite_colors: this.selectedValues('colors'),
    };
    this.profile.saveQuiz(payload).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.analyzing.set(false);
        this.quizSaved.set(true);
        this.draftDirty.set(false);
      },
      error: (error: Error) => {
        this.analyzing.set(false);
        this.submitError.set(error.message || 'Chưa lưu được hồ sơ phong cách. Hãy thử lại.');
      },
    });
  }

  private shouldProtectDraft(): boolean {
    return !this.auth.session() && this.draftDirty() && !this.quizSaved();
  }

  private persistDraft(): void {
    if (!this.shouldProtectDraft()) return;
    this.profile.saveGuestDraft({ step: this.step(), answers: this.collectDraftAnswers() });
  }

  private collectDraftAnswers(): Partial<StyleQuizAnswers> {
    const numberValue = (id: string) => Number((document.getElementById(id) as HTMLInputElement | null)?.value || 0);
    return {
      height_cm: this.height(), weight_kg: this.weight(), chest_cm: numberValue('input-vong1'),
      waist_cm: numberValue('input-vong2'), hip_cm: numberValue('input-vong3'),
      body_shape: this.selectedValue('body-shape'), skin_tone: this.selectedValue('skin-tone'),
      style_tags: this.selectedValues('main-style'), preferred_occasions: [this.selectedValue('context')].filter(Boolean),
      favorite_brands: [], budget_range: this.selectedValue('budget'), age_group: this.selectedValue('age'),
      favorite_colors: this.selectedValues('colors'),
    };
  }

  private restoreAnswers(): void {
    if (this.auth.session()) {
      this.profile.loadQuiz().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (answers) => {
          if (!answers) return;
          this.applyAnswers(answers);
          this.quizSaved.set(true);
        },
        error: (error: Error) => this.submitError.set(error.message || 'Chưa tải được Style Profile. Hãy thử lại.'),
      });
      return;
    }
    const draft: StyleQuizDraft | null = this.profile.guestDraft();
    if (!draft) return;
    this.step.set(Math.min(8, Math.max(1, draft.step || 1)));
    this.applyAnswers(draft.answers);
    this.draftDirty.set(true);
  }

  private applyAnswers(answers: Partial<StyleQuizAnswers>): void {
    const setInput = (id: string, value: number | undefined) => {
      const input = document.getElementById(id) as HTMLInputElement | null;
      if (input && value !== undefined) input.value = String(value);
    };
    if (answers.height_cm !== undefined) this.height.set(answers.height_cm);
    if (answers.weight_kg !== undefined) this.weight.set(answers.weight_kg);
    setInput('input-height', answers.height_cm); setInput('input-weight', answers.weight_kg);
    setInput('input-vong1', answers.chest_cm); setInput('input-vong2', answers.waist_cm); setInput('input-vong3', answers.hip_cm);
    const select = (group: string, values: string[]) => {
      document.querySelectorAll(`[data-group="${group}"] [data-value]`).forEach((node) => {
        node.classList.toggle('is-selected', values.includes(node.getAttribute('data-value') || ''));
      });
    };
    select('context', answers.preferred_occasions || []); select('age', answers.age_group ? [answers.age_group] : []);
    select('body-shape', answers.body_shape ? [answers.body_shape] : []); select('skin-tone', answers.skin_tone ? [answers.skin_tone] : []);
    select('main-style', answers.style_tags || []); select('colors', answers.favorite_colors || []);
    select('budget', answers.budget_range ? [answers.budget_range] : []);
    const heightLabel = document.getElementById('height-val');
    const weightLabel = document.getElementById('weight-val');
    if (heightLabel) heightLabel.textContent = String(this.height());
    if (weightLabel) weightLabel.textContent = String(this.weight());
  }
}
