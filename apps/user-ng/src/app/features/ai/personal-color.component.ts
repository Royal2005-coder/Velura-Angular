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
  readonly activeTab = signal<'ai' | 'manual'>('ai');
  readonly selectedManualSeason = signal<'Spring' | 'Summer' | 'Autumn' | 'Winter'>('Spring');
  readonly consent = signal(false);
  readonly previewUrl = signal('');
  readonly busy = signal(false);
  readonly error = signal('');
  readonly canAnalyze = computed(() => !!this.capabilities()?.enabled && !!this.profile() && !!this.previewUrl() && this.consent() && !this.busy());
  readonly canConfirm = computed(() => this.analysis()?.status === 'SUCCESS' && this.analysis()?.profile_version === this.profile()?.version && !this.busy());
  readonly canConfirmManual = computed(() => !!this.profile() && !this.busy());
  readonly isManualConfirmed = computed(() => Boolean(this.profile()?.personal_color?.analysis_id?.startsWith('manual-')));
  readonly seasons: Array<{
    id: 'Spring' | 'Summer' | 'Autumn' | 'Winter';
    name: string;
    english: string;
    undertone: string;
    undertoneBadge: string;
    description: string;
    palette: string[];
    avoided: string[];
  }> = [
    {
      id: 'Spring',
      name: 'Mùa Xuân',
      english: 'Spring',
      undertone: 'Tone da Ấm (Warm & Bright)',
      undertoneBadge: 'Sắc da ấm · Tươi sáng',
      description: 'Làn da ấm áp, tươi tắn, ánh vàng nhẹ. Rất hợp với các gam màu rạng rỡ, ngập tràn sức sống như cam đào, san hô, vàng hoàng yến, xanh mint tươi mát.',
      palette: ['peach', 'coral', 'gold', 'mint'],
      avoided: ['black', 'burgundy', 'royal_blue'],
    },
    {
      id: 'Summer',
      name: 'Mùa Hè',
      english: 'Summer',
      undertone: 'Tone da Lạnh (Cool & Soft)',
      undertoneBadge: 'Sắc da lạnh · Dịu nhẹ',
      description: 'Làn da tông lạnh, trong trẻo, ánh hồng nhẹ. Tôn da nhất với các gam màu pastel nhã nhặn, thanh lịch như tím oải hương, hồng phấn, xanh da trời, xô thơm.',
      palette: ['lavender', 'rose', 'sky', 'sage'],
      avoided: ['terracotta', 'mustard', 'brown'],
    },
    {
      id: 'Autumn',
      name: 'Mùa Thu',
      english: 'Autumn',
      undertone: 'Tone da Ấm (Warm & Deep)',
      undertoneBadge: 'Sắc da ấm · Trầm sâu',
      description: 'Làn da ấm, đậm nét quý phái, cổ điển. Đẹp hoàn hảo với các tone màu đất ấm nồng như cam đất terracotta, xanh rêu oliu, vàng mù tạt, nâu trầm mocha.',
      palette: ['terracotta', 'olive', 'mustard', 'brown'],
      avoided: ['sky', 'lavender', 'mint'],
    },
    {
      id: 'Winter',
      name: 'Mùa Đông',
      english: 'Winter',
      undertone: 'Tone da Lạnh (Cool & Bright)',
      undertoneBadge: 'Sắc da lạnh · Tương phản cao',
      description: 'Làn da lạnh sắc sảo, độ tương phản ngũ quan rõ rệt. Tỏa sáng tuyệt đối với những gam màu đá quý quyền lực: xanh ngọc lục bảo, xanh hoàng gia, đỏ rượu, đen tuyền.',
      palette: ['emerald', 'royal_blue', 'burgundy', 'black'],
      avoided: ['peach', 'gold', 'mustard'],
    },
  ];
  readonly selectedSeasonData = computed(() => this.seasons.find((s) => s.id === this.selectedManualSeason()) || this.seasons[0]);
  readonly statusLabel = computed(() => {
    const analysis = this.analysis();
    const status = analysis?.status;
    if (status === 'FAILED' && analysis?.error === 'COLOR_RATE_LIMITED') {
      return 'Hệ thống AI đang xử lý nhiều lượt cùng lúc. Vui lòng bấm phân tích lại sau giây lát.';
    }
    const labels: Record<string, string> = { RUNNING: 'Đang kiểm tra ảnh và phân tích…', SUCCESS: 'Bản xem trước — chưa lưu', LOW_CONFIDENCE: 'Độ tin cậy thấp — không thể xác nhận. Hãy chụp ảnh khác.', VALIDATION_FAILED: 'Ảnh chưa đáp ứng hướng dẫn. Hãy chụp lại.', FAILED: 'Phân tích thất bại. Màu đã xác nhận vẫn được giữ.', TIMEOUT: 'Phân tích đã hết thời gian. Màu đã xác nhận vẫn được giữ.', CANCELLED: 'Đã huỷ. Màu đã xác nhận vẫn được giữ.', CONFIRMED: 'Đã xác nhận và lưu vào hồ sơ phong cách.' };
    return status ? labels[status] : '';
  });
  readonly colorLabels: Record<string, string> = {
    peach: 'Hồng đào (Peach)',
    coral: 'San hô (Coral)',
    gold: 'Ánh vàng (Gold)',
    mint: 'Xanh bạc hà (Mint)',
    lavender: 'Tím oải hương (Lavender)',
    rose: 'Hồng cánh sen (Rose)',
    sky: 'Xanh da trời (Sky Blue)',
    sage: 'Xanh xô thơm (Sage)',
    terracotta: 'Cam đất (Terracotta)',
    olive: 'Xanh rêu (Olive)',
    mustard: 'Vàng mù tạt (Mustard)',
    brown: 'Nâu trầm (Brown)',
    emerald: 'Ngọc lục bảo (Emerald)',
    royal_blue: 'Xanh hoàng gia (Royal Blue)',
    burgundy: 'Đỏ rượu vang (Burgundy)',
    black: 'Đen tuyền (Black)',
  };

  colorLabel(key: string): string {
    return this.colorLabels[key] || key;
  }

  seasonTitle(season: string): string {
    const titles: Record<string, string> = {
      Spring: 'Mùa Xuân (Spring)',
      Summer: 'Mùa Hè (Summer)',
      Autumn: 'Mùa Thu (Autumn)',
      Winter: 'Mùa Đông (Winter)',
    };
    return titles[season] || season;
  }

  seasonUndertone(season: string): string {
    const tones: Record<string, string> = {
      Spring: 'Tone da Ấm (Warm Undertone)',
      Summer: 'Tone da Lạnh (Cool Undertone)',
      Autumn: 'Tone da Ấm (Warm Undertone)',
      Winter: 'Tone da Lạnh (Cool Undertone)',
    };
    return tones[season] || 'Tone da Tự nhiên';
  }

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
  /** Selects one of the 4 standard seasons manually. */
  selectManualSeason(season: 'Spring' | 'Summer' | 'Autumn' | 'Winter'): void {
    this.selectedManualSeason.set(season);
  }

  /** Switches to the manual configuration mode with optional initial season choice. */
  editManually(season?: string): void {
    if (season && ['Spring', 'Summer', 'Autumn', 'Winter'].includes(season)) {
      this.selectedManualSeason.set(season as 'Spring' | 'Summer' | 'Autumn' | 'Winter');
    }
    this.activeTab.set('manual');
  }

  /** Confirms the selected standard season directly into the user Style Profile. */
  confirmManual(): void {
    const profile = this.profile();
    if (!profile || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    const generation = this.generation;
    this.model
      .confirmManual(this.selectedManualSeason(), profile.version)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (updated) => {
          if (generation === this.generation) {
            this.profile.set(updated);
            this.busy.set(false);
          }
        },
        error: (err: Error) => {
          if (generation === this.generation) {
            this.error.set(err.message || 'Không thể lưu mùa màu sắc. Vui lòng thử lại.');
            this.busy.set(false);
          }
        },
      });
  }

  private clearFile(): void { if (this.previewUrl()) URL.revokeObjectURL(this.previewUrl()); this.previewUrl.set(''); this.file = null; }
}
