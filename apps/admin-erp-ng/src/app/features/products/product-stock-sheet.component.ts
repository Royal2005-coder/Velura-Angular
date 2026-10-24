import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import {
  AdminBulkStockLine,
  AdminErpApiService,
  AdminLowStockAlert,
  AdminProductRow,
  AdminProductVariant,
} from '../../core/admin-erp-api.service';
import { MIN_CHANGE_REASON_LENGTH, stockDelta } from '../../core/admin-erp-catalog';
import { adminErrorMessage } from '../../core/admin-erp-http';
import { AdminErpDataTable, AdminTableColumn } from '../../shared/ui/admin-data-table';
import { AdminErpModal } from '../../shared/ui/admin-modal';
import { AdminErpStatusBadge } from '../../shared/ui/admin-status-badge';

/**
 * Stock sheet for one product. A single variant moves by an inbound, outbound or set
 * line; the batch tab adjusts every variant of the product under one shared reason.
 * Going below the low-stock threshold is legal — the API answers with the alert it raised.
 */
@Component({
  selector: 'app-erp-product-stock-sheet',
  imports: [AdminErpModal, AdminErpDataTable, AdminErpStatusBadge],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './product-stock-sheet.component.html',
  styleUrl: './product-stock-sheet.component.scss',
})
export class ProductStockSheetComponent {
  private readonly api = inject(AdminErpApiService);

  readonly product = input<AdminProductRow | null>(null);
  readonly variants = input<readonly AdminProductVariant[]>([]);
  readonly open = input(false);

  readonly adjusted = output<AdminLowStockAlert | null>();
  readonly closed = output<void>();

  readonly mode = signal<'single' | 'batch'>('single');
  readonly variantId = signal('');
  readonly type = signal<'in' | 'out' | 'set'>('in');
  readonly quantity = signal(10);
  readonly threshold = signal(5);
  readonly reason = signal('Nhập lô hàng mới từ xưởng may');
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  /** Batch lines keyed by variant, holding the operator's target quantity and threshold. */
  readonly lines = signal<Record<string, { quantity: number; threshold: number }>>({});

  readonly reasons = [
    'Nhập lô hàng mới từ xưởng may',
    'Khách hoàn hàng, tái nhập kho',
    'Xuất trả hàng lỗi / bảo hành',
    'Hàng rách, hỏng, tiêu hủy mẫu trưng bày',
    'Cân bằng kiểm kê định kỳ',
  ];
  readonly minReasonLength = MIN_CHANGE_REASON_LENGTH;

  readonly chosen = computed(() => {
    const id = this.variantId();
    return this.variants().find((variant) => variant.variant_id === id) || this.variants()[0] || null;
  });
  readonly current = computed(() => Number(this.chosen()?.stock_quantity ?? 0));
  readonly reserved = computed(() => Number(this.chosen()?.reserved_quantity ?? 0));
  readonly thresholdValue = computed(() => Number(this.chosen()?.low_stock_threshold ?? 5));
  readonly projected = computed(() => Math.max(0, this.current() + this.delta()));
  readonly delta = computed(() => stockDelta(this.type(), this.current(), Math.max(0, this.quantity())));
  readonly belowThreshold = computed(() => this.projected() <= this.threshold());
  readonly exceedsOnHand = computed(() => this.type() === 'out' && this.quantity() > this.current());
  readonly thresholdChanged = computed(() => this.threshold() !== this.thresholdValue());
  readonly canSubmit = computed(() => {
    const reason = this.reason().trim();
    if (this.saving() || reason.length < MIN_CHANGE_REASON_LENGTH) {
      return false;
    }
    if (this.exceedsOnHand()) {
      return false;
    }
    return this.mode() === 'single' ? this.delta() !== 0 || this.thresholdChanged() : this.batchLines().length > 0;
  });

