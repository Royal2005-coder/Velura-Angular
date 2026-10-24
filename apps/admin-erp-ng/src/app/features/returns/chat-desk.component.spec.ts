import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { AdminChatMessageRow, AdminChatSessionRow, AdminErpApiService } from '../../core/admin-erp-api.service';
import { AdminErpSessionService } from '../../core/admin-erp-session.service';
import { ChatDeskComponent } from './chat-desk.component';

const messages: AdminChatMessageRow[] = [
  { message_id: 'm-1', sender: 'user', text: 'Áo bị lỗi chỉ', moderation_status: 'visible', created_at: '2026-10-20T04:00:00Z' },
  { message_id: 'm-2', sender: 'bot', text: '[Đang lọc nội dung để bảo vệ cuộc trò chuyện]', moderation_status: 'pending' },
];

const session: AdminChatSessionRow = {
  session_id: 'c-1',
  title: 'Cuộc trò chuyện hỗ trợ',
  handoff_status: 'requested',
  risk_level: 'orange',
  last_message_preview: 'Áo bị lỗi chỉ',
  updated_at: '2026-10-20T04:00:00Z',
  assigned_to: null,
  metadata: {
    intelligence: {
      filter_status: 'ready',
      classification: {
        intent: 'order',
        level: 'L1',
        issue: 'return',
        sentiment: 'negative',
        risk: 'orange',
        moderation: 'none',
      },
    },
    warnings: [{ id: 'w1', text: 'Khách dọa đăng khiếu nại', action: 'Báo supervisor' }],
    eligible_offers: [{ offer_id: 'offer-1', title: 'Voucher 100.000đ' }],
    report_status: { state: 'failed', attempts: 2 },
  },
};

