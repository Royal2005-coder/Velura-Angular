import { DecimalPipe } from '@angular/common';
import { Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subscription, exhaustMap, takeWhile, timer } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { PersonalColorModel, type ColorCapabilities, type PersonalColorAnalysis, type PersonalColorProfile } from './personal-color.model';

/** Optional quiz/profile editor: inference preview never replaces the last confirmed color without explicit confirmation. */
@Component({
  selector: 'app-personal-color',
  standalone: true,
  imports: [DecimalPipe],
  templateUrl: './personal-color.component.html',
  styleUrl: './personal-color.component.css',
})
export class PersonalColorComponent {
  private readonly model = inject(PersonalColorModel);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);
  private polling?: Subscription;
  private generation = 0;
  private file: File | null = null;
  readonly capabilities = signal<ColorCapabilities | null>(null);
  readonly profile = signal<PersonalColorProfile | null>(null);
  readonly analysis = signal<PersonalColorAnalysis | null>(null);
  readonly consent = signal(false);
  readonly previewUrl = signal('');
  readonly busy = signal(false);
  readonly error = signal('');
  readonly canAnalyze = computed(() => !!this.capabilities()?.enabled && !!this.profile() && !!this.previewUrl() && this.consent() && !this.busy());
  readonly canConfirm = computed(() => this.analysis()?.status === 'SUCCESS' && this.analysis()?.profile_version === this.profile()?.version && !this.busy());
  readonly statusLabel = computed(() => {
    const status = this.analysis()?.status;
    const labels: Record<string, string> = { RUNNING: 'Đang kiểm tra ảnh và phân tích…', SUCCESS: 'Bản xem trước — chưa lưu', LOW_CONFIDENCE: 'Độ tin cậy thấp — không thể xác nhận. Hãy chụp ảnh khác.', VALIDATION_FAILED: 'Ảnh chưa đáp ứng hướng dẫn. Hãy chụp lại.', FAILED: 'Phân tích thất bại. Màu đã xác nhận vẫn được giữ.', TIMEOUT: 'Phân tích đã hết thời gian. Màu đã xác nhận vẫn được giữ.', CANCELLED: 'Đã huỷ. Màu đã xác nhận vẫn được giữ.', CONFIRMED: 'Đã xác nhận và lưu vào hồ sơ phong cách.' };
    return status ? labels[status] : '';
  });

  constructor() {
    effect(() => {
      this.auth.session();
      untracked(() => {
        this.generation++;
        this.polling?.unsubscribe();
        this.analysis.set(null); this.profile.set(null); this.busy.set(false); this.consent.set(false); this.error.set('');
        this.clearFile();
        this.reload();
      });
    });
    this.destroyRef.onDestroy(() => { this.generation++; this.polling?.unsubscribe(); this.clearFile(); });
  }

  /** Reload current server policy and same-owner profile; storage failure remains visible. */
  reload(): void {
    const generation = this.generation;
    this.model.capabilities().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (value) => { if (generation === this.generation) this.capabilities.set(value); },
      error: () => { if (generation === this.generation) { this.capabilities.set(null); this.error.set('Chưa kiểm tra được khả năng phân tích màu.'); } },
    });
    this.model.profile().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (value) => { if (generation === this.generation) this.profile.set(value); },
      error: (error: Error) => { if (generation === this.generation) this.error.set(error.message || 'Lưu Style Quiz trước khi phân tích màu.'); },
    });
  }

  /** Preview locally; no upload or inference occurs when selecting a picture. */
  selectFile(event: Event): void {
    if (this.busy()) return;
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    this.clearFile(); this.error.set(''); this.consent.set(false); this.analysis.set(null);
    input.value = '';
    if (!file) return;
    if (!this.capabilities()?.enabled || !['image/jpeg', 'image/png'].includes(file.type) || file.size > Number(this.capabilities()?.max_upload_bytes || 0)) { this.error.set('Chọn JPEG/PNG trong giới hạn cho phép.'); input.value = ''; return; }
    this.file = file;
    this.previewUrl.set(URL.createObjectURL(file));
    this.polling?.unsubscribe();
  }

  /** Record explicit processing consent separately from final-result confirmation. */
  setConsent(event: Event): void { this.consent.set((event.target as HTMLInputElement).checked); }

  /** Create and poll one analysis; previous confirmed result stays visible throughout reanalysis. */
  analyze(): void {
    const file = this.file, capabilities = this.capabilities(), profile = this.profile();
    if (!this.canAnalyze() || !file || !capabilities || !profile) return;
    const generation = ++this.generation;
    this.polling?.unsubscribe(); this.error.set(''); this.analysis.set(null); this.busy.set(true);
    this.model.analyze(file, capabilities, profile.version, this.consent()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (analysis) => {
        if (generation !== this.generation) return;
        this.analysis.set(analysis);
        if (analysis.status !== 'RUNNING') { this.busy.set(false); this.clearFile(); return; }
        this.polling = timer(0, 1200).pipe(exhaustMap(() => this.model.analysis(analysis.id)), takeWhile((value) => value.status === 'RUNNING', true), takeUntilDestroyed(this.destroyRef)).subscribe({
          next: (value) => { if (generation === this.generation) { this.analysis.set(value); this.busy.set(value.status === 'RUNNING'); if (value.status !== 'RUNNING') this.clearFile(); } },
          error: (error: Error) => { if (generation === this.generation) { this.busy.set(false); this.clearFile(); this.error.set(error.message || 'Chưa tải được trạng thái.'); } },
        });
      },
      error: (error: Error) => { if (generation === this.generation) { this.busy.set(false); this.clearFile(); this.error.set(error.message || 'Chưa phân tích được ảnh.'); } },
    });
  }

  /** Cancel current unconfirmed work; never clear or revert a confirmed Style Profile value. */
  cancel(): void {
    const analysis = this.analysis();
    if (!analysis || analysis.status === 'CONFIRMED') return;
    const generation = ++this.generation;
    this.polling?.unsubscribe(); this.busy.set(true);
    this.model.cancel(analysis.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (value) => { if (generation === this.generation) { this.analysis.set(value); this.busy.set(false); this.clearFile(); } },
      error: (error: Error) => { if (generation === this.generation) { this.busy.set(false); this.error.set(error.message); } },
    });
  }

  /** Only acknowledged atomic confirmation refreshes the effective profile and recommendations. */
  confirm(): void {
    const analysis = this.analysis();
    if (!this.canConfirm() || !analysis) return;
    const generation = this.generation;
    this.busy.set(true); this.error.set('');
    this.model.confirm(analysis).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (profile) => { if (generation === this.generation) { this.profile.set(profile); this.analysis.set({ ...analysis, status: 'CONFIRMED' }); this.busy.set(false); this.clearFile(); this.consent.set(false); } },
      error: (error: Error) => { if (generation === this.generation) { this.busy.set(false); this.error.set(error.message); this.reload(); } },
    });
  }
  private clearFile(): void { if (this.previewUrl()) URL.revokeObjectURL(this.previewUrl()); this.previewUrl.set(''); this.file = null; }
}
