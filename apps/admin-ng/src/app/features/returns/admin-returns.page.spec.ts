import { createAdminPage, lastAdminFixture } from '../../../testing/admin-testing';
import { AdminReturnsPage } from './admin-returns.page';
import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { of, Subject, throwError } from 'rxjs';
import { vi } from 'vitest';
import { AdminSessionService } from '../../core/admin-session.service';
import { AdminChatReviewService, type AdminChatOriginal, type AdminChatReviewInput, type AdminReviewedChatMessage } from '../../core/admin-chat-review.service';
import type { AdminChatMessagesPayload } from '../../core/admin-api.service';

describe('AdminReturnsPage', () => {

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

  it('computes fixed refund amount strictly from item value and manages quick contact modal', async () => {
    const page = await createAdminPage(AdminReturnsPage);
    
    expect(page.fixedRefundAmount()).toBe(0);
    page.selectedReturn.set({ return_id: 'ret_1', refundable_amount: 349000, version: 1 });
    expect(page.fixedRefundAmount()).toBe(349000);

    page.refundSuggestion.set(250000);
    expect(page.fixedRefundAmount()).toBe(250000);

    expect(page.contactTarget()).toBeNull();
    TestBed.inject(AdminSessionService).applyAuthContext({ role: 'admin_operator_cskh_dt', isAdmin: true, profile: { is_active: true }, allowedModules: ['returns'] });
    page.openContact({ return_id: 'ret_1', status: 'REQUESTED', version: 1 });
    expect(page.contactTarget()?.return_id).toBe('ret_1');
    expect(page.contactResult()).toBe('reached');
    page.closeContact();
    expect(page.contactTarget()).toBeNull();
  });

  it('requires review confirmation, suppresses duplicate writes and waits for server persistence', async () => {
    const page = await createAdminPage(AdminReturnsPage);
    TestBed.inject(AdminSessionService).applyAuthContext({ role: 'admin_operator_cskh_dt', isAdmin: true, profile: { is_active: true }, allowedModules: ['returns'] });
    page.selectedChat.set({ session_id: 'session', handoff_status: 'assigned' });
    const target: AdminReviewedChatMessage = { message_id: 'message', sender: 'user', metadata: { classification: { intent: 'facts', level: 'L0', issue: 'return', sentiment: 'negative', risk: 'yellow', moderation: 'none' } } };
    const response = new Subject<AdminChatMessagesPayload>();
    const review = vi.spyOn(TestBed.inject(AdminChatReviewService), 'review').mockReturnValue(response);
    page.openChatReview(target); page.chatReviewNote.set('Cảm xúc tiêu cực không phải nội dung vi phạm');
    page.saveChatReview(new Event('submit'));
    expect(review).not.toHaveBeenCalled();
    expect(page.chatReviewError()).not.toBeNull();
    page.chatReviewConfirmed.set(true); page.saveChatReview(new Event('submit')); page.saveChatReview(new Event('submit'));
    expect(review).toHaveBeenCalledTimes(1);
    expect(page.chatReviewBusy()).toBe(true);
    expect(page.chatReviewFeedback()).toBeNull();
    response.next({ session: { session_id: 'session', handoff_status: 'assigned' } }); response.complete();
    expect(page.chatReviewBusy()).toBe(false);
    expect(page.chatReviewFeedback()).not.toBeNull();
    expect(page.chatReviewConfirmed()).toBe(false);
    expect(page.selectedChat()?.handoff_status).toBe('assigned');
    expect(target.metadata?.classification?.risk).toBe('yellow');
  });

  it('a failed review preserves the human note and never reports that a correction was saved', async () => {
    const page = await createAdminPage(AdminReturnsPage);
    TestBed.inject(AdminSessionService).applyAuthContext({ role: 'admin_operator_cskh_dt', isAdmin: true, profile: { is_active: true }, allowedModules: ['returns'] });
    page.selectedChat.set({ session_id: 'session' }); page.openChatReview();
    vi.spyOn(TestBed.inject(AdminChatReviewService), 'review').mockReturnValue(throwError(() => new Error('database unavailable')));
    page.chatReviewNote.set('Khách đã được hướng dẫn thực hiện đổi trả'); page.chatReviewConfirmed.set(true);
    page.saveChatReview(new Event('submit'));
    expect(page.chatReviewNote()).toBe('Khách đã được hướng dẫn thực hiện đổi trả');
    expect(page.chatReviewFeedback()).toBeNull();
    expect(page.chatReviewError()).not.toBeNull();
    expect(page.chatReviewBusy()).toBe(false);
  });

  it('changing classification invalidates confirmation without changing the transcript classification', async () => {
    const page = await createAdminPage(AdminReturnsPage);
    TestBed.inject(AdminSessionService).applyAuthContext({ role: 'admin_operator_cskh_dt', isAdmin: true, profile: { is_active: true }, allowedModules: ['returns'] });
    page.selectedChat.set({ session_id: 'session' });
    const target: AdminReviewedChatMessage = { message_id: 'message', metadata: { classification: { intent: 'facts', level: 'L0', issue: 'return', sentiment: 'neutral', risk: 'green', moderation: 'none' } } };
    page.openChatReview(target); page.chatReviewConfirmed.set(true);
    const select = document.createElement('select'); select.innerHTML = '<option value=\"yellow\">Yellow</option>'; select.value = 'yellow';
    page.setChatClassification('risk', { target: select } as unknown as Event);
    expect(page.chatReviewConfirmed()).toBe(false);
    expect(page.chatReviewClassification().risk).toBe('yellow');
    expect(target.metadata?.classification?.risk).toBe('green');
  });

  it('ordinary CSKH staff cannot fetch a moderated original or take over a supervisor-only session', async () => {
    const assignChatSession = vi.fn(() => of({}));
    const page = await createAdminPage(AdminReturnsPage, { assignChatSession });
    TestBed.inject(AdminSessionService).applyAuthContext({ role: 'admin_operator_cskh_dt', isAdmin: true, profile: { is_active: true }, allowedModules: ['returns'] });
    page.selectedChat.set({ session_id: 'session', handoff_status: 'requested', metadata: { supervisor_required: true } });
    const original = vi.spyOn(TestBed.inject(AdminChatReviewService), 'original');
    page.openChatReview({ message_id: 'message', moderation_status: 'restricted' }); page.chatOriginalConfirmed.set(true);
    page.viewChatOriginal(); page.assignChat(); page.closeChat();
    expect(original).not.toHaveBeenCalled();
    expect(assignChatSession).not.toHaveBeenCalled();
    expect(page.canReply()).toBe(false);
    expect(page.canJoinChat()).toBe(false);
    expect(page.chatOriginal()).toBeNull();
  });

  it('supervisor access requires explicit confirmation and discards late originals after session changes', async () => {
    const page = await createAdminPage(AdminReturnsPage);
    TestBed.inject(AdminSessionService).applyAuthContext({ role: 'super_admin', isAdmin: true, profile: { is_active: true }, allowedModules: ['returns'] });
    page.selectedChat.set({ session_id: 'first' });
    const response = new Subject<AdminChatOriginal>();
    const original = vi.spyOn(TestBed.inject(AdminChatReviewService), 'original').mockReturnValue(response);
    page.openChatReview({ message_id: 'message', moderation_status: 'restricted' }); page.viewChatOriginal();
    expect(original).not.toHaveBeenCalled();
    page.chatOriginalConfirmed.set(true); page.viewChatOriginal();
    expect(original).toHaveBeenCalledTimes(1);
    expect(page.chatOriginal()).toBeNull();
    page.selectChat({ session_id: 'second' });
    response.next({ message_id: 'message', original_text: 'Private first-customer content', risk: 'red', reason: 'threat' }); response.complete();
    expect(page.chatOriginal()).toBeNull();
    expect(page.chatReviewFeedback()).toBeNull();
    expect(page.chatOriginalConfirmed()).toBe(false);
    expect(page.chatReviewOpen()).toBe(false);
  });

  it('failed privileged access shows failure feedback without retaining private data', async () => {
    const page = await createAdminPage(AdminReturnsPage);
    TestBed.inject(AdminSessionService).applyAuthContext({ role: 'super_admin', isAdmin: true, profile: { is_active: true }, allowedModules: ['returns'] });
    page.selectedChat.set({ session_id: 'session' }); page.openChatReview({ message_id: 'message', moderation_status: 'restricted' });
    vi.spyOn(TestBed.inject(AdminChatReviewService), 'original').mockReturnValue(throwError(() => new HttpErrorResponse({ status: 403, error: { error: { message: 'Supervisor required' } } })));
    page.chatOriginalConfirmed.set(true); page.viewChatOriginal();
    expect(page.chatOriginal()).toBeNull();
    expect(page.chatReviewError()).not.toBeNull();
    expect(page.chatReviewFeedback()).toBeNull();
    expect(page.chatOriginalBusy()).toBe(false);
  });

  it('manual moderation sends the selected severity only after deliberate confirmation', async () => {
    const page = await createAdminPage(AdminReturnsPage);
    TestBed.inject(AdminSessionService).applyAuthContext({ role: 'admin_operator_cskh_dt', isAdmin: true, profile: { is_active: true }, allowedModules: ['returns'] });
    page.selectedChat.set({ session_id: 'session' }); page.openChatReview({ message_id: 'message' });
    let saved: AdminChatReviewInput | undefined;
    vi.spyOn(TestBed.inject(AdminChatReviewService), 'review').mockImplementation((_sessionId, body) => { saved = body; return of({}); });
    page.chatReviewAction.set('moderate'); page.chatReviewRisk.set('red'); page.chatReviewNote.set('Nội dung đe dọa cần giám sát');
    page.saveChatReview(new Event('submit')); expect(saved).toBeUndefined();
    page.chatReviewConfirmed.set(true); page.saveChatReview(new Event('submit'));
    expect(saved?.risk).toBe('red');
    expect(saved?.confirmed).toBe(true);
    expect(saved?.action).toBe('moderate');
    expect(saved?.messageId).toBe('message');
  });

  it('quarantines pending text and products rather than trusting a raw server turn', async () => {
    const page = await createAdminPage(AdminReturnsPage);
    const pending: AdminReviewedChatMessage = { message_id: 'pending', text: 'unsafe raw text', moderation_status: 'pending', product_ids: ['product'] };
    page.chatProducts.set([{ product_id: 'product' }]);
    expect(page.safeChatText(pending)).not.toContain('unsafe raw text');
    expect(page.productsOf(pending)).toEqual([]);
    expect(page.chatMessageReady(pending)).toBe(false);
    expect(page.chatRiskBadge({ session_id: 's', risk_level: 'green', metadata: { intelligence: { filter_status: 'outage' } } }).tone).toBe('neutral');
    page.selectedChat.set({ session_id: 's' }); page.messages.set([pending]);
    const fixture = lastAdminFixture(); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('unsafe raw text');
  });

  it('does not allow replies or takeover when another staff member owns the case', async () => {
    const page = await createAdminPage(AdminReturnsPage);
    TestBed.inject(AdminSessionService).applyAuthContext({ role: 'admin_operator_cskh_dt', isAdmin: true, user: { id: 'viewer' }, profile: { is_active: true }, allowedModules: ['returns'] });
    page.selectedChat.set({ session_id: 's', assigned_to: 'other-staff', handoff_status: 'assigned' });
    expect(page.canReply()).toBe(false);
    expect(page.canJoinChat()).toBe(false);
  });

  it('requires re-confirmation after structured summary corrections and sends those fields', async () => {
    const page = await createAdminPage(AdminReturnsPage);
    TestBed.inject(AdminSessionService).applyAuthContext({ role: 'admin_operator_cskh_dt', isAdmin: true, profile: { is_active: true }, allowedModules: ['returns'] });
    page.selectedChat.set({ session_id: 's', metadata: { handoff_summary: { problem: 'Giao hàng muộn', wanted: 'Xác minh lịch giao', failed_approaches: ['Tra cứu'] } } });
    page.openChatReview(); page.chatReviewAction.set('summary'); page.chatReviewNote.set('Đã xác minh nội dung'); page.chatReviewConfirmed.set(true);
    const input = document.createElement('input'); input.value = 'Cập nhật lịch giao';
    page.setChatCaseField('summaryWanted', { target: input } as unknown as Event);
    const review = vi.spyOn(TestBed.inject(AdminChatReviewService), 'review').mockReturnValue(of({}));
    page.saveChatReview(new Event('submit'));
    expect(review).not.toHaveBeenCalled();
    page.chatReviewConfirmed.set(true); page.saveChatReview(new Event('submit'));
    expect(review).toHaveBeenCalledWith('s', expect.objectContaining({ action: 'summary', confirmed: true, summary: { problem: 'Giao hàng muộn', wanted: 'Cập nhật lịch giao', failed_approaches: ['Tra cứu'] } }));
  });

  it('refuses an offer that is no longer in the server eligible set', async () => {
    const page = await createAdminPage(AdminReturnsPage);
    TestBed.inject(AdminSessionService).applyAuthContext({ role: 'admin_operator_cskh_dt', isAdmin: true, profile: { is_active: true }, allowedModules: ['returns'] });
    page.selectedChat.set({ session_id: 's', metadata: { eligible_offers: [{ offer_id: 'approved', title: 'Ưu đãi thật' }] } });
    page.openChatReview(); page.chatReviewAction.set('offer'); page.selectedOfferId.set('expired');
    page.chatReviewNote.set('Xác nhận điều kiện'); page.chatReviewConfirmed.set(true);
    const review = vi.spyOn(TestBed.inject(AdminChatReviewService), 'review');
    page.saveChatReview(new Event('submit'));
    expect(review).not.toHaveBeenCalled();
    expect(page.chatReviewError()).not.toBeNull();
  });

  it('opens the exact reported case even when it is outside the current sidebar page', async () => {
    const getChatMessages = vi.fn(() => of({ session: { session_id: 'reported-case' }, messages: [] }));
    const page = await createAdminPage(AdminReturnsPage, { getChatMessages }, { zone: 'chat', sessionId: 'reported-case' });
    expect(page.selectedChat()?.session_id).toBe('reported-case');
    expect(getChatMessages).toHaveBeenCalledWith('reported-case', { limit: '150' });
  });

  it('refreshes context during human review without discarding drafts and invalidates stale confirmation', async () => {
    const page = await createAdminPage(AdminReturnsPage, { getChatMessages: () => of({ session: { session_id: 's', metadata: { intelligence: { source_seq: 2, filter_status: 'ready' } } }, messages: [] }) });
    TestBed.inject(AdminSessionService).applyAuthContext({ role: 'admin_operator_cskh_dt', isAdmin: true, profile: { is_active: true }, allowedModules: ['returns'] });
    page.selectedChat.set({ session_id: 's', metadata: { intelligence: { source_seq: 1, filter_status: 'ready' } } });
    page.openChatReview(); page.chatReviewNote.set('Nhận xét đang soạn'); page.chatReviewConfirmed.set(true); page.replyDraft.set('Phản hồi đang soạn');
    page.refreshChatContext();
    expect(page.chatReviewConfirmed()).toBe(false);
    expect(page.chatReviewNote()).toBe('Nhận xét đang soạn');
    expect(page.replyDraft()).toBe('Phản hồi đang soạn');
    expect(page.selectedChat()?.metadata?.intelligence?.source_seq).toBe(2);
  });

  it('requires explicit confirmation before retrying the actual persisted failed report', async () => {
    const page = await createAdminPage(AdminReturnsPage);
    TestBed.inject(AdminSessionService).applyAuthContext({ role: 'admin_operator_cskh_dt', isAdmin: true, profile: { is_active: true }, allowedModules: ['returns'] });
    page.selectedChat.set({ session_id: 's', metadata: { report_status: { report_id: 'real-report', state: 'failed' } } });
    page.openChatReview(); page.chatReviewAction.set('report_retry'); page.chatReviewNote.set('Đã cập nhật cấu hình nhận báo cáo');
    const response = new Subject<AdminChatMessagesPayload>();
    const review = vi.spyOn(TestBed.inject(AdminChatReviewService), 'review').mockReturnValue(response);
    page.saveChatReview(new Event('submit'));
    expect(review).not.toHaveBeenCalled();
    page.chatReviewConfirmed.set(true); page.saveChatReview(new Event('submit'));
    expect(review).toHaveBeenCalledWith('s', expect.objectContaining({ action: 'report_retry', reportId: 'real-report', confirmed: true }));
    expect(page.chatReviewFeedback()).toBeNull();
    response.error(new Error('configuration still invalid'));
    expect(page.chatReviewFeedback()).toBeNull();
    expect(page.chatReviewNote()).toBe('Đã cập nhật cấu hình nhận báo cáo');
  });

  it('keeps linked tickets out of legacy replies and lifecycle writes and opens canonical filtered chat', async () => {
    const respondTicket = vi.fn(() => of({}));
    const resolveTicket = vi.fn(() => of({}));
    const closeTicket = vi.fn(() => of({}));
    const getChatMessages = vi.fn(() => of({ session: { session_id: 'canonical-chat' }, messages: [{ message_id: 'filtered', text: 'Ngữ cảnh đã lọc', moderation_status: 'visible' }] }));
    const page = await createAdminPage(AdminReturnsPage, { respondTicket, resolveTicket, closeTicket, getChatMessages });
    TestBed.inject(AdminSessionService).applyAuthContext({ role: 'admin_operator_cskh_dt', isAdmin: true, profile: { is_active: true }, allowedModules: ['returns'] });
    const linked = { ticket_id: 'linked-ticket', chat_session_id: 'canonical-chat', status: 'processing', version: 1, title: 'Raw legacy title', description: 'Raw legacy description', admin_reply: 'Raw legacy response' };
    page.tickets.set([linked]); page.zone.set('support');
    const form = document.createElement('form');
    const note = document.createElement('textarea'); note.name = 'note'; note.value = 'Raw response must not bypass the filter'; form.append(note);
    for (const action of ['reply', 'resolve', 'close'] as const) {
      expect(page.canTicketAction(linked, action)).toBe(false);
      page.openTicketAction(action, linked.ticket_id);
      expect(page.actionType()).toBeNull();
      page.selectedTicket.set(linked); page.actionType.set(action);
      page.submitAction({ preventDefault: () => undefined, target: form } as unknown as Event);
    }
    expect(respondTicket).not.toHaveBeenCalled();
    expect(resolveTicket).not.toHaveBeenCalled();
    expect(closeTicket).not.toHaveBeenCalled();
    page.selectedTicket.set(linked); page.ticketDetailOpen.set(true);
    const fixture = lastAdminFixture(); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('Raw legacy title');
    expect(fixture.nativeElement.textContent).not.toContain('Raw legacy description');
    expect(fixture.nativeElement.textContent).not.toContain('Raw legacy response');
    page.openLinkedTicketChat(linked);
    expect(page.zone()).toBe('chat');
    expect(page.selectedChat()?.session_id).toBe('canonical-chat');
    expect(page.ticketDetailOpen()).toBe(false);
    expect(getChatMessages).toHaveBeenCalledWith('canonical-chat', { limit: '150' });
    expect(page.messages()[0]?.text).toBe('Ngữ cảnh đã lọc');
  });
});