describe('ChatDeskComponent', () => {
  function boot(api: Partial<AdminErpApiService>, capabilities: Record<string, string[]> = { support_tickets: ['read', 'update'] }) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [ChatDeskComponent],
      providers: [{ provide: AdminErpApiService, useValue: api }],
    });
    TestBed.inject(AdminErpSessionService).applyAuthContext({
      role: 'admin_operator_cskh_dt',
      roleName: 'CSKH',
      isAdmin: true,
      allowedPages: ['returns-cskh'],
      allowedModules: ['support_tickets'],
      capabilities,
      user: { id: 'u1', email: 'cskh@velura.test' },
      profile: { user_id: 'u1', email: 'cskh@velura.test', full_name: 'CSKH', is_active: true },
    });
    const fixture = TestBed.createComponent(ChatDeskComponent);
    fixture.componentRef.setInput('canMutate', true);
    fixture.detectChanges();
    return fixture.componentInstance;
  }

  it('loads the queue with the handoff filters the API understands', () => {
    const sent: Record<string, string>[] = [];
    const desk = boot({
      listChatSessions: (params) => {
        sent.push(params || {});
        return of({ rows: [session], count: 1 });
      },
    });

    expect(desk.sessions().length).toBe(1);
    desk.handoffStatus.set('assigned');
    desk.setHandoffFilter('only', { target: { checked: true } } as unknown as Event);

    const last = sent.at(-1) as Record<string, string>;
    expect(last['handoffStatus']).toBe('assigned');
    expect(last['handoffOnly']).toBe('true');
  });

  it('opens a case through its public transcript only', () => {
    const desk = boot({
      listChatSessions: () => of({ rows: [session], count: 1 }),
      getChatMessages: () => of({ session, messages }),
    });
    desk.open(session);

    expect(desk.messages().length).toBe(2);
    expect(desk.warnings().length).toBe(1);
    expect(desk.label(messages[0])).toBe('Khách');
    expect(desk.label(messages[1])).toBe('Trợ lý ảo');
    expect(desk.intelligence()?.filter_status).toBe('ready');
  });

  it('claims the case before allowing a reply and keeps the draft bounded', () => {
    const assigned: string[] = [];
    const replies: string[] = [];
    const desk = boot({
      listChatSessions: () => of({ rows: [session], count: 1 }),
      getChatMessages: () => of({ session, messages }),
      assignChatSession: (id) => {
        assigned.push(id);
        return of({ session: { ...session, assigned_to: 'u1', assigned_agent_name: 'CSKH' }, messages });
      },
      sendChatReply: (_id, text) => {
        replies.push(text);
        return of({ session, messages: [...messages, { message_id: 'm-3', sender: 'agent', text }] });
      },
    });

    desk.open(session);
    desk.draft.set('Shop sẽ đổi chiếc mới cho mình.');
    expect(desk.replyReady()).toBe(true);
    desk.sendReply();
    expect(replies).toEqual(['Shop sẽ đổi chiếc mới cho mình.']);
    expect(desk.draft()).toBe('');

    desk.claim();
    expect(assigned).toEqual(['c-1']);
    expect(desk.assignedToMe()).toBe(true);
  });

  it('refuses a review decision without the explicit confirmation', () => {
    const bodies: Record<string, unknown>[] = [];
    const desk = boot({
      listChatSessions: () => of({ rows: [session], count: 1 }),
      getChatMessages: () => of({ session, messages }),
      reviewChatSession: (_id, body) => {
        bodies.push(body as unknown as Record<string, unknown>);
        return of({ session, messages });
      },
    });
    desk.open(session);
    desk.draft.set('Khách đồng ý đổi size M.');

    expect(desk.reviewReady()).toBe(false);
    desk.submitReview();
    expect(bodies.length).toBe(0);

    desk.setConfirmed({ target: { checked: true } } as unknown as Event);
    expect(desk.reviewReady()).toBe(true);
    desk.submitReview();
    expect(bodies[0]).toMatchObject({ action: 'outcome', confirmed: true, text: 'Khách đồng ý đổi size M.' });
  });

  it('collects the fields each review action actually requires', () => {
    const desk = boot({
      listChatSessions: () => of({ rows: [session], count: 1 }),
      getChatMessages: () => of({ session, messages }),
      reviewChatSession: () => of({ session, messages }),
    });
    desk.open(session);

    // changing the decision re-arms the confirmation box, so every switch confirms again
    const confirm = (): void => desk.setConfirmed({ target: { checked: true } } as unknown as Event);

    desk.chooseAction('resolve');
    confirm();
    expect(desk.reviewReady()).toBe(false);
    desk.setReviewField('resolution', { target: { value: 'Đã gửi đơn đổi' } } as unknown as Event);
    expect(desk.reviewReady()).toBe(true);

    desk.chooseAction('offer');
    confirm();
    expect(desk.reviewReady()).toBe(false);
    expect(desk.offers().length).toBe(1);
    desk.setReviewField('offerId', { target: { value: 'offer-1' } } as unknown as Event);
    expect(desk.reviewReady()).toBe(true);

    desk.chooseAction('moderate');
    confirm();
    expect(desk.needsTarget()).toBe(true);
    // every review needs its own text, because the API validates it before branching
    expect(desk.reviewReady()).toBe(false);
    desk.draft.set('Tin nhắn có lời đe dọa, gắn mức đỏ để theo dõi.');
    expect(desk.reviewReady()).toBe(false);
    desk.pickTarget(messages[0]);
    expect(desk.reviewReady()).toBe(true);
  });

  it('hides supervisor-only actions and the audited original from a normal agent', () => {
    const desk = boot({
      listChatSessions: () => of({ rows: [session], count: 1 }),
      getChatMessages: () => of({ session, messages }),
    });
    desk.open(session);
    desk.pickTarget(messages[1]);

    expect(desk.isSupervisor()).toBe(false);
    expect(desk.visibleActions().some((action) => action.code === 'refilter')).toBe(false);
    desk.readOriginal();
    expect(desk.original()).toBeNull();
  });

  it('shows supervisor powers when the capability grants approval', () => {
    const requested: string[] = [];
    const desk = boot(
      {
        listChatSessions: () => of({ rows: [session], count: 1 }),
        getChatMessages: () => of({ session, messages }),
        getChatOriginal: (_id, messageId) => {
          requested.push(messageId);
          return of({ message_id: messageId, original_text: 'nội dung gốc', risk: 'red', reason: 'từ ngữ đe dọa' });
        },
      },
      { support_tickets: ['read', 'update', 'approve'] },
    );
    desk.open(session);
    desk.pickTarget(messages[1]);

    expect(desk.isSupervisor()).toBe(true);
    expect(desk.visibleActions().some((action) => action.code === 'refilter')).toBe(true);
    desk.readOriginal();
    expect(requested).toEqual(['m-2']);
    expect(desk.original()?.original_text).toBe('nội dung gốc');
  });

  it('reports a failed send without claiming the case was updated', () => {
    const desk = boot({
      listChatSessions: () => of({ rows: [session], count: 1 }),
      getChatMessages: () => of({ session, messages }),
      sendChatReply: () =>
        throwError(
          () => new HttpErrorResponse({ status: 409, error: { error: { message: 'Ca đã thuộc nhân viên khác' } } }),
        ),
    });
    desk.open(session);
    desk.draft.set('Phản hồi thử.');
    desk.sendReply();

    expect(desk.actionError()).toBe('Ca đã thuộc nhân viên khác');
    expect(desk.busy()).toBe(false);
    expect(desk.messages().length).toBe(2);
  });
});
