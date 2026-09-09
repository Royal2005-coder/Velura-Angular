import { createStorefrontPage } from '../../../testing/storefront-testing';
import { StyleQuizPage } from './style-quiz.page';

describe('StyleQuizPage', () => {
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(StyleQuizPage);
    expect(page).toBeTruthy();
  });
});
