/**
 * Shared helpers for the Extension Development Host integration suite.
 *
 * These files deliberately do NOT use the `.test.ts` suffix: the unit runner
 * (scripts/run-tests.mjs) discovers `*.test.js` under out-test/ recursively,
 * and these modules import the REAL `vscode` API — they only work inside a
 * live extension host launched by scripts/run-integration-tests.mjs.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export const EXTENSION_ID = 'itcredibl.ghcp-mem';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Close any open notifications. First-run activation awaits the privacy-wizard
 * notification (`maybeShowPrivacyWizard`), so an unattended test host would
 * never finish activating — dismissing stands in for the user closing it.
 */
export async function dismissNotifications(): Promise<void> {
  try {
    await vscode.commands.executeCommand('notifications.clearAll');
  } catch {
    /* command id may change across VS Code versions — polling continues */
  }
}

/**
 * Wait for the extension to activate through its own `onStartupFinished`
 * activation event — the suite never calls `ext.activate()` itself, so a
 * passing wait proves the declared activation path works end to end.
 *
 * Generous default: with storage encryption on, first activation touches the
 * OS keychain (Electron safeStorage), which has been observed to take well
 * over a minute on a cold macOS keychain.
 */
export async function waitForActivation(timeoutMs = 240_000): Promise<vscode.Extension<unknown>> {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext, `extension ${EXTENSION_ID} not found in the test host`);
  const deadline = Date.now() + timeoutMs;
  while (!ext.isActive) {
    if (Date.now() > deadline) {
      throw new Error(`extension did not activate within ${timeoutMs}ms`);
    }
    await dismissNotifications();
    await sleep(250);
  }
  await dismissNotifications();
  return ext;
}

export async function pollUntil<T>(
  fn: () => T | undefined | Promise<T | undefined>,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    }
    await sleep(250);
  }
}

export function workspaceRoot(): vscode.WorkspaceFolder {
  const ws = vscode.workspace.workspaceFolders?.[0];
  assert.ok(ws, 'no workspace folder open in the test host');
  return ws;
}

/**
 * Open a workspace file in a real editor and type an appendix into it, then
 * save. Drives the genuine `onDidChangeTextDocument` capture path.
 */
export async function typeIntoWorkspaceFile(relPath: string, text: string): Promise<void> {
  const uri = vscode.Uri.joinPath(workspaceRoot().uri, ...relPath.split('/'));
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  const end = doc.lineAt(doc.lineCount - 1).range.end;
  const applied = await editor.edit((builder) => builder.insert(end, text));
  assert.ok(applied, `edit was not applied to ${relPath}`);
  await doc.save();
}

/** The disk mirror the extension writes for the standalone MCP server. */
export function mirrorPath(): string {
  return path.join(os.homedir(), '.ghcp-mem', 'sessions.json');
}

export function readMirrorRaw(): string | undefined {
  try {
    return fs.readFileSync(mirrorPath(), 'utf8');
  } catch {
    return undefined;
  }
}

export interface MirrorSession {
  id: string;
  summary: string;
  keyFiles?: string[];
  compressorMode?: string;
}

/** Parse the mirror as a plaintext ContextDatabase; undefined if absent/encrypted. */
export function readMirrorSessions(): MirrorSession[] | undefined {
  const raw = readMirrorRaw();
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as { sessions?: MirrorSession[] };
    return Array.isArray(parsed.sessions) ? parsed.sessions : undefined;
  } catch {
    return undefined;
  }
}

/** Run `ghcpMem.showContext` and return the rendered markdown report. */
export async function showContextReport(): Promise<string> {
  await vscode.commands.executeCommand('ghcpMem.showContext');
  const editor = await pollUntil(
    () => {
      const active = vscode.window.activeTextEditor;
      return active && active.document.getText().includes('GHCP-MEM — Context Report')
        ? active
        : undefined;
    },
    15_000,
    'the ghcpMem.showContext report editor',
  );
  return editor.document.getText();
}
