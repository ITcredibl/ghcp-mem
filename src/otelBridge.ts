// Outbound OpenTelemetry (OTLP/HTTP) export bridge.
//
// GHCP-MEM never opens a port or runs a daemon — the whole extension talks
// over VS Code IPC or stdio. This module keeps that contract: it only *emits*
// telemetry outbound to an OTLP/HTTP collector you already run. There is no
// inbound receiver here and there never should be.
//
// When GHCP-MEM answers a query from local memory (instead of letting the
// model re-expand files into context), it can export a single "saved query"
// span describing how many tokens that avoided. Spans follow the OpenTelemetry
// gen_ai semantic conventions so any Grafana/Tempo/Jaeger backend can chart
// token savings without bespoke parsing.
//
// Everything here is fire-and-forget and failure-silent: telemetry problems
// must never surface to the user or break a chat turn.

import { randomBytes } from 'node:crypto';

import type { OtelConfig } from './types';
import { redact } from './redactor';

/** A single "answered from memory" event worth one OTLP span. */
export interface SavedQueryEvent {
  /** Slash command / path that produced the local answer, e.g. 'search'. */
  operation: string;
  /** Raw user query text. Only exported (redacted) when captureContent is on. */
  query?: string;
  /** Estimated tokens avoided by answering from memory instead of re-expanding. */
  tokensSaved: number;
  /** Raw tokens the equivalent full-context expansion would have cost. */
  rawTokens: number;
  /** Compact tokens actually spent on the memory-backed answer. */
  compactTokens: number;
  /** How many sessions/snippets backed the answer. */
  resultCount: number;
}

/** Minimal transport seam so tests can assert payloads without real network I/O. */
export type OtlpSender = (
  url: string,
  body: string,
  headers: Record<string, string>,
) => Promise<void>;

const SERVICE_NAME = 'ghcp-mem';

/** Resolve the extension version for the OTLP scope, tolerating bundling. */
function resolveVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../package.json').version ?? 'unknown';
  } catch {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require('../../package.json').version ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }
}

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

interface OtlpAttr {
  key: string;
  value: { stringValue: string } | { intValue: string };
}

function strAttr(key: string, value: string): OtlpAttr {
  return { key, value: { stringValue: value } };
}

function intAttr(key: string, value: number): OtlpAttr {
  // OTLP encodes 64-bit ints as strings to survive JSON round-trips.
  return { key, value: { intValue: String(Math.max(0, Math.round(value))) } };
}

/**
 * Build the OTLP/HTTP JSON trace payload for a single saved-query event.
 *
 * Pure and deterministic given `nowMs` + injected IDs, so tests can assert the
 * exact gen_ai attribute shape and confirm redaction is applied.
 */
export function buildSavedQuerySpanPayload(
  event: SavedQueryEvent,
  config: OtelConfig,
  opts: { nowMs?: number; traceId?: string; spanId?: string; version?: string } = {},
): unknown {
  const nowMs = opts.nowMs ?? Date.now();
  const nowNano = String(nowMs * 1_000_000);
  const traceId = opts.traceId ?? hex(16);
  const spanId = opts.spanId ?? hex(8);
  const version = opts.version ?? resolveVersion();

  const attributes: OtlpAttr[] = [
    strAttr('gen_ai.system', SERVICE_NAME),
    strAttr('gen_ai.operation.name', event.operation),
    // Tokens the memory-backed answer actually consumed vs. what a full
    // re-expansion would have cost. Mapped onto gen_ai usage conventions.
    intAttr('gen_ai.usage.input_tokens', event.compactTokens),
    intAttr('ghcp_mem.usage.raw_input_tokens', event.rawTokens),
    intAttr('ghcp_mem.usage.tokens_saved', event.tokensSaved),
    intAttr('ghcp_mem.result_count', event.resultCount),
  ];

  if (config.captureContent && event.query) {
    // Never export raw query text — redact secrets/PII/private-tagged spans
    // before it leaves the machine, exactly like every other capture path.
    const { text } = redact(event.query, {
      redactSecrets: true,
      honorPrivateTags: true,
      detectHighEntropy: true,
    });
    attributes.push(strAttr('ghcp_mem.query', text));
  }

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [strAttr('service.name', SERVICE_NAME)],
        },
        scopeSpans: [
          {
            scope: { name: SERVICE_NAME, version },
            spans: [
              {
                traceId,
                spanId,
                name: 'ghcp_mem.saved_query',
                kind: 1, // SPAN_KIND_INTERNAL
                startTimeUnixNano: nowNano,
                endTimeUnixNano: nowNano,
                attributes,
              },
            ],
          },
        ],
      },
    ],
  };
}

/** Default transport: fire-and-forget POST via global fetch, swallowing errors. */
const defaultSender: OtlpSender = async (url, body, headers) => {
  await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  }).catch(() => undefined);
};

/**
 * Export a saved-query span to the configured OTLP endpoint.
 *
 * No-op (zero network I/O) when disabled or no endpoint is set. Never throws:
 * any failure — config, payload, or transport — is swallowed so telemetry can
 * never break a chat turn.
 *
 * @param send injectable transport, primarily for tests.
 */
export function emitSavedQuery(
  event: SavedQueryEvent,
  config: OtelConfig,
  send: OtlpSender = defaultSender,
): void {
  if (!config.enabled || !config.endpoint) return;
  try {
    const payload = buildSavedQuerySpanPayload(event, config);
    const url = `${config.endpoint}/v1/traces`;
    void Promise.resolve(send(url, JSON.stringify(payload), config.headers)).catch(() => undefined);
  } catch {
    // Telemetry must never surface to the user.
  }
}
