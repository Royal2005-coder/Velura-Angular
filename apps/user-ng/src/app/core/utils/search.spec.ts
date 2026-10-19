import { productMaterial, productMaterialText } from './material';
import { matchesAllSearchWords } from './search';

describe('matchesAllSearchWords', () => {
  it('requires every word, not just one shared word', () => {
    expect(matchesAllSearchWords('Premium Cotton 100% Áo thun', 'premium cotton')).toBe(true);
    expect(matchesAllSearchWords('Premium Cotton 100% Áo thun', 'Áo thun basic')).toBe(false);
  });

  it('ignores accents and treats % and * as plain characters', () => {
    expect(matchesAllSearchWords('Đầm lụa Velura', 'dam lua')).toBe(true);
    expect(matchesAllSearchWords('Premium Cotton 100%', 'Premium Cotton 100%')).toBe(true);
    expect(matchesAllSearchWords('Quần jeans', '*')).toBe(false);
    expect(matchesAllSearchWords('Quần jeans', '%')).toBe(false);
  });
});

describe('productMaterial', () => {
  it('reads only the declared Chất liệu line', () => {
    expect(productMaterial({ description: 'Mô tả\nChất liệu: Cotton 100%' })).toBe('Cotton 100%');
    expect(productMaterial({ description: 'Áo cotton mềm' })).toBeNull();
  });

  it('falls back to name and description for filtering when no fabric is declared', () => {
    expect(productMaterialText({ name: 'Áo cotton', description: 'Mềm' })).toContain('cotton');
    expect(productMaterialText({ name: 'Áo', description: 'Chất liệu: Lanh' })).toBe('Lanh');
  });
});
