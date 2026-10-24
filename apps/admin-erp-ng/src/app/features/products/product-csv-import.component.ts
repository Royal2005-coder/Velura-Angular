import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { AdminCsvIssue, AdminCsvPreview, AdminCsvPreviewRow, AdminErpApiService } from '../../core/admin-erp-api.service';
import { CSV_REQUIRED_COLUMNS, MAX_CSV_ROWS } from '../../core/admin-erp-catalog';
import { adminErrorMessage, adminErrorDetails } from '../../core/admin-erp-http';
import { AdminErpDataTable, AdminTableColumn } from '../../shared/ui/admin-data-table';
import { AdminErpIcon } from '../../shared/ui/admin-erp-icon';

const MAX_FILE_BYTES = 60 * 1024;

/**
 * CSV staging area. A file is validated by the API first and only the exact text that
 * came back without blocking errors may be committed, so the catalog never receives a
 * file the operator did not review. Prices are never written by import.
 */
@Component({
  selector: 'app-erp-product-csv-import',
  imports: [AdminErpDataTable, AdminErpIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './product-csv-import.component.html',
  styleUrl: './product-csv-import.component.scss',
})
export class ProductCsvImportComponent {
  private readonly api = inject(AdminErpApiService);

  readonly canWrite = input(false);
  readonly categories = input<readonly { category_id: string; name: string }[]>([]);
  readonly imported = output<void>();

  readonly fileName = signal('');
  readonly text = signal('');
  readonly checking = signal(false);
  readonly committing = signal(false);
  readonly reviewed = signal(false);
  readonly message = signal('Chưa có file nào được kiểm tra.');
  readonly rows = signal<AdminCsvPreviewRow[]>([]);
  readonly errors = signal<AdminCsvIssue[]>([]);
  readonly warnings = signal<AdminCsvIssue[]>([]);
  readonly validRows = signal(0);
  readonly totalRows = signal(0);

  private fileRevision = 0;

  readonly hasErrors = computed(() => this.errors().length > 0);
  readonly canCommit = computed(
    () =>
      this.canWrite() &&
      this.reviewed() &&
      !this.checking() &&
      !this.committing() &&
      !this.hasErrors() &&
      this.validRows() > 0 &&
      this.text().length > 0,
  );
  readonly requiredColumns = CSV_REQUIRED_COLUMNS.join(', ');
  readonly maxRows = MAX_CSV_ROWS;

  readonly previewColumns = computed<readonly AdminTableColumn[]>(() => [
    { key: 'row', label: 'Dòng', value: (row) => String((row as AdminCsvPreviewRow).row), mono: true, align: 'right' },
    { key: 'sku', label: 'SKU', value: (row) => (row as AdminCsvPreviewRow).sku, mono: true },
    {
      key: 'parent',
      label: 'SKU cha',
      value: (row) => (row as AdminCsvPreviewRow).product_sku || '—',
      mono: true,
    },
    { key: 'name', label: 'Tên', value: (row) => (row as AdminCsvPreviewRow).name || '—' },
    {
      key: 'operation',
      label: 'Thao tác',
      value: (row) => ((row as AdminCsvPreviewRow).operation === 'created' ? 'Tạo mới' : 'Cập nhật'),
      badge: (row) => {
        const created = (row as AdminCsvPreviewRow).operation === 'created';
        return { label: created ? 'Tạo mới' : 'Cập nhật', tone: created ? ('info' as const) : ('neutral' as const) };
      },
    },
    {
      key: 'variant',
      label: 'Biến thể',
      value: (row) => {
        const line = row as AdminCsvPreviewRow;
        return [line.color, line.size].filter(Boolean).join(' · ') || '—';
      },
    },
    {
      key: 'stock',
      label: 'Tồn',
      align: 'right',
      mono: true,
      value: (row) => {
        const line = row as AdminCsvPreviewRow;
        return line.stock_quantity == null ? '—' : String(line.stock_quantity);
      },
    },
    {
      key: 'status',
      label: 'Trạng thái',
      value: (row) => (row as AdminCsvPreviewRow).status || 'giữ nguyên',
    },
    {
      key: 'price',
      label: 'Giá',
      align: 'right',
      mono: true,
      value: (row) => {
        const line = row as AdminCsvPreviewRow;
        return line.skipped_prices?.length ? 'giữ giá hiện tại' : String(line.base_price ?? '—');
      },
    },
  ]);

  readonly issueColumns: readonly AdminTableColumn[] = [
    { key: 'row', label: 'Dòng', value: (row) => String((row as AdminCsvIssue).row ?? '—'), mono: true, align: 'right' },
    { key: 'field', label: 'Cột', value: (row) => (row as AdminCsvIssue).field || 'csv', mono: true },
    { key: 'message', label: 'Nội dung', value: (row) => (row as AdminCsvIssue).message || '—' },
  ];

  /**
   * Reads a chosen file and asks the API to validate it.
   */
  onFilePicked(event: Event): void {
    if (this.committing()) {
      return;
    }
    const picker = event.target as HTMLInputElement;
    const file = picker.files?.[0];
    picker.value = '';
    if (!file) {
      return;
    }
    const revision = ++this.fileRevision;
    this.resetResult();
    this.fileName.set(file.name);
    if (file.size > MAX_FILE_BYTES) {
      this.message.set('File CSV không được vượt quá 60 KB.');
      return;
    }
    this.checking.set(true);
    this.message.set('Đang kiểm tra CSV, chưa thể ghi catalog.');
    const reader = new FileReader();
    reader.onload = () => {
      if (revision !== this.fileRevision) {
        return;
      }
      const csv = String(reader.result || '');
      this.text.set(csv);
      this.reviewed.set(false);
      this.api.previewCsv(csv).subscribe({
        next: (preview) => this.applyPreview(preview, revision),
        error: (error: unknown) => {
          if (revision !== this.fileRevision) {
            return;
          }
          this.checking.set(false);
          this.message.set(adminErrorMessage(error, 'Không kiểm tra được CSV.'));
        },
      });
    };
    reader.onerror = () => {
      if (revision !== this.fileRevision) {
        return;
      }
      this.checking.set(false);
      this.message.set('Không đọc được file CSV. Vui lòng chọn lại file.');
    };
    reader.readAsText(file);
  }

  /**
   * Writes the API's answer into the review state and unlocks the commit only when clean.
   */
  private applyPreview(preview: AdminCsvPreview, revision: number): void {
    if (revision !== this.fileRevision) {
      return;
    }
    const rows = Array.isArray(preview?.rows) ? preview.rows : [];
    const errors = Array.isArray(preview?.errors) ? preview.errors : [];
    const valid = preview?.validRows;
    const total = preview?.totalRows;
    this.checking.set(false);
    if (typeof valid !== 'number' || typeof total !== 'number' || valid !== rows.length || valid < 0 || total < valid) {
      this.message.set('Kết quả kiểm tra CSV không hợp lệ. Chưa cho phép ghi catalog.');
      return;
    }
    const warnings = Array.isArray(preview?.warnings) ? preview.warnings : [];
    this.rows.set(rows);
    this.errors.set(errors);
    this.warnings.set(warnings);
    this.validRows.set(valid);
    this.totalRows.set(total);
    const warningNote = warnings.length
      ? ` ${warnings.length} mức giá trong CSV khác giá hiện tại và sẽ bị bỏ qua.`
      : '';
    this.message.set(
      errors.length
        ? `Kiểm tra xong: ${valid}/${total} dòng hợp lệ, ${errors.length} lỗi. Chưa thể ghi catalog.${warningNote}`
        : `Kiểm tra xong: ${valid} dòng hợp lệ. Tích xác nhận để ghi catalog.${warningNote}`,
    );
    /** A clean preview unlocks the control, but the operator still has to confirm the write. */
    this.reviewed.set(false);
  }

  /**
   * Toggles the explicit operator confirmation required before a write.
   */
  toggleReviewed(event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    if (this.hasErrors() || this.validRows() === 0) {
      this.reviewed.set(false);
      this.message.set('CSV còn dòng lỗi nên không thể xác nhận ghi catalog.');
      return;
    }
    this.reviewed.set(checked);
  }

  /**
   * Commits the reviewed text.
   */
  commit(): void {
    if (!this.canCommit()) {
      this.message.set('CSV phải được kiểm tra không còn lỗi và được xác nhận trước khi ghi catalog.');
      return;
    }
    const csv = this.text();
    this.reviewed.set(false);
    this.committing.set(true);
    this.api.commitCsv(csv).subscribe({
      next: (result) => {
        this.committing.set(false);
        if (typeof result?.failed !== 'number' || !Number.isSafeInteger(result.failed) || result.failed < 0) {
          this.message.set('Chưa xác minh được kết quả nhập. Giữ CSV để đối chiếu trước khi gửi lại.');
          this.reviewed.set(true);
          return;
        }
        if (result.failed > 0) {
          this.message.set('Kết quả nhập báo lỗi. Giữ file CSV để đối chiếu và kiểm tra lại trước khi gửi lại.');
          return;
        }
        const warnings = Array.isArray(result.warnings) ? result.warnings : [];
        this.warnings.set(warnings);
        this.message.set(
          warnings.length
            ? `Đã ghi CSV: ${result.created ?? 0} tạo mới, ${result.updated ?? 0} cập nhật. ${warnings.length} mức giá được giữ nguyên.`
            : `Đã ghi CSV: ${result.created ?? 0} tạo mới, ${result.updated ?? 0} cập nhật.`,
        );
        this.resetResult();
        this.imported.emit();
      },
      error: (error: unknown) => {
        this.committing.set(false);
        const status = error instanceof HttpErrorResponse ? error.status : 0;
        const rows = adminErrorDetails(error)?.['errors'];
        if (status === 422 && Array.isArray(rows)) {
          this.errors.set(rows as AdminCsvIssue[]);
          this.message.set('CSV không còn hợp lệ ở thời điểm ghi. Xem lỗi từng dòng và kiểm tra lại file.');
          return;
        }
        this.message.set(adminErrorMessage(error, 'Không thể ghi CSV vào catalog.'));
      },
    });
  }

  /**
   * Downloads the template with a real category id when the catalog has one.
   */
  downloadTemplate(): void {
    const categoryId = this.categories()[0]?.category_id || '';
    const header = 'sku,name,base_price,category_id,sale_price,status,description,image_url,product_sku,color,color_hex,size,stock_quantity,low_stock_threshold';
    const sample = `VLR-DEMO001,Áo khoác mẫu,450000,${categoryId},420000,hidden,Bản nháp chờ duyệt ảnh,,,Đen,#1A1A1A,M,50,5`;
    const blob = new Blob([`${header}\n${sample}\n`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'velura-products-template.csv';
    link.click();
    URL.revokeObjectURL(url);
  }

  private resetResult(): void {
    this.rows.set([]);
    this.errors.set([]);
    this.warnings.set([]);
    this.validRows.set(0);
    this.totalRows.set(0);
    this.reviewed.set(false);
  }
}
