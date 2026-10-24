import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { AdminCsvCommitResult, AdminCsvPreview, AdminErpApiService } from '../../core/admin-erp-api.service';
import { ProductCsvImportComponent } from './product-csv-import.component';

const preview: AdminCsvPreview = {
  rows: [
    { row: 2, sku: 'VLR-UAT001', name: 'Áo linen mẫu', base_price: 450_000, category_id: 'c1', operation: 'created' },
    { row: 3, sku: 'VLR-UAT002', name: 'Quần kaki mẫu', base_price: 500_000, category_id: 'c1', operation: 'updated' },
  ],
  errors: [],
  warnings: [{ row: 2, field: 'base_price', message: 'giá khác', csv_value: 450_000, current_value: 420_000 }],
  totalRows: 2,
  validRows: 2,
};

const sample = 'sku,name,base_price,category_id\nVLR-UAT001,Áo,450000,c1\n';

describe('ProductCsvImportComponent', () => {
  function boot(api: Partial<AdminErpApiService>, canWrite = true) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [ProductCsvImportComponent],
      providers: [{ provide: AdminErpApiService, useValue: api }],
    });
    const fixture = TestBed.createComponent(ProductCsvImportComponent);
    fixture.componentRef.setInput('canWrite', canWrite);
    fixture.componentRef.setInput('categories', [{ category_id: 'c1', name: 'Áo' }]);
    fixture.detectChanges();
    return { fixture, panel: fixture.componentInstance };
  }

  /** Drives the real file path: a picked File reaches the component through the change event. */
  async function review(panel: ProductCsvImportComponent, csv: string, size?: number): Promise<void> {
    const file = new File([csv], 'products.csv', { type: 'text/csv' });
    if (size !== undefined) {
      Object.defineProperty(file, 'size', { value: size });
    }
    panel.onFilePicked({ target: { files: [file], value: '' } } as unknown as Event);
    for (let attempt = 0; attempt < 20 && panel.checking(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  function confirm(panel: ProductCsvImportComponent): void {
    panel.toggleReviewed({ target: { checked: true } } as unknown as Event);
  }

  it('validates through the API and keeps the write behind an explicit confirmation', async () => {
    const { panel } = boot({ previewCsv: () => of(preview) });
    expect(panel.canCommit()).toBe(false);

    await review(panel, sample);

    expect(panel.checking()).toBe(false);
    expect(panel.validRows()).toBe(2);
    expect(panel.totalRows()).toBe(2);
    expect(panel.rows().length).toBe(2);
    expect(panel.warnings().length).toBe(1);
    expect(panel.message()).toContain('2 dòng hợp lệ');
    expect(panel.canCommit()).toBe(false);

    confirm(panel);
    expect(panel.canCommit()).toBe(true);
  });

  it('blocks the write and the confirmation when the preview has blocking errors', async () => {
    const { panel } = boot({
      previewCsv: () =>
        of({
          ...preview,
          rows: [preview.rows![0]],
          validRows: 1,
          errors: [{ row: 3, field: 'sku', message: 'SKU trùng' }],
        }),
    });

    await review(panel, 'sku,name,base_price,category_id\nBAD,Quần,10,c1\n');

    expect(panel.hasErrors()).toBe(true);
    expect(panel.errors()[0].message).toBe('SKU trùng');
    expect(panel.reviewed()).toBe(false);
    expect(panel.canCommit()).toBe(false);
    expect(panel.message()).toContain('Chưa thể ghi catalog');

    confirm(panel);
    expect(panel.reviewed()).toBe(false);
  });

  it('commits exactly the text that was reviewed and reports the counters', async () => {
    const committed: string[] = [];
    const emitted: number[] = [];
    const { panel } = boot({
      previewCsv: () => of(preview),
      commitCsv: (csv: string) => {
        committed.push(csv);
        return of({ created: 1, updated: 1, failed: 0, total: 2, warnings: [], skippedPrices: 0 });
      },
    });
    panel.imported.subscribe(() => emitted.push(1));

    await review(panel, sample);
    confirm(panel);
    panel.commit();

    expect(committed).toEqual([sample]);
    expect(panel.message()).toContain('1 tạo mới, 1 cập nhật');
    expect(panel.rows()).toEqual([]);
    expect(emitted).toEqual([1]);
  });

  it('keeps row errors when the server rejects the file at commit time', async () => {
    const { panel } = boot({
      previewCsv: () => of(preview),
      commitCsv: () =>
        throwError(
          () =>
            new HttpErrorResponse({
              status: 422,
              error: {
                error: { code: 'CSV_VALIDATION_FAILED', details: { errors: [{ row: 2, field: 'sku', message: 'đổi rồi' }] } },
              },
            }),
        ),
    });

    await review(panel, sample);
    confirm(panel);
    panel.commit();

    expect(panel.errors()).toEqual([{ row: 2, field: 'sku', message: 'đổi rồi' }]);
    expect(panel.message()).toContain('không còn hợp lệ');
    expect(panel.canCommit()).toBe(false);
  });

  it('refuses to write for a role without catalog update', async () => {
    const commits: string[] = [];
    const { panel } = boot(
      {
        previewCsv: () => of(preview),
        commitCsv: (csv: string) => {
          commits.push(csv);
          return of({ created: 0, updated: 0, failed: 0 } as AdminCsvCommitResult);
        },
      },
      false,
    );

    await review(panel, sample);
    confirm(panel);
    panel.commit();

    expect(commits).toEqual([]);
    expect(panel.canCommit()).toBe(false);
  });

  it('rejects an oversized file before calling the API', async () => {
    const calls: string[] = [];
    const { panel } = boot({
      previewCsv: (csv: string) => {
        calls.push(csv);
        return of(preview);
      },
    });

    await review(panel, sample, 61 * 1024);

    expect(calls).toEqual([]);
    expect(panel.message()).toContain('60 KB');
    expect(panel.checking()).toBe(false);
  });
});
