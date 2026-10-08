import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { config } from "../../apps/api/src/config.js";
import { HttpError } from "../../apps/api/src/http.js";
import { analyzeImageWithGemini, generateGeminiEmbedding, generateGeminiJson, generateGeminiText, generateGeminiVisionJson, isGeminiConfigured, readAiGatewayMetrics, vectorLiteral } from "../../apps/api/src/gemini-client.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=", "base64");
const schema = { type: "OBJECT", properties: { season: { type: "STRING", enum: ["winter", "summer"] }, confidence: { type: "NUMBER", minimum: 0, maximum: 1 } }, required: ["season", "confidence"], additionalProperties: false };
const answer = { choices: [{ message: { content: '{"season":"winter","confidence":0.9}' }, finish_reason: "stop" }] };

interface ObservedRequest { path: string; authorization: string | undefined; contentType: string | undefined; body: Buffer; }
async function fixture(handler: (request: ObservedRequest, response: ServerResponse) => void, run: (requests: ObservedRequest[]) => Promise<void>): Promise<void> {
  const requests: ObservedRequest[] = [];
  const server = createServer((incoming: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const observed = { path: incoming.url || "", authorization: incoming.headers.authorization, contentType: incoming.headers["content-type"], body: Buffer.concat(chunks) };
      requests.push(observed);
      handler(observed, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const before = { endpoint: process.env.LITELLM_ENDPOINT, key: process.env.LITELLM_API_KEY, direct: process.env.AI_ALLOW_DIRECT_PROVIDER, image: process.env.LITELLM_IMAGE_MODEL, nodeEnv: config.nodeEnv, providerKey: config.geminiApiKey };
  process.env.LITELLM_ENDPOINT = `http://127.0.0.1:${address.port}`;
  process.env.LITELLM_API_KEY = "application-virtual-key-fixture";
  process.env.AI_ALLOW_DIRECT_PROVIDER = "true";
  config.geminiApiKey = "direct-provider-key-must-not-be-used";
  try { await run(requests); } finally {
    for (const [name, value] of [["LITELLM_ENDPOINT", before.endpoint], ["LITELLM_API_KEY", before.key], ["AI_ALLOW_DIRECT_PROVIDER", before.direct], ["LITELLM_IMAGE_MODEL", before.image]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    config.nodeEnv = before.nodeEnv;
    config.geminiApiKey = before.providerKey;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}
function json(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
function code(expected: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof HttpError && error.code === expected;
}

test("AI gateway real HTTP contracts", async (suite) => {
  await suite.test("text, JSON, vision and attachments use the gateway and exact per-call aliases", async () => {
    await fixture((request, response) => { assert.equal(request.path, "/v1/chat/completions"); json(response, answer); }, async (requests) => {
      assert.equal(isGeminiConfigured(), true);
      assert.equal(await generateGeminiText("private text", { model: "text-alias", maxRetries: 0 }), '{"season":"winter","confidence":0.9}');
      assert.deepEqual(await generateGeminiJson("choose season", schema, { model: "json-alias" }), { season: "winter", confidence: 0.9 });
      assert.deepEqual(await generateGeminiVisionJson("analyze", png, "image/png", schema, { model: "vision-alias" }), { season: "winter", confidence: 0.9 });
      await generateGeminiText("attachment", { images: [{ bytes: png, mime: "image/png" }] });
      await analyzeImageWithGemini(`data:image/png;base64,${png.toString("base64")}`, "image/png", "describe");
      assert.equal(requests.length, 5);
      const bodies = requests.map((request) => JSON.parse(request.body.toString("utf8")) as { model: string; messages: Array<{ content: unknown }>; response_format?: { type: string } });
      assert.deepEqual(bodies.slice(0, 3).map((body) => body.model), ["text-alias", "json-alias", "vision-alias"]);
      assert.equal(bodies[1].response_format?.type, "json_object");
      assert.equal(Array.isArray(bodies[2].messages[1].content), true);
      assert.equal(Array.isArray(bodies[3].messages[0].content), true);
      assert.ok(requests.every((request) => request.authorization === "Bearer application-virtual-key-fixture"));
    });
  });

  await suite.test("1536 text embedding is exact and never a sliced CLIP vector", async () => {
    let responseVector: unknown[] = Array.from({ length: 1536 }, (_, index) => index / 1536);
    await fixture((request, response) => {
      assert.equal(request.path, "/v1/embeddings");
      const body = JSON.parse(request.body.toString("utf8")) as { dimensions: number; model: string; encoding_format: string };
      assert.equal(body.dimensions, 1536); assert.equal(body.model, "embedding-alias"); assert.equal(body.encoding_format, "float");
      json(response, { data: [{ embedding: responseVector }] });
    }, async () => {
      const vector = await generateGeminiEmbedding("query", { model: "embedding-alias", dimensions: 1536 });
      assert.equal(vector.length, 1536); assert.equal(vector[100], 100 / 1536);
      for (const invalid of [Array(512).fill(1), Array(1537).fill(1), [...Array(1535).fill(1), "0.1"], [...Array(1535).fill(1), null]]) {
        responseVector = invalid;
        await assert.rejects(generateGeminiEmbedding("query", { model: "embedding-alias", dimensions: 1536 }), code("AI_EMBEDDING_INVALID"));
      }
      assert.throws(() => vectorLiteral([1, Infinity]), code("INVALID_VECTOR"));
      assert.throws(() => vectorLiteral([1, "2"]), code("INVALID_VECTOR"));
    });
  });

  await suite.test("unauthorized gateway never retries or bypasses to a configured direct key", async () => {
    await fixture((_request, response) => json(response, { error: { message: "PRIVATE_PROVIDER_BODY virtual-key" } }, 401), async (requests) => {
      config.nodeEnv = "production";
      const started = performance.now();
      await assert.rejects(generateGeminiText("PRIVATE_PROMPT", { timeoutMs: 1500, maxRetries: 5 }), code("AI_PROVIDER_UNAUTHORIZED"));
      assert.equal(requests.length, 1);
      assert.ok(performance.now() - started < 1500);
    });
  });

  await suite.test("transient status retries share one total deadline including Retry-After", async () => {
    let fail = true;
    await fixture((_request, response) => {
      if (fail) { response.setHeader("retry-after", "30"); json(response, { error: "rate limit" }, 429); }
      else json(response, answer);
    }, async (requests) => {
      const started = performance.now();
      await assert.rejects(generateGeminiText("deadline", { timeoutMs: 120, maxRetries: 5 }), code("AI_TIMEOUT"));
      assert.ok(performance.now() - started < 1500);
      assert.equal(requests.length, 1);
      fail = false;
      assert.equal(await generateGeminiText("next request", { timeoutMs: 1500 }), '{"season":"winter","confidence":0.9}');
    });
    await fixture((_request, response) => json(response, answer), async () => {
      assert.equal(await generateGeminiText("normal", { maxRetries: 0 }), '{"season":"winter","confidence":0.9}');
    });
    let attempts = 0;
    await fixture((_request, response) => { attempts++; json(response, attempts === 1 ? { error: "temporary" } : answer, attempts === 1 ? 503 : 200); }, async (requests) => {
      assert.equal(await generateGeminiText("retry", { timeoutMs: 2000, maxRetries: 1 }), '{"season":"winter","confidence":0.9}');
      assert.equal(requests.length, 2);
    });
  });

  await suite.test("caller cancellation stops hanging HTTP and retry backoff; pre-abort sends nothing", async () => {
    let requestSeen!: () => void;
    const received = new Promise<void>((resolve) => { requestSeen = resolve; });
    await fixture((_request, _response) => { requestSeen(); }, async (requests) => {
      const controller = new AbortController();
      const pending = generateGeminiText("cancel", { signal: controller.signal, timeoutMs: 5000 });
      await received;
      controller.abort();
      await assert.rejects(pending, code("AI_CANCELLED"));
      assert.equal(requests.length, 1);
      await assert.rejects(generateGeminiText("already cancelled", { signal: controller.signal }), code("AI_CANCELLED"));
      assert.equal(requests.length, 1);
    });
    await fixture((_request, response) => { response.setHeader("retry-after", "10"); json(response, {}, 503); }, async (requests) => {
      const controller = new AbortController();
      const pending = generateGeminiEmbedding("cancel backoff", { signal: controller.signal, timeoutMs: 5000 });
      // Real HTTP retry-backoff cancellation exercises the platform AbortSignal/timer interaction.
      const timer = setTimeout(() => controller.abort(), 100);
      try { await assert.rejects(pending, code("AI_CANCELLED")); } finally { clearTimeout(timer); }
      assert.equal(requests.length, 1);
    });
  });

  await suite.test("malformed, truncated, empty and schema-invalid outputs are explicit failures", async () => {
    let output: unknown = { choices: [{ message: { content: "not JSON PRIVATE_OUTPUT" } }] };
    await fixture((_request, response) => json(response, output), async (requests) => {
      await assert.rejects(generateGeminiJson("json", schema), code("AI_JSON_INVALID"));
      for (const invalid of ['{"season":"autumn","confidence":0.9}', '{"season":"winter","confidence":2}', '{"season":"winter"}', '{"season":"winter","confidence":0.9,"extra":true}']) {
        output = { choices: [{ message: { content: invalid } }] };
        await assert.rejects(generateGeminiJson("json", schema), code("AI_OUTPUT_SCHEMA_INVALID"));
      }
      output = { choices: [{ message: { content: "" } }] };
      await assert.rejects(generateGeminiText("empty"), code("AI_TEXT_EMPTY"));
      output = { choices: [{ message: { content: "unfinished" }, finish_reason: "length" }] };
      await assert.rejects(generateGeminiText("truncated"), code("AI_OUTPUT_TRUNCATED"));
      const count = requests.length;
      await assert.rejects(generateGeminiJson("schema", { type: "object", $ref: "unsupported" }), code("AI_SCHEMA_UNSUPPORTED"));
      assert.equal(requests.length, count);
    });
    await fixture((_request, response) => response.end("NOT_JSON_PRIVATE"), async () => {
      await assert.rejects(generateGeminiText("malformed envelope"), code("AI_RESPONSE_INVALID"));
    });
  });

  await suite.test("image MIME and byte bounds fail before external inference", async () => {
    await fixture((_request, response) => json(response, { error: "Must not reach inference" }, 500), async (requests) => {
      await assert.rejects(generateGeminiVisionJson("image", png, "image/jpeg", schema), code("AI_IMAGE_MIME_INVALID"));
      await assert.rejects(generateGeminiVisionJson("image", Buffer.alloc(10 * 1024 * 1024 + 1), "image/png", schema), code("AI_IMAGE_TOO_LARGE"));
      await assert.rejects(analyzeImageWithGemini("invalid", "image/png", "image"), code("AI_IMAGE_INVALID"));
      assert.equal(requests.length, 0);
    });
  });

  await suite.test("metrics measure supplied tokens/cost and redact prompts, responses, keys and errors", async () => {
    const messages: unknown[][] = [];
    const beforeConsole = { error: console.error, warn: console.warn, log: console.log };
    console.error = console.warn = console.log = (...args: unknown[]) => { messages.push(args); };
    try {
      await fixture((_request, response) => {
        response.setHeader("x-litellm-response-cost", "0.002");
        json(response, { choices: [{ message: { content: "PRIVATE_GENERATED_CONTENT" } }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } });
      }, async () => {
        const before = readAiGatewayMetrics().find((metric) => metric.operation === "text");
        const text = await generateGeminiText("PRIVATE_PROMPT");
        assert.equal(text, "PRIVATE_GENERATED_CONTENT");
        const metric = readAiGatewayMetrics().find((entry) => entry.operation === "text");
        assert.ok(metric);
        assert.equal(metric.promptTokens - (before?.promptTokens ?? 0), 10);
        assert.equal(metric.totalTokens - (before?.totalTokens ?? 0), 14);
        assert.ok(Math.abs(metric.costUsd - (before?.costUsd ?? 0) - 0.002) < 1e-10);
        assert.ok(metric.latencyMs > (before?.latencyMs ?? 0));
      });
      await fixture((_request, response) => json(response, { error: { message: "PRIVATE_ERROR_RESPONSE direct-provider-key-must-not-be-used" } }, 403), async () => {
        try { await generateGeminiText("PRIVATE_PROMPT"); assert.fail("Expected authorization failure"); } catch (error: unknown) {
          assert.ok(error instanceof HttpError);
          assert.doesNotMatch(JSON.stringify({ message: error.message, details: error.details }), /PRIVATE|provider-key|virtual-key/);
        }
      });
      assert.doesNotMatch(JSON.stringify({ messages, metrics: readAiGatewayMetrics() }), /PRIVATE|provider-key|virtual-key|base64|season/);
    } finally { Object.assign(console, beforeConsole); }
  });

  await suite.test("partial gateway config fails closed and production forbids direct mode", async () => {
    await fixture((_request, response) => json(response, answer), async (requests) => {
      delete process.env.LITELLM_API_KEY;
      assert.equal(isGeminiConfigured(), false);
      await assert.rejects(generateGeminiText("partial"), code("AI_GATEWAY_CONFIG_INVALID"));
      delete process.env.LITELLM_ENDPOINT;
      config.nodeEnv = "production";
      assert.equal(isGeminiConfigured(), false);
      await assert.rejects(generateGeminiText("production direct"), code("AI_GATEWAY_REQUIRED"));
      assert.equal(requests.length, 0);
    });
  });
});
