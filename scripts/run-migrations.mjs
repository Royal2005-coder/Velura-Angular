#!/usr/bin/env node
/**
 * Chạy migration SQL lên cơ sở dữ liệu Supabase.
 *
 * Kho này trước đây không có cách nào chạy migration ngoài việc dán tay vào SQL Editor
 * của Supabase, nên các bản 025-027 nằm trong `database/migrations` mà không ai biết đã
 * chạy hay chưa. Script này lấp chỗ đó.
 *
 *   node scripts/run-migrations.mjs --check              # chỉ đọc, không ghi gì
 *   node scripts/run-migrations.mjs 025 026 027          # chạy theo đúng thứ tự đã liệt kê
 *   node scripts/run-migrations.mjs --dry-run 027        # in ra SQL sẽ chạy rồi dừng
 *
 * Chuỗi kết nối đọc từ SUPABASE_DB_URL trong .env ở gốc kho. Script không in chuỗi đó
 * ra màn hình hay nhật ký.
 *
 * Mỗi tệp chạy trong một giao dịch riêng: hỏng giữa chừng thì tệp đó quay lui trọn vẹn,
 * các tệp đã xong trước đó vẫn giữ nguyên. Postgres cho phép DDL trong giao dịch nên
 * điều này áp dụng cho cả `create table` lẫn `drop function`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(ROOT, "database", "migrations");

/**
 * Tìm tệp .env.
 *
 * Khi chạy trong một git worktree, .env nằm ở kho chính chứ không được sao sang
 * worktree — `git rev-parse --git-common-dir` chỉ về `.git` của kho chính nên thư mục
 * cha của nó là gốc cần tìm.
 */
function findEnvFile() {
  const candidates = [join(ROOT, ".env")];
  try {
    const commonDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: ROOT,
      encoding: "utf8"
    }).trim();
    if (commonDir) candidates.push(join(dirname(commonDir), ".env"));
  } catch {
    // Không phải kho git, hoặc không có git — chỉ còn đường dẫn mặc định.
  }
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`Không tìm thấy .env. Đã tìm ở:\n  ${candidates.join("\n  ")}`);
  }
  return found;
}

/** Đọc một biến từ .env mà không nạp cả tệp vào process.env. */
function readEnv(name) {
  const text = readFileSync(findEnvFile(), "utf8");
  const match = text.match(new RegExp(`^${name}=(.*)$`, "m"));
  if (!match) return "";
  return match[1].trim().replace(/^["']|["']$/g, "");
}

/** Tìm tệp migration theo số thứ tự, ví dụ "027". */
function findMigration(prefix) {
  const matches = readdirSync(MIGRATIONS_DIR).filter((name) => name.startsWith(prefix) && name.endsWith(".sql"));
  if (matches.length === 0) throw new Error(`Không có migration nào bắt đầu bằng "${prefix}"`);
  if (matches.length > 1) throw new Error(`Nhiều migration cùng bắt đầu bằng "${prefix}": ${matches.join(", ")}`);
  return matches[0];
}

/** Đọc hiện trạng những thứ mà 025-027 đụng tới. */
const CHECK_SQL = `
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'promotion'
      and column_name in ('description','banner_image_url','highlight_label','display_order','is_featured')
  ) as cot_trinh_bay_026,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in
      ('velura_record_voucher_redemption','velura_release_voucher_redemption','velura_sync_promotion_schedule')
  ) as rpc_025,
  (select string_agg(distinct p.pronargs::text, ',') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'admin_update_promotion'
  ) as so_tham_so_admin_update_promotion,
  (select count(*) from public.promotion) as so_chien_dich,
  (select count(*) from public.voucher) as so_voucher,
  (select coalesce(sum(total_discount_issued), 0) from public.promotion) as tong_da_giam;
`;

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const checkOnly = args.includes("--check");
  const prefixes = args.filter((arg) => !arg.startsWith("--"));

  if (dryRun) {
    for (const prefix of prefixes) {
      const file = findMigration(prefix);
      console.log(`----- ${file} -----`);
      console.log(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    }
    return;
  }

  const connectionString = readEnv("SUPABASE_DB_URL");
  if (!connectionString) {
    console.error("Thiếu SUPABASE_DB_URL trong .env ở gốc kho.");
    process.exit(1);
  }

  // Script này cầm chuỗi kết nối cơ sở dữ liệu production và đẩy nguyên văn DDL qua đó.
  // Bản trước đặt thẳng `rejectUnauthorized: false`, nghĩa là bất kỳ ai chen được vào
  // giữa cũng đọc được thông tin kết nối và toàn bộ nội dung migration.
  //
  // Supabase ký chứng chỉ bằng CA riêng nên kho tin cậy mặc định của Node không xác thực
  // được; cách đúng là trỏ tới CA của họ (tải ở Dashboard > Settings > Database > SSL).
  // Không có CA thì script dừng và nói rõ hai lựa chọn, thay vì âm thầm hạ tiêu chuẩn.
  const caPath = readEnv("SUPABASE_DB_CA_CERT");
  const allowInsecureTls = readEnv("SUPABASE_DB_ALLOW_INSECURE_TLS") === "true";

  let ssl;
  if (caPath) {
    ssl = { ca: readFileSync(caPath, "utf8"), rejectUnauthorized: true };
  } else if (allowInsecureTls) {
    console.warn("CẢNH BÁO: đang bỏ qua xác thực chứng chỉ TLS tới cơ sở dữ liệu.");
    console.warn("Chỉ dùng tạm. Đặt SUPABASE_DB_CA_CERT trỏ tới CA của Supabase để chạy an toàn.");
    ssl = { rejectUnauthorized: false };
  } else {
    console.error("Thiếu cấu hình TLS cho kết nối cơ sở dữ liệu. Chọn một trong hai:");
    console.error("  1. SUPABASE_DB_CA_CERT=<đường dẫn tới CA của Supabase>   (khuyến nghị)");
    console.error("  2. SUPABASE_DB_ALLOW_INSECURE_TLS=true                    (chỉ khi chạy tạm)");
    process.exit(1);
  }

  const { Client } = require("pg");
  const client = new Client({ connectionString, ssl });
  await client.connect();

  try {
    const before = await client.query(CHECK_SQL);
    console.log("Hiện trạng trước:", JSON.stringify(before.rows[0]));
    if (checkOnly) return;

    for (const prefix of prefixes) {
      const file = findMigration(prefix);
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      process.stdout.write(`Đang chạy ${file} … `);
      try {
        await client.query("begin");
        await client.query(sql);
        await client.query("commit");
        console.log("xong");
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        console.log("HỎNG");
        console.error(`  ${error.message}`);
        if (error.hint) console.error(`  gợi ý: ${error.hint}`);
        if (error.where) console.error(`  tại: ${error.where}`);
        console.error(`  ${file} đã quay lui trọn vẹn. Các tệp trước đó vẫn giữ nguyên.`);
        process.exitCode = 1;
        return;
      }
    }

    const after = await client.query(CHECK_SQL);
    console.log("Hiện trạng sau: ", JSON.stringify(after.rows[0]));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
