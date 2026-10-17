import { Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { LoyaltyService, type LoyaltyWallet } from '../../core/services/loyalty.service';
import { formatVnd } from '../../core/utils/money';

/** Read-only wallet and referral history, reachable from existing account offers. */
@Component({ selector: 'app-loyalty-wallet', standalone: true, imports: [RouterLink], templateUrl: './loyalty-wallet.component.html' })
export class LoyaltyWalletComponent {
  private readonly model = inject(LoyaltyService);
  private readonly auth = inject(AuthService);
  private readonly destroy = inject(DestroyRef);
  private generation = 0;
  readonly wallet = signal<LoyaltyWallet | null>(null);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  readonly hasOlder = signal(false);
  readonly referralLink = computed(() => `${window.location.origin}/auth/signup?referral=${encodeURIComponent(this.wallet()?.referral_code || '')}`);
  constructor() {
    effect(() => { this.auth.session(); untracked(() => { this.generation++; this.wallet.set(null); this.hasOlder.set(false); this.busy.set(false); this.error.set(''); this.notice.set(''); if (this.auth.isLoggedIn()) this.reload(); }); });
  }
  /** Refresh balances, expiry lots and rewards from the authenticated server. */
  reload(): void { this.load(); }
  /** Request the next 50 durable ledger entries without changing the balance locally. */
  older(): void { const history = this.wallet()?.history; if (history?.length && this.hasOlder()) this.load(history[history.length - 1].entry_id); }
  /** Copy only the public referral link; clipboard failure remains visible. */
  async copyReferral(): Promise<void> {
    if (!this.wallet()?.referral_code) return;
    try { await navigator.clipboard.writeText(this.referralLink()); this.notice.set('Đã sao chép liên kết giới thiệu.'); }
    catch { this.error.set('Không sao chép được. Chọn và sao chép liên kết bên dưới.'); }
  }
  /** Format server monetary values, not a frontend reward calculation. */
  money(value: number): string { return formatVnd(value); }
  /** Display server expiry and event timestamps in the browser locale. */
  date(value: string): string { return new Date(value).toLocaleString('vi-VN'); }
  /** Translate authoritative referral and voucher states without inferring qualification. */
  state(value: string): string { return ({ pending: 'Chờ đủ điều kiện', qualified: 'Đã đủ điều kiện', reversed: 'Đã đảo thưởng', issued: 'Đã cấp', used: 'Đã sử dụng', revoked: 'Đã thu hồi' } as Record<string, string>)[value] || value; }
  private load(before?: string): void {
    if (this.busy()) return;
    const generation = ++this.generation;
    this.busy.set(true); this.error.set('');
    this.model.wallet(before).pipe(takeUntilDestroyed(this.destroy)).subscribe({
      next: response => {
        if (generation !== this.generation) return;
        const wallet = response.wallet;
        this.hasOlder.set(wallet.history.length === 50);
        const previous = before ? this.wallet()?.history || [] : [];
        this.wallet.set({ ...wallet, history: [...previous, ...wallet.history] });
        this.busy.set(false);
      },
      error: (error: Error) => { if (generation === this.generation) { this.busy.set(false); this.error.set(error.message || 'Chưa tải được ví điểm.'); } },
    });
  }
}
