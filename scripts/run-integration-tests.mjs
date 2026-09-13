#!/usr/bin/env node
/**
 * Extension Development Host integration runner (@vscode/test-electron).
 *
 * Complements the unit suite (which runs against src/test/__mocks__/vscode.ts
 * and never needs a VS Code instance) with a handful of end-to-end checks in
 * a REAL extension host: activation on onStartupFinished, live
 * onDidChangeTextDocument capture → persistence, generated-file hygiene, the
 * LM-unavailable fallback path, and the storage-encryption round-trip.
 *
 * Two phases, each a separate VS Code launch:
 *   plain      fresh profile, default settings
 *   encrypted  fresh profile, ghcpMem.storageEncryption=os-keychain
 * (No cross-process reload phase: extension tests run in a transient VS Code
 * profile whose storage is in-memory, so globalState/SecretStorage can never
 * survive a relaunch. The decrypt round-trip is asserted in-process via the
 * extension's GhcpMemDiagnostics export instead.)
 *
 * Isolation: every phase gets a throwaway --user-data-dir/--extensions-dir,
 * and $HOME/%USERPROFILE% is pointed at a sandbox so the extension's
 * ~/.ghcp-mem/sessions.json mirror never touches the developer's real store.
 *
 * Skips (exit 0) on Linux without a display — CI wraps it in `xvfb-run -a`.
 * Downloads VS Code stable into .vscode-test/ on first run (gitignored).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  console.log('[itest] SKIPPED: no display available — run under `xvfb-run -a` on headless Linux.');
  process.exit(0);
}

const extensionMain = join(repoRoot, 'out', 'extension.js');
const extensionTestsPath = join(repoRoot, 'out-test', 'src', 'test', 'integration', 'runner.js');
for (const [file, fix] of [
  [extensionMain, 'npm run compile'],
  [extensionTestsPath, 'tsc -p ./tsconfig.test.json'],
]) {
  if (!existsSync(file)) {
    console.error(
      `[itest] missing ${file} — run \`${fix}\` first (npm run test:integration does).`,
    );
    process.exit(1);
  }
}

// Deliberately terse directory names: VS Code creates a Unix socket inside
// --user-data-dir, and macOS caps socket paths at 103 chars ("IPC handle …
// is longer than 103 chars" → listen EINVAL). tmpdir() alone is ~50 chars
// on macOS, so every extra path segment counts.
const sandboxRoot = mkdtempSync(join(tmpdir(), 'gm-'));

/** Create home/user-data/extensions/workspace dirs for one isolated profile. */
function makeProfile(name) {
  const base = join(sandboxRoot, name);
  const dirs = {
    home: join(base, 'h'),
    userData: join(base, 'ud'),
    extensions: join(base, 'x'),
    workspace: join(base, 'w'),
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  return dirs;
}

function seedWorkspace(workspace, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(workspace, ...rel.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

function launchArgs(profile) {
  return [
    profile.workspace,
    `--user-data-dir=${profile.userData}`,
    `--extensions-dir=${profile.extensions}`,
    '--disable-extensions', // only the development extension loads
    '--disable-workspace-trust',
    '--disable-updates',
    '--disable-crash-reporter',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-gpu',
    // Deterministic SecretStorage on keyring-less Linux CI: secrets persist
    // across the encrypt-write → encrypt-reload restart.
    ...(process.platform === 'linux' ? ['--password-store=basic'] : []),
  ];
}

const plain = makeProfile('p');
seedWorkspace(plain.workspace, {
  'seed0.ts': 'export const seed0 = 0;\n',
  'seed1.ts': 'export const seed1 = 1;\n',
  'seed2.ts': 'export const seed2 = 2;\n',
});

const encrypted = makeProfile('e');
seedWorkspace(encrypted.workspace, {
  'itest-encrypt-marker.ts': 'export const marker = true;\n',
  'seed1.ts': 'export const seed1 = 1;\n',
  'seed2.ts': 'export const seed2 = 2;\n',
  '.vscode/settings.json': JSON.stringify({ 'ghcpMem.storageEncryption': 'os-keychain' }, null, 2),
});

// GHCP_MEM_ITEST_PHASES (comma-separated) narrows the run for debugging.
const only = process.env.GHCP_MEM_ITEST_PHASES?.split(',').map((s) => s.trim());
const phases = [
  { phase: 'plain', profile: plain },
  { phase: 'encrypted', profile: encrypted },
].filter((p) => !only || only.includes(p.phase));

let failed = false;
try {
  for (const { phase, profile } of phases) {
    console.log(`\n[itest] ── phase: ${phase} ─────────────────────────────`);
    try {
      const exitCode = await runTests({
        version: 'stable',
        extensionDevelopmentPath: repoRoot,
        extensionTestsPath,
        launchArgs: launchArgs(profile),
        extensionTestsEnv: {
          GHCP_MEM_ITEST_PHASE: phase,
          HOME: profile.home,
          USERPROFILE: profile.home,
        },
      });
      if (exitCode !== 0) throw new Error(`exit code ${exitCode}`);
    } catch (err) {
      console.error(`[itest] phase "${phase}" FAILED: ${err instanceof Error ? err.message : err}`);
      failed = true;
      break; // later phases depend on earlier state — no point continuing
    }
  }
} finally {
  if (process.env.GHCP_MEM_ITEST_KEEP === '1') {
    console.log(`[itest] keeping sandbox for inspection: ${sandboxRoot}`);
  } else {
    rmSync(sandboxRoot, { recursive: true, force: true });
  }
}

if (failed) process.exit(1);
console.log('\n[itest] all phases passed');
