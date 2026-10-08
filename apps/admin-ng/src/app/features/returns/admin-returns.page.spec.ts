import { createAdminPage } from '../../../testing/admin-testing';
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
});
