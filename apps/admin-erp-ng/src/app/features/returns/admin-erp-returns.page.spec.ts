import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import {
  AdminAuditRow,
  AdminErpApiService,
  AdminReturnRow,
  AdminTicketRow,
} from '../../core/admin-erp-api.service';
import { AdminErpSessionService } from '../../core/admin-erp-session.service';
import { AdminErpReturnsPage } from './admin-erp-returns.page';

const rows: AdminReturnRow[] = [
  {
    return_id: 'r-1',
    order_id: 'o-1',
    order_code: 'VLR-001',
    return_type: 'refund',
    status: 'REQUESTED',
    version: 3,
    customer_name: 'Nguyễn A',
    customer_phone: '0900000001',
    payment_kind: 'cod',
    refund_flow: 'cod_manual',
    refund_receiver_status: 'missing',
  },
  {
    return_id: 'r-2',
    order_id: 'o-2',
    return_type: 'exchange',
    status: 'RETURN_IN_TRANSIT',
    version: 1,
    payment_kind: 'stripe',
  },
];

const detail: AdminReturnRow = { ...rows[0], refundable_amount: 500_000, lines: [{ return_item_id: 'ri-1', order_item_id: 'i-1', quantity: 2, version: 4, decision_status: 'pending', item_status: 'REQUESTED', resolution_type: 'refund' }] };

const tickets: AdminTicketRow[] = [
  { ticket_id: 't-1', title: 'Khách cần đổi size', status: 'open', priority: 'high', version: 1 },
  { ticket_id: 't-2', title: 'Khiếu nại đơn', status: 'resolved', version: 2 },
  { ticket_id: 't-3', title: 'Chat CSKH', status: 'open', chat_session_id: 'c-1', version: 1 },
];

