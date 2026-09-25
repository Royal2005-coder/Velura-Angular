import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function findEnvFile() {
  const candidates = [join(ROOT, '.env')];
  try {
    const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
    if (commonDir) candidates.push(join(dirname(commonDir), '.env'));
  } catch {}
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error('No .env found');
  return found;
}

// Load .env
const envText = readFileSync(findEnvFile(), 'utf8');
for (const line of envText.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq > 0) {
    const k = trimmed.slice(0, eq).trim();
    let v = trimmed.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    process.env[k] = v;
  }
}

const { supabaseRequest } = await import('../apps/api/dist/supabase.js');

console.log('=== Cleaning up old promotions and vouchers ===');

// 1. Deactivate old test vouchers
const junkCodes = ['HIHI', 'TEST463', 'TEST183', 'TƯTGWT', 'SALE70', 'SALE50', 'SALE100', 'TEST596', 'SALE50K', 'SUMMER25', 'VIP200K'];
for (const code of junkCodes) {
  try {
    await supabaseRequest('/rest/v1/voucher', {
      method: 'PATCH',
      query: { code: `eq.${code}` },
      body: { is_active: false },
    });
    console.log(`Deactivated voucher: ${code}`);
  } catch (err) {
    console.warn(`Could not deactivate ${code}:`, err.message);
  }
}

// 2. Deactivate old test campaigns
const junkCampaignNames = ['Test Campaign 1783249143511', 'Test Campaign 1783249912004', 'KM Test RPC 1783005531234', 'grsgrg', 'Test Campaign 1783249933508'];
for (const name of junkCampaignNames) {
  try {
    await supabaseRequest('/rest/v1/promotion', {
      method: 'PATCH',
      query: { promo_name: `eq.${name}` },
      body: { is_active: false },
    });
    console.log(`Deactivated campaign: ${name}`);
  } catch (err) {
    console.warn(`Could not deactivate campaign ${name}:`, err.message);
  }
}

// 3. Upsert clean active 2026 campaigns
console.log('=== Upserting clean active 2026 campaigns ===');
const ADMIN_USER_ID = '6ed03143-1c74-4654-a14b-ecdd87e551c8';

const campaigns = [
  {
    promo_name: 'Thu Đông Khởi Sắc 2026',
    promo_type: 'seasonal_sale',
    start_date: '2026-09-01T00:00:00',
    end_date: '2026-11-30T23:59:59',
    is_active: true,
    budget_limit: 100000000,
    max_vouchers_allowed: 500,
    display_order: 1,
    is_featured: true,
    created_by: ADMIN_USER_ID,
  },
  {
    promo_name: 'Ưu Đãi Khách Hàng Mới & Tri Ân',
    promo_type: 'product_discount',
    start_date: '2026-09-01T00:00:00',
    end_date: '2026-12-31T23:59:59',
    is_active: true,
    budget_limit: 50000000,
    max_vouchers_allowed: 300,
    display_order: 2,
    is_featured: true,
    created_by: ADMIN_USER_ID,
  },
  {
    promo_name: 'Flash Sale Cuối Tuần 2026',
    promo_type: 'flash_sale',
    start_date: '2026-09-01T00:00:00',
    end_date: '2026-10-31T23:59:59',
    is_active: true,
    budget_limit: 50000000,
    max_vouchers_allowed: 200,
    display_order: 3,
    is_featured: true,
    created_by: ADMIN_USER_ID,
  },
];

const campaignMap = {};
for (const camp of campaigns) {
  // Check if exists
  const existing = await supabaseRequest('/rest/v1/promotion', {
    query: { promo_name: `eq.${camp.promo_name}`, select: 'promo_id' },
  });
  if (existing.data && existing.data.length > 0) {
    const id = existing.data[0].promo_id;
    await supabaseRequest('/rest/v1/promotion', {
      method: 'PATCH',
      query: { promo_id: `eq.${id}` },
      body: camp,
    });
    campaignMap[camp.promo_name] = id;
    console.log(`Updated campaign: ${camp.promo_name} (${id})`);
  } else {
    const created = await supabaseRequest('/rest/v1/promotion', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: camp,
    });
    const id = created.data[0].promo_id;
    campaignMap[camp.promo_name] = id;
    console.log(`Created campaign: ${camp.promo_name} (${id})`);
  }
}

