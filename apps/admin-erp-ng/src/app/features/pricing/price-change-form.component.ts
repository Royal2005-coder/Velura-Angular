import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { finalize } from 'rxjs';
import { AdminErpApiService, AdminProductRow } from '../../core/admin-erp-api.service';
import { MIN_CHANGE_REASON_LENGTH } from '../../core/admin-erp-catalog';
import { AdminErpConfirmService } from '../../core/admin-erp-confirm.service';
import { adminMoney } from '../../core/admin-erp-format';
import { adminErrorMessage } from '../../core/admin-erp-http';
import { AdminErpModal } from '../../shared/ui/admin-modal';
import { AdminErpToastService } from '../../shared/ui/admin-toast';

/** A price drop larger than this (in %) is treated as a probable typo and needs a second confirmation. */
export const PRICE_DROP_CONFIRM_PCT = 30;

let formSequence = 0;

/**
 * Signed change from `before` to `after` in whole percent (−90 for 49 000 → 4 900), or null when there
 * is no meaningful baseline to compare against.
 */
export function priceChangePct(before: number, after: number): number | null {
  if (!Number.isFinite(before) || !Number.isFinite(after) || before <= 0) {
    return null;
  }
  return Math.round(((after - before) * 100) / before);
}

/**
 * The one price rule set for every change-price entry point: base > 0, sale > 0 and never above base,
 * reason long enough for the audit trail. Returns the first problem in Vietnamese, or null when valid.
 */
export function priceChangeProblem(base: number, sale: number, reason: string): string | null {
  if (!Number.isFinite(base) || base <= 0) {
    return 'Giá gốc phải lớn hơn 0.';
  }
  if (!Number.isFinite(sale) || sale <= 0) {
    return 'Giá bán phải lớn hơn 0.';
  }
  if (sale > base) {
    return 'Giá bán không được cao hơn giá gốc.';
  }
  if (reason.trim().length < MIN_CHANGE_REASON_LENGTH) {
    return `Lý do cần tối thiểu ${MIN_CHANGE_REASON_LENGTH} ký tự.`;
  }
  return null;
}

/**
 * Change-price dialog shared by the catalog and pricing workspaces. Shows current → new for base and
 * selling price with the % change, blocks a selling price above the base price, asks a second time when
 * the price drops by more than {@link PRICE_DROP_CONFIRM_PCT}% (typo guard, e.g. 49 000 → 4 900), and writes
 * through `change-price` with the version the operator is looking at. A blank selling price means "no
 * promotion": the product sells at its base price.
 */
