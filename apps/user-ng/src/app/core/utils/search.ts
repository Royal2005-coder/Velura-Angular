/**
 * Vietnamese diacritics removal and search text normalization.
 * Enables insensitive matching between accented and unaccented terms (e.g. 'đầm' matches 'dam').
 */
export function normalizeSearchText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .replace(/[^a-z0-9_\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Checks whether a target text contains a search query, matching both original and unaccented variants.
 */
export function matchesSearchText(target: string | undefined | null, query: string): boolean {
  if (!target || !query) return false;
  const rawTarget = target.toLowerCase();
  const rawQuery = query.toLowerCase().trim();
  if (rawTarget.includes(rawQuery)) return true;

  const normTarget = normalizeSearchText(target);
  const normQuery = normalizeSearchText(query);
  if (!normQuery) return false;
  return normTarget.includes(normQuery);
}

/**
 * Common fashion compound phrases where splitting words creates false positives
 * (e.g., 'tay dài' vs 'ngắn tay', 'độ dài' vs 'đỏ' + 'dài').
 */
const COMPOUND_PHRASE_MAPPINGS: Array<[RegExp, string]> = [
  [/(?<![\p{L}\p{N}])(?:tay\s+dài|dài\s+tay|tay\s+dai|dai\s+tay)(?![\p{L}\p{N}])/gui, 'tay_dai'],
  [/(?<![\p{L}\p{N}])(?:tay\s+ngắn|ngắn\s+tay|cộc\s+tay|tay\s+ngan|ngan\s+tay|coc\s+tay)(?![\p{L}\p{N}])/gui, 'tay_ngan'],
  [/(?<![\p{L}\p{N}])(?:không\s+tay|sát\s+nách|khong\s+tay|sat\s+nach)(?![\p{L}\p{N}])/gui, 'khong_tay'],
  [/(?<![\p{L}\p{N}])(?:tay\s+lửng|lửng\s+tay|tay\s+lung|lung\s+tay)(?![\p{L}\p{N}])/gui, 'tay_lung'],
  [/(?<![\p{L}\p{N}])(?:tay\s+bồng|bồng\s+tay|tay\s+bong|bong\s+tay)(?![\p{L}\p{N}])/gui, 'tay_bong'],
  [/(?<![\p{L}\p{N}])(?:dáng\s+dài|dang\s+dai)(?![\p{L}\p{N}])/gui, 'dang_dai'],
  [/(?<![\p{L}\p{N}])(?:dáng\s+ngắn|dang\s+ngan)(?![\p{L}\p{N}])/gui, 'dang_ngan'],
  [/(?<![\p{L}\p{N}])(?:chân\s+váy|chan\s+vay)(?![\p{L}\p{N}])/gui, 'chan_vay'],
  [/(?<![\p{L}\p{N}])(?:đầm|đam|dam|váy|vay)(?![\p{L}\p{N}])/gui, 'dam_vay'],
  [/(?<![\p{L}\p{N}])(?:độ\s+dài|do\s+dai)(?![\p{L}\p{N}])/gui, 'do_dai'],
  [/(?<![\p{L}\p{N}])(?:dự\s+tiệc|du\s+tiec|dạ\s+tiệc|da\s+tiec|dạ\s+hội|da\s+hoi)(?![\p{L}\p{N}])/gui, 'du_tiec'],
  [/(?<![\p{L}\p{N}])(?:công\s+sở|cong\s+so|đi\s+làm|di\s+lam)(?![\p{L}\p{N}])/gui, 'cong_so'],
];

export const OCCASION_VIETNAMESE_MAP: Readonly<Record<string, string>> = {
  Party: 'dự tiệc dạ tiệc dạ hội tiệc party',
  Casual: 'dạo phố thường ngày đi chơi casual',
  Office: 'công sở đi làm văn phòng office',
  Wedding: 'đám cưới tiệc cưới wedding',
  Travel: 'du lịch đi biển dạo biển nghỉ dưỡng travel',
  School: 'đi học học sinh sinh viên school',
};

export function bindCompoundPhrases(text: string): string {
  let result = text;
  for (const [regex, replacement] of COMPOUND_PHRASE_MAPPINGS) {
    result = result.replace(regex, replacement);
  }
  return result;
}

/**
 * Checks that a text contains the whole typed phrase, or every unaccented word of it.
 * Preserves compound phrases and verifies attribute boundaries (sleeve, color).
 */
export function matchesAllSearchWords(target: string | undefined | null, query: string): boolean {
  if (!target || !query.trim()) return false;
  if (target.toLowerCase().includes(query.trim().toLowerCase())) return true;

  const rawTargetLower = target.toLowerCase();
  const rawQueryLower = query.toLowerCase();

  // 1. Sleeve attribute conflict check
  const queryWantsLong = /(?<![\p{L}\p{N}])(?:tay dài|dài tay|tay dai|dai tay)(?![\p{L}\p{N}])/ui.test(rawQueryLower);
  const targetShortOnly = /(?<![\p{L}\p{N}])(?:tay ngắn|ngắn tay|cộc tay|tay ngan|ngan tay|coc tay)(?![\p{L}\p{N}])/ui.test(rawTargetLower) &&
    !/(?<![\p{L}\p{N}])(?:tay dài|dài tay|tay dai|dai tay)(?![\p{L}\p{N}])/ui.test(rawTargetLower);
  if (queryWantsLong && targetShortOnly) return false;

  const queryWantsShort = /(?<![\p{L}\p{N}])(?:tay ngắn|ngắn tay|cộc tay|tay ngan|ngan tay|coc tay)(?![\p{L}\p{N}])/ui.test(rawQueryLower);
  const targetLongOnly = /(?<![\p{L}\p{N}])(?:tay dài|dài tay|tay dai|dai tay)(?![\p{L}\p{N}])/ui.test(rawTargetLower) &&
    !/(?<![\p{L}\p{N}])(?:tay ngắn|ngắn tay|cộc tay|tay ngan|ngan tay|coc tay)(?![\p{L}\p{N}])/ui.test(rawTargetLower);
  if (queryWantsShort && targetLongOnly) return false;

  // 2. Color attribute check for "đỏ" (avoiding "độ"/"đồ" in "độ dài", "set đồ")
  const queryHasExplicitRed = /(?<!\p{L})đỏ(?!\p{L})/iu.test(rawQueryLower);
  if (queryHasExplicitRed) {
    const targetHasExplicitRed = /(?<!\p{L})đỏ(?!\p{L})/iu.test(rawTargetLower);
    if (!targetHasExplicitRed) return false;
  }

  // 3. Compound-bound token matching
  const boundQuery = bindCompoundPhrases(query);
  const boundTarget = bindCompoundPhrases(target);

  const words = normalizeSearchText(boundQuery).split(' ').filter(Boolean);
  if (!words.length) return false;
  const normTarget = normalizeSearchText(boundTarget);
  const targetTokens = new Set(normTarget.split(/\s+/).filter(Boolean));
  return words.every((word) => targetTokens.has(word));
}