  readonly batchLines = computed<AdminBulkStockLine[]>(() => {
    const lines = this.lines();
    const result: AdminBulkStockLine[] = [];
    for (const variant of this.variants()) {
      const line = lines[variant.variant_id];
      if (!line) {
        continue;
      }
      const current = Number(variant.stock_quantity ?? 0);
      const delta = Number(line.quantity) - current;
      const threshold = Number(line.threshold);
      const changedThreshold = Number.isFinite(threshold) && threshold >= 0 && threshold !== Number(variant.low_stock_threshold ?? 5);
      if (delta === 0 && !changedThreshold) {
        continue;
      }
      result.push({
        variantId: variant.variant_id,
        delta,
        ...(changedThreshold ? { lowStockThreshold: threshold } : {}),
        expectedVersion: Number(variant.version ?? 1),
      });
    }
    return result;
  });

  readonly batchColumns: readonly AdminTableColumn[] = [
    {
      key: 'variant',
      label: 'Biến thể',
      value: (row) => {
        const variant = row as AdminProductVariant;
        return [variant.color, variant.size].filter(Boolean).join(' · ') || variant.variant_id;
      },
    },
    { key: 'sku', label: 'SKU', value: (row) => (row as AdminProductVariant).sku || '—', mono: true },
    {
      key: 'current',
      label: 'Hiện có',
      align: 'right',
      mono: true,
      value: (row) => String((row as AdminProductVariant).stock_quantity ?? 0),
    },
    {
      key: 'reserved',
      label: 'Đang giữ',
      align: 'right',
      mono: true,
      value: (row) => String((row as AdminProductVariant).reserved_quantity ?? 0),
    },
    {
      key: 'threshold',
      label: 'Ngưỡng',
      align: 'right',
      mono: true,
      value: (row) => String((row as AdminProductVariant).low_stock_threshold ?? 5),
    },
  ];

  constructor() {
    /** Opening the sheet always starts from the stored state of the first variant. */
    effect(() => {
      if (!this.open()) {
        return;
      }
      const first = this.variants()[0];
      this.mode.set('single');
      this.variantId.set(first?.variant_id || '');
      this.type.set('in');
      this.quantity.set(10);
      this.threshold.set(Number(first?.low_stock_threshold ?? 5));
      this.lines.set({});
      this.error.set(null);
    });
  }

  /**
   * Switches between single and batch entry.
   */
  setMode(mode: string): void {
    this.mode.set(mode === 'batch' ? 'batch' : 'single');
    this.error.set(null);
    if (mode === 'batch') {
      this.seedLines();
    }
  }

  /**
   * Selects the variant to adjust and mirrors its threshold.
   */
  selectVariant(event: Event): void {
    const variantId = (event.target as HTMLSelectElement).value;
    const variant = this.variants().find((row) => row.variant_id === variantId);
    this.variantId.set(variantId);
    this.threshold.set(Number(variant?.low_stock_threshold ?? 5));
  }

  /**
   * Chooses inbound, outbound or absolute stock.
   */
  setType(type: 'in' | 'out' | 'set'): void {
    this.type.set(type);
  }

  /**
   * Updates the adjustment quantity.
   */
  setQuantity(event: Event): void {
    this.quantity.set(Math.max(0, Math.trunc(Number((event.target as HTMLInputElement).value) || 0)));
  }

  /**
   * Updates the low-stock threshold written with the same adjustment.
   */
  setThreshold(event: Event): void {
    this.threshold.set(Math.max(0, Math.trunc(Number((event.target as HTMLInputElement).value) || 0)));
  }

  /**
   * Picks a standard reason phrase.
   */
  setReason(reason: string): void {
    this.reason.set(reason);
  }

  /**
   * Types a free-text reason.
   */
  setReasonInput(event: Event): void {
    this.reason.set((event.target as HTMLTextAreaElement).value);
  }

  /**
   * Sets one batch line's target quantity.
   */
  setLineQuantity(variantId: string, event: Event): void {
    this.setLine(variantId, 'quantity', Math.max(0, Math.trunc(Number((event.target as HTMLInputElement).value) || 0)));
  }

