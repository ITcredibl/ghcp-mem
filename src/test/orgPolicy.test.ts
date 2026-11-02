import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultPolicy, evaluateRead, evaluateWrite, parsePolicy } from '../orgPolicy';

test('orgPolicy: default policy allows everything (pre-1.20 behavior)', () => {
  const policy = defaultPolicy();
  assert.ok(evaluateWrite(policy, {}).allowed);
  assert.ok(evaluateWrite(policy, { scopeLevel: 'organization' }).allowed);
  assert.ok(evaluateRead(policy, {}, undefined).allowed);
});

test('orgPolicy: parse validates shape, version, levels and kinds', () => {
  const policy = parsePolicy(
    JSON.stringify({
      version: 1,
      scopes: { organization: { write: ['human'], read: 'all' } },
    }),
  );
  assert.deepEqual(policy.scopes.organization?.write, ['human']);
  assert.throws(() => parsePolicy('[]'), /JSON object/);
  assert.throws(() => parsePolicy('{"version":2,"scopes":{}}'), /version/);
  assert.throws(() => parsePolicy('{"version":1,"scopes":{"galaxy":{}}}'), /Unknown scope level/);
  assert.throws(
    () => parsePolicy('{"version":1,"scopes":{"team":{"write":["gpt"]}}}'),
    /unknown author kind/,
  );
  assert.throws(() => parsePolicy('{"x":1}'.padEnd(70000, ' ')), /64 KiB/);
});

test('orgPolicy: restricted scope denies wrong kinds and unattributed writers', () => {
  const policy = parsePolicy(
    JSON.stringify({
      version: 1,
      scopes: { organization: { write: ['human'], read: 'all' } },
    }),
  );
  assert.ok(evaluateWrite(policy, { scopeLevel: 'organization', author: 'human:seyi' }).allowed);
  const deniedKind = evaluateWrite(policy, {
    scopeLevel: 'organization',
    author: 'claude:reviewer',
  });
  assert.equal(deniedKind.allowed, false);
  assert.match(deniedKind.reason, /denies claude/);
  const deniedAnon = evaluateWrite(policy, { scopeLevel: 'organization' });
  assert.equal(deniedAnon.allowed, false);
  assert.match(deniedAnon.reason, /requires an attributed author/);
});

test('orgPolicy: unstamped memories are governed by the repository rule', () => {
  const policy = parsePolicy(
    JSON.stringify({ version: 1, scopes: { repository: { write: ['human'], read: 'all' } } }),
  );
  assert.equal(evaluateWrite(policy, { author: 'agent:bot' }).allowed, false);
  assert.ok(evaluateWrite(policy, { author: 'human:seyi' }).allowed);
});

test('orgPolicy: read rules gate by accessor author kind', () => {
  const policy = parsePolicy(
    JSON.stringify({ version: 1, scopes: { team: { write: 'all', read: ['human', 'claude'] } } }),
  );
  assert.ok(evaluateRead(policy, { scopeLevel: 'team' }, 'claude:reviewer').allowed);
  assert.equal(evaluateRead(policy, { scopeLevel: 'team' }, 'cursor:impl').allowed, false);
});