@Component({
  selector: 'app-erp-price-change-form',
  imports: [AdminErpModal],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-erp-modal #modal [open]="open()" title="Đổi giá sản phẩm" size="sm" [dirty]="dirty()" [busy]="saving()" (closed)="closed.emit()">
      @if (product(); as item) {
        <form class="price-change" [id]="formId" (submit)="submit($event)" novalidate>
          <div class="price-change__product">
            <strong>{{ item.name }}</strong>
            <span>{{ item.sku || '—' }} · v{{ item.version ?? '—' }}</span>
          </div>

          <div class="price-change__fields">
            <label class="erp-field">
              <span>Giá gốc</span>
              <input class="erp-input" name="basePrice" type="number" min="0" step="1000" inputmode="numeric" [value]="baseInput()" (input)="onBaseInput($event)" required />
            </label>
            <label class="erp-field">
              <span>Giá bán (bỏ trống = bán bằng giá gốc)</span>
              <input class="erp-input" name="salePrice" type="number" min="0" step="1000" inputmode="numeric" [value]="saleInput()" (input)="onSaleInput($event)" />
            </label>
          </div>

          <dl class="price-change__compare" aria-live="polite">
            <div>
              <dt>Giá gốc</dt>
              <dd>
                {{ money(oldBase()) }} → <strong>{{ money(newBase()) }}</strong>
                <span class="price-change__delta" [class.is-drop]="(baseChange() ?? 0) < 0">{{ pctLabel(baseChange()) }}</span>
              </dd>
            </div>
            <div>
              <dt>Giá bán</dt>
              <dd>
                {{ money(oldSale()) }} → <strong>{{ money(newSale()) }}</strong>
                <span class="price-change__delta" [class.is-drop]="(saleChange() ?? 0) < 0">{{ pctLabel(saleChange()) }}</span>
              </dd>
            </div>
            <div>
              <dt>Giảm so với giá gốc</dt>
              <dd><strong>{{ discountPct() }}%</strong></dd>
            </div>
          </dl>

          @if (saleAboveBase()) {
            <p class="erp-error" role="alert">Giá bán không được cao hơn giá gốc.</p>
          } @else if (bigDrop()) {
            <p class="price-change__warn" role="status">
              Giá giảm {{ dropPct() }}% so với hiện tại. Khi lưu sẽ cần xác nhận thêm một lần.
            </p>
          }

          <label class="erp-field">
            <span>Lý do (tối thiểu {{ minReasonLength }} ký tự, ghi vào lịch sử giá)</span>
            <textarea class="erp-input" name="reason" rows="3" [value]="reason()" (input)="onReasonInput($event)" required></textarea>
          </label>

          @if (error()) {
            <p class="erp-error" role="alert">{{ error() }}</p>
          }
        </form>
      }
      <div footer>
        <button class="erp-btn erp-btn--sm" type="button" [disabled]="saving()" (click)="modal.close()">Hủy</button>
        <button class="erp-btn erp-btn--primary erp-btn--sm" type="submit" [attr.form]="formId" [disabled]="!product() || saving() || confirming() || saleAboveBase()">
          {{ saving() ? 'Đang lưu…' : 'Lưu giá' }}
        </button>
      </div>
    </app-erp-modal>
  `,
  styles: [
    `
      .price-change {
        display: grid;
        gap: 14px;
      }
      .price-change__product {
        display: grid;
        gap: 2px;
        padding: 10px 12px;
        border: 1px solid var(--erp-line);
        border-radius: var(--erp-radius-sm);
        background: var(--erp-surface-muted);
      }
      .price-change__product strong {
        font-size: 13px;
      }
      .price-change__product span {
        color: var(--erp-muted);
        font-size: 11px;
      }
      .price-change__fields {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
      }
      .price-change__compare {
        display: grid;
        gap: 6px;
        margin: 0;
        padding: 10px 12px;
        border-radius: var(--erp-radius-sm);
        background: var(--erp-surface-muted);
        font-size: 12.5px;
      }
      .price-change__compare div {
        display: flex;
        justify-content: space-between;
        gap: 12px;
      }
      .price-change__compare dt {
        color: var(--erp-muted);
      }
      .price-change__compare dd {
        margin: 0;
        font-variant-numeric: tabular-nums;
        text-align: right;
      }
      .price-change__delta {
        margin-left: 6px;
        color: var(--erp-success);
        font-weight: 600;
      }
      .price-change__delta.is-drop {
        color: var(--erp-danger);
      }
      .price-change__warn {
        margin: 0;
        padding: 8px 10px;
        border: 1px solid var(--erp-warning-line);
        border-radius: var(--erp-radius-sm);
        background: var(--erp-warning-soft);
        color: var(--erp-warning-text);
        font-size: 12px;
      }
      @media (max-width: 480px) {
        .price-change__fields {
          grid-template-columns: minmax(0, 1fr);
        }
      }
    `,
  ],
})
export class PriceChangeFormComponent {
  private readonly api = inject(AdminErpApiService);
  private readonly confirm = inject(AdminErpConfirmService);
  private readonly toast = inject(AdminErpToastService);

  /** Product whose price is changed; its `version` is sent as `expectedVersion`. */
  readonly product = input<AdminProductRow | null>(null);
  readonly open = input(false);
  /** The row returned by the API after a successful write. */
  readonly saved = output<AdminProductRow>();
  /** The operator dismissed the dialog (after the discard prompt when there were edits). */
  readonly closed = output<void>();

  readonly formId = `price-change-form-${++formSequence}`;
  readonly minReasonLength = MIN_CHANGE_REASON_LENGTH;
  readonly baseInput = signal('');
  readonly saleInput = signal('');
  readonly reason = signal('');
  readonly saving = signal(false);
  /** The second (large-drop) confirmation is on screen. */
  readonly confirming = signal(false);
  readonly error = signal<string | null>(null);
  private readonly initial = signal({ base: '', sale: '' });

  readonly oldBase = computed(() => Number(this.product()?.base_price || 0));
  readonly oldSale = computed(() => {
    const product = this.product();
    return Number(product?.sale_price ?? product?.base_price ?? 0);
  });
  readonly newBase = computed(() => parsePrice(this.baseInput()));
  readonly newSale = computed(() => (this.saleInput().trim() === '' ? this.newBase() : parsePrice(this.saleInput())));
  readonly baseChange = computed(() => priceChangePct(this.oldBase(), this.newBase()));
  readonly saleChange = computed(() => priceChangePct(this.oldSale(), this.newSale()));
  readonly discountPct = computed(() => {
    const base = this.newBase();
    const sale = this.newSale();
    return base > 0 && sale >= 0 && sale < base ? Math.round(((base - sale) * 100) / base) : 0;
  });
  readonly saleAboveBase = computed(() => Number.isFinite(this.newSale()) && Number.isFinite(this.newBase()) && this.newSale() > this.newBase());
  /** Largest drop across base and selling price, in positive percent. */
  readonly dropPct = computed(() => Math.max(0, -(this.baseChange() ?? 0), -(this.saleChange() ?? 0)));
  readonly bigDrop = computed(() => this.dropPct() > PRICE_DROP_CONFIRM_PCT);
  readonly dirty = computed(
    () =>
      this.reason().trim().length > 0 ||
      this.baseInput() !== this.initial().base ||
      this.saleInput() !== this.initial().sale,
  );

  constructor() {
    /** Every opening (or switch to another product) starts from the stored prices. */
    effect(() => {
      const open = this.open();
      const productId = this.product()?.product_id;
      if (!open || !productId) {
        return;
      }
      untracked(() => this.reset());
    });
  }

  /**
   * Validates, asks again for a large drop, then writes the change with expectedVersion and an audit reason.
   */
  async submit(event?: Event): Promise<void> {
    event?.preventDefault();
    const product = this.product();
    if (!product || this.saving() || this.confirming()) {
      return;
    }
    if (product.version == null) {
      this.error.set('Thiếu phiên bản sản phẩm để cập nhật giá.');
      return;
    }
    const base = this.newBase();
    const sale = this.newSale();
    const reason = this.reason().trim();
    const problem = priceChangeProblem(base, sale, reason);
    if (problem) {
      this.error.set(problem);
      return;
    }
    this.error.set(null);
    if (this.bigDrop()) {
      this.confirming.set(true);
      const answer = await this.confirm.ask({
        title: `Giảm giá ${this.dropPct()}%?`,
        message: `Giá bán ${adminMoney(this.oldSale())} → ${adminMoney(sale)}, giá gốc ${adminMoney(this.oldBase())} → ${adminMoney(base)}. Kiểm tra lại số chữ số trước khi lưu.`,
        confirmLabel: 'Lưu giá mới',
        tone: 'danger',
      });
      this.confirming.set(false);
      if (!answer.confirmed) {
        return;
      }
    }
    this.saving.set(true);
    this.api
      .changePrice(product.product_id, { newBasePrice: base, newSalePrice: sale, reason, expectedVersion: product.version })
      .pipe(finalize(() => this.saving.set(false)))
      .subscribe({
        next: (updated) => {
          this.toast.success(`Đã lưu giá mới cho ${product.name}: ${adminMoney(sale)}.`);
          this.saved.emit(updated);
        },
        error: (error: unknown) => {
          const message = adminErrorMessage(error, 'Không lưu được giá.');
          this.error.set(message);
          this.toast.error(`Không lưu được giá: ${message}`);
        },
      });
  }

  /** Tracks the typed base price. */
  onBaseInput(event: Event): void {
    this.baseInput.set((event.target as HTMLInputElement).value);
  }

  /** Tracks the typed selling price; blank means "sell at base price". */
  onSaleInput(event: Event): void {
    this.saleInput.set((event.target as HTMLInputElement).value);
  }

  /** Tracks the audit reason. */
  onReasonInput(event: Event): void {
    this.reason.set((event.target as HTMLTextAreaElement).value);
  }

  /** Locale money label; a value that is not a number yet shows as a dash. */
  money(value: number): string {
    return Number.isFinite(value) ? adminMoney(value) : '—';
  }

  /** Signed percent label ("−90%", "+5%", "0%"); empty when there is no baseline price. */
  pctLabel(value: number | null): string {
    if (value === null) {
      return '';
    }
    return value > 0 ? `+${value}%` : value < 0 ? `−${Math.abs(value)}%` : '0%';
  }

  private reset(): void {
    const product = this.product();
    const base = product?.base_price != null ? String(product.base_price) : '';
    const sale = product?.sale_price != null ? String(product.sale_price) : '';
    this.initial.set({ base, sale });
    this.baseInput.set(base);
    this.saleInput.set(sale);
    this.reason.set('');
    this.error.set(null);
    this.confirming.set(false);
  }
}

function parsePrice(raw: string): number {
  const text = raw.trim();
  return text === '' ? Number.NaN : Number(text);
}
