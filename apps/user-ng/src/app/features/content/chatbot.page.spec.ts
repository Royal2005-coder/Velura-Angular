import { createStorefrontPage } from '../../../testing/storefront-testing';
import { ChatbotPage } from './chatbot.page';
import { TestBed } from '@angular/core/testing';
import { of, Subject } from 'rxjs';
import { ChatbotService, type ChatSendResponse } from '../../core/services/chatbot.service';

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
});
