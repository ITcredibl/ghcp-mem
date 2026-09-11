import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSavedQuerySpanPayload, emitSavedQuery, type SavedQueryEvent } from '../otelBridge';
import type { OtelConfig } from '../types';

const EVENT: SavedQueryEvent = {
  operation: 'search',
  query: 'how do we handle auth',
  tokensSaved: 900,
  rawTokens: 1200,
  compactTokens: 300,
  resultCount: 4,
};

function cfg(overrides: Partial<OtelConfig> = {}): OtelConfig {
  return {
    enabled: true,
    endpoint: 'http://localhost:4318',
    captureContent: false,
    headers: {},
    ...overrides,
  };
}

// Reach into the OTLP JSON structure for a span attribute by key.
function attrs(payload: unknown): Record<string, string> {
  const span = (payload as any).resourceSpans[0].scopeSpans[0].spans[0];
  const out: Record<string, string> = {};
  for (const a of span.attributes) {
    out[a.key] = a.value.stringValue ?? a.value.intValue;
  }
  return out;
}

test('emitSavedQuery — no endpoint means zero network calls', () => {
  let calls = 0;
  const send = async () => {
    calls++;
  };
  emitSavedQuery(EVENT, cfg({ endpoint: '' }), send);
  assert.equal(calls, 0);
});

test('emitSavedQuery — disabled means zero network calls', () => {
  let calls = 0;
  const send = async () => {
    calls++;
  };
  emitSavedQuery(EVENT, cfg({ enabled: false }), send);
  assert.equal(calls, 0);
});

test('emitSavedQuery — enabled + endpoint POSTs to /v1/traces once', async () => {
  const seen: { url: string; body: string; headers: Record<string, string> }[] = [];
  const send = async (url: string, body: string, headers: Record<string, string>) => {
    seen.push({ url, body, headers });
  };
  emitSavedQuery(EVENT, cfg({ headers: { authorization: 'Bearer x' } }), send);
  // emit schedules the send on a resolved promise microtask; let it flush.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'http://localhost:4318/v1/traces');
  assert.equal(seen[0].headers.authorization, 'Bearer x');
  const payload = JSON.parse(seen[0].body);
  const a = attrs(payload);
  assert.equal(a['gen_ai.system'], 'ghcp-mem');
  assert.equal(a['gen_ai.operation.name'], 'search');
});

test('emitSavedQuery — transport rejection never throws', async () => {
  const send = async () => {
    throw new Error('collector down');
  };
  // Must not throw synchronously nor reject the calling turn.
  assert.doesNotThrow(() => emitSavedQuery(EVENT, cfg(), send));
  await Promise.resolve();
  await Promise.resolve();
});

test('buildSavedQuerySpanPayload — gen_ai usage attributes', () => {
  const payload = buildSavedQuerySpanPayload(EVENT, cfg(), {
    nowMs: 1_700_000_000_000,
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    version: '1.13.0',
  });
  const a = attrs(payload);
  assert.equal(a['gen_ai.usage.input_tokens'], '300');
  assert.equal(a['ghcp_mem.usage.raw_input_tokens'], '1200');
  assert.equal(a['ghcp_mem.usage.tokens_saved'], '900');
  assert.equal(a['ghcp_mem.result_count'], '4');

  const span = (payload as any).resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(span.name, 'ghcp_mem.saved_query');
  assert.equal(span.traceId, 'a'.repeat(32));
  assert.equal(span.spanId, 'b'.repeat(16));
  assert.equal(span.startTimeUnixNano, '1700000000000000000');
  assert.equal(span.kind, 1);
  const scope = (payload as any).resourceSpans[0].scopeSpans[0].scope;
  assert.equal(scope.version, '1.13.0');
});

test('buildSavedQuerySpanPayload — captureContent off omits query text', () => {
  const payload = buildSavedQuerySpanPayload(EVENT, cfg({ captureContent: false }));
  assert.equal(attrs(payload)['ghcp_mem.query'], undefined);
});

test('buildSavedQuerySpanPayload — captureContent on redacts secrets in query', () => {
  const secretEvent: SavedQueryEvent = {
    ...EVENT,
    query: 'deploy with token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  };
  const payload = buildSavedQuerySpanPayload(secretEvent, cfg({ captureContent: true }));
  const q = attrs(payload)['ghcp_mem.query'];
  assert.ok(q, 'query attribute present when captureContent is on');
  assert.ok(!q.includes('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'), 'raw secret must be redacted');
});

test('buildSavedQuerySpanPayload — captureContent on honors private tags', () => {
  const privateEvent: SavedQueryEvent = {
    ...EVENT,
    query: 'public part <private>secret internal note</private> tail',
  };
  const payload = buildSavedQuerySpanPayload(privateEvent, cfg({ captureContent: true }));
  const q = attrs(payload)['ghcp_mem.query'];
  assert.ok(!q.includes('secret internal note'), 'private-tagged content must be redacted');
});
