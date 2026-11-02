/**
 * Sinh mã giảm giá hàng loạt theo tiền tố (BA AD_VOUCHER_03, ngoại lệ 4).
 * Logic thuần: RNG và thao tác tạo mã được truyền vào nên test không cần DB.
 */

/** Bỏ các ký tự dễ nhầm (0/O, 1/I). */
export const VOUCHER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const VOUCHER_SUFFIX_LENGTH = 6;
/** Số lần thử lại tối đa khi một mã bị trùng (không tính lần thử đầu). */
export const MAX_COLLISION_RETRIES = 3;
export const BULK_MAX_QUANTITY = 500;
const PREFIX_PATTERN = /^[A-Z0-9]{2,12}$/;

/** Trả số trong [0, 1). Mặc định `Math.random`. */
export type Rng = () => number;

/** Chuẩn hoá và kiểm tiền tố. Trả `null` nếu không hợp lệ. */
export function normalizeVoucherPrefix(prefix: unknown): string | null {
  const value = String(prefix ?? "").trim().toUpperCase();
  return PREFIX_PATTERN.test(value) ? value : null;
}

/** Sinh một mã = tiền tố + hậu tố ngẫu nhiên. */
export function generateVoucherCode(prefix: string, rng: Rng = Math.random): string {
  let suffix = "";
  for (let i = 0; i < VOUCHER_SUFFIX_LENGTH; i += 1) {
    const index = Math.min(VOUCHER_CODE_ALPHABET.length - 1, Math.floor(rng() * VOUCHER_CODE_ALPHABET.length));
    suffix += VOUCHER_CODE_ALPHABET[index];
  }
  return `${prefix}${suffix}`;
}

/** Kết quả của một lần tạo mã. `collision` = mã đã tồn tại. */
export type CreateCodeResult = { ok: true } | { ok: false; collision: boolean; reason: string };

export interface BulkVoucherResult {
  requested: number;
  created: string[];
  complete: boolean;
  failure: { code: string; reason: string } | null;
}

/**
 * Tạo `quantity` mã duy nhất. Trùng mã thì sinh mã khác, tối đa `MAX_COLLISION_RETRIES` lần
 * thử lại cho mỗi mã. Lỗi khác, hoặc hết lượt thử lại, thì dừng và GIỮ các mã đã tạo.
 */
export async function generateVouchersBulk(input: {
  prefix: string;
  quantity: number;
  rng?: Rng;
  createCode: (code: string) => Promise<CreateCodeResult>;
}): Promise<BulkVoucherResult> {
  const rng = input.rng ?? Math.random;
  const created: string[] = [];
  const seen = new Set<string>();

  for (let n = 0; n < input.quantity; n += 1) {
    let lastCode = "";
    let lastReason = "";
    let done = false;
    for (let attempt = 0; attempt <= MAX_COLLISION_RETRIES && !done; attempt += 1) {
      const code = generateVoucherCode(input.prefix, rng);
      lastCode = code;
      if (seen.has(code)) {
        lastReason = "Mã sinh ra trùng trong cùng lô.";
        continue;
      }
      seen.add(code);
      const result = await input.createCode(code);
      if (result.ok) {
        created.push(code);
        done = true;
      } else if (!result.collision) {
        return { requested: input.quantity, created, complete: false, failure: { code, reason: result.reason } };
      } else {
        lastReason = result.reason;
      }
    }
    if (!done) {
      return {
        requested: input.quantity,
        created,
        complete: false,
        failure: { code: lastCode, reason: `Trùng mã sau ${MAX_COLLISION_RETRIES} lần thử lại: ${lastReason}` }
      };
    }
  }
  return { requested: input.quantity, created, complete: true, failure: null };
}
