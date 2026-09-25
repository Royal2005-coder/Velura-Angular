import { of } from 'rxjs';
import { vi } from 'vitest';
import { createStorefrontPage, lastStorefrontFixture } from '../../../testing/storefront-testing';
import { AccountOrderDetailPage, MemberOrderDetail } from './order-detail.page';

const order = (overrides: Partial<MemberOrderDetail> = {}): MemberOrderDetail => ({
  order_id: 'o1',
  order_code: 'VLR1A2B3C4D5',
  status: 'confirmed',
  status_label: 'Đã xác nhận',
  payment_method: 'COD',
  created_at: '2026-09-24 03:00:00',
  items: [{ item_id: 'i1', product_name: 'Áo sơ mi linen', quantity: 2, unit_price: 450000 }],
  steps: [
    { status: 'pending', label: 'Chờ xác nhận', at: '2026-09-24 03:00:00', state: 'done' },
    { status: 'confirmed', label: 'Đã xác nhận', at: '2026-09-24 09:00:00', state: 'current' },
    { status: 'processing', label: 'Đang chuẩn bị hàng', at: null, state: 'upcoming' },
  ],
  can_cancel: true,
  can_pay_again: false,
  ...overrides,
});

function render(): HTMLElement {
  const fixture = lastStorefrontFixture();
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('AccountOrderDetailPage', () => {
  it('shows the order code, the API label and a timeline built from real history', async () => {
    await createStorefrontPage(AccountOrderDetailPage, { get: () => of(order()) });
    const root = render();
    expect(root.textContent).toContain('VLR1A2B3C4D5');
    expect(root.querySelector('.detail-status-badge')?.textContent?.trim()).toBe('Đã xác nhận');
    const titles = Array.from(root.querySelectorAll('.detail-timeline-title')).map((node) => node.textContent?.trim());
    expect(titles).toEqual(['Chờ xác nhận', 'Đã xác nhận', 'Đang chuẩn bị hàng']);
    expect(root.querySelectorAll('.detail-timeline-item--active')).toHaveLength(1);
    expect(root.textContent).toContain('Áo sơ mi linen');
  });

  it('offers cancel only when the API says so (BR-03)', async () => {
    await createStorefrontPage(AccountOrderDetailPage, { get: () => of(order({ status: 'processing', can_cancel: false })) });
    const buttons = Array.from(render().querySelectorAll('.detail-action-card button')).map((node) => node.textContent?.trim());
    expect(buttons).not.toContain('Hủy đơn');
  });

  it('hides the waybill until there is one (FR-09)', async () => {
    await createStorefrontPage(AccountOrderDetailPage, { get: () => of(order({ tracking_code: null })) });
    expect(render().querySelector('.detail-tracking-row')).toBeNull();
  });

  it('pay again opens the Stripe page the API returns, and nothing else', async () => {
    const post = vi.fn(() => of({ stripe: { url: 'javascript:alert(1)' } }));
    const page = await createStorefrontPage(AccountOrderDetailPage, {
      get: () => of(order({ status: 'waiting_payment', payment_method: 'ONLINE_PAYMENT', can_pay_again: true, pay_again_until: '2026-09-25 03:00:00' })),
      post,
    });
    expect(render().querySelector('.detail-pay-again-card')).not.toBeNull();
    page.payAgain();
    expect(post).toHaveBeenCalledWith('/api/user/orders/o1/pay-again', {});
    // Link không phải https bị bỏ: trang báo lỗi thay vì điều hướng.
    expect(page.payError()).toBeTruthy();
    expect(page.paying()).toBe(false);
  });

  it('cancelling reloads the order instead of guessing the new state', async () => {
    const get = vi.fn(() => of(order()));
    const patch = vi.fn(() => of({ refund: null }));
    const page = await createStorefrontPage(AccountOrderDetailPage, { get, patch });
    page.openCancel();
    page.submitCancel();
    expect(patch).toHaveBeenCalledWith('/api/user/orders', expect.objectContaining({ order_id: 'o1', status: 'cancelled' }));
    expect(get).toHaveBeenCalledTimes(2);
    expect(page.notice()).toContain('hủy');
  });
});
