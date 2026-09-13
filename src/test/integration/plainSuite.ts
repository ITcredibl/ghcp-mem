/**
 * Default-settings phase: activation, real capture → persistence, generated-file
 * hygiene, and the LM-unavailable fallback path. Runs against a throwaway
 * workspace and a sandboxed $HOME (see scripts/run-integration-tests.mjs).
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Harness } from './runner';
import type { GhcpMemDiagnostics } from '../../extension';
import {
  pollUntil,
  readMirrorSessions,
  showContextReport,
  sleep,
  typeIntoWorkspaceFile,
  waitForActivation,
  workspaceRoot,
} from './helpers';

const INSTRUCTIONS_REL = '.github/instructions/session-memory.instructions.md';

export function registerPlainSuite(t: Harness): void {
  t.test('activates on onStartupFinished without errors', async () => {
    const ext = await waitForActivation();
    assert.strictEqual(ext.isActive, true);
    const commands = await vscode.commands.getCommands(true);
    for (const id of ['ghcpMem.captureSnapshot', 'ghcpMem.showContext', 'ghcpMem.clearMemory']) {
      assert.ok(commands.includes(id), `command ${id} was not registered during activation`);
    }
  });

  t.test('real onDidChangeTextDocument capture persists a session', async () => {
    await waitForActivation();
    // Three files → three file_edit events, comfortably above the
    // quality-floor drop gate for fallback-compressed sessions.
    for (let i = 0; i < 3; i++) {
      await typeIntoWorkspaceFile(
        `seed${i}.ts`,
        `\nexport function integrationAdded${i}(): number {\n  return ${i};\n}\n`,
      );
    }
    await vscode.commands.executeCommand('ghcpMem.captureSnapshot');
    const sessions = await pollUntil(
      () => {
        const all = readMirrorSessions();
        return all && all.length > 0 ? all : undefined;
      },
      30_000,
      'a persisted session in the ~/.ghcp-mem/sessions.json mirror',
    );
    const hit = sessions.find((s) => s.keyFiles?.some((f) => f.includes('seed0.ts')));
    assert.ok(
      hit,
      `no persisted session references seed0.ts — got keyFiles: ${JSON.stringify(
        sessions.map((s) => s.keyFiles),
      )}`,
    );
    // And the canonical persistence target — globalState — holds it too.
    const ext = await waitForActivation();
    const api = ext.exports as GhcpMemDiagnostics | undefined;
    assert.ok(api?.verifyPersistedStore, 'activate() did not export GhcpMemDiagnostics');
    const persisted = await api.verifyPersistedStore();
    assert.strictEqual(persisted.encrypted, false);
    assert.ok(
      typeof persisted.persistedSessionCount === 'number' && persisted.persistedSessionCount >= 1,
      `globalState holds no parsable session db: ${JSON.stringify(persisted)}`,
    );
  });

  t.test('generated instructions file is written and git-ignored', async () => {
    const wsPath = workspaceRoot().uri.fsPath;
    const insPath = path.join(wsPath, ...INSTRUCTIONS_REL.split('/'));
    await pollUntil(
      () => (fs.existsSync(insPath) ? true : undefined),
      20_000,
      `${INSTRUCTIONS_REL} to be written after compression`,
    );
    const content = fs.readFileSync(insPath, 'utf8');
    assert.ok(content.includes('GHCP-MEM'), 'instructions file should identify its generator');
    // ensureGitIgnored runs just after the instructions write — poll rather
    // than racing it.
    await pollUntil(
      () => {
        try {
          const gitignore = fs.readFileSync(path.join(wsPath, '.gitignore'), 'utf8');
          return gitignore.split('\n').some((line) => line.trim() === INSTRUCTIONS_REL)
            ? true
            : undefined;
        } catch {
          return undefined;
        }
      },
      15_000,
      `.gitignore to gain the ${INSTRUCTIONS_REL} entry`,
    );
  });

  t.test('generated instructions file is excluded from capture', async () => {
    const before = readMirrorSessions()?.length ?? 0;
    await typeIntoWorkspaceFile(INSTRUCTIONS_REL, '\n<!-- itest-must-not-be-captured -->\n');
    await vscode.commands.executeCommand('ghcpMem.captureSnapshot');
    // Give the (400ms-debounced) disk mirror time to flush if a session
    // slipped through — absence of change is the expected outcome.
    await sleep(3_000);
    const sessions = readMirrorSessions() ?? [];
    assert.strictEqual(
      sessions.length,
      before,
      'editing the generated memory file must not produce a new session',
    );
    for (const s of sessions) {
      assert.ok(
        !s.keyFiles?.some((f) => f.includes('session-memory.instructions.md')),
        `GENERATED_MEMORY_FILES exclusion breached: ${JSON.stringify(s.keyFiles)}`,
      );
    }
  });

  t.test('LM unavailable → fallbackCompress path, extension stays functional', async () => {
    let models: readonly vscode.LanguageModelChat[] = [];
    try {
      models = await vscode.lm.selectChatModels();
    } catch {
      /* no LM provider registered at all — same premise */
    }
    assert.strictEqual(
      models.length,
      0,
      'test host unexpectedly has chat models — fallback premise broken',
    );
    const sessions = readMirrorSessions() ?? [];
    const ours = sessions.find((s) => s.keyFiles?.some((f) => f.includes('seed0.ts')));
    assert.ok(ours, 'expected the session persisted earlier in this phase');
    assert.strictEqual(ours.compressorMode, 'fallback');
    const report = await showContextReport();
    assert.ok(report.includes('(fallback)'), 'context report should surface the fallback mode');
    assert.ok(report.includes('seed0.ts'), 'context report should list the captured key files');
  });
}
