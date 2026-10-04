import { HttpErrorResponse } from '@angular/common/http';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import type { AdminOrderAction, AdminOrderRow } from '../../core/admin-api.service';
import { createAdminPage, lastAdminFixture } from '../../../testing/admin-testing';
import { AdminOrdersPage } from './admin-orders.page';

const ORDER_ID = '50000000-0000-4000-8000-000000000001';

const action = (code: string, label: string, extra: Partial<AdminOrderAction> = {}): AdminOrderAction => ({
  code,
  label,
  to_status: null,
  requires_note: true,
  fields: [],
  destructive: false,
  ...extra,
});

const pendingCod = (overrides: Partial<AdminOrderRow> = {}): AdminOrderRow => ({
  order_id: ORDER_ID,
  order_code: 'VLR1A2B3C4D5',
  status: 'pending',
  status_label: 'Chờ xác nhận',
  payment_method: 'COD',
  total_amount: 900_000,
  version: 3,
  tags: [{ code: 'PRIORITY_REVIEW', label: 'Ưu tiên duyệt' }],
  allowed_actions: [
    action('call_confirm', 'Gọi xác nhận', { fields: ['call_result'] }),
    action('confirm_cod', 'Xác nhận đơn', { to_status: 'confirmed' }),
    action('cancel', 'Hủy đơn', { to_status: 'cancelled', fields: ['cancel_reason'], destructive: true }),
  ],
  events: [],
  ...overrides,
});

const summary = {
  by_status: [
    { status: 'pending', label: 'Chờ xác nhận', count: 4 },
    { status: 'cancelled', label: 'Đã hủy', count: 2 },
  ],
  attention: 5,
};

