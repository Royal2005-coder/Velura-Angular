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

  it('rejects short-sleeve products when searching for tay dài', () => {
    const shortSleeve = 'Đầm Tweed Ngắn Tay Cổ Sơ Mi Thông số: Độ dài đầm 85cm';
    expect(matchesAllSearchWords(shortSleeve, 'váy đỏ tay dài')).toBe(false);
  });

  it('rejects products lacking explicit red color when searching for đỏ', () => {
    const pinkDress = 'Đầm Tay Bồng Cổ Bèo Đính Hoa Hồng Sakura Thông số: Độ dài đầm 80cm';
    expect(matchesAllSearchWords(pinkDress, 'váy đỏ tay dài')).toBe(false);
  });

  it('matches products with correct red color and long sleeves', () => {
    const matchingDress = 'Đầm Dạ Hội Đỏ Tay Dài Sang Trọng';
    expect(matchesAllSearchWords(matchingDress, 'váy đỏ tay dài')).toBe(true);
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
