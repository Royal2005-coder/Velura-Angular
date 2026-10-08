import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRuntimeRoute } from '../../apps/api/src/ops-runtime.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

function mockReq(method: string, url: string, authHeader?: string): IncomingMessage {
  return {
    method,
    url,
    headers: authHeader ? { authorization: authHeader } : {}
  } as unknown as IncomingMessage;
}

function mockRes(): { res: ServerResponse; getOutput: () => { statusCode: number; headers: Record<string, string>; body: string } } {
  let statusCode = 200;
  const headers: Record<string, string> = {};
  let body = '';
  const res = {
    writeHead(code: number, hdrs: Record<string, string>) {
      statusCode = code;
      Object.assign(headers, hdrs);
    },
    end(chunk?: string) {
      if (chunk) body += chunk;
    }
  } as unknown as ServerResponse;
  return { res, getOutput: () => ({ statusCode, headers, body }) };
}

test('metrics endpoint fails closed when METRICS_SCRAPE_BEARER_TOKEN is unset or empty', async () => {
  const orig = process.env.METRICS_SCRAPE_BEARER_TOKEN;
  delete process.env.METRICS_SCRAPE_BEARER_TOKEN;
  try {
    const { res } = mockRes();
    const req = mockReq('GET', '/metrics', 'Bearer any-token');
    await assert.rejects(
      () => handleRuntimeRoute(req, res, new URL('http://localhost/metrics'), {}),
      { status: 403, code: 'METRICS_ACCESS_DENIED' }
    );
  } finally {
    if (orig !== undefined) process.env.METRICS_SCRAPE_BEARER_TOKEN = orig;
  }
});

test('metrics endpoint rejects anonymous and incorrect bearer tokens', async () => {
  const orig = process.env.METRICS_SCRAPE_BEARER_TOKEN;
  process.env.METRICS_SCRAPE_BEARER_TOKEN = 'secret-metrics-collector-token-12345';
  try {
    const { res: res1 } = mockRes();
    await assert.rejects(
      () => handleRuntimeRoute(mockReq('GET', '/metrics'), res1, new URL('http://localhost/metrics'), {}),
      { status: 403, code: 'METRICS_ACCESS_DENIED' }
    );

    const { res: res2 } = mockRes();
    await assert.rejects(
      () => handleRuntimeRoute(mockReq('GET', '/metrics', 'Bearer wrong-token'), res2, new URL('http://localhost/metrics'), {}),
      { status: 403, code: 'METRICS_ACCESS_DENIED' }
    );
  } finally {
    if (orig !== undefined) process.env.METRICS_SCRAPE_BEARER_TOKEN = orig;
    else delete process.env.METRICS_SCRAPE_BEARER_TOKEN;
  }
});

test('metrics endpoint succeeds with valid bearer token and returns Prometheus text format', async () => {
  const orig = process.env.METRICS_SCRAPE_BEARER_TOKEN;
  process.env.METRICS_SCRAPE_BEARER_TOKEN = 'secret-metrics-collector-token-12345';
  try {
    const { res, getOutput } = mockRes();
    const handled = await handleRuntimeRoute(
      mockReq('GET', '/metrics', 'Bearer secret-metrics-collector-token-12345'),
      res,
      new URL('http://localhost/metrics'),
      {}
    );
    assert.equal(handled, true);
    const out = getOutput();
    assert.equal(out.statusCode, 200);
    assert.match(out.headers['content-type'] || '', /text\/plain/);
    assert.match(out.body, /velura_http_requests_total/);
  } finally {
    if (orig !== undefined) process.env.METRICS_SCRAPE_BEARER_TOKEN = orig;
    else delete process.env.METRICS_SCRAPE_BEARER_TOKEN;
  }
});

test('ready probe endpoint remains accessible without credentials', async () => {
  const { res, getOutput } = mockRes();
  const handled = await handleRuntimeRoute(mockReq('GET', '/ready'), res, new URL('http://localhost/ready'), {});
  assert.equal(handled, true);
  const out = getOutput();
  assert.ok(out.statusCode === 200 || out.statusCode === 503);
  assert.match(out.body, /"checks"/);
});
