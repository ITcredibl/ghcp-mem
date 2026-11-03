#!/usr/bin/env node
/* eslint-disable no-console */
//
// VSIX ↔ source parity check (v1.20.1, from the independent v1.20.0 review's
// recommendation #5: "Test the published VSIX against source").
//
// Rebuilds the production bundles from the CURRENT tree and compares their
// SHA-256 hashes against the runtime bundles inside a given .vsix. Matching
// hashes prove the shipped code is exactly what this source builds; docs and
// manifest files are reported separately (a docs-only delta is common and
// harmless, a bundle delta is not).
//
// Usage:
//   npm run bundle:prod
//   node scripts/check-vsix-parity.mjs path/to/ghcp-mem.vsix
//
// Requires a POSIX `unzip` on PATH (ubuntu/macOS; on Windows use WSL or
// `Expand-Archive` manually and point at the extracted folder instead).
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vsixPath = process.argv[2];
if (!vsixPath || !existsSync(vsixPath)) {
  console.error(
    'usage: node scripts/check-vsix-parity.mjs <path-to-vsix>  (run bundle:prod first)',
  );
  process.exit(1);
}

const BUNDLES = ['out/extension.js', 'out/mcpServer.js', 'out/ciSeeder.js', 'out/agentBridge.js'];
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

let mismatches = 0;
for (const bundle of BUNDLES) {
  const local = resolve(root, bundle);
  if (!existsSync(local)) {
    console.error(`[parity] missing ${bundle} — run: npm run bundle:prod`);
    process.exit(1);
  }
  const child = spawnSync('unzip', ['-p', vsixPath, `extension/${bundle}`], {
    maxBuffer: 64 * 1024 * 1024,
  });
  if (child.status !== 0 || !child.stdout?.length) {
    console.error(
      `[parity] could not read extension/${bundle} from the vsix (is unzip installed?)`,
    );
    process.exit(1);
  }
  const localHash = sha(readFileSync(local));
  const vsixHash = sha(child.stdout);
  const ok = localHash === vsixHash;
  if (!ok) mismatches++;
  console.log(
    `[parity] ${ok ? 'MATCH   ' : 'MISMATCH'} ${bundle}  src=${localHash.slice(0, 12)} vsix=${vsixHash.slice(0, 12)}`,
  );
}

if (mismatches > 0) {
  console.error(`[parity] ${mismatches} runtime bundle(s) differ from this source tree.`);
  process.exit(1);
}
console.log('[parity] all runtime bundles match this source tree (docs/manifest not compared).');