// 4. Upsert 5 active realistic vouchers
console.log('=== Upserting 5 clean active 2026 vouchers ===');
const vouchers = [
  {
    code: 'FALL10',
    name: 'Giảm 10% Bộ sưu tập Thu Đông',
    discount_type: 'percentage',
    discount_value: 10,
    max_discount_amount: 50000,
    min_order_value: 200000,
    promo_id: campaignMap['Thu Đông Khởi Sắc 2026'],
    start_date: '2026-09-01T00:00:00',
    end_date: '2026-11-30T23:59:59',
    is_active: true,
    usage_limit_total: 500,
    usage_limit_per_user: 2,
    applicable_user_group: 'all_users',
    applicable_categories: ['8fee0728-1d9e-498a-a048-9b8366ac0184', 'ce1a6336-4ada-4a57-9106-5f651e1bcdc9', '21d95344-84e7-42ca-a228-510d700e73e1'],
    created_by: ADMIN_USER_ID,
  },
  {
    code: 'FALL50K',
    name: 'Giảm ngay 50.000đ cho đơn từ 350K',
    discount_type: 'fixed_amount',
    discount_value: 50000,
    min_order_value: 350000,
    promo_id: campaignMap['Thu Đông Khởi Sắc 2026'],
    start_date: '2026-09-01T00:00:00',
    end_date: '2026-11-30T23:59:59',
    is_active: true,
    usage_limit_total: 300,
    usage_limit_per_user: 1,
    applicable_user_group: 'all_users',
    applicable_categories: null,
    created_by: ADMIN_USER_ID,
  },
  {
    code: 'FREESHIP',
    name: 'Miễn phí vận chuyển toàn quốc',
    discount_type: 'free_shipping',
    discount_value: 0,
    min_order_value: 250000,
    promo_id: campaignMap['Flash Sale Cuối Tuần 2026'],
    start_date: '2026-09-01T00:00:00',
    end_date: '2026-10-31T23:59:59',
    is_active: true,
    usage_limit_total: 1000,
    usage_limit_per_user: 3,
    applicable_user_group: 'all_users',
    applicable_categories: null,
    created_by: ADMIN_USER_ID,
  },
  {
    code: 'CHAOBANMOI',
    name: 'Ưu đãi bạn mới giảm 30.000đ',
    discount_type: 'fixed_amount',
    discount_value: 30000,
    min_order_value: 150000,
    promo_id: campaignMap['Ưu Đãi Khách Hàng Mới & Tri Ân'],
    start_date: '2026-09-01T00:00:00',
    end_date: '2026-12-31T23:59:59',
    is_active: true,
    usage_limit_total: 500,
    usage_limit_per_user: 1,
    applicable_user_group: 'all_users',
    applicable_categories: null,
    created_by: ADMIN_USER_ID,
  },
  {
    code: 'VIP100K',
    name: 'Tri ân VIP giảm 100.000đ cho đơn từ 600K',
    discount_type: 'fixed_amount',
    discount_value: 100000,
    min_order_value: 600000,
    promo_id: campaignMap['Ưu Đãi Khách Hàng Mới & Tri Ân'],
    start_date: '2026-09-01T00:00:00',
    end_date: '2026-12-31T23:59:59',
    is_active: true,
    usage_limit_total: 200,
    usage_limit_per_user: 1,
    applicable_user_group: 'all_users',
    applicable_categories: null,
    created_by: ADMIN_USER_ID,
  },
];

for (const v of vouchers) {
  const existing = await supabaseRequest('/rest/v1/voucher', {
    query: { code: `eq.${v.code}`, select: 'voucher_id' },
  });
  if (existing.data && existing.data.length > 0) {
    const id = existing.data[0].voucher_id;
    await supabaseRequest('/rest/v1/voucher', {
      method: 'PATCH',
      query: { voucher_id: `eq.${id}` },
      body: v,
    });
    console.log(`Updated voucher: ${v.code} (${id})`);
  } else {
    const created = await supabaseRequest('/rest/v1/voucher', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: v,
    });
    console.log(`Created voucher: ${v.code} (${created.data[0].voucher_id})`);
  }
}

console.log('=== Promotion & Voucher Seeding Completed Successfully! ===');
