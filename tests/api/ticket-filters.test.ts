import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../../apps/api/src/config.js";
import { createReturnRepository } from "../../apps/api/src/returns/return-repository.js";
import { SEARCH_SCAN_LIMIT } from "../../apps/api/src/search-text.js";

/**
 * Bộ lọc hàng đợi phiếu hỗ trợ (KAN-106, UAT TC_TICK_08): CSKH phải tìm lại được một ca từ số
 * điện thoại của đơn, và gõ thiếu dấu vẫn ra kết quả. Tìm kiếm chạy trên cửa sổ đọc có trần rồi
 * gấp dấu trong Node, nên chuỗi người dùng gõ không bao giờ trở thành cú pháp PostgREST.
 */
const TICKETS = [
  { ticket_id: "t-1", title: "Khách cần đổi size", guest_phone: "0912345678" },
  { ticket_id: "t-2", title: "Hỏi giao hàng" },
];

function gateway() {
  const originalFetch = globalThis.fetch;
  const saved = { ...config };
  const urls: URL[] = [];
  Object.assign(config, {
    supabaseUrl: "https://tickets.test",
    // Danh sách phiếu chạy theo token thành viên (RLS của `support_ticket`), nên câu hỏi đi bằng
    // anon key + Authorization — cùng đường mà admin thật đi.
    supabaseAnonKey: "test-anon",
    supabaseServiceRoleKey: "test-service",
    nodeEnv: "production",
  });
  globalThis.fetch = (async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    urls.push(url);
    const data = url.pathname.endsWith("/support_ticket") ? TICKETS : [];
    return new Response(JSON.stringify(data), { status: 200, headers: { "content-range": `0-1/${TICKETS.length}` } });
  }) as typeof fetch;
  return {
    queries: () => urls.map((url) => Object.fromEntries(url.searchParams.entries())),
    restore() {
      globalThis.fetch = originalFetch;
      Object.assign(config, saved);
    },
  };
}

test("a phone search matches the ticket that carries it", async () => {
  const stub = gateway();
  try {
    const repository = createReturnRepository();
    const result = await repository.listTickets({ search: "0912345678", limit: 50, offset: 0 }, "member-token");
    const query = stub.queries()[0];
    // Folded search never travels as an `or` filter: the window is read and matched in Node.
    assert.equal(query.or, undefined);
    assert.equal(query.limit, String(SEARCH_SCAN_LIMIT));
    assert.equal(query.offset, "0");
    assert.deepEqual(result.rows.map((row) => row.ticket_id), ["t-1"]);
    assert.equal(result.count, 1);
  } finally {
    stub.restore();
  }
});

test("a search without diacritics still finds an accented ticket title", async () => {
  const stub = gateway();
  try {
    const repository = createReturnRepository();
    const result = await repository.listTickets({ search: "khach can doi", limit: 50, offset: 0 }, "member-token");
    assert.deepEqual(result.rows.map((row) => row.ticket_id), ["t-1"]);
    assert.equal(result.count, 1);
  } finally {
    stub.restore();
  }
});

test("filter punctuation in the search is plain text, never query syntax", async () => {
  const stub = gateway();
  try {
    const repository = createReturnRepository();
    const injection = 'a"),status.eq.closed';
    const result = await repository.listTickets({ search: injection, limit: 50, offset: 0 }, "member-token");
    const query = stub.queries()[0];
    assert.equal(query.or, undefined);
    assert.equal(query.status, undefined);
    assert.equal(result.count, 0);
  } finally {
    stub.restore();
  }
});

test("status and paging still travel as their own filters", async () => {
  const stub = gateway();
  try {
    const repository = createReturnRepository();
    await repository.listTickets({ status: "open", userId: "77777777-7777-4777-8777-777777777777", limit: 10, offset: 20 }, "member-token");
    const query = stub.queries()[0];
    assert.equal(query.status, "eq.open");
    assert.equal(query.user_id, "eq.77777777-7777-4777-8777-777777777777");
    assert.equal(query.limit, "10");
    assert.equal(query.offset, "20");
  } finally {
    stub.restore();
  }
});
