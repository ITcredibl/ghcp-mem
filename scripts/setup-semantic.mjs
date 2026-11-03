#!/usr/bin/env node
/* eslint-disable no-console */
//
// Semantic-retrieval setup for MCP-only / headless users (v1.23.0, RET-001).
// Downloads the pinned local model + WASM runtime (~35 MB, every file
// verified against SHA-256 checksums pinned in src/neuralEmbedder.ts) into
// the shared semantic directory, then loads it once to prove it works.
// The VS Code extension offers the same via "GHCP-MEM: Set Up Semantic
// Retrieval". Remove the directory to disable; set GHCP_MEM_SEMANTIC=off to
// disable without removing.
//
// Usage:  npm run bundle? not needed —  node scripts/setup-semantic.mjs
//   (requires a prior `tsc -p ./tsconfig.test.json` in a dev checkout; the
//    published extension carries the compiled module in its bundle.)
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(import.meta.url);
const neural = req(resolve(root, 'out-test', 'src', 'neuralEmbedder.js'));

const providerKey = process.argv.includes('--provider')
  ? process.argv[process.argv.indexOf('--provider') + 1]
  : undefined;
const spec = providerKey
  ? neural.SEMANTIC_PROVIDERS.find((s) => s.key === providerKey)
  : neural.recommendedProvider();
if (!spec) {
  console.error(
    `unknown provider ${providerKey}; available: ${neural.SEMANTIC_PROVIDERS.map((s) => s.key).join(', ')}`,
  );
  process.exit(1);
}
const dir = neural.providerDir(spec);
console.log(`[semantic-setup] provider: ${spec.key} → ${dir}`);
console.log(
  `[semantic-setup] downloading ${(neural.providerTotalBytes(spec) / 1e6).toFixed(1)} MB (checksum-pinned)…`,
);
await neural.downloadNeuralAssets(spec, (msg, done, total) =>
  console.log(`  ${msg} [${Math.round((done / total) * 100)}%]`),
);
const embedder = await neural.NeuralEmbedder.load(spec, dir);
const probe = await embedder.embed('semantic setup self-test');
if (probe.length !== embedder.dims) throw new Error('self-test failed');
console.log(`[semantic-setup] ready — provider ${embedder.providerId}`);
