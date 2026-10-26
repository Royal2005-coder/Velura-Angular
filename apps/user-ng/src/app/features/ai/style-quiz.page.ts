import { afterNextRender, Component, computed, DestroyRef, HostListener, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink, UrlTree } from '@angular/router';
import { Observable, Subject } from 'rxjs';
import { StyleProfileService } from '../../core/services/style-profile.service';
import { AuthService } from '../../core/services/auth.service';
import type { StyleQuizAnswers, StyleQuizDraft } from '../../core/models/style-profile.interface';
import { useBodyClass } from '../../core/utils/body-class';
import { PersonalColorComponent } from './personal-color.component';

const COLOR_HEX_MAP: Record<string, string> = {
  Kem: '#F4E5DA',
  Phấn: '#EAD0C4',
  'Hồng đào': '#E9C6B8',
  'Hồng đất': '#C97C65',
  'Xanh lá lúa': '#A8B49F',
  Onyx: '#292522',
  'Xám ấm': '#908A82',
  'Xanh khói': '#5A6E7D',
  Camel: '#D2A16E',
  'Đỏ rượu': '#7A283C',
};

const STYLE_PERSONAS: Record<string, { name: string; description: string; tip: string }> = {
  Classic: {
    name: 'The Timeless Muse',
    description: 'Bạn bị thu hút bởi vẻ thanh lịch không phụ thuộc xu hướng. Những thiết kế chỉn chu và chi tiết bền dáng thường là lựa chọn lâu dài của bạn.',
    tip: 'Các phom có đường eo rõ hoặc chiết nhẹ có thể làm nổi bật tỷ lệ tự nhiên; phom suông cũng đẹp nếu bạn thích thoải mái. Với undertone lạnh, bạn có thể thử xanh khói, hồng hoặc đỏ rượu. Ưu tiên món đồ dễ phối và mặc lại nhiều dịp để tối đa hóa giá trị.'
  },
  Minimalist: {
    name: 'The Quiet Classic',
    description: 'Bạn yêu những đường nét tinh giản, cân đối và dễ ứng dụng. Một tủ đồ gọn gàng với phom dáng đẹp, chất liệu tốt giúp bạn luôn thấy tự tin.',
    tip: 'Bắt đầu với phom dáng và chất liệu tinh tế; những gam màu trung tính kết hợp một điểm nhấn nhẹ sẽ tôn trọn nét thanh lịch riêng của bạn.'
  },
  Romantic: {
    name: 'The Soft Romantic',
    description: 'Bạn yêu nét mềm mại, duyên dáng và những chi tiết giàu cảm xúc. Chất liệu bay nhẹ, sắc màu dịu và điểm nhấn tinh tế hợp với tinh thần của bạn.',
    tip: 'Phối một chi tiết bèo nhún hoặc voan ren mềm mại cùng phom dáng gọn gàng giúp tổng thể nữ tính ngọt ngào mà vẫn rất hài hòa.'
  },
  Elegant: {
    name: 'The Elegant Edit',
    description: 'Bạn trân trọng sự tinh xảo và vẻ chỉn chu tự nhiên. Phom dáng rõ nét, chất liệu đẹp và bảng màu hài hòa tạo nên dấu ấn sang trọng riêng.',
    tip: 'Giữ bảng màu gọn gàng và ưu tiên các đường cắt may sắc nét để diện mạo luôn toát lên khí chất quý phái, thanh lịch.'
  },
  Boho: {
    name: 'The Free Spirit',
    description: 'Bạn thích sự tự do, tự nhiên và có chút ngẫu hứng. Những lớp vải chuyển động cùng sắc màu ấm áp giúp phong cách của bạn phóng khoáng mà vẫn giàu cá tính.',
    tip: 'Kết hợp một item bay bổng với phụ kiện có điểm nhấn để tạo cảm giác tự do, bay bổng mà có chủ ý.'
  },
  Street: {
    name: 'The City Original',
    description: 'Bạn thích thử nghiệm và không ngại để trang phục thể hiện cá tính. Phom dáng hiện đại, cách phối linh hoạt và một điểm nhấn phá cách là lựa chọn tự nhiên của bạn.',
    tip: 'Chọn một item làm tâm điểm cá tính, giữ các món còn lại tối giản để tổng thể outfit vừa độc đáo vừa cân bằng hoàn hảo.'
  },
  Sporty: {
    name: 'The Everyday Active',
    description: 'Bạn đặt sự linh hoạt và thoải mái lên hàng đầu. Những thiết kế dễ vận động, dễ phối và vẫn gọn gàng sẽ đồng hành tốt với nhịp sống của bạn.',
    tip: 'Ưu tiên chất liệu co giãn và phom dáng năng động; khoác thêm một chiếc blazer hay sơ mi nhẹ để chuyển biến linh hoạt sang phong cách chỉn chu.'
  },
  'Smart Casual': {
    name: 'The Modern Classic',
    description: 'Bạn thích sự cân bằng giữa chỉn chu và thoải mái. Những món đồ có thể đi từ công việc đến cuộc hẹn thường là lựa chọn phù hợp nhất với bạn.',
    tip: 'Phối một item có cấu trúc chuẩn mực với chất liệu rũ mềm để tạo vẻ ngoài chuyên nghiệp, tự tin mà không hề cứng nhắc.'
  }
};

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
  readonly skinToneMethod = signal<'ai' | 'manual'>('ai');
  readonly aiDetectedSeason = signal<{ season: string; undertone: string } | null>(null);
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

  /** Switches between AI Vision and manual skin-tone selection mode. */
  setSkinToneMethod(method: 'ai' | 'manual'): void {
    this.skinToneMethod.set(method);
    this.draftDirty.set(true);
  }

  /** Auto-syncs AI Vision result into quiz answers. */
  onSeasonConfirmed(event: { season: string; undertone: string }): void {
    this.aiDetectedSeason.set(event);
    const tone = event.undertone === 'Warm' ? 'Warm' : 'Cool';
    document.querySelectorAll('[data-group="skin-tone"] [data-value]').forEach((node) => {
      node.classList.toggle('is-selected', node.getAttribute('data-value') === tone);
    });
    this.draftDirty.set(true);
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
      const val = Number(input.value);
      this.height.set(val);
      const label = document.getElementById('height-val');
      if (label) {
        label.textContent = String(val);
      }
      const numInput = document.getElementById('input-height-num') as HTMLInputElement | null;
      if (numInput && Number(numInput.value) !== val) {
        numInput.value = String(val);
      }
    }
    if (input.id === 'input-weight') {
      const val = Number(input.value);
      this.weight.set(val);
      const label = document.getElementById('weight-val');
      if (label) {
        label.textContent = String(val);
      }
      const numInput = document.getElementById('input-weight-num') as HTMLInputElement | null;
      if (numInput && Number(numInput.value) !== val) {
        numInput.value = String(val);
      }
    }
    this.persistDraft();
  }

  /**
   * Syncs height from direct number input to slider and state.
   */
  onHeightNumberInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    const val = Number(input.value);
    if (!isNaN(val) && val > 0) {
      this.height.set(val);
      this.quizSaved.set(false);
      this.draftDirty.set(true);
      const slider = document.getElementById('input-height') as HTMLInputElement | null;
      if (slider && Number(slider.value) !== val) slider.value = String(val);
      const label = document.getElementById('height-val');
      if (label) label.textContent = String(val);
      this.persistDraft();
    }
  }

  /**
   * Clamps height to valid range on blur.
   */
  onHeightBlur(event: Event): void {
    const input = event.target as HTMLInputElement;
    let val = Number(input.value);
    if (isNaN(val) || val < 100) val = 100;
    if (val > 220) val = 220;
    this.height.set(val);
    input.value = String(val);
    const slider = document.getElementById('input-height') as HTMLInputElement | null;
    if (slider) slider.value = String(val);
    const label = document.getElementById('height-val');
    if (label) label.textContent = String(val);
    this.persistDraft();
  }

  /**
   * Syncs weight from direct number input to slider and state.
   */
  onWeightNumberInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    const val = Number(input.value);
    if (!isNaN(val) && val > 0) {
      this.weight.set(val);
      this.quizSaved.set(false);
      this.draftDirty.set(true);
      const slider = document.getElementById('input-weight') as HTMLInputElement | null;
      if (slider && Number(slider.value) !== val) slider.value = String(val);
      const label = document.getElementById('weight-val');
      if (label) label.textContent = String(val);
      this.persistDraft();
    }
  }

  /**
   * Clamps weight to valid range on blur.
   */
  onWeightBlur(event: Event): void {
    const input = event.target as HTMLInputElement;
    let val = Number(input.value);
    if (isNaN(val) || val < 30) val = 30;
    if (val > 150) val = 150;
    this.weight.set(val);
    input.value = String(val);
    const slider = document.getElementById('input-weight') as HTMLInputElement | null;
    if (slider) slider.value = String(val);
    const label = document.getElementById('weight-val');
    if (label) label.textContent = String(val);
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
      else this.submitQuiz(true);
      return;
    }
    if (this.step() === 8) {
      this.showSummary.set(true);
      this.fillSummary();
      this.syncStepDom();
      this.submitQuiz(false);
      if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
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

  /** Return to questions to edit answers from summary. */
  editAnswers(): void {
    this.showSummary.set(false);
    this.syncStepDom();
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /** Retake quiz from step 1. */
  retakeQuiz(): void {
    this.step.set(1);
    this.showSummary.set(false);
    this.syncStepDom();
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
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
    setText('summary-measurements', [vong1 ? `Vòng 1: ${vong1} cm` : '', vong2 ? `Vòng 2: ${vong2} cm` : '', vong3 ? `Vòng 3: ${vong3} cm` : ''].filter(Boolean).join(' · ') || `${vong1} / ${vong2} / ${vong3} cm`);
    setText('summary-body-shape', this.selectedValue('body-shape') || '—');
    setText('summary-skin-tone', this.selectedValue('skin-tone') || '—');
    setText('summary-main-style', this.selectedValues('main-style').join(', ') || '—');
    setText('summary-budget', this.selectedValue('budget') || '—');
    const colors = document.querySelector('#summary-colors .quiz-summary-colors-list');
    if (colors) {
      colors.textContent = this.selectedValues('colors').join(', ') || '—';
    }

    const mainStyle = this.selectedValues('main-style')[0] || 'Classic';
    const persona = STYLE_PERSONAS[mainStyle] || STYLE_PERSONAS['Classic'];
    setText('profile-name', persona.name);
    setText('profile-description', persona.description);
    setText('style-tip', persona.tip);

    const swatchContainer = document.getElementById('result-swatches');
    if (swatchContainer) {
      const selectedColors = this.selectedValues('colors');
      if (selectedColors.length > 0) {
        swatchContainer.innerHTML = selectedColors.map(c => {
          const hex = COLOR_HEX_MAP[c] || '#EAD0C4';
          return `<span class="quiz-swatch-circle" style="background-color: ${hex}" title="${c}" aria-label="${c}"></span>`;
        }).join('');
      } else {
        swatchContainer.innerHTML = `
          <span class="quiz-swatch-circle" style="background-color: #EAD0C4" title="Phấn"></span>
          <span class="quiz-swatch-circle" style="background-color: #E9C6B8" title="Hồng đào"></span>
        `;
      }
    }
  }

  private submitQuiz(navigateAfter = false): void {
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
        if (navigateAfter) {
          void this.router.navigateByUrl('/ai/suggestions?isNewQuiz=true');
        }
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
    setInput('input-height-num', answers.height_cm); setInput('input-weight-num', answers.weight_kg);
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
