#!/usr/bin/env node
/* eslint-disable no-console */
//
// Published-release verification (v1.22.0, REL-001).
//
// Proves the artifact users actually download is the artifact this source
// tree builds. For a given tag (default: v<package.json version>) it:
//
//   1. asserts the tag exists and points at the current HEAD (parity against
//      a different tree would be meaningless) — override with --skip-head-check
//      for informational runs;
//   2. downloads ghcp-mem.vsix and ghcp-mem.vsix.sha256 from that GitHub
//      Release (via `gh`, falling back to the public download URL);
//   3. checks the vsix against its published sha256;
//   4. asserts the version inside the vsix's extension/package.json equals
//      the tag and the local package.json;
//   5. rebuilds production bundles (skip with --no-build if already built)
//      and runs scripts/check-vsix-parity.mjs against the DOWNLOADED vsix —
//      byte-for-byte runtime-bundle parity with this source;
//   6. reports the live Marketplace version (informational only — the listing
//      lags publication by minutes, so a mismatch here is a warning, not a
//      failure, unless --require-marketplace is passed).
//
// Usage:
//   node scripts/verify-release-artifact.mjs [vX.Y.Z] [--no-build]
//     [--skip-head-check] [--require-marketplace]
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const tag = argv.find((a) => /^v\d+\.\d+\.\d+$/.test(a)) ?? `v${pkg.version}`;
const version = tag.slice(1);
const REPO = 'ITcredibl/ghcp-mem';

const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
const fail = (msg) => {
  console.error(`[release-verify] FAIL: ${msg}`);
  process.exit(1);
};
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

console.log(`[release-verify] verifying ${REPO} ${tag} against this source tree`);

// 1. Tag ↔ HEAD.
const tagSha = run('git', ['rev-parse', `${tag}^{commit}`]);
if (tagSha.status !== 0) fail(`tag ${tag} not found locally — git fetch --tags first`);
const headSha = run('git', ['rev-parse', 'HEAD']).stdout.trim();
if (tagSha.stdout.trim() !== headSha) {
  const msg = `tag ${tag} is ${tagSha.stdout.trim().slice(0, 12)} but HEAD is ${headSha.slice(0, 12)} — check out the tag before verifying`;
  if (flags.has('--skip-head-check')) console.warn(`[release-verify] WARN (skipped): ${msg}`);
  else fail(msg);
}
if (pkg.version !== version && !flags.has('--skip-head-check'))
  fail(`local package.json is ${pkg.version} but verifying ${tag}`);

// 2. Download the published artifact + checksum.
const dir = mkdtempSync(join(tmpdir(), 'ghcp-rel-'));
const dl = run('gh', [
  'release',
  'download',
  tag,
  '--repo',
  REPO,
  '--pattern',
  'ghcp-mem.vsix*',
  '--dir',
  dir,
]);
if (dl.status !== 0) {
  console.warn('[release-verify] gh unavailable — falling back to public download URLs');
  for (const name of ['ghcp-mem.vsix', 'ghcp-mem.vsix.sha256']) {
    const url = `https://github.com/${REPO}/releases/download/${tag}/${name}`;
    const curl = run('curl', ['-fsSL', '-o', join(dir, name), url]);
    if (curl.status !== 0) fail(`could not download ${url}`);
  }
}
const vsixPath = join(dir, 'ghcp-mem.vsix');
const shaPath = join(dir, 'ghcp-mem.vsix.sha256');
if (!existsSync(vsixPath)) fail('release has no ghcp-mem.vsix asset');
console.log(`[release-verify] downloaded release asset to ${vsixPath}`);

// 3. Checksum.
const actual = sha256(readFileSync(vsixPath));
if (existsSync(shaPath)) {
  const published = readFileSync(shaPath, 'utf8').trim().split(/\s+/)[0].toLowerCase();
  if (published !== actual)
    fail(`sha256 mismatch: published ${published.slice(0, 16)}… vs actual ${actual.slice(0, 16)}…`);
  console.log(`[release-verify] sha256 OK (${actual.slice(0, 16)}…)`);
} else {
  console.warn('[release-verify] WARN: release has no .sha256 asset — checksum not verified');
}

// 4. Version inside the artifact.
const inner = run('unzip', ['-p', vsixPath, 'extension/package.json']);
if (inner.status !== 0 || !inner.stdout) fail('could not read extension/package.json from vsix');
const innerVersion = JSON.parse(inner.stdout).version;
if (innerVersion !== version)
  fail(`vsix contains version ${innerVersion}, expected ${version} for ${tag}`);
console.log(`[release-verify] artifact version OK (${innerVersion})`);

// 5. Runtime-bundle parity with this source.
if (!flags.has('--no-build')) {
  console.log('[release-verify] rebuilding production bundles…');
  const build = run('npm', ['run', 'bundle:prod'], { stdio: 'inherit' });
  if (build.status !== 0) fail('bundle:prod failed');
}
const parity = run('node', ['scripts/check-vsix-parity.mjs', vsixPath], { stdio: 'inherit' });
if (parity.status !== 0) fail('runtime-bundle parity check failed');

// 6. Marketplace listing (informational unless --require-marketplace).
const mkt = run('curl', [
  '-fsSL',
  '-X',
  'POST',
  'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery',
  '-H',
  'Content-Type: application/json',
  '-H',
  'Accept: application/json;api-version=3.0-preview.1',
  '-d',
  JSON.stringify({
    filters: [{ criteria: [{ filterType: 7, value: 'itcredibl.ghcp-mem' }] }],
    flags: 0x200, // include latest version only
  }),
]);
let liveVersion = null;
try {
  liveVersion = JSON.parse(mkt.stdout).results?.[0]?.extensions?.[0]?.versions?.[0]?.version;
} catch {
  /* network/API hiccup — stays informational */
}
if (liveVersion === version) {
  console.log(`[release-verify] Marketplace listing OK (${liveVersion})`);
} else {
  const msg = `Marketplace lists ${liveVersion ?? 'unknown'}, expected ${version} (listing lags publication by ~5-15 min)`;
  if (flags.has('--require-marketplace')) fail(msg);
  console.warn(`[release-verify] WARN: ${msg}`);
}

console.log(
  `[release-verify] PASS — the published ${tag} artifact is checksum-valid, version-consistent, and byte-identical to this source's runtime bundles.`,
);
