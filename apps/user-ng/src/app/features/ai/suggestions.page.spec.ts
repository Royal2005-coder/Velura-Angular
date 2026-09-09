import { createStorefrontPage } from '../../../testing/storefront-testing';
import { AiSuggestionsPage } from './suggestions.page';

describe('AiSuggestionsPage', () => {
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(AiSuggestionsPage);
    expect(page).toBeTruthy();
  });
});
