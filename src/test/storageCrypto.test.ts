/**
 * v1.16.0 — storage encryption tests.
 *
 * The envelope is the trust boundary for encryption-at-rest: these tests pin
 * round-trip correctness, tamper evidence, wrong-key behavior, KDF
 * determinism, format detection, and the fail-closed contract of the
 * ContextStore integration (a locked-out store must NEVER clobber data).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encryptEnvelope,
  decryptEnvelope,
  isEncryptedEnvelope,
  parseEnvelopeHeader,
  generateKey,
  generateSalt,
  deriveKeyFromPassphrase,
  serializeDb,
  deserializeDb,
  keysEqual,
} from '../storageCrypto';
import { ContextStore } from '../contextStore';
import { InMemoryMemento } from './__mocks__/vscode';
import { CompressedSession, computeContentHash } from '../types';

const KEY = generateKey();

// ── Envelope round-trip + detection ───────────────────────────────────────

test('encrypt → decrypt round-trips arbitrary JSON', () => {
  const plain = JSON.stringify({ sessions: [{ id: 'a', summary: 'héllo → wörld 🚀' }] });
  const env = encryptEnvelope(plain, KEY, 'os-keychain');
  assert.notEqual(env, plain);
  assert.ok(isEncryptedEnvelope(env), 'envelope must self-identify');
  assert.equal(decryptEnvelope(env, KEY), plain);
});

test('isEncryptedEnvelope: negative on plaintext JSON and prose', () => {
  assert.equal(isEncryptedEnvelope('{"version":2,"sessions":[]}'), false);
  assert.equal(isEncryptedEnvelope('not json at all'), false);
  assert.equal(isEncryptedEnvelope(''), false);
});

test('ciphertext does not contain the plaintext', () => {
  const secretText = 'the-launch-codes-are-0000';
  const env = encryptEnvelope(JSON.stringify({ secretText }), KEY, 'os-keychain');
  assert.ok(!env.includes(secretText));
  assert.ok(!env.includes(Buffer.from(secretText).toString('base64')));
});

test('fresh IV per write — same plaintext encrypts differently', () => {
  const plain = '{"a":1}';
  assert.notEqual(
    encryptEnvelope(plain, KEY, 'os-keychain'),
    encryptEnvelope(plain, KEY, 'os-keychain'),
  );
});

// ── Failure modes ─────────────────────────────────────────────────────────

test('wrong key throws (GCM auth failure), never returns garbage', () => {
  const env = encryptEnvelope('{"a":1}', KEY, 'os-keychain');
  assert.throws(() => decryptEnvelope(env, generateKey()));
});

test('tampered ciphertext throws (auth tag mismatch)', () => {
  const env = encryptEnvelope('{"a":1}', KEY, 'os-keychain');
  const parsed = JSON.parse(env);
  const data = Buffer.from(parsed.data, 'base64');
  data[0] ^= 0xff; // flip one bit
  parsed.data = data.toString('base64');
  assert.throws(() => decryptEnvelope(JSON.stringify(parsed), KEY));
});

test('deserializeDb returns null (never throws) on wrong/missing key', () => {
  const env = encryptEnvelope('{"sessions":[]}', KEY, 'os-keychain');
  assert.equal(deserializeDb(env, generateKey()), null);
  assert.equal(deserializeDb(env, undefined), null);
});

// ── KDF ───────────────────────────────────────────────────────────────────

test('scrypt KDF: deterministic for (passphrase, salt); differs across salts', () => {
  const salt = generateSalt();
  const a = deriveKeyFromPassphrase('correct horse battery staple', salt);
  const b = deriveKeyFromPassphrase('correct horse battery staple', salt);
  const c = deriveKeyFromPassphrase('correct horse battery staple', generateSalt());
  assert.ok(keysEqual(a, b));
  assert.ok(!keysEqual(a, c));
  assert.equal(a.length, 32);
});

test('passphrase mode stores salt in the header for later re-derivation', () => {
  const salt = generateSalt();
  const key = deriveKeyFromPassphrase('pw12345678', salt);
  const env = encryptEnvelope('{"x":1}', key, 'passphrase', salt);
  const header = parseEnvelopeHeader(env);
  assert.equal(header?.mode, 'passphrase');
  assert.equal(header?.salt, salt.toString('hex'));
  const rederived = deriveKeyFromPassphrase('pw12345678', Buffer.from(header!.salt!, 'hex'));
  assert.equal(decryptEnvelope(env, rederived), '{"x":1}');
});

// ── serializeDb dispatch ──────────────────────────────────────────────────

test('serializeDb: plaintext without key, envelope with key', () => {
  const db = { version: 2, sessions: [], lastUpdated: 1 };
  assert.equal(serializeDb(db, undefined, undefined), JSON.stringify(db));
  const enc = serializeDb(db, KEY, 'os-keychain');
  assert.ok(isEncryptedEnvelope(enc));
  assert.deepEqual(deserializeDb(enc, KEY), db);
});

// ── ContextStore integration ──────────────────────────────────────────────

function mkSession(id: string): CompressedSession {
  const summary = `encrypted store session ${id}`;
  return {
    id,
    workspaceId: 'ws',
    workspaceName: 'ws',
    startTime: Date.now() - 1000,
    endTime: Date.now(),
    summary,
    observationType: 'feature',
    keyFiles: ['a.ts'],
    keyTopics: ['crypto'],
    decisions: [],
    problemsSolved: [],
    rawEventCount: 3,
    userTags: [],
    redactionCount: 0,
    contentHash: computeContentHash({
      summary,
      keyFiles: ['a.ts'],
      keyTopics: ['crypto'],
      decisions: [],
      problemsSolved: [],
    }),
  };
}

test('store round-trip: encrypted persist → new store with same key reloads sessions', async () => {
  const memento = new InMemoryMemento();
  const enc = { key: KEY, mode: 'os-keychain' as const };
  const store1 = new ContextStore(memento as never, undefined, enc);
  await store1.addSession(mkSession('enc-1'));

  // globalState must hold an envelope, and the plaintext key must be gone.
  const encBlob = (memento as never as { get(k: string): unknown }).get(
    'ghcpMem.contextDatabase.enc',
  );
  assert.equal(typeof encBlob, 'string');
  assert.ok(isEncryptedEnvelope(encBlob as string));
  assert.equal(
    (memento as never as { get(k: string): unknown }).get('ghcpMem.contextDatabase'),
    undefined,
  );

  const store2 = new ContextStore(memento as never, undefined, enc);
  assert.ok(store2.getAllSessions().some((s) => s.id === 'enc-1'));
  assert.equal(store2.isEncryptionLockedOut, false);
});

test('fail-closed: wrong key locks the store out and persist becomes a no-op', async () => {
  const memento = new InMemoryMemento();
  const store1 = new ContextStore(memento as never, undefined, {
    key: KEY,
    mode: 'os-keychain',
  });
  await store1.addSession(mkSession('protected'));
  const blobBefore = (memento as never as { get(k: string): unknown }).get(
    'ghcpMem.contextDatabase.enc',
  );

  // Open with the WRONG key: empty view, locked out, and writes must not clobber.
  const store2 = new ContextStore(memento as never, undefined, {
    key: generateKey(),
    mode: 'os-keychain',
  });
  assert.equal(store2.getAllSessions().length, 0);
  assert.equal(store2.isEncryptionLockedOut, true);
  await store2.addSession(mkSession('attacker-write'));
  const blobAfter = (memento as never as { get(k: string): unknown }).get(
    'ghcpMem.contextDatabase.enc',
  );
  assert.equal(blobAfter, blobBefore, 'locked-out store must never overwrite encrypted data');

  // Original key still opens the original data.
  const store3 = new ContextStore(memento as never, undefined, {
    key: KEY,
    mode: 'os-keychain',
  });
  assert.ok(store3.getAllSessions().some((s) => s.id === 'protected'));
});

test('migration: plaintext store transparently encrypts on first persist with key', async () => {
  const memento = new InMemoryMemento();
  const plainStore = new ContextStore(memento as never);
  await plainStore.addSession(mkSession('legacy-plain'));
  assert.ok((memento as never as { get(k: string): unknown }).get('ghcpMem.contextDatabase'));

  // Reopen with encryption on: legacy plaintext loads, next persist encrypts.
  const encStore = new ContextStore(memento as never, undefined, {
    key: KEY,
    mode: 'os-keychain',
  });
  assert.ok(encStore.getAllSessions().some((s) => s.id === 'legacy-plain'));
  await encStore.addSession(mkSession('post-migration'));
  assert.equal(
    (memento as never as { get(k: string): unknown }).get('ghcpMem.contextDatabase'),
    undefined,
    'plaintext copy must be removed after encrypted persist',
  );
  assert.ok(
    isEncryptedEnvelope(
      (memento as never as { get(k: string): unknown }).get(
        'ghcpMem.contextDatabase.enc',
      ) as string,
    ),
  );
});

test('parseSerializedDb: reads both plaintext and envelope backups', () => {
  const memento = new InMemoryMemento();
  const enc = { key: KEY, mode: 'os-keychain' as const };
  const store = new ContextStore(memento as never, undefined, enc);
  const db = { version: 2, sessions: [mkSession('b1')], lastUpdated: 1 };
  assert.equal(store.parseSerializedDb(JSON.stringify(db))?.sessions.length, 1);
  const env = serializeDb(db, KEY, 'os-keychain');
  assert.equal(store.parseSerializedDb(env)?.sessions.length, 1);
});
