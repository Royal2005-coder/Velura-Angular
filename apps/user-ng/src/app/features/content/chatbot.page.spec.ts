import { createStorefrontPage } from '../../../testing/storefront-testing';
import { ChatbotPage } from './chatbot.page';

describe('ChatbotPage', () => {
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(ChatbotPage);
    expect(page).toBeTruthy();
  });
});