function render(): HTMLElement {
  const fixture = lastAdminFixture();
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

function buttonLabels(root: HTMLElement, selector: string): string[] {
  return Array.from(root.querySelectorAll(selector)).map((button) => button.textContent?.trim() || '');
}

function submitForm(root: HTMLElement): void {
  const form = root.querySelector('.admin-modal form') as HTMLFormElement;
  form.dispatchEvent(new Event('submit', { cancelable: true }));
}

describe('AdminOrdersPage', () => {
  it('exposes loading, empty, and error list signals', async () => {
    const page = await createAdminPage(AdminOrdersPage);
    expect(page.loading()).toBe(false);
    expect(page.rows()).toEqual([]);
    expect(page.loadError()).toBeNull();
  });

  it('counts come from the summary endpoint, not from the page being viewed', async () => {
    const page = await createAdminPage(AdminOrdersPage, { orderSummary: () => of(summary) });
    expect(page.attentionCount()).toBe(5);
    expect(page.cancelledCount()).toBe(2);
  });

  it('"Cần xử lý" and payment tabs filter on the server', async () => {
    const listOrders = vi.fn(() => of({ rows: [], count: 0 }));
    const page = await createAdminPage(AdminOrdersPage, { listOrders });
    page.setTab('attention');
    expect(listOrders).toHaveBeenLastCalledWith(expect.objectContaining({ attention: 'true' }));
    page.setTab('payment');
    expect(listOrders).toHaveBeenLastCalledWith(expect.objectContaining({ tag: 'PAYMENT_ATTENTION' }));
  });

  it('the drawer renders one button per allowed action and keeps cancel apart (FR-06)', async () => {
    const page = await createAdminPage(AdminOrdersPage, { getOrder: () => of(pendingCod()) });
    page.openDetail(ORDER_ID);
    const root = render();
    expect(buttonLabels(root, '.admin-order-action-bar__primary button')).toEqual(['Gọi xác nhận', 'Xác nhận đơn']);
    expect(buttonLabels(root, '.admin-order-action-bar__danger')).toEqual(['Hủy đơn']);
    expect(root.textContent).toContain('Ưu tiên duyệt');
  });

  it('a read-only role gets no action bar at all (KAN-60: hide, do not disable)', async () => {
    const page = await createAdminPage(AdminOrdersPage, { getOrder: () => of(pendingCod({ allowed_actions: [] })) });
    page.openDetail(ORDER_ID);
    expect(render().querySelector('.admin-order-action-bar')).toBeNull();
  });

  it('the carrier simulator only shows when the API allows it', async () => {
    const page = await createAdminPage(AdminOrdersPage, {
      getOrder: () => of(pendingCod({ status: 'shipping', allowed_actions: [], can_simulate_carrier: true })),
    });
    page.openDetail(ORDER_ID);
    expect(buttonLabels(render(), '.admin-order-simulator button')).toHaveLength(3);
  });

  it('AC-17: an action without a note is not sent', async () => {
    const performOrderAction = vi.fn();
    const page = await createAdminPage(AdminOrdersPage, { getOrder: () => of(pendingCod()), performOrderAction });
    page.openDetail(ORDER_ID);
    page.openAction(pendingCod().allowed_actions![1]);
    submitForm(render());
    expect(performOrderAction).not.toHaveBeenCalled();
    expect(page.actionError()).toContain('ghi chú');
  });

  it('sends the note, the fields and the version the admin was looking at', async () => {
    const performOrderAction = vi.fn(() => of({ order: pendingCod({ status: 'confirmed' }), refund: null }));
    const page = await createAdminPage(AdminOrdersPage, { getOrder: () => of(pendingCod()), performOrderAction });
    page.openDetail(ORDER_ID);
    page.openAction(pendingCod().allowed_actions![0]);
    const root = render();
    (root.querySelector('input[name="callResult"][value="reached"]') as HTMLInputElement).checked = true;
    (root.querySelector('textarea[name="note"]') as HTMLTextAreaElement).value = 'Khách xác nhận địa chỉ';
    submitForm(root);
    expect(performOrderAction).toHaveBeenCalledWith(ORDER_ID, 'call_confirm', expect.objectContaining({
      note: 'Khách xác nhận địa chỉ',
      callResult: 'reached',
      expectedVersion: 3,
    }));
    expect(page.modal()).toBeNull();
    expect(page.selected()?.status).toBe('confirmed');
  });

  it('a stale order (409) closes the modal, reloads the order and says why', async () => {
    const getOrder = vi.fn(() => of(pendingCod()));
    const conflict = new HttpErrorResponse({
      status: 409,
      error: { error: { code: 'VERSION_CONFLICT', message: 'Đơn vừa được người khác cập nhật.' } },
    });
    const page = await createAdminPage(AdminOrdersPage, { getOrder, performOrderAction: () => throwError(() => conflict) });
    page.openDetail(ORDER_ID);
    page.openAction(pendingCod().allowed_actions![1]);
    const root = render();
    (root.querySelector('textarea[name="note"]') as HTMLTextAreaElement).value = 'Đã gọi xác nhận';
    submitForm(root);
    expect(page.modal()).toBeNull();
    expect(getOrder).toHaveBeenCalledTimes(2);
    expect(page.notice()).toContain('tải lại');
  });

  it('a refund Stripe rejected is reported with the retry path (OPEN-02)', async () => {
    const page = await createAdminPage(AdminOrdersPage, {
      getOrder: () => of(pendingCod()),
      performOrderAction: () => of({ order: pendingCod({ status: 'cancelled' }), refund: { status: 'failed', message: 'card_declined' } }),
    });
    page.openDetail(ORDER_ID);
    page.openAction(pendingCod().allowed_actions![2]);
    const root = render();
    (root.querySelector('select[name="cancelReason"]') as HTMLSelectElement).value = 'customer_request';
    (root.querySelector('textarea[name="note"]') as HTMLTextAreaElement).value = 'Khách gọi huỷ đơn';
    submitForm(root);
    expect(page.notice()).toContain('Thử hoàn tiền lại');
  });

  it('requires call confirmation for guest COD >= 1M and locks confirm button', async () => {
    const page = await createAdminPage(AdminOrdersPage, {
      getOrder: () => of(pendingCod({
        total_amount: 1_500_000,
        user_id: undefined,
        is_guest: true,
        requires_call_confirmation: true,
        allowed_actions: [
          action('call_confirm', 'Gọi xác nhận', { fields: ['call_result'] }),
          action('cancel', 'Hủy đơn', { to_status: 'cancelled', fields: ['cancel_reason'], destructive: true }),
        ],
      })),
    });
    page.openDetail(ORDER_ID);
    expect(page.isGuestOrder()).toBe(true);
    expect(page.requiresCallConfirmation()).toBe(true);
    const root = render();
    expect(root.querySelector('.admin-customer-badge--guest')).not.toBeNull();
    expect(root.querySelector('.admin-btn--disabled-lock')).not.toBeNull();
    expect(root.textContent).toContain('Cần gọi trước');
  });

  it('renders ERP pipeline steps for order progression', async () => {
    const page = await createAdminPage(AdminOrdersPage, {
      getOrder: () => of(pendingCod({ status: 'processing' })),
    });
    page.openDetail(ORDER_ID);
    const steps = page.pipelineSteps();
    expect(steps).toHaveLength(5);
    expect(steps[0].state).toBe('done');
    expect(steps[1].state).toBe('done');
    expect(steps[2].state).toBe('current');
    expect(steps[3].state).toBe('upcoming');
    expect(steps[4].state).toBe('upcoming');
    const root = render();
    expect(root.querySelector('.admin-order-pipeline')).not.toBeNull();
    expect(root.querySelectorAll('.admin-order-pipeline__step')).toHaveLength(5);
  });

  it('submits COD call confirmation with reached and auto-confirm', async () => {
    const performOrderAction = vi.fn(() => of({ order: pendingCod({ status: 'confirmed' }), refund: null }));
    const page = await createAdminPage(AdminOrdersPage, {
      getOrder: () => of(pendingCod({ is_guest: true, total_amount: 1_200_000 })),
      performOrderAction,
    });
    page.openCodCallConfirm(pendingCod({ is_guest: true, total_amount: 1_200_000 }));
    page.codDecision.set('confirm');
    page.codNote.set('Khách nghe máy và xác nhận đúng thông tin đơn hàng');
    page.codAutoConfirm.set(true);

    const event = new Event('submit');
    page.submitCodCall(event);

    expect(performOrderAction).toHaveBeenCalledWith(ORDER_ID, 'call_confirm', expect.objectContaining({
      callResult: 'reached',
      confirmOrder: true,
      note: 'Khách nghe máy và xác nhận đúng thông tin đơn hàng',
    }));
  });
});
