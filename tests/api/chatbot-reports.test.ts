import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createServer as createSmtpServer, type Socket } from "node:net";
import { once } from "node:events";
import { config } from "../../apps/api/src/config.js";
import { enqueueChatReport, startChatReportWorker } from "../../apps/api/src/chatbot/chatbot-reports.js";
import { asJsonObject, type JsonObject } from "../../apps/api/src/types.js";

const REPORT = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const LEASE = "33333333-3333-4333-8333-333333333333";
const RECIPIENT = "cskh@example.test";
const ENV_KEYS = ["CHAT_REPORT_EMAIL", "SUPPORT_ALERT_TO", "CHAT_REPORT_WEBHOOK_URL", "CHAT_REPORT_WEBHOOK_TOKEN", "CHAT_REPORT_WORKER_INTERVAL_MS"];

function preserveConfiguration() {
  const savedConfig = { ...config };
  const savedEnv: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(config, { supabaseServiceRoleKey: "report-test-service", smtpHost: "", smtpUser: "sender@example.test", smtpAppPassword: "", n8nChatWebhookUrl: "", n8nChatWebhookToken: "", nodeEnv: "production" });
  process.env.CHAT_REPORT_WORKER_INTERVAL_MS = "60000";
  return () => {
    Object.assign(config, savedConfig);
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  };
}