describe('AdminErpReturnsPage', () => {
  function boot(capabilities: Record<string, string[]> = { returns: ['read', 'update'] }, role = 'admin_operator_cskh_dt') {
    TestBed.resetTestingModule();
    const calls = {
      returns: [] as Record<string, string>[],
      tickets: [] as Record<string, string>[],
      respond: [] as Record<string, unknown>[],
      close: [] as Record<string, unknown>[],
      serviceLogs: [] as Record<string, string>[],
    };
    const api = {
      listReturns: (params?: Record<string, string>, paymentKind?: string) => {
        calls.returns.push({ ...(params ?? {}), ...(paymentKind ? { payment_kind: paymentKind } : {}) });
        const status = params?.['status'];
        if (status === 'REQUESTED') {
          return of({ rows: [rows[0]], count: 4 });
        }
        if (status === 'RETURN_IN_TRANSIT') {
          return of({ rows: [rows[1]], count: 1 });
        }
        return of({ rows, count: 26 });
      },
      getReturn: () => of(detail),
      listTickets: (params?: Record<string, string>) => {
        calls.tickets.push(params ?? {});
        const status = params?.['status'];
        if (status === 'open') {
          return of({ rows: [tickets[0]], count: 7 });
        }
        if (status === 'processing') {
          return of({ rows: [], count: 2 });
        }
        return of({ rows: tickets, count: 3 });
      },
      getTicket: (id: string) => of(tickets.find((row) => row.ticket_id === id) || tickets[0]),
      respondTicket: (_id: string, body: Record<string, unknown>) => {
        calls.respond.push(body);
        return of({ ...tickets[0], status: 'processing', version: 2 });
      },
      resolveTicket: () => of({ ...tickets[0], status: 'resolved' }),
      closeTicket: (_id: string, body: Record<string, unknown>) => {
        calls.close.push(body);
        return of({ ...tickets[1], status: 'closed' });
      },
      listServiceLogs: (params?: Record<string, string>) => {
        calls.serviceLogs.push(params ?? {});
        return of({
          rows: [
            {
              audit_id: 'l1',
              timestamp: '2026-10-24T00:00:00Z',
              action: 'update',
              action_label: 'Duyệt hoàn tiền',
              actor_label: 'Nguyễn CSKH',
              reason: 'Khách cung cấp đủ chứng từ',
            },
          ] as AdminAuditRow[],
          count: 1,
        });
      },
      getOrder: () =>
        of({
          order_id: 'o-1',
          order_code: 'VLR-001',
          status: 'delivered',
          shipping_name: 'Trần Bình',
          shipping_phone: '0900000001',
          shipping_address: '68 Nguyễn Huệ, Quận 1',
          tracking_code: 'GHN-7788',
          total_amount: 890000,
          items: [{ product_name: 'Áo lụa tay lỡ', quantity: 2, unit_price: 445000 }],
        }),
      triggerStripeRefund: () => of({ success: true, refund: { status: 'requested' } }),
    };
    TestBed.configureTestingModule({
      imports: [AdminErpReturnsPage],
      providers: [provideRouter([]), { provide: AdminErpApiService, useValue: api }],
    });
    TestBed.inject(AdminErpSessionService).applyAuthContext({
      role,
      roleName: 'CSKH',
      isAdmin: true,
      allowedPages: ['returns-cskh'],
      allowedModules: ['returns', 'support_tickets'],
      capabilities,
      user: { id: 'u1', email: 'cskh@velura.test' },
      profile: { user_id: 'u1', email: 'cskh@velura.test', full_name: 'CSKH', is_active: true },
    });
    const fixture = TestBed.createComponent(AdminErpReturnsPage);
    fixture.detectChanges();
    return { fixture, page: fixture.componentInstance, calls };
  }

  function ticketForm(note: string): Event {
    const form = document.createElement('form');
    const textarea = document.createElement('textarea');
    textarea.name = 'note';
    textarea.value = note;
    form.appendChild(textarea);
    return { preventDefault: () => undefined, target: form } as unknown as Event;
  }

  it('loads the return queue with its server counts', () => {
    const { page } = boot();

    expect(page.returns().length).toBe(2);
    expect(page.total()).toBe(26);
    expect(page.pendingReturns()).toBe(4);
    expect(page.awaitingReceipt()).toBe(1);
    expect(page.openTickets()).toBe(7);
    expect(page.canWrite()).toBe(true);
    expect(page.statusLabel('REQUESTED')).toBeTruthy();
  });

  it('sends the status and payment channel filters to the server', () => {
    const { page, calls } = boot();
    page.statusFilter.set('REQUESTED');
    page.paymentFilter.set('cod');
    page.search.set('VLR');
    page.applyFilters();

    const filtered = calls.returns.filter((params) => params['q'] === 'VLR');
    expect(filtered.length).toBe(1);
    expect(filtered[0]['status']).toBe('REQUESTED');
    expect(filtered[0]['payment_kind']).toBe('cod');
    expect(filtered[0]['offset']).toBe('0');
  });

  it('rereads detail and leaves final decisions to the explicit super-admin role', () => {
    const { page } = boot({ returns: ['read', 'update', 'approve'] });
    page.openReturn(rows[0]);
    expect(page.selected()?.refundable_amount).toBe(500_000);
    expect(page.canApprove()).toBe(false);
    expect(page.itemActions(detail.lines![0])).toEqual([]);
    page.openFlow('approve', detail.lines![0]);
    expect(page.flow()).toBeNull();
  });

  it('lets super-admin decide each part without deriving decisions from the header', () => {
    const { page } = boot({ returns: ['read', 'update'] }, 'super_admin');
    page.openReturn(rows[0]);
    expect(page.canApprove()).toBe(true);
    expect(page.itemActions(detail.lines![0])).toEqual(['approve', 'reject']);
    page.openFlow('approve', detail.lines![0]);
    expect(page.flowLine()?.return_item_id).toBe('ri-1');
    expect(page.flow()).toBe('approve');
  });

  it('offers money per approved refund part even when the original request was exchange', () => {
    const { page } = boot();
    page.selected.set({ ...detail, return_type: 'exchange', refund_receiver_status: 'valid' });
    const part = { ...detail.lines![0], item_status: 'RECEIVED', decision_status: 'approved' as const, refundable_amount: 250_000 };
    expect(page.itemActions(part)).toContain('manual');
    expect(page.itemActions({ ...part, item_status: 'RETURN_SHIPPING' })).not.toContain('manual');
    page.openFlow('manual', part);
    expect(page.flowLine()).toEqual(part);
    expect(page.selected()?.return_type).toBe('exchange');
  });

  it('shows mixed decisions, waiting customer, initial video and independently keyed parts', () => {
    const { page, fixture } = boot({ returns: ['read'] });
    page.selected.set({
      ...detail, status: 'IN_PROGRESS', decision_status: 'PARTIALLY_APPROVED', attention_status: 'waiting_customer',
      contact_due_at: '2020-01-01T00:00:00Z', evidence_images: ['/proof.jpg'], evidence_videos: ['/initial.webm'],
      lines: [{ ...detail.lines![0], return_item_id: 'part-a', quantity: 1, decision_status: 'approved', item_status: 'WAITING_RETURN' },
        { ...detail.lines![0], return_item_id: 'part-b', quantity: 1, decision_status: 'rejected', item_status: 'REJECTED' }],
    });
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelectorAll('[data-return-item-id]').length).toBe(2);
    expect(element.querySelector('video')?.getAttribute('src')).toBe('/initial.webm');
    expect(element.textContent).toContain('Duyệt một phần');
    expect(element.textContent).toContain('Đã quá hạn liên hệ');
    expect(element.textContent).toContain('Chờ khách bổ sung');
  });

  it('masks bank data for a nonfinancial order reader even with broad update grants', () => {
    const { page } = boot({ returns: ['read', 'update'] }, 'admin_viewer');
    expect(page.canFinance()).toBe(false);
    expect(page.bankAccount('1234567890')).toBe('•••• 7890');
    expect(page.itemActions({ ...detail.lines![0], decision_status: 'approved', item_status: 'RECEIVED' })).not.toContain('manual');
  });

  it('filters tickets server-side and keeps chat-linked tickets read-only', () => {
    const { page, calls } = boot();
    page.setTab('tickets');
    page.ticketStatus.set('open');
    page.applyTicketFilters();

    const last = calls.tickets.at(-1);
    expect(last?.['status']).toBe('open');

    page.openTicket(tickets[0]);
    expect(page.canReply(page.selectedTicket())).toBe(true);
    expect(page.canResolve(page.selectedTicket())).toBe(false);

    page.openTicket(tickets[2]);
    expect(page.canReply(page.selectedTicket())).toBe(false);
    expect(page.canClose(page.selectedTicket())).toBe(false);
  });

  it('writes a ticket reply with the version on screen and closes without a discarded reason', () => {
    const { page, calls } = boot();
    page.openTicket(tickets[0]);
    page.openTicketAction('reply');
    page.submitTicketAction(ticketForm(''));
    expect(page.ticketError()).toContain('không được để trống');

    page.submitTicketAction(ticketForm('Shop đã ghi nhận yêu cầu đổi size.'));
    expect(calls.respond.length).toBe(1);
    expect(calls.respond[0]['expectedVersion']).toBe(1);

    page.openTicketAction('close');
    page.submitTicketAction(ticketForm(''));
    expect(calls.close.length).toBe(1);
    // the reply already bumped the row: closing uses the version the drawer now shows
    expect(calls.close[0]).toEqual({ expectedVersion: 2 });
  });

  it('leaves a read-only reviewer with no write affordances', () => {
    const { page } = boot({ returns: ['read'] });

    expect(page.canWrite()).toBe(false);
    page.openReturn(rows[0]);
    page.openFlow('manual');
    expect(page.flow()).toBeNull();
    page.openTicket(tickets[0]);
    expect(page.canReply(page.selectedTicket())).toBe(false);
  });

  it('reports a queue failure instead of pretending the list is empty', () => {
    TestBed.resetTestingModule();
    const api = {
      listReturns: (params?: Record<string, string>) =>
        params?.['status'] ? of({ rows: [], count: 0 }) : throwError(() => new Error('returns down')),
      listTickets: () => of({ rows: [], count: 0 }),
      getReturn: () => of(detail),
    };
    TestBed.configureTestingModule({
      imports: [AdminErpReturnsPage],
      providers: [provideRouter([]), { provide: AdminErpApiService, useValue: api }],
    });
    TestBed.inject(AdminErpSessionService).applyAuthContext({
      role: 'admin_viewer',
      roleName: 'Xem',
      isAdmin: true,
      allowedPages: ['returns-cskh'],
      allowedModules: ['returns'],
      capabilities: { returns: ['read'] },
      user: { id: 'u9', email: 'v@velura.test' },
      profile: { user_id: 'u9', email: 'v@velura.test', full_name: 'Viewer', is_active: true },
    });
    const fixture = TestBed.createComponent(AdminErpReturnsPage);
    fixture.detectChanges();

    expect(fixture.componentInstance.loadError()).toBe('returns down');
    expect(fixture.componentInstance.loading()).toBe(false);
  });

  it('shows the source order and the trail of the open return', () => {
    const { page, calls } = boot({ returns: ['read', 'update'], orders: ['read'] });
    page.openReturn(rows[0]);

    expect(page.orderContext()?.shipping_name).toBe('Trần Bình');
    expect(page.orderContext()?.items?.length).toBe(1);
    expect(page.recordTrail().length).toBe(1);
    expect(calls.serviceLogs.at(-1)?.['targetId']).toBe('r-1');
    expect(page.returnLinks().map((link) => link.label)).toContain('Đơn hàng gốc');
  });

  it('keeps the order code but reads nothing when the operator cannot read orders', () => {
    const { page } = boot();
    page.openReturn(rows[0]);

    expect(page.canReadOrders()).toBe(false);
    expect(page.orderContext()).toBeNull();
    expect(page.selected()?.order_code).toBe('VLR-001');
  });

  it('links a ticket to the chat case that raised it', () => {    const { page } = boot();
    page.openTicket({ ticket_id: 't-3' });

    expect(page.ticketLinks().map((link) => link.label)).toContain('Hội thoại của phiếu');
    expect(page.ticketLinks()[0].query).toEqual({ tab: 'chat', focus: 'c-1' });
  });

  it('scopes the return queue to the order a deep link named', () => {
    const { page, calls } = boot();
    page.orderFilter.set('o-1');
    page.applyFilters();

    const scoped = calls.returns.filter((params) => params['order_id'] === 'o-1');
    expect(scoped.length).toBe(1);
    expect(page.orderFilter()).toBe('o-1');
  });

  it('searches tickets by the phone number an order carries', () => {
    const { page, calls } = boot();
    page.setTab('tickets');
    page.ticketSearch.set('0900000001');
    page.applyTicketFilters();

    const searched = calls.tickets.filter((params) => params['q'] === '0900000001');
    expect(searched.length).toBe(1);
    expect(searched[0]['status']).toBe('');

    page.resetTicketFilters();
    expect(page.ticketSearch()).toBe('');
  });
});