  /**
   * Sets one batch line's threshold.
   */
  setLineThreshold(variantId: string, event: Event): void {
    this.setLine(variantId, 'threshold', Math.max(0, Math.trunc(Number((event.target as HTMLInputElement).value) || 0)));
  }

  /**
   * Writes the adjustment and reports the alert the same write produced.
   */
  submit(): void {
    const product = this.product();
    if (!product) {
      return;
    }
    const reason = this.reason().trim();
    if (reason.length < MIN_CHANGE_REASON_LENGTH) {
      this.error.set(`Lý do điều chỉnh cần tối thiểu ${MIN_CHANGE_REASON_LENGTH} ký tự.`);
      return;
    }
    this.error.set(null);
    this.saving.set(true);
    if (this.mode() === 'single') {
      const variant = this.chosen();
      if (!variant) {
        this.saving.set(false);
        this.error.set('Sản phẩm chưa có biến thể để điều chỉnh.');
        return;
      }
      this.api
        .updateStock(product.product_id, {
          variantId: variant.variant_id,
          delta: this.delta(),
          reason,
          expectedVersion: Number(variant.version ?? 1),
          ...(this.thresholdChanged() ? { lowStockThreshold: this.threshold() } : {}),
        })
        .subscribe({
          next: (result) => {
            this.saving.set(false);
            this.adjusted.emit(result.lowStockAlert ?? null);
          },
          error: (error: unknown) => {
            this.saving.set(false);
            this.error.set(adminErrorMessage(error, 'Không điều chỉnh được tồn kho.'));
          },
        });
      return;
    }
    this.api
      .bulkUpdateStock(product.product_id, { updates: this.batchLines(), reason })
      .subscribe({
        next: (result) => {
          this.saving.set(false);
          this.adjusted.emit(result.lowStockAlerts?.[0] ?? null);
        },
        error: (error: unknown) => {
          this.saving.set(false);
          this.error.set(adminErrorMessage(error, 'Không điều chỉnh được tồn kho hàng loạt.'));
        },
      });
  }

  /**
   * Closes the sheet without writing.
   */
  dismiss(): void {
    if (!this.saving()) {
      this.closed.emit();
    }
  }

  /**
   * Current target quantity of one batch line, defaulting to the stored stock.
   */
  lineQuantity(variant: AdminProductVariant): number {
    return this.lines()[variant.variant_id]?.quantity ?? Number(variant.stock_quantity ?? 0);
  }

  /**
   * Current threshold of one batch line.
   */
  lineThreshold(variant: AdminProductVariant): number {
    return this.lines()[variant.variant_id]?.threshold ?? Number(variant.low_stock_threshold ?? 5);
  }

  /**
   * Color and size of a variant, for selects and batch rows.
   */
  variantLabel(variant: AdminProductVariant): string {
    return [variant.color, variant.size]
      .map((value) => String(value || '').trim())
      .filter((value) => value.length > 0)
      .join(' · ') || variant.variant_id;
  }

  private setLine(variantId: string, field: 'quantity' | 'threshold', value: number): void {
    this.lines.update((lines) => {
      const variant = this.variants().find((row) => row.variant_id === variantId);
      const current = lines[variantId] || {
        quantity: Number(variant?.stock_quantity ?? 0),
        threshold: Number(variant?.low_stock_threshold ?? 5),
      };
      return { ...lines, [variantId]: { ...current, [field]: value } };
    });
  }

  private seedLines(): void {
    const seed: Record<string, { quantity: number; threshold: number }> = {};
    for (const variant of this.variants()) {
      seed[variant.variant_id] = {
        quantity: Number(variant.stock_quantity ?? 0),
        threshold: Number(variant.low_stock_threshold ?? 5),
      };
    }
    this.lines.set(seed);
    this.variantId.set(this.variants()[0]?.variant_id || '');
  }
}
