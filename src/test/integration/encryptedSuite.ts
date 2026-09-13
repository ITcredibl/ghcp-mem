/**
 * Storage-encryption phase. The workspace pre-sets
 * `ghcpMem.storageEncryption: "os-keychain"` in .vscode/settings.json, so
 * activation generates an AES-256-GCM key in VS Code SecretStorage.
 *
 * Round-trip coverage note: extension tests run in a transient VS Code
 * profile whose storage lives in memory (no state.vscdb is ever written), so
 * a cross-PROCESS restart cannot observe the previous run's globalState —
 * that's a platform property of `--extensionTestsPath`, not of this
 * extension. The round-trip is instead proven in-process through the
 * GhcpMemDiagnostics API: `verifyPersistedStore()` re-reads the persisted
 * ciphertext payload and decrypts it with the SecretStorage-held key.
 */
import * as assert from 'assert';
import * as vscode from 'vscode';
import type { Harness } from './runner';
import type { GhcpMemDiagnostics } from '../../extension';
// Compiled alongside this suite by tsconfig.test.json; pure Node, no vscode.
import { deserializeDb, parseEnvelopeHeader } from '../../storageCrypto';
import {
  pollUntil,
  readMirrorRaw,
  showContextReport,
  sleep,
  typeIntoWorkspaceFile,
  waitForActivation,
} from './helpers';

const ENVELOPE_PREFIX = '{"kind":"ghcp-mem-encrypted"';
const MARKER_FILE = 'itest-encrypt-marker.ts';

export function registerEncryptedSuite(t: Harness): void {
  t.test('activates with ghcpMem.storageEncryption=os-keychain', async () => {
    await waitForActivation();
    const mode = vscode.workspace.getConfiguration('ghcpMem').get<string>('storageEncryption');
    assert.strictEqual(mode, 'os-keychain');
  });

  t.test('captured session is persisted encrypted at rest', async () => {
    await waitForActivation();
    const seeds = [MARKER_FILE, 'seed1.ts', 'seed2.ts'];
    for (let i = 0; i < seeds.length; i++) {
      await typeIntoWorkspaceFile(
        seeds[i],
        `\nexport function encryptedAdded${i}(): number {\n  return ${i};\n}\n`,
      );
    }
    await vscode.commands.executeCommand('ghcpMem.captureSnapshot');
    await pollUntil(
      () => readMirrorRaw(),
      30_000,
      'the ~/.ghcp-mem/sessions.json mirror to be written',
    );
    // Let the debounced mirror settle on the post-snapshot content.
    await sleep(2_000);
    const raw = readMirrorRaw();
    assert.ok(raw, 'mirror file disappeared');
    assert.ok(
      raw.startsWith(ENVELOPE_PREFIX),
      `mirror is not an encryption envelope: ${raw.slice(0, 60)}…`,
    );
    assert.ok(
      !raw.includes(MARKER_FILE),
      'plaintext session data leaked into the encrypted mirror',
    );
    // The live store must still serve the session (decrypted in memory).
    const report = await showContextReport();
    assert.ok(report.includes(MARKER_FILE), 'live store lost the captured session');
  });

  t.test('persisted ciphertext decrypts with the SecretStorage key (round-trip)', async () => {
    const ext = await waitForActivation();
    const api = ext.exports as GhcpMemDiagnostics | undefined;
    assert.ok(api?.verifyPersistedStore, 'activate() did not export GhcpMemDiagnostics');
    const result = await api.verifyPersistedStore();
    assert.strictEqual(result.encrypted, true, 'persisted store should be the encrypted payload');
    assert.strictEqual(result.mode, 'os-keychain');
    assert.ok(
      typeof result.persistedSessionCount === 'number' && result.persistedSessionCount >= 1,
      `decryption of the persisted payload failed or store empty: ${JSON.stringify(result)}`,
    );
  });

  t.test('envelope is well-formed and fails closed on a wrong key', async () => {
    const raw = readMirrorRaw();
    assert.ok(raw, 'mirror file missing');
    const header = parseEnvelopeHeader(raw);
    assert.ok(header, 'mirror envelope header did not parse');
    assert.strictEqual(header.mode, 'os-keychain');
    const wrongKey = Buffer.alloc(32, 7);
    assert.strictEqual(
      deserializeDb(raw, wrongKey),
      null,
      'a wrong key must never yield plaintext',
    );
  });
}
