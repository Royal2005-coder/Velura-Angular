import { convertToParamMap } from '@angular/router';
import { choiceParam, flagParam, textParam } from './admin-erp-deep-link';

describe('admin deep link params', () => {
  const params = convertToParamMap({ tab: 'stock', q: 'VLR-10', handoff: 'true', empty: '' });
  const none = convertToParamMap({});

  it('keeps a param value only when the screen knows that choice', () => {
    expect(choiceParam(params, 'tab', ['catalog', 'stock'])).toBe('stock');
    expect(choiceParam(params, 'tab', ['catalog'])).toBe('');
    expect(choiceParam(params, 'tab', ['catalog'], 'catalog')).toBe('catalog');
    expect(choiceParam(none, 'tab', ['catalog'], 'keep')).toBe('keep');
  });

  it('reads free text with an empty default', () => {
    expect(textParam(params, 'q')).toBe('VLR-10');
    expect(textParam(params, 'missing')).toBe('');
  });

  it('treats only the literal true as a flag', () => {
    expect(flagParam(params, 'handoff')).toBe(true);
    expect(flagParam(params, 'empty')).toBe(false);
    expect(flagParam(none, 'handoff')).toBe(false);
  });
});
