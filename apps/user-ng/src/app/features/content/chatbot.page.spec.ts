import { createStorefrontPage, lastStorefrontFixture } from '../../../testing/storefront-testing';
import { ChatbotPage } from './chatbot.page';
import { TestBed } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import { ChatbotService, type ChatSendResponse } from '../../core/services/chatbot.service';
import { CartStore } from '../../core/services/cart.store';
import { OrderAccountApiStore } from '../../core/services/order-account-api.store';

describe('ChatbotPage', () => {
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(ChatbotPage);
    expect(page).toBeTruthy();
  });
  it('suppresses AI typing after server takeover and labels the shared widget as human', async () => {
    const page = await createStorefrontPage(ChatbotPage);
    const model = TestBed.inject(ChatbotService);
    vi.spyOn(model, 'listMessages').mockReturnValue(of({ session: { session_id: 'session', handoff_status: 'assigned' }, messages: [] }));
    page.openSession({ session_id: 'session', handoff_status: 'assigned' });
    const response = new Subject<ChatSendResponse>();
    vi.spyOn(model, 'sendMessage').mockReturnValue(response);
    page.send('Xin hỗ trợ');
    expect(page.humanTakeover()).toBe(true);
    expect(model.activeHandoff()).toBe('assigned');
    expect(page.messages().some(message => message.metadata?.typing)).toBe(false);
    response.next({ session: { session_id: 'session', handoff_status: 'assigned' }, messages: [{ message_id: 'human', sender: 'agent', text: 'Tôi đang hỗ trợ bạn', created_at: '', metadata: { speaker: 'HUMAN' } }] });
    expect(page.messages()[0].sender).toBe('agent');
  });

  it('does not append an old AI response after starting a new conversation', async () => {
    const page = await createStorefrontPage(ChatbotPage);
    const response = new Subject<ChatSendResponse>();
    vi.spyOn(TestBed.inject(ChatbotService), 'sendMessage').mockReturnValue(response);
    page.send('Tư vấn');
    page.newChat();
    response.next({ session: { session_id: 'old' }, messages: [{ message_id: 'old-ai', sender: 'bot', text: 'Old answer', created_at: '' }] });
    expect(page.sessionId()).toBe('');
    expect(page.messages().some(message => message.message_id === 'old-ai')).toBe(false);
  });

  it('recovers after a polling failure and detects proactive takeover while still in AI routing', async () => {
    vi.useFakeTimers();
    try {
      const page = await createStorefrontPage(ChatbotPage);
      page.sessionId.set('session');
      const get = vi.spyOn(TestBed.inject(ChatbotService), 'listMessages')
        .mockReturnValueOnce(throwError(() => new Error('temporary outage')))
        .mockReturnValue(of({ session: { session_id: 'session', handoff_status: 'assigned' }, messages: [] }));
      await vi.advanceTimersByTimeAsync(3000);
      expect(page.chatError()).not.toBe('');
      await vi.advanceTimersByTimeAsync(3000);
      expect(get).toHaveBeenCalledTimes(2);
      expect(page.handoffStatus()).toBe('assigned');
      expect(page.chatError()).toBe('');
    } finally { vi.useRealTimers(); }
  });

  it('keeps optimistic pending content neutral and removes it when sending fails', async () => {
    const page = await createStorefrontPage(ChatbotPage);
    const response = new Subject<ChatSendResponse>();
    vi.spyOn(TestBed.inject(ChatbotService), 'sendMessage').mockReturnValue(response);
    page.send('raw private draft');
    expect(page.messages().some(message => message.text.includes('raw private draft'))).toBe(false);
    expect(page.messages().some(message => message.moderation_status === 'pending')).toBe(true);
    response.error(new Error('unavailable'));
    expect(page.messages().some(message => message.moderation_status === 'pending')).toBe(false);
    expect(page.draft()).toBe('raw private draft');
  });

  it('never uses a product ID or expired variant as a cart variant fallback', async () => {
    const page = await createStorefrontPage(ChatbotPage);
    const add = vi.spyOn(TestBed.inject(CartStore), 'addItem');
    const missing = { product_id: 'product', name: 'Product', price: 100000, variant: null };
    const expired = { ...missing, variant: { variant_id: 'variant', stock_quantity: 0 } };
    page.addProduct(missing); page.addProduct(expired);
    expect(page.isOutOfStock(missing)).toBe(true);
    expect(add).not.toHaveBeenCalled();
  });

  it('forwards selected order ownership proof separately from the customer message', async () => {
    const page = await createStorefrontPage(ChatbotPage);
    page.selectedOrderId.set('owned-order');
    vi.spyOn(TestBed.inject(OrderAccountApiStore), 'guestAccessToken').mockReturnValue('scoped-proof');
    const send = vi.spyOn(TestBed.inject(ChatbotService), 'sendMessage').mockReturnValue(of({}));
    page.send('Kiểm tra đơn');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'owned-order', guestAccessToken: 'scoped-proof', message: 'Kiểm tra đơn' }));
  });

  it('blocks closed-case sends and reopens the same case only after server success', async () => {
    const page = await createStorefrontPage(ChatbotPage);
    page.sessionId.set('closed-case'); page.handoffStatus.set('closed');
    const send = vi.spyOn(TestBed.inject(ChatbotService), 'sendMessage');
    const response = new Subject<ChatSendResponse>();
    const lifecycle = vi.spyOn(TestBed.inject(ChatbotService), 'lifecycle').mockReturnValue(response);
    page.send('Không được gửi vào phiên đóng');
    expect(send).not.toHaveBeenCalled();
    page.lifecycleNote.set('Vấn đề chưa được giải quyết'); page.updateLifecycle('reopen');
    expect(lifecycle).toHaveBeenCalledWith('closed-case', expect.objectContaining({ action: 'reopen' }));
    expect(page.handoffStatus()).toBe('closed');
    response.next({ session: { session_id: 'closed-case', handoff_status: 'requested' }, messages: [] });
    expect(page.sessionId()).toBe('closed-case');
    expect(page.handoffStatus()).toBe('requested');
  });

  it('never renders raw text or images returned with pending moderation', async () => {
    const page = await createStorefrontPage(ChatbotPage);
    page.messages.set([{ message_id: 'pending', sender: 'user', text: 'raw sensitive text', created_at: '', moderation_status: 'pending', metadata: { attachment: { type: 'image', data: 'data:image/png;base64,private', filename: 'private.png', mimeType: 'image/png' } } }]);
    const fixture = lastStorefrontFixture(); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('raw sensitive text');
    expect(fixture.nativeElement.querySelector('.chatbot-message__attachment')).toBeNull();
  });

  it('adopts the server-linked case ID when reopening outside the same-case window', async () => {
    const page = await createStorefrontPage(ChatbotPage);
    page.sessionId.set('old-case'); page.handoffStatus.set('closed');
    vi.spyOn(TestBed.inject(ChatbotService), 'lifecycle').mockReturnValue(of({ session: { session_id: 'linked-case', handoff_status: 'requested', metadata: { previous_session_id: 'old-case' } }, messages: [] }));
    page.lifecycleNote.set('Vẫn cần xử lý'); page.updateLifecycle('reopen');
    expect(page.sessionId()).toBe('linked-case');
    expect(page.previousSessionId()).toBe('old-case');
    expect(TestBed.inject(ChatbotService).activeSession()).toBe('linked-case');
  });
});
