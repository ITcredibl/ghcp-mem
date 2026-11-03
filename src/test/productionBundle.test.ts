/**
 * Production-bundle regression tests (REL-001: validate activation from the
 * artifact that actually ships).
 *
 * The standalone MCP server shipped broken through v1.22.0: `embeddings.ts`
 * imports `vscode` at module top and was transitively bundled into
 * out/mcpServer.js, so `node out/mcpServer.js` crashed with "Cannot find
 * module 'vscode'" for every real MCP client. The e2e suite masked it by
 * spawning the tsc-compiled server with a NODE_PATH that resolved the mock
 * vscode. These tests build the REAL production bundles and spawn them with
 * NODE_PATH explicitly stripped — the environment a Marketplace install gets.
 */
import { strict as assert } from 'node:assert';
import { before, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(__dirname, '..', '..', '..');

function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== 'NODE_PATH') env[k] = v;
  }
  return { ...env, ...extra };
}

before(() => {
  const build = spawnSync(process.execPath, [join(root, 'esbuild.js'), '--production'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(build.status, 0, `bundle:prod failed: ${build.stderr}`);
});

test('production mcpServer bundle must not reference the vscode module', () => {
  const bundle = readFileSync(join(root, 'out', 'mcpServer.js'), 'utf8');
  assert.ok(
    !bundle.includes('require("vscode")') && !bundle.includes("require('vscode')"),
    'out/mcpServer.js references the vscode module — a pure module imported embeddings.ts ' +
      '(or another vscode-importing module); route pure imports through vectorMath.ts',
  );
});

test('production mcpServer starts under plain node (no NODE_PATH) and answers initialize', () => {
  const store = join(mkdtempSync(join(tmpdir(), 'ghcp-prod-')), 'sessions.json');
  const requests = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'prod-bundle-test', version: '0' },
      },
    },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ];
  const child = spawnSync(process.execPath, [join(root, 'out', 'mcpServer.js')], {
    input: requests.map((r) => JSON.stringify(r)).join('\n') + '\n',
    encoding: 'utf8',
    timeout: 20_000,
    env: cleanEnv({ GHCP_MEM_STORE_PATH: store }),
  });
  assert.equal(child.status, 0, `server exited ${child.status}: ${child.stderr}`);
  const lines = child.stdout.split('\n').filter((l) => l.trim());
  const init = JSON.parse(lines[0]);
  assert.equal(init.id, 1);
  assert.ok(init.result?.serverInfo?.name === 'ghcp-mem', 'initialize must identify the server');
  assert.ok(init.result?.serverInfo?.version, 'initialize must carry a version');
  const tools = JSON.parse(lines[1]);
  assert.ok(Array.isArray(tools.result?.tools) && tools.result.tools.length > 0, 'tools listed');
});

test('production ciSeeder and agentBridge bundles start under plain node', () => {
  for (const bin of ['ciSeeder.js', 'agentBridge.js']) {
    const bundle = readFileSync(join(root, 'out', bin), 'utf8');
    assert.ok(!bundle.includes('require("vscode")'), `${bin} references vscode`);
    const child = spawnSync(process.execPath, [join(root, 'out', bin)], {
      input: '',
      encoding: 'utf8',
      timeout: 20_000,
      env: cleanEnv(),
    });
    // Both exit nonzero on empty stdin by design — the assertion is that they
    // reach their own argument handling instead of dying in module loading.
    const combined = `${child.stdout}\n${child.stderr}`;
    assert.ok(
      !combined.includes("Cannot find module 'vscode'"),
      `${bin} failed to load under plain node: ${combined.slice(0, 300)}`,
    );
  }
});