async function smtpFixture(rejectRecipient = false) {
  const sockets = new Set<Socket>();
  const messages: string[] = [];
  const recipients: string[] = [];
  const server = createSmtpServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.write("220 localhost report-test SMTP\r\n");
    let buffer = "";
    let dataMode = false;
    let message = "";
    socket.on("data", chunk => {
      buffer += chunk.toString();
      let lineEnd = buffer.indexOf("\r\n");
      while (lineEnd >= 0) {
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 2);
        if (dataMode) {
          if (line === ".") {
            messages.push(message);
            message = "";
            dataMode = false;
            socket.write("250 queued\r\n");
          } else message += `${line}\r\n`;
        } else if (/^(EHLO|HELO) /i.test(line)) socket.write("250-localhost\r\n250 AUTH PLAIN\r\n");
        else if (/^AUTH PLAIN /i.test(line)) socket.write("235 authenticated\r\n");
        else if (/^MAIL FROM:/i.test(line)) socket.write("250 sender accepted\r\n");
        else if (/^RCPT TO:/i.test(line)) {
          recipients.push(line);
          socket.write(rejectRecipient ? "550 recipient rejected\r\n" : "250 recipient accepted\r\n");
        } else if (line === "DATA") { dataMode = true; socket.write("354 send data\r\n"); }
        else if (line === "QUIT") { socket.end("221 bye\r\n"); }
        else socket.write("250 OK\r\n");
        lineEnd = buffer.indexOf("\r\n");
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { port: address.port, messages, recipients, async close() {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}

async function reportGateway(webhookStatuses: number[] = [200]) {
  const calls: { path: string; payload: JsonObject; idempotencyKey?: string; authorization?: string }[] = [];
  let report: JsonObject | null = null;
  let complete: ((payload: JsonObject) => void) | null = null;
  const server = createHttpServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const payload = asJsonObject(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
    const path = request.url || "";
    calls.push({ path, payload, idempotencyKey: String(request.headers["idempotency-key"] || ""), authorization: String(request.headers.authorization || "") });
    let result: unknown = 0;
    if (path.endsWith("/chat_claim_reports")) { result = report ? [report] : []; report = null; }
    if (path.endsWith("/chat_complete_report")) result = true;
    if (path.endsWith("/chat_enqueue_report")) result = { reportId: REPORT, status: "blocked" };
    const status = path === "/report-webhook" ? webhookStatuses.shift() || 200 : 200;
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
    if (path.endsWith("/chat_complete_report")) complete?.(payload);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin, calls,
    claim(overrides: JsonObject = {}) {
      report = {
        report_id: REPORT, session_id: SESSION, case_id: SESSION, lease_token: LEASE, event: "correction",
        context_version: "7:verified", source_sequence: 9, recipient_email: RECIPIENT,
        webhook_url: `${origin}/report-webhook`, corrects_report_id: "previous-report",
        payload: { sessionId: SESSION, caseId: SESSION, contextVersion: "7:verified", pendingMessages: 1,
          context: { problem: "<script>alert('unsafe')</script>", wanted: "Đổi hàng", failedApproaches: ["Đã thử đổi kích cỡ"], sentiment: "negative" },
          messages: [{ messageId: "verified-message", sequence: 9, version: 7, filterVerified: true, sender: "user", text: "Yêu cầu hợp lệ đã lọc" }],
          intelligence: { confidence: 0.93, filterStatus: "ready", sourceSequence: 9, reasons: ["Safety checked"] },
          verifiedFacts: [{ kind: "policy", id: "policy1", version: "v9", approved: true }],
          currentSuggestion: { text: "<b>Approved suggestion</b>", approach: "Approved alternative", sourceIds: ["policy1"], sourceSequence: 9, verifiedAt: "2026-10-10T00:00:00Z" },
          ownerVerification: "member_account", summaryVerification: { confirmed: true, by: "reviewer", at: "2026-10-10T00:00:00Z" },
          linkedCaseId: "previous-case", linkedHistory: { caseId: "previous-case", contextRevision: 4, problem: "Prior filtered issue", outcome: { resolution: "Prior safe outcome", finalSentiment: "neutral" } } },
        ...overrides
      };
    },
    checkpoint(signal: AbortSignal) {
      return new Promise<JsonObject>((resolve, reject) => {
        const abort = () => reject(new Error("Test ended before the worker checkpointed its report"));
        signal.addEventListener("abort", abort, { once: true });
        complete = payload => { signal.removeEventListener("abort", abort); resolve(payload); };
      });
    },
    async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  };
}

test("enqueue uses explicit department config, never the SMTP sender, and posts no caller content", async () => {
  const restore = preserveConfiguration();
  const gateway = await reportGateway();
  try {
    config.supabaseUrl = gateway.origin;
    await enqueueChatReport(SESSION, "L2");
    const first = gateway.calls.find(call => call.path.endsWith("/chat_enqueue_report"));
    assert.deepEqual(first?.payload, { p_session: SESSION, p_event: "l2", p_email: null, p_webhook: null });
    process.env.SUPPORT_ALERT_TO = RECIPIENT;
    await enqueueChatReport(SESSION, "important_update");
    assert.equal(gateway.calls.at(-1)?.payload.p_email, RECIPIENT);
    process.env.CHAT_REPORT_EMAIL = "override@example.test";
    await enqueueChatReport(SESSION, "warning");
    assert.equal(gateway.calls.at(-1)?.payload.p_email, "override@example.test");
  } finally { await gateway.close(); restore(); }
});

test("real SMTP and HTTP gateways receive urgent escaped filtered reports with stable identifiers", { timeout: 10000 }, async context => {
  const restore = preserveConfiguration();
  const smtp = await smtpFixture();
  const gateway = await reportGateway();
  let worker: NodeJS.Timeout | null = null;
  try {
    Object.assign(config, { supabaseUrl: gateway.origin, smtpHost: "127.0.0.1", smtpPort: smtp.port, smtpSecure: false, smtpAppPassword: "fixture-password", smtpFrom: "sender@example.test" });
    process.env.CHAT_REPORT_EMAIL = RECIPIENT;
    process.env.CHAT_REPORT_WEBHOOK_URL = `${gateway.origin}/report-webhook`;
    process.env.CHAT_REPORT_WEBHOOK_TOKEN = "report-only-secret";
    gateway.claim();
    const checkpoint = gateway.checkpoint(context.signal);
    worker = startChatReportWorker();
    assert.ok(worker);
    const result = await checkpoint;
    assert.equal(result.p_email_success, true);
    assert.equal(result.p_webhook_success, true);
    assert.equal(result.p_report, REPORT);
    assert.equal(result.p_lease, LEASE);
    assert.equal(smtp.messages.length, 1);
    const wire = smtp.messages[0].replace(/=\r\n/g, "").replace(/=([A-F0-9]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
    assert.match(wire, /X-Priority: 1/i);
    assert.match(wire, new RegExp(`Message-ID:\\s*<chat-report-${REPORT}@velura\\.royalai\\.dev>`, "i"));
    const html = wire.slice(wire.indexOf("Content-Type: text/html"));
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /0\.93/);
    assert.match(html, /Safety checked/);
    assert.match(html, /policy:policy1 @ v9/);
    assert.match(html, /&lt;b&gt;Approved suggestion&lt;\/b&gt;/);
    assert.match(html, /member_account/);
    assert.match(html, /Prior safe outcome/);
    assert.ok(smtp.recipients.every(recipient => recipient.includes(RECIPIENT)));
    const webhook = gateway.calls.find(call => call.path === "/report-webhook");
    assert.equal(webhook?.idempotencyKey, REPORT);
    assert.equal(webhook?.authorization, "Bearer report-only-secret");
    assert.equal(webhook?.payload.caseId, SESSION);
    assert.equal(webhook?.payload.correctsReportId, "previous-report");
    assert.equal(asJsonObject(webhook?.payload.context).pendingMessages, 1);
  } finally { clearInterval(worker ?? undefined); await gateway.close(); await smtp.close(); restore(); }
});

test("HTTP non-2xx retries only the unconfirmed channel and preserves report identity", { timeout: 10000 }, async context => {
  const restore = preserveConfiguration();
  const smtp = await smtpFixture();
  const gateway = await reportGateway([503, 200]);
  let worker: NodeJS.Timeout | null = null;
  try {
    Object.assign(config, { supabaseUrl: gateway.origin, smtpHost: "127.0.0.1", smtpPort: smtp.port, smtpSecure: false, smtpAppPassword: "fixture-password" });
    process.env.CHAT_REPORT_EMAIL = RECIPIENT;
    process.env.CHAT_REPORT_WEBHOOK_URL = `${gateway.origin}/report-webhook`;
    for (const expected of [false, true]) {
      gateway.claim({ email_delivered_at: "2026-10-10T00:00:00Z" });
      const checkpoint = gateway.checkpoint(context.signal);
      worker = startChatReportWorker();
      assert.ok(worker);
      const result = await checkpoint;
      clearInterval(worker); worker = null;
      assert.equal(result.p_email_success, true);
      assert.equal(result.p_webhook_success, expected);
      assert.equal(result.p_report, REPORT);
      if (!expected) assert.match(String(result.p_error), /HTTP 503/);
    }
    assert.equal(smtp.messages.length, 0);
    assert.equal(gateway.calls.filter(call => call.path === "/report-webhook").length, 2);
  } finally { clearInterval(worker ?? undefined); await gateway.close(); await smtp.close(); restore(); }
});

test("SMTP recipient rejection is never checkpointed as successful delivery", { timeout: 10000 }, async context => {
  const restore = preserveConfiguration();
  const smtp = await smtpFixture(true);
  const gateway = await reportGateway();
  let worker: NodeJS.Timeout | null = null;
  try {
    Object.assign(config, { supabaseUrl: gateway.origin, smtpHost: "127.0.0.1", smtpPort: smtp.port, smtpSecure: false, smtpAppPassword: "fixture-password" });
    process.env.CHAT_REPORT_EMAIL = RECIPIENT;
    gateway.claim({ webhook_url: null });
    const checkpoint = gateway.checkpoint(context.signal);
    worker = startChatReportWorker();
    assert.ok(worker);
    const result = await checkpoint;
    assert.equal(result.p_email_success, false);
    assert.match(String(result.p_error), /SMTP did not confirm/);
    assert.equal(smtp.messages.length, 0);
  } finally { clearInterval(worker ?? undefined); await gateway.close(); await smtp.close(); restore(); }
});
