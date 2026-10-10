#!/usr/bin/env node
/**
 * Apply explicit ordered SQL migrations to staging, or the current database with explicit owner approval.
 * Production stays read-only unless --environment=production --owner-approved-production is supplied.
 *
 * node scripts/run-migrations.mjs --check
 * node scripts/run-migrations.mjs --check --environment=staging
 * node scripts/run-migrations.mjs --environment=staging 054 056 057 058
 * node scripts/run-migrations.mjs --check --environment=staging --require-chatbot-schema
 * node scripts/run-migrations.mjs --environment=production --owner-approved-production 054 056 057 058
 * node scripts/run-migrations.mjs --dry-run 049
 *
 * Staging requires STAGING_SUPABASE_DB_URL and STAGING_SUPABASE_DB_CA_CERT.
 * Current-database checks and owner-approved writes use SUPABASE_DB_URL and SUPABASE_DB_CA_CERT.
 * Each migration runs in one transaction; failures preserve earlier committed files.
 * Credentials are never printed and TLS certificate verification cannot be disabled.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { lookup as dnsLookup, promises as dnsPromises } from "node:dns";

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
  if (!found) return null;
  return found;
}

/**
 * Đọc một biến cấu hình: ưu tiên biến môi trường, sau đó mới tới .env.
 *
 * Đường dẫn CA và cờ TLS thường được truyền ngay trên dòng lệnh cho một lần chạy chứ
 * không ghi vào .env, nên chỉ đọc .env là bỏ sót đúng những tham số đó.
 */
