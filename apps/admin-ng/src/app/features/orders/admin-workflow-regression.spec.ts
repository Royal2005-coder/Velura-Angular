import { TestBed } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import { vi } from 'vitest';
import { createAdminPage } from '../../../testing/admin-testing';
import { AdminOrderRow } from '../../core/admin-api.service';
import { AdminSessionService } from '../../core/admin-session.service';
import { AdminOrdersPage } from './admin-orders.page';
import { AdminProductsPage } from '../catalog/admin-products.page';
import { AdminPricingPage } from '../pricing/admin-pricing.page';

const cod: AdminOrderRow = {
  order_id: 'o', status: 'pending', payment_method: 'COD', total_amount: 1200000, version: 3,
  user_id: 'member', is_guest: false, shipping_phone: '0912345678', allowed_actions: [
    { code: 'call_confirm', label: 'Gọi xác nhận', to_status: null, requires_note: true, fields: ['call_result'], destructive: false },
    { code: 'confirm_cod', label: 'Xác nhận', to_status: 'confirmed', requires_note: true, fields: [], destructive: false },
  ],
};

describe('Admin workflow regressions', () => {
  it('requires successful call logging for member COD at the threshold too', async () => {
    const page = await createAdminPage(AdminOrdersPage, { getOrder: () => of(cod) });
    page.openDetail('o');
    expect(page.requiresCallConfirmation()).toBe(true);
    expect(page.primaryActions().map((action) => action.code)).not.toContain('confirm_cod');
    page.selected.set({ ...cod, total_amount: 999999 });
    expect(page.requiresCallConfirmation()).toBe(false);
    page.selected.set({ ...cod, has_successful_call_confirm: true });
    expect(page.requiresCallConfirmation()).toBe(false);
  });

  it('opens COD contact with no assumed outcome or fabricated note', async () => {
    const performOrderAction = vi.fn();
    const page = await createAdminPage(AdminOrdersPage, { getOrder: () => of(cod), performOrderAction });
    page.openCodCallConfirm(cod);
    expect(page.codDecision()).toBe('');
    expect(page.codNote()).toBe('');
    expect(page.codCallStarted()).toBe(false);
    page.codNote.set('Chưa liên hệ khách hàng');
    page.submitCodCall(new Event('submit'));
    expect(performOrderAction).not.toHaveBeenCalled();
    expect(page.actionError()).toContain('Bấm Gọi');
  });

  it('starting a call never unlocks order confirmation before the server accepts reached', async () => {
    const response = new Subject<{ order: AdminOrderRow }>();
    const performOrderAction = vi.fn((_id: string, _action: string, _body: Record<string, unknown>) => response);
    const page = await createAdminPage(AdminOrdersPage, { getOrder: () => of(cod), performOrderAction });
    page.openCodCallConfirm(cod);
    page.codDecision.set('confirm'); page.codNote.set('Đã trao đổi với khách hàng');
    page.submitCodCall(new Event('submit'));
    expect(performOrderAction).not.toHaveBeenCalled();
    page.startCodCall();
    expect(page.requiresCallConfirmation()).toBe(true);
    page.submitCodCall(new Event('submit'));
    expect(performOrderAction).toHaveBeenCalledWith('o', 'call_confirm', expect.objectContaining({ callResult: 'reached', expectedVersion: 3 }));
    expect(performOrderAction.mock.calls[0][2]).not.toHaveProperty('confirmOrder');
    expect(page.requiresCallConfirmation()).toBe(true);
    response.next({ order: { ...cod, has_successful_call_confirm: true, version: 4 } });
    expect(page.requiresCallConfirmation()).toBe(false);
  });

  it('cancels old list responses after a new filter request', async () => {
    const first = new Subject<{ rows: AdminOrderRow[]; count: number }>();
    const second = new Subject<{ rows: AdminOrderRow[]; count: number }>();
    const page = await createAdminPage(AdminOrdersPage, { listOrders: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second) });
    page.reload();
    second.next({ rows: [{ ...cod, order_code: 'NEW' }], count: 1 });
    first.next({ rows: [{ ...cod, order_code: 'OLD' }], count: 1 });
    expect(page.rows()[0].order_code).toBe('NEW');
  });

  it('does not submit a call when latest order data fails to load', async () => {
    const performOrderAction = vi.fn();
    const page = await createAdminPage(AdminOrdersPage, { getOrder: () => throwError(() => new Error('Offline')), performOrderAction });
    page.openCodCallConfirm(cod);
    page.codDecision.set('confirm'); page.codNote.set('Khách xác nhận địa chỉ');
    page.submitCodCall(new Event('submit'));
    expect(performOrderAction).not.toHaveBeenCalled();
  });

  it('uses the version returned by price mutation for the following details save', async () => {
    const product = { product_id: 'p', name: 'Áo Linen', sku: 'VL-AO001', category_id: 'c', base_price: 500000, sale_price: 400000, version: 3, images: ['/assets/linen.jpg'] };
    const updated = { ...product, sale_price: 350000, version: 4 };
    const changePrice = vi.fn(() => of(updated)), updateProduct = vi.fn(() => of({ ...updated, version: 5 }));
    const page = await createAdminPage(AdminProductsPage, { changePrice, updateProduct });
    TestBed.inject(AdminSessionService).applyAuthContext({ role: 'super_admin', isAdmin: true });
    page.selected.set(product); page.overlay.set('edit'); page.editBasePrice.set(500000); page.editSalePrice.set(350000);
    const form = document.createElement('form');
    for (const [name, value] of Object.entries({ name: 'Áo Linen', sku: 'VL-AO001', slug: 'ao', categoryId: 'c', collection: '', description: '', images: '/assets/linen.jpg' })) { const input = document.createElement('input'); input.name = name; input.value = value; form.append(input); }
    page.submitEditor({ preventDefault: () => {}, target: form } as unknown as Event);
    expect(updateProduct).toHaveBeenCalledWith('p', expect.objectContaining({ expectedVersion: 4 }));
  });

  it('reads prices through the permission-scoped pricing Model', async () => {
    const listPricingProducts = vi.fn(() => of({ rows: [], count: 0 })), listProducts = vi.fn();
    await createAdminPage(AdminPricingPage, { listPricingProducts, listProducts });
    expect(listPricingProducts).toHaveBeenCalled(); expect(listProducts).not.toHaveBeenCalled();
  });

  it('integrates prices while keeping a price operator outside catalog mutations', async () => {
    const listPricingProducts = vi.fn(() => of({ rows: [], count: 0 })), listProducts = vi.fn(() => of({ rows: [], count: 0 }));
    const page = await createAdminPage(AdminProductsPage, { listPricingProducts, listProducts });
    TestBed.inject(AdminSessionService).applyAuthContext({ role: 'admin_operator_gia_km', isAdmin: true, allowedModules: ['pricing'] });
    listProducts.mockClear(); page.reloadCatalog();
    expect(listProducts).not.toHaveBeenCalled(); expect(listPricingProducts).toHaveBeenCalled();
    expect(page.canMutate()).toBe(false); expect(page.canChangePrice()).toBe(true);
  });

  it('requires an audit reason and suppresses duplicate integrated price saves', async () => {
    const response = new Subject<unknown>(), changePrice = vi.fn(() => response);
    const page = await createAdminPage(AdminProductsPage, { changePrice });
    TestBed.inject(AdminSessionService).applyAuthContext({ role: 'admin_operator_gia_km', isAdmin: true });
    page.openPrice({ product_id: 'p', name: 'Áo', version: 3, base_price: 500000 });
    const form = document.createElement('form');
    for (const [name, value] of Object.entries({ base: '500000', sale: '400000', reason: '' })) { const input = document.createElement('input'); input.name = name; input.value = value; form.append(input); }
    const event = { preventDefault: () => {}, target: form } as unknown as Event;
    page.submitPrice(event); expect(changePrice).not.toHaveBeenCalled();
    (form.elements.namedItem('reason') as HTMLInputElement).value = 'Điều chỉnh cho chiến dịch mùa mới';
    page.submitPrice(event); page.submitPrice(event);
    expect(changePrice).toHaveBeenCalledTimes(1);
    expect(changePrice).toHaveBeenCalledWith('p', expect.objectContaining({ expectedVersion: 3, newSalePrice: 400000 }));
    response.complete();
  });
});
