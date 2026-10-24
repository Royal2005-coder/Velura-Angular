import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { AdminErpApiService, AdminLowStockAlert, AdminProductRow } from '../../core/admin-erp-api.service';
import { ProductStockSheetComponent } from './product-stock-sheet.component';

const product: AdminProductRow = {
  product_id: 'p1',
  name: 'Áo khoác lụa',
  sku: 'VL-AO001',
  status: 'on_sale',
  version: 4,
};

const variants = [
  { variant_id: 'v1', color: 'Đen', size: 'M', stock_quantity: 10, reserved_quantity: 2, low_stock_threshold: 5, version: 3 },
  { variant_id: 'v2', color: 'Trắng', size: 'S', stock_quantity: 4, reserved_quantity: 0, low_stock_threshold: 5, version: 1 },
];

const alert: AdminLowStockAlert = {
  productId: 'p1',
  variantId: 'v1',
  productName: 'Áo khoác lụa',
  sku: 'VL-AO001-DEN-M',
  color: 'Đen',
  size: 'M',
  stock: 2,
  threshold: 5,
  emailQueued: false,
  retryRecorded: true,
  message: 'Cảnh báo tồn kho thấp',
};

describe('ProductStockSheetComponent', () => {
  function boot(calls: Array<Record<string, unknown>> = [], alerts: AdminLowStockAlert[] = [alert]) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [ProductStockSheetComponent],
      providers: [
        {
          provide: AdminErpApiService,
          useValue: {
            updateStock: (_id: string, body: Record<string, unknown>) => {
              calls.push(body);
              return of({ variant_id: 'v1', stock_quantity: 2, lowStockAlert: alerts[0] });
            },
            bulkUpdateStock: (_id: string, body: Record<string, unknown>) => {
              calls.push(body);
              return of({ success: true, results: [], lowStockAlerts: alerts });
            },
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(ProductStockSheetComponent);
    fixture.componentRef.setInput('product', product);
    fixture.componentRef.setInput('variants', variants);
    fixture.componentRef.setInput('open', true);
    fixture.detectChanges();
    return { fixture, calls };
  }

  it('opens on the first variant and converts an outbound intent into a negative delta', () => {
    const { fixture } = boot();
    const sheet = fixture.componentInstance;

    expect(sheet.chosen()?.variant_id).toBe('v1');
    expect(sheet.current()).toBe(10);
    expect(sheet.threshold()).toBe(5);

    sheet.setType('out');
    sheet.quantity.set(4);
    expect(sheet.delta()).toBe(-4);
    expect(sheet.projected()).toBe(6);
    expect(sheet.belowThreshold()).toBe(false);

    sheet.quantity.set(14);
    expect(sheet.exceedsOnHand()).toBe(true);
    expect(sheet.canSubmit()).toBe(false);
  });

  it('writes an absolute target as the signed delta the RPC expects', () => {
    const { fixture, calls } = boot();
    const sheet = fixture.componentInstance;

    sheet.setType('set');
    sheet.quantity.set(18);
    sheet.reason.set('Cân bằng kiểm kê định kỳ cuối tháng');
    sheet.submit();

    expect(calls.length).toBe(1);
    expect(calls[0]['delta']).toBe(8);
    expect(calls[0]['variantId']).toBe('v1');
    expect(calls[0]['expectedVersion']).toBe(3);
  });

  it('carries a threshold change in the same request only when it differs', () => {
    const { fixture, calls } = boot();
    const sheet = fixture.componentInstance;

    sheet.quantity.set(0);
    sheet.setThreshold({ target: Object.assign(document.createElement('input'), { value: '8' }) } as unknown as Event);
    sheet.reason.set('Nâng ngưỡng cảnh báo cho mùa mới');
    sheet.submit();

    expect(calls.length).toBe(1);
    expect(calls[0]['delta']).toBe(0);
    expect(calls[0]['lowStockThreshold']).toBe(8);
  });

  it('refuses a reason shorter than the audited minimum', () => {
    const { fixture, calls } = boot();
    const sheet = fixture.componentInstance;

    sheet.reason.set('quá ngắn');
    expect(sheet.canSubmit()).toBe(false);
    sheet.submit();
    expect(calls.length).toBe(0);
    expect(sheet.error()).toContain('10 ký tự');
  });

  it('reports the low-stock alert produced by the write', () => {
    const { fixture } = boot();
    const sheet = fixture.componentInstance;
    const emitted: Array<AdminLowStockAlert | null> = [];
    sheet.adjusted.subscribe((value) => emitted.push(value));

    sheet.quantity.set(8);
    sheet.reason.set('Xuất hàng cho đơn khách đã xác nhận');
    sheet.submit();

    expect(emitted.length).toBe(1);
    expect(emitted[0]?.variantId).toBe('v1');
    expect(emitted[0]?.emailQueued).toBe(false);
  });

  it('submits only the batch lines the operator actually changed', () => {
    const { fixture, calls } = boot();
    const sheet = fixture.componentInstance;

    sheet.setMode('batch');
    const event = (value: string): Event =>
      ({ target: Object.assign(document.createElement('input'), { value }) }) as unknown as Event;
    sheet.setLineQuantity('v2', event('9'));
    sheet.setLineThreshold('v2', event('4'));
    sheet.reason.set('Nhập lô hàng mới từ xưởng may');

    expect(sheet.batchLines()).toEqual([
      { variantId: 'v2', delta: 5, lowStockThreshold: 4, expectedVersion: 1 },
    ]);

    sheet.submit();
    expect(calls.length).toBe(1);
    expect(calls[0]['reason']).toBe('Nhập lô hàng mới từ xưởng may');
    expect((calls[0]['updates'] as unknown[]).length).toBe(1);
  });
});
