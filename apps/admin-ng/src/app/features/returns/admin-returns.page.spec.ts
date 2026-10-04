import { createAdminPage } from '../../../testing/admin-testing';
import { AdminReturnsPage } from './admin-returns.page';

describe('AdminReturnsPage', () => {
  it('creates the ViewModel with a stub AdminApiService', async () => {
    const page = await createAdminPage(AdminReturnsPage);
    expect(page).toBeTruthy();
  });

  it('exposes loading, empty, and zone signals instead of template filters', async () => {
    const page = await createAdminPage(AdminReturnsPage);
    expect(page.loading()).toBe(false);
    expect(page.returns()).toEqual([]);
    expect(page.loadError()).toBeNull();
    page.zone.set('returns');
    expect(page.zone()).toBe('returns');
    expect(page.canLookupOrders()).toBe(false);
  });

  it('shows the customer return type instead of an empty request column', async () => {
    const page = await createAdminPage(AdminReturnsPage);
    expect(page.returnKind({ return_id: '1', return_type: 'refund' })).toBe('Hoàn tiền');
    expect(page.returnKind({ return_id: '2', return_type: 'exchange' })).toBe('Đổi hàng');
    expect(page.showReturnAction({ return_id: '1', return_type: 'refund' }, 'refund')).toBe(true);
    expect(page.showReturnAction({ return_id: '1', return_type: 'refund' }, 'exchange')).toBe(false);
  });

  it('handles detail drawers, stepper steps, and image lightbox', async () => {
    const page = await createAdminPage(AdminReturnsPage);
    expect(page.returnDetailOpen()).toBe(false);
    expect(page.ticketDetailOpen()).toBe(false);

    page.openReturnDetail('ret_123');
    expect(page.returnDetailOpen()).toBe(true);
    expect(page.ticketDetailOpen()).toBe(false);

    page.openTicketDetail('tkt_456');
    expect(page.ticketDetailOpen()).toBe(true);
    expect(page.returnDetailOpen()).toBe(false);

    page.openLightbox('https://example.com/proof.jpg');
    expect(page.lightboxImage()).toBe('https://example.com/proof.jpg');
    page.closeLightbox();
    expect(page.lightboxImage()).toBeNull();

    expect(page.returnStepIndex('REQUESTED')).toBe(0);
    expect(page.returnStepIndex('CONTACTING')).toBe(1);
    expect(page.returnStepIndex('WAITING_RETURN')).toBe(2);
    expect(page.returnStepIndex('RETURN_IN_TRANSIT')).toBe(3);
    expect(page.returnStepIndex('RECEIVED')).toBe(4);
    expect(page.returnStepIndex('REFUND_PROCESSING')).toBe(5);
    expect(page.returnStepIndex('REFUNDED')).toBe(6);
    expect(page.returnStepIndex('COMPLETED')).toBe(7);
    expect(page.returnStepIndex('CANCELLED')).toBe(-1);

    page.closeOverlays();
    expect(page.returnDetailOpen()).toBe(false);
    expect(page.ticketDetailOpen()).toBe(false);
  });
});