function readEnv(name) {
  const fromProcess = process.env[name];
  if (fromProcess !== undefined && fromProcess !== "") return fromProcess.trim();

  const envFile = findEnvFile();
  if (!envFile) return "";
  const text = readFileSync(envFile, "utf8");
  const match = text.match(new RegExp(`^${name}=(.*)$`, "m"));
  if (!match) return "";
  return match[1].trim().replace(/^["']|["']$/g, "");
}

/**
 * Phân giải tên máy chủ cơ sở dữ liệu, có đường lui khi trình phân giải của hệ điều
 * hành không trả lời.
 *
 * Máy chủ Supabase chỉ công bố bản ghi AAAA. Trên một số máy — Windows có VPN hoặc
 * Tailscale chen vào DNS — `dns.lookup` (đi qua getaddrinfo của hệ điều hành) trả
 * ENOENT trong khi truy vấn DNS trực tiếp vẫn ra địa chỉ. Khi rơi vào trường hợp đó,
 * script tự hỏi DNS rồi nối thẳng tới địa chỉ IP.
 *
 * Nối bằng IP thì tên trong chứng chỉ không còn khớp với `host` nữa, nên phải truyền
 * `servername` là tên máy chủ thật. Xác thực chứng chỉ vẫn giữ nguyên, chỉ đổi cách
 * tìm ra địa chỉ.
 */
async function resolveHostAddress(hostname) {
  try {
    await new Promise((ok, fail) => dnsLookup(hostname, (error, address) => (error ? fail(error) : ok(address))));
    return null; // Trình phân giải của hệ điều hành chạy được, không cần can thiệp.
  } catch (lookupError) {
    for (const query of [dnsPromises.resolve6, dnsPromises.resolve4]) {
      try {
        const [address] = await query.call(dnsPromises, hostname);
        if (address) return address;
      } catch {
        // Thử loại bản ghi tiếp theo.
      }
    }
    throw new Error(
      `Không phân giải được ${hostname} (${lookupError.code || lookupError.message}). ` +
        "Kiểm tra DNS hoặc VPN đang chen vào phân giải tên."
    );
  }
}

/** Tìm tệp migration theo số thứ tự, ví dụ "027". */
function findMigration(prefix) {
  const matches = readdirSync(MIGRATIONS_DIR).filter((name) => name.startsWith(prefix) && name.endsWith(".sql"));
  if (matches.length === 0) throw new Error(`Không có migration nào bắt đầu bằng "${prefix}"`);
  if (matches.length > 1) throw new Error(`Nhiều migration cùng bắt đầu bằng "${prefix}": ${matches.join(", ")}`);
  return matches[0];
}

/** Inspect prerequisites using catalog metadata only; no customer, promotion or transcript rows are read. */
const CHECK_SQL = `
select
  to_regprocedure('public.chat_append_user_turn(uuid,uuid,uuid,text,jsonb)') is not null
    and to_regprocedure('public.chat_record_analysis(uuid,uuid,text,jsonb,boolean)') is not null
    and to_regprocedure('public.chat_staff_action(uuid,uuid,text,jsonb)') is not null
    and (select count(*) = 5 from information_schema.columns where table_schema='public'
      and table_name='chat_session' and column_name in ('ai_epoch','next_sequence','ai_failures','issue_counts','risk_level'))
    and exists(select 1 from information_schema.columns where table_schema='public'
      and table_name='chat_message' and column_name='moderation_status') as governance054,
  exists(select 1 from information_schema.columns where table_schema='public'
    and table_name='chat_session' and column_name='context_revision')
    and to_regclass('public.chat_issue_state') is not null
    and to_regprocedure('public.chat_owner_lifecycle(uuid,uuid,uuid,text,jsonb)') is not null as session056,
  to_regclass('public.chat_support_offer_claim') is not null
    and to_regprocedure('public.chat_list_eligible_support_offers(uuid)') is not null
    and to_regprocedure('public.chat_confirm_support_offer(uuid,uuid,uuid)') is not null as promotions057,
  to_regprocedure('public.chat_schema_readiness()') is not null as readiness_rpc;
`;

/** Fail closed on an incomplete installed contract without invoking any mutation RPC. */
async function requireChatbotSchema(client) {
  const metadata = (await client.query(CHECK_SQL)).rows[0];
  if (!metadata.readiness_rpc) throw new Error("Chatbot schema is not ready: install prerequisites 054, 056, 057 and 058.");
  const state = (await client.query("select public.chat_schema_readiness() as schema")).rows[0].schema;
  console.log("Chatbot schema:", JSON.stringify(state));
  if (state?.contract !== "chatbot-3.1.7" || state.ready !== true ||
      !["governance054", "session056", "promotions057", "reports058"].every(key => state.checks?.[key] === true)) {
    throw new Error("Chatbot schema readiness failed; do not deploy this release.");
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const checkOnly = args.includes("--check");
  const requireSchema = args.includes("--require-chatbot-schema");
  const ownerApprovedProduction = args.includes("--owner-approved-production");
  const prefixes = args.filter((arg) => !arg.startsWith("--"));
  const environment = args.find(arg => arg.startsWith("--environment="))?.slice("--environment=".length) || "production";
  if (!["staging", "production"].includes(environment)) throw new Error("Environment must be staging or production.");
  if (ownerApprovedProduction && !args.includes("--environment=production")) {
    throw new Error("Owner-approved current-database writes require explicit --environment=production.");
  }
  if (!checkOnly && !dryRun && environment === "production" && !ownerApprovedProduction) {
    throw new Error("Production is read-only by default. Owner-approved writes require --environment=production --owner-approved-production and explicit migration numbers.");
  }
  if (!checkOnly && !dryRun && (!prefixes.length || prefixes.some(prefix => !/^\d{3}$/.test(prefix)))) throw new Error("Supply explicit three-digit migration numbers.");
  if (requireSchema && !checkOnly) throw new Error("--require-chatbot-schema requires --check.");
  if (prefixes.length && (prefixes.some(prefix => !/^\d{3}$/.test(prefix)) ||
      new Set(prefixes).size !== prefixes.length || prefixes.some((prefix, index) => index > 0 && prefix <= prefixes[index - 1]))) {
    throw new Error("Migration numbers must be unique explicit three-digit numbers in ascending order.");
  }

  if (dryRun) {
    for (const prefix of prefixes) {
      const file = findMigration(prefix);
      console.log(`----- ${file} -----`);
      console.log(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    }
    return;
  }

  const connectionKey = environment === "staging" ? "STAGING_SUPABASE_DB_URL" : "SUPABASE_DB_URL";
  const connectionString = readEnv(connectionKey);
  if (!connectionString) throw new Error(`Missing ${connectionKey}.`);
  if (environment === "staging") {
    const production = readEnv("SUPABASE_DB_URL");
    const stage = new URL(connectionString);
    if (production) {
      const live = new URL(production);
      const sharedPooler = /\.pooler\.supabase\.com$/i.test(stage.hostname);
      const stageUser = decodeURIComponent(stage.username), liveUser = decodeURIComponent(live.username);
      const distinctProject = sharedPooler && /^[a-z_]+\.[a-z0-9]{20}$/i.test(stageUser) &&
        /^[a-z_]+\.[a-z0-9]{20}$/i.test(liveUser) && stageUser.split(".")[1] !== liveUser.split(".")[1];
      if (stage.hostname === live.hostname && stage.pathname === live.pathname &&
          !distinctProject) throw new Error("Staging database identity matches production; refusing migration.");
    }
  }

  const caKey = environment === "staging" ? "STAGING_SUPABASE_DB_CA_CERT" : "SUPABASE_DB_CA_CERT";
  const caPath = readEnv(caKey);
  if (!caPath) throw new Error(`Missing ${caKey}; certificate verification is required.`);
  const ssl = { ca: readFileSync(caPath, "utf8"), rejectUnauthorized: true };

  const dbUrl = new URL(connectionString);
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") throw new Error("TLS verification cannot be disabled.");
  // pg connection-string SSL flags must not override the independently trusted CA.
  for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert", "ssl"]) dbUrl.searchParams.delete(key);
  const resolvedAddress = await resolveHostAddress(dbUrl.hostname);
  const clientConfig = { connectionString: dbUrl.toString(), ssl };
  if (resolvedAddress) {
    console.log(`DNS của hệ điều hành không trả lời; dùng địa chỉ phân giải trực tiếp cho ${dbUrl.hostname}.`);
    // `pg` ưu tiên connectionString hơn các trường rời, nên phải bỏ hẳn chuỗi đó đi
    // thì `host` mới có tác dụng.
    delete clientConfig.connectionString;
    clientConfig.host = resolvedAddress;
    clientConfig.port = Number(dbUrl.port) || 5432;
    clientConfig.user = decodeURIComponent(dbUrl.username);
    clientConfig.password = decodeURIComponent(dbUrl.password);
    clientConfig.database = dbUrl.pathname.replace(/^\//, "") || "postgres";
    clientConfig.ssl = { ...ssl, servername: dbUrl.hostname };
  }

  const { Client } = require("pg");
  const client = new Client({ ...clientConfig, connectionTimeoutMillis: 10_000, statement_timeout: 120_000 });
  await client.connect();

  try {
    const before = await client.query(CHECK_SQL);
    console.log("Hiện trạng trước:", JSON.stringify(before.rows[0]));
    if (checkOnly) {
      if (requireSchema) await requireChatbotSchema(client);
      return;
    }

    for (const prefix of prefixes) {
      if (["056", "057", "058"].includes(prefix)) {
        const installed = (await client.query(CHECK_SQL)).rows[0];
        if (!installed.governance054) throw new Error(`${prefix} requires installed migration 054; no repository fallback is acceptable.`);
        if (prefix !== "056" && !installed.session056) throw new Error(`${prefix} requires installed migration 056.`);
        if (prefix === "058" && !installed.promotions057) throw new Error("058 requires installed migration 057.");
      }
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
    if (prefixes.includes("058")) await requireChatbotSchema(client);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
