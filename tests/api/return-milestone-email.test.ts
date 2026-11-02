import test from "node:test";
import assert from "node:assert/strict";
import {
  RETURN_MILESTONE_TEMPLATES, buildReturnMilestoneMessage, returnMilestoneKey, sendReturnMilestoneEmail,
  type ReturnMilestoneDeps
} from "../../apps/api/src/returns/return-milestone-email.js";
import type { JsonObject } from "../../apps/api/src/types.js";

const CTX = { customerName: "An", returnCode: "RETABC123", orderCode: "VL001" };

function fakeDeps() {
  const outbox: JsonObject[] = [];
  const sent: string[] = [];
  const deps = {
    selectRows: async (_table: string, query: Record<string, unknown>) => ({
      rows: outbox.filter((row) => (row.metadata as JsonObject).event_key === String(query["metadata->>event_key"]).replace("eq.", ""))
    }),
    selectOne: async (table: string) => table === "return_exchange"
      ? { return_id: "r1", order_id: "o1", user_id: null, return_code: "RETABC123" }
      : { order_id: "o1", order_code: "VL001", shipping_name: "An", shipping_email: "an@example.com" },
    insertRow: async (_table: string, payload: unknown) => { outbox.push(payload as JsonObject); return payload; },
    send: async (to: string, subject: string) => { sent.push(`${to}|${subject}`); return true; }
  } as unknown as ReturnMilestoneDeps;
  return { deps, outbox, sent };
}

test("each milestone renders its own subject with the return code", () => {
  for (const milestone of ["intake", "contacted", "received", "refunding"] as const) {
    const message = buildReturnMilestoneMessage(milestone, CTX);
    assert.ok(message.subject.includes("RETABC123"), milestone);
    assert.ok(message.text.includes("Kính chào An"));
  }
  assert.notEqual(RETURN_MILESTONE_TEMPLATES.intake, RETURN_MILESTONE_TEMPLATES.refunding);
});

test("refunding promises the 4-5 working day SLA and a partial receipt names the shortfall", () => {
  const message = buildReturnMilestoneMessage("refunding", { ...CTX, receivedQuantity: 1, registeredQuantity: 2, refundDueAt: "2026-11-13T03:00:00Z" });
  assert.match(message.text, /4-5 ngày làm việc/);
  assert.match(message.text, /thực nhận: 1\/2/);
  assert.match(message.text, /13\/11\/2026/);
});

test("a milestone is sent once per key and a retry does not email again", async () => {
  const { deps, outbox, sent } = fakeDeps();
  assert.equal(await sendReturnMilestoneEmail("r1", "received", { returnItemId: "item-1" }, deps), true);
  assert.equal(await sendReturnMilestoneEmail("r1", "received", { returnItemId: "item-1" }, deps), true);
  assert.equal(sent.length, 1);
  assert.equal(outbox.length, 1);
  assert.equal((outbox[0].metadata as JsonObject).event_key, returnMilestoneKey("received", "r1", "item-1"));
  // A different part of the same request is a different event.
  await sendReturnMilestoneEmail("r1", "received", { returnItemId: "item-2" }, deps);
  assert.equal(sent.length, 2);
});

test("no valid recipient means nothing is sent and nothing is recorded", async () => {
  const { deps, outbox, sent } = fakeDeps();
  const noEmail = { ...deps, selectOne: async (table: string) => table === "return_exchange"
    ? { return_id: "r1", order_id: "o1", user_id: null } : { order_id: "o1", shipping_email: "", shipping_name: "" } } as unknown as ReturnMilestoneDeps;
  assert.equal(await sendReturnMilestoneEmail("r1", "intake", {}, noEmail), false);
  assert.equal(sent.length + outbox.length, 0);
});
