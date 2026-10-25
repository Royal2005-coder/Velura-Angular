import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../../apps/api/src/config.js";
import { createReturnRepository } from "../../apps/api/src/returns/return-repository.js";

/**
 * Bộ lọc hàng đợi phiếu hỗ trợ (KAN-106): CSKH phải tìm lại được một ca từ số điện thoại của đơn
 * hàng, và chuỗi họ gõ không được mở thêm điều kiện lọc trong câu hỏi PostgREST.
 */
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
    const data = url.pathname.endsWith("/support_ticket") ? [{ ticket_id: "t-1", title: "Khách cần đổi size" }] : [];
    return new Response(JSON.stringify(data), { status: 200, headers: { "content-range": "0-0/1" } });
  }) as typeof fetch;
  return {
    queries: () => urls.map((url) => Object.fromEntries(url.searchParams.entries())),
    restore() {
      globalThis.fetch = originalFetch;
      Object.assign(config, saved);
    },
  };
}

test("a phone search matches the four fields CSKH can read from an order", async () => {
  const stub = gateway();
  try {
    const repository = createReturnRepository();
    await repository.listTickets({ search: "0912345678", limit: 50, offset: 0 }, "member-token");
    const query = stub.queries()[0];
    assert.equal(query.or, '(title.ilike.*"0912345678"*,description.ilike.*"0912345678"*,guest_phone.ilike.*"0912345678"*,guest_email.ilike.*"0912345678"*)');
  } finally {
    stub.restore();
  }
});

test("filter punctuation in the search stays inside the quoted value", async () => {
  const stub = gateway();
  try {
    const repository = createReturnRepository();
    const injection = 'a"),status.eq.closed';
    await repository.listTickets({ search: injection, limit: 50, offset: 0 }, "member-token");
    const or = String(stub.queries()[0].or);
    // Bốn trường, không hơn: nháy kép và dấu đóng ngoặc phải nằm trong giá trị đã thoát.
    assert.equal(or.split("ilike").length - 1, 4);
    assert.ok(or.includes('\\"'), "nháy kép phải được thoát");
    assert.ok(!or.includes(injection), "chuỗi gõ không được mở điều kiện lọc mới");
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
