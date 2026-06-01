import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionCapture, semanticTextSignature } from '../sessionCapture';
import type { SessionEvent } from '../types';

test('semantic signature ignores formatting-only edits', () => {
  const a = 'const x = 1;\n\nconsole.log(x);\n';
  const b = 'const x = 1;  \r\nconsole.log(x);\r\n';
  assert.equal(semanticTextSignature(a), semanticTextSignature(b));
});

test('SessionCapture trims the volatile buffer by bytes', () => {
  const capture = new SessionCapture();
  const payload = 'x'.repeat(1024 * 1024);
  for (let i = 0; i < 8; i++) {
    const event: SessionEvent = {
      timestamp: Date.now() + i,
      type: 'terminal_command',
      data: { command: `${i}:${payload}` },
    };
    capture.pushExistingEvent(event);
  }
  assert.ok(capture.eventCount <= 5, 'volatile buffer should evict old large events');
});
