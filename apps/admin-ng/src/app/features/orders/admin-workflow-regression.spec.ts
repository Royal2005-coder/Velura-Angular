import { TestBed } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import { vi } from 'vitest';
import { createAdminPage } from '../../../testing/admin-testing';
import { AdminChatMessagesPayload, AdminOrderRow, AdminReturnRow } from '../../core/admin-api.service';
import { AdminSessionService } from '../../core/admin-session.service';
import { AdminOrdersPage } from './admin-orders.page';
import { AdminReturnsPage } from '../returns/admin-returns.page';
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

  it('reports chat outages as errors, not an empty customer queue', async () => {
    const page = await createAdminPage(AdminReturnsPage, { listChatSessions: () => throwError(() => new Error('Chat offline')) });
    expect(page.loadError()).toBeTruthy();
  });

  it('cannot show previous customer messages after selecting another session', async () => {
    const first = new Subject<AdminChatMessagesPayload>(), second = new Subject<AdminChatMessagesPayload>();
    const page = await createAdminPage(AdminReturnsPage, { getChatMessages: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second) });
    page.selectChat({ session_id: 'first' }); page.selectChat({ session_id: 'second' });
    second.next({ messages: [{ text: 'Second customer' }] }); first.next({ messages: [{ text: 'First customer' }] });
    expect(page.messages()[0].text).toBe('Second customer');
  });

  it('blocks receipt when registered return lines are absent', async () => {
    const page = await createAdminPage(AdminReturnsPage, { getReturn: () => of({ return_id: 'r', lines: [] }) });
    TestBed.inject(AdminSessionService).applyAuthContext({ role: 'super_admin', isAdmin: true });
    page.openReceive({ return_id: 'r', version: 1, status: 'RETURN_IN_TRANSIT' });
    expect(page.qaReady()).toBe(false);
    expect(page.qaError()).toContain('dòng hàng');
  });

  it('reconciles every warehouse line and suppresses duplicate receipt', async () => {
    const response = new Subject<unknown>(), updateReturnStatus = vi.fn(() => response);
    const row: AdminReturnRow = { return_id: 'r', version: 4, status: 'RETURN_IN_TRANSIT', lines: [{ order_item_id: 'a', quantity: 2 }, { order_item_id: 'b', quantity: 1 }] };
    const page = await createAdminPage(AdminReturnsPage, { getReturn: () => of(row), updateReturnStatus });
    TestBed.inject(AdminSessionService).applyAuthContext({ role: 'super_admin', isAdmin: true });
    page.openReceive(row); page.qaResult.set('qa_pass'); page.qaProof.set('data:image/png;base64,proof');
    page.qaLines.update((lines) => lines.map((line) => ({ ...line, receivedQuantity: String(line.expectedQuantity), confirmedItemId: line.orderItemId, matchesProduct: true })));
    page.confirmReceive(); page.confirmReceive();
    expect(updateReturnStatus).toHaveBeenCalledTimes(1);
    expect(updateReturnStatus).toHaveBeenCalledWith('r', expect.objectContaining({ expectedVersion: 4, items: [{ orderItemId: 'a', receivedQuantity: 2, matchesProduct: true }, { orderItemId: 'b', receivedQuantity: 1, matchesProduct: true }] }));
    response.complete();
  });

  it('uses the version returned by price mutation for the following details save', async () => {
    const product = { product_id: 'p', name: 'Áo Linen', sku: 'VL-AO001', category_id: 'c', base_price: 500000, sale_price: 400000, version: 3 };
    const updated = { ...product, sale_price: 350000, version: 4 };
    const changePrice = vi.fn(() => of(updated)), updateProduct = vi.fn(() => of({ ...updated, version: 5 }));
    const page = await createAdminPage(AdminProductsPage, { changePrice, updateProduct });
    TestBed.inject(AdminSessionService).applyAuthContext({ role: 'super_admin', isAdmin: true });
    page.selected.set(product); page.overlay.set('edit'); page.editBasePrice.set(500000); page.editSalePrice.set(350000);
    const form = document.createElement('form');
    for (const [name, value] of Object.entries({ name: 'Áo Linen', sku: 'VL-AO001', slug: 'ao', categoryId: 'c', collection: '', description: '', images: '' })) { const input = document.createElement('input'); input.name = name; input.value = value; form.append(input); }
    page.submitEditor({ preventDefault: () => {}, target: form } as unknown as Event);
    expect(updateProduct).toHaveBeenCalledWith('p', expect.objectContaining({ expectedVersion: 4 }));
  });

  it('reads prices through the permission-scoped pricing Model', async () => {
    const listPricingProducts = vi.fn(() => of({ rows: [], count: 0 })), listProducts = vi.fn();
    await createAdminPage(AdminPricingPage, { listPricingProducts, listProducts });
    expect(listPricingProducts).toHaveBeenCalled(); expect(listProducts).not.toHaveBeenCalled();
  });

  it('requires contact before approval and exposes both actual return branches', async () => {
    const page = await createAdminPage(AdminReturnsPage);
    TestBed.inject(AdminSessionService).applyAuthContext({ role: 'super_admin', isAdmin: true });
    page.returns.set([{ return_id: 'r', status: 'REQUESTED', version: 1 }]);
    page.openReturnAction('refund', 'r');
    expect(page.actionType()).toBeNull();
    page.selectedReturn.set({ return_id: 'r', status: 'RECEIVED', return_type: 'refund' });
    expect(page.returnPipeline().map((step) => step.status)).toContain('REFUND_PROCESSING');
    expect(page.nextReturnStep(page.selectedReturn()!)).toBeNull();
    page.selectedReturn.set({ return_id: 'r', status: 'RECEIVED', return_type: 'exchange', condition_check_result: 'qa_pass' });
    expect(page.returnPipeline().map((step) => step.status)).not.toContain('REFUNDED');
    expect(page.nextReturnStep(page.selectedReturn()!)?.status).toBe('EXCHANGE_PREPARING');
  });

  it('flags untouched requests after24h without cancelling them', async () => {
    const updateReturnStatus = vi.fn();
    const page = await createAdminPage(AdminReturnsPage, { updateReturnStatus });
    const row = { return_id: 'r', status: 'REQUESTED', created_at: new Date(Date.now() - 25 * 3600000).toISOString() };
    expect(page.contactOverdue(row)).toBe(true);
    expect(row.status).toBe('REQUESTED');
    expect(updateReturnStatus).not.toHaveBeenCalled();
    expect(page.contactOverdue({ ...row, status: 'CONTACTING' })).toBe(false);
  });

  it('requires new tracking for replacement shipments instead of reusing the return parcel', async () => {
    const updateReturnStatus = vi.fn(() => of({}));
    const page = await createAdminPage(AdminReturnsPage, { updateReturnStatus });
    TestBed.inject(AdminSessionService).applyAuthContext({ role: 'super_admin', isAdmin: true });
    page.advanceReturn({ return_id: 'r', status: 'EXCHANGE_PREPARING', version: 4, tracking_return_code: 'OLD' }, 'EXCHANGE_SHIPPING');
    expect(updateReturnStatus).not.toHaveBeenCalled();
    const form = document.createElement('form'), input = document.createElement('input'); input.name = 'tracking'; form.append(input);
    page.submitShipment({ preventDefault: () => {}, target: form } as unknown as Event);
    expect(updateReturnStatus).not.toHaveBeenCalled();
    input.value = 'NEW'; page.submitShipment({ preventDefault: () => {}, target: form } as unknown as Event);
    expect(updateReturnStatus).toHaveBeenCalledWith('r', { status: 'EXCHANGE_SHIPPING', trackingReturnCode: 'NEW', expectedVersion: 4 });
  });

  it('refuses generic gateway state transitions even with admin permissions', async () => {
    const updateReturnStatus = vi.fn();
    const page = await createAdminPage(AdminReturnsPage, { updateReturnStatus });
    TestBed.inject(AdminSessionService).applyAuthContext({ role: 'super_admin', isAdmin: true });
    page.advanceReturn({ return_id: 'r', status: 'RECEIVED', version: 1 }, 'REFUNDED');
    expect(updateReturnStatus).not.toHaveBeenCalled();
  });

  it('requires QA and captured non-Stripe payment before manual transfer recording', async () => {
    const page = await createAdminPage(AdminReturnsPage);
    TestBed.inject(AdminSessionService).applyAuthContext({ role: 'super_admin', isAdmin: true });
    const row = { return_id: 'r', status: 'RECEIVED', condition_check_result: 'qa_pass', return_type: 'refund', payment: { payment_status: 'paid', payment_provider: 'cod' } };
    expect(page.canRecordManualRefund(row)).toBe(true);
    expect(page.canRecordManualRefund({ ...row, condition_check_result: 'qa_fail' })).toBe(false);
    expect(page.canRecordManualRefund({ ...row, payment: { payment_status: 'paid', payment_provider: 'stripe' } })).toBe(false);
  });

  it('routes negative QA evidence to support without declaring receipt or issuing a refund', async () => {
    const updateReturnStatus = vi.fn(() => of({}));
    const page = await createAdminPage(AdminReturnsPage, { updateReturnStatus });
    TestBed.inject(AdminSessionService).applyAuthContext({ role: 'super_admin', isAdmin: true });
    page.receiveTarget.set({ return_id: 'r', status: 'RETURN_IN_TRANSIT', version: 2 });
    page.qaLines.set([{ orderItemId: 'a', expectedQuantity: 1, receivedQuantity: '1', confirmedItemId: 'a', matchesProduct: false }]);
    page.qaResult.set('qa_fail'); page.qaProof.set('data:image/png;base64,proof'); page.qaFailureNote.set('Hàng khác với sản phẩm trên đơn');
    page.reportQaFailure();
    expect(updateReturnStatus).toHaveBeenCalledWith('r', expect.objectContaining({ status: 'NEEDS_SUPPORT', conditionCheckResult: 'qa_fail', expectedVersion: 2 }));
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
