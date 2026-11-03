/**
 * Local neural embedding providers (v1.23.0 RET-001/RET-002, provider packs
 * v1.24.0) — pure module, NO vscode import, usable by the extension host, the
 * standalone MCP server, and the eval harness alike.
 *
 * Design constraints, in order:
 *  1. Zero native dependencies — inference runs on onnxruntime-web's WASM
 *     backend (single-threaded), never onnxruntime-node/sharp.
 *  2. Nothing ships in the VSIX and nothing downloads implicitly. Semantic
 *     retrieval is OFF until the user explicitly runs setup, which downloads
 *     the chosen provider pack (size disclosed up front) into
 *     `~/.ghcp-mem/semantic/<provider>/`: the ONNX runtime (pinned npm
 *     artifacts) and the model + vocab (pinned Hugging Face revision). Every
 *     file is verified against a SHA-256 pinned IN THIS SOURCE before it is
 *     kept, and re-verified at load time, so the CDNs are
 *     untrusted-but-verified transport, not a trust root.
 *  3. Provider identity, model, dimensions, pooling and preprocessing version
 *     form one canonical id persisted with every cached vector; vectors from
 *     a different id or stale content hash are never compared (RET-002).
 *
 * A provider pack also carries its own calibration thresholds: cosine scales
 * are not comparable across models (MiniLM's hardest dev negative peaks at
 * 0.48; bge-small's at ~0.66), so thresholds travel with the provider and are
 * tuned on the DEV set only (scripts/tune-semantic.mjs), validated once on
 * the frozen set.
 *
 * Tokenizer: hand-rolled BERT WordPiece (uncased, NFD accent strip, greedy
 * longest-match) — both shipped models use the standard BERT uncased vocab.
 */
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const MAX_TOKENS = 256;

export interface NeuralAsset {
  /** Path relative to the provider dir where the artifact is stored. */
  file: string;
  url: string;
  sha256: string;
  bytes: number;
  /** npm tarballs are extracted (package/* → `extractTo`) after verification. */
  extractTo?: string;
}

export interface SemanticThresholds {
  candidate: number;
  weak: number;
  match: number;
}

export interface SemanticProviderSpec {
  /** Directory name under the semantic root; also the human-facing key. */
  key: string;
  /** Canonical id: runtime@version / model / preprocessing # dims. */
  providerId: string;
  dims: number;
  pooling: 'mean' | 'cls';
  /** Prepended to QUERIES only (asymmetric retrieval models such as bge). */
  queryPrefix?: string;
  /**
   * Dev-tuned calibration floors for THIS provider's cosine scale (see module
   * header). match = lowest floor at which no labeled dev negative serves.
   */
  thresholds: SemanticThresholds;
  /** Model + vocab artifacts (the WASM runtime assets are shared). */
  modelAssets: NeuralAsset[];
}

/**
 * Shared WASM runtime artifacts — identical for every provider. Checksums
 * computed from the npm-registry artifacts of onnxruntime-web@1.23.0 on
 * 2026-11-03.
 */
export const RUNTIME_ASSETS: NeuralAsset[] = [
  {
    file: 'node_modules/onnxruntime-web/dist/ort.node.min.js',
    url: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.23.0/dist/ort.node.min.js',
    sha256: '1c1d6c5b4834a7b4e058b55378009a34c4e0a1407e2babdefee2dc0f24fce526',
    bytes: 26890,
  },
  {
    file: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs',
    url: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.23.0/dist/ort-wasm-simd-threaded.mjs',
    sha256: 'c0bc2244e2c95fbf39a5eccb595bca31defb9eefdffa6f9ce0325a1c47524461',
    bytes: 20321,
  },
  {
    file: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
    url: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.23.0/dist/ort-wasm-simd-threaded.wasm',
    sha256: '3260fcdb33b4fc4ec33e89caf392e13625823e01049d3bf32c38464f9dbfe14c',
    bytes: 11815498,
  },
  {
    // ort.node.min.js has a bare require("onnxruntime-common"); the pinned
    // npm tarball (one artifact, one hash) is extracted next to it so Node
    // resolution finds it — no package manager involved.
    file: 'onnxruntime-common-1.23.0.tgz',
    url: 'https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-1.23.0.tgz',
    sha256: '19ca20843087ad898c5542bb27d5c81b81f6411d2eb7fa476267726513c19698',
    bytes: 65554,
    extractTo: 'node_modules/onnxruntime-common',
  },
];

/**
 * Provider registry, priority order: the FIRST provider whose assets are
 * installed becomes active. bge-small-en-v1.5 is the recommended pack (its
 * relevant/negative similarity separation is far wider than MiniLM's on the
 * dev set — median relevant 0.706 vs 95th-pct negative 0.658, where MiniLM's
 * median relevant sits level with its 95th-pct negative); the MiniLM pack
 * remains fully supported for v1.23.0 installs.
 */
export const SEMANTIC_PROVIDERS: SemanticProviderSpec[] = [
  {
    key: 'bge-small-en-v1.5-q8',
    providerId: 'onnx-wasm@1.23.0/bge-small-en-v1.5-q8/wordpiece-uncased-cls-l2.v1#384',
    dims: 384,
    pooling: 'cls',
    queryPrefix: 'Represent this sentence for searching relevant passages: ',
    // Dev-tuned 2026-11-03 (tune-semantic.mjs full-pipeline sweep): 0.665 is
    // the lowest match floor serving ZERO dev negatives semantically; 0.65
    // doubles the false-positive rate (11.5%) for +3pp recall — rejected.
    // At these floors: dev recall@5 0.851, paraphrase 70%, FP 3.8% (one
    // lexical negative, "django orm n+1 queries" → React Query at 0.614
    // cosine — genuinely adjacent, no honest veto floor removes it without
    // cutting into the relevant range, which starts at p25 0.644).
    thresholds: { candidate: 0.6, weak: 0.6, match: 0.665 },
    modelAssets: [
      {
        file: 'model_quantized.onnx',
        url: 'https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/onnx/model_quantized.onnx',
        sha256: '6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4',
        bytes: 34014426,
      },
      {
        file: 'vocab.txt',
        url: 'https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/vocab.txt',
        sha256: '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3',
        bytes: 231508,
      },
    ],
  },
  {
    key: 'minilm-l6-v2-q8',
    providerId: 'onnx-wasm@1.23.0/all-MiniLM-L6-v2-q8/wordpiece-uncased-mean-l2.v1#384',
    dims: 384,
    pooling: 'mean',
    // Dev-tuned 2026-11-03: 0.5 is the lowest match floor serving zero
    // labeled negatives (hardest negative 0.48 cosine).
    thresholds: { candidate: 0.3, weak: 0.3, match: 0.5 },
    modelAssets: [
      {
        file: 'model_quantized.onnx',
        url: 'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/onnx/model_quantized.onnx',
        sha256: 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1',
        bytes: 22972370,
      },
      {
        file: 'vocab.txt',
        url: 'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/vocab.txt',
        sha256: '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3',
        bytes: 231508,
      },
    ],
  },
];

/** The pack the setup command installs by default. */
export function recommendedProvider(): SemanticProviderSpec {
  return SEMANTIC_PROVIDERS[0];
}

export function providerAssets(spec: SemanticProviderSpec): NeuralAsset[] {
  return [...RUNTIME_ASSETS, ...spec.modelAssets];
}

export function providerTotalBytes(spec: SemanticProviderSpec): number {
  return providerAssets(spec).reduce((s, a) => s + a.bytes, 0);
}

// Back-compat aliases (v1.23.0 public names; the MiniLM pack).
export const NEURAL_PROVIDER_ID = SEMANTIC_PROVIDERS[1].providerId;
export const NEURAL_DIMS = 384;
export const NEURAL_TOTAL_BYTES = providerTotalBytes(recommendedProvider());

function semanticRoot(): string {
  return path.join(os.homedir(), '.ghcp-mem', 'semantic');
}

/** Asset directory for a provider (env override applies to the ACTIVE dir). */
export function providerDir(spec: SemanticProviderSpec): string {
  return process.env.GHCP_MEM_SEMANTIC_DIR ?? path.join(semanticRoot(), spec.key);
}

/** v1.23.0 name, kept for callers that want "the active provider's dir". */
export function defaultSemanticDir(): string {
  const active = activeProvider();
  return active ? active.dir : providerDir(recommendedProvider());
}

/** Semantic mode is explicitly disabled via env (both entry points honor it). */
export function semanticDisabledByEnv(): boolean {
  const v = (process.env.GHCP_MEM_SEMANTIC ?? '').toLowerCase();
  return v === 'off' || v === '0' || v === 'false';
}

const sha256File = (p: string): string =>
  createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function assetsValid(spec: SemanticProviderSpec, dir: string): boolean {
  try {
    return providerAssets(spec).every((a) => {
      const p = path.join(dir, a.file);
      return fs.existsSync(p) && sha256File(p) === a.sha256;
    });
  } catch {
    return false;
  }
}

/**
 * Resolve the active provider: GHCP_MEM_SEMANTIC_PROVIDER pins one by key;
 * otherwise the first registry entry with valid installed assets wins.
 * Returns undefined when nothing is installed (lexical-only operation).
 */
export function activeProvider(): { spec: SemanticProviderSpec; dir: string } | undefined {
  const pinned = process.env.GHCP_MEM_SEMANTIC_PROVIDER;
  const candidates = pinned
    ? SEMANTIC_PROVIDERS.filter((s) => s.key === pinned)
    : SEMANTIC_PROVIDERS;
  for (const spec of candidates) {
    const dir = providerDir(spec);
    if (assetsValid(spec, dir)) return { spec, dir };
  }
  return undefined;
}

/** True when ANY provider pack is installed and hash-valid. */
export function neuralAssetsPresent(): boolean {
  return !!activeProvider();
}

/**
 * Minimal ustar extractor for VERIFIED npm tarballs — regular files only
 * (symlinks/devices are skipped), `package/` prefix stripped, path-traversal
 * guarded. ~40 lines beats a tar dependency for exactly one known artifact.
 */
function extractNpmTarball(tgz: Buffer, destDir: string): void {
  const tar = gunzipSync(tgz);
  let off = 0;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    off += 512;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    if (!name) break; // end-of-archive zero blocks
    const size = parseInt(header.subarray(124, 136).toString('utf8').trim(), 8) || 0;
    const type = String.fromCharCode(header[156]);
    const body = tar.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
    if (type !== '0' && type !== '\0') continue; // regular files only
    const rel = name.replace(/^package\//, '');
    if (!rel || rel.includes('..')) continue;
    const dest = path.join(destDir, rel);
    if (!path.resolve(dest).startsWith(path.resolve(destDir) + path.sep)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body);
  }
}

/** Extract a verified tarball asset if its package main is not in place yet. */
function ensureExtracted(dir: string, asset: NeuralAsset): void {
  if (!asset.extractTo) return;
  const destDir = path.join(dir, asset.extractTo);
  if (fs.existsSync(path.join(destDir, 'package.json'))) return;
  extractNpmTarball(fs.readFileSync(path.join(dir, asset.file)), destDir);
}

/** The local (generated, not downloaded) manifest Node resolution needs. */
function writeLocalPackageJsons(dir: string): void {
  const webDir = path.join(dir, 'node_modules', 'onnxruntime-web');
  fs.mkdirSync(webDir, { recursive: true });
  fs.writeFileSync(
    path.join(webDir, 'package.json'),
    JSON.stringify({ name: 'onnxruntime-web', version: '1.23.0', main: 'dist/ort.node.min.js' }) +
      '\n',
  );
}

/**
 * Download a provider pack into its directory. Explicit-invocation only —
 * called by the extension's setup command and scripts/setup-semantic.mjs,
 * never on activation. Each file is fetched, hash-verified against the
 * in-source pin, and atomically renamed into place; a hash mismatch deletes
 * the download and throws. Re-running skips files already present and valid.
 */
export async function downloadNeuralAssets(
  spec: SemanticProviderSpec = recommendedProvider(),
  onProgress?: (msg: string, doneBytes: number, totalBytes: number) => void,
  dir: string = providerDir(spec),
): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  const assets = providerAssets(spec);
  const total = providerTotalBytes(spec);
  let done = 0;
  for (const asset of assets) {
    const dest = path.join(dir, asset.file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest) && sha256File(dest) === asset.sha256) {
      done += asset.bytes;
      onProgress?.(`${asset.file} already present`, done, total);
      continue;
    }
    onProgress?.(`downloading ${asset.file}…`, done, total);
    const res = await fetch(asset.url);
    if (!res.ok) throw new Error(`${asset.url}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const actual = createHash('sha256').update(buf).digest('hex');
    if (actual !== asset.sha256) {
      throw new Error(
        `integrity failure for ${asset.file}: expected ${asset.sha256.slice(0, 16)}…, ` +
          `got ${actual.slice(0, 16)}… — download discarded`,
      );
    }
    const tmp = `${dest}.part`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, dest);
    done += asset.bytes;
    onProgress?.(`${asset.file} verified`, done, total);
  }
  for (const asset of assets) ensureExtracted(dir, asset);
  writeLocalPackageJsons(dir);
}

// ---------------------------------------------------------------------------
// WordPiece tokenizer (BERT uncased)
// ---------------------------------------------------------------------------

function basicTokenize(text: string): string[] {
  const clean = (text ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const out: string[] = [];
  let cur = '';
  for (const ch of clean) {
    if (/\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = '';
    } else if (/[^\w]/.test(ch) && !/[一-鿿]/.test(ch)) {
      if (cur) out.push(cur);
      out.push(ch);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function wordpiece(tokens: string[], vocab: Map<string, number>): string[] {
  const out: string[] = [];
  for (const tok of tokens) {
    if (tok.length > 100) {
      out.push('[UNK]');
      continue;
    }
    let start = 0;
    const sub: string[] = [];
    let bad = false;
    while (start < tok.length) {
      let end = tok.length;
      let cur: string | null = null;
      while (start < end) {
        const piece = (start > 0 ? '##' : '') + tok.slice(start, end);
        if (vocab.has(piece)) {
          cur = piece;
          break;
        }
        end--;
      }
      if (cur === null) {
        bad = true;
        break;
      }
      sub.push(cur);
      start = end;
    }
    out.push(...(bad ? ['[UNK]'] : sub));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Embedder
// ---------------------------------------------------------------------------

export class NeuralEmbedder {
  private session: any;
  private vocab = new Map<string, number>();
  private hasTokenTypeIds = false;
  private Tensor: any;

  private constructor(
    readonly spec: SemanticProviderSpec,
    readonly dir: string,
  ) {}

  get providerId(): string {
    return this.spec.providerId;
  }
  get dims(): number {
    return this.spec.dims;
  }
  get thresholds(): SemanticThresholds {
    return this.spec.thresholds;
  }

  /**
   * Load a provider pack (default: the active one). Refuses to proceed if any
   * asset fails its pinned hash — the runtime JS is about to be require()d,
   * so this is the integrity boundary, not just hygiene.
   */
  static async load(spec?: SemanticProviderSpec, dirOverride?: string): Promise<NeuralEmbedder> {
    let dir: string;
    if (spec) {
      dir = dirOverride ?? providerDir(spec);
    } else {
      const active = activeProvider();
      if (!active) throw new Error('no semantic provider pack is installed');
      spec = active.spec;
      dir = dirOverride ?? active.dir;
    }
    for (const asset of providerAssets(spec)) {
      const p = path.join(dir, asset.file);
      if (!fs.existsSync(p)) throw new Error(`semantic asset missing: ${asset.file}`);
      if (sha256File(p) !== asset.sha256)
        throw new Error(`semantic asset failed integrity check: ${asset.file}`);
    }
    const self = new NeuralEmbedder(spec, dir);
    for (const asset of providerAssets(spec)) ensureExtracted(dir, asset);
    writeLocalPackageJsons(dir);
    const distDir = path.join(dir, 'node_modules', 'onnxruntime-web', 'dist');
    // Anchor resolution inside the runtime's own dist dir so its bare
    // require('onnxruntime-common') resolves to the sibling extracted package.
    const req = createRequire(path.join(distDir, 'ort.node.min.js'));
    const ort = req(path.join(distDir, 'ort.node.min.js'));
    ort.env.wasm.numThreads = 1; // plain WASM — no workers/SharedArrayBuffer
    ort.env.wasm.wasmPaths = distDir + path.sep;
    self.session = await ort.InferenceSession.create(path.join(dir, 'model_quantized.onnx'), {
      executionProviders: ['wasm'],
    });
    self.hasTokenTypeIds = self.session.inputNames.includes('token_type_ids');
    fs.readFileSync(path.join(dir, 'vocab.txt'), 'utf8')
      .split('\n')
      .forEach((tok, i) => self.vocab.set(tok, i));
    // The tensor constructor comes from the loaded runtime; keep a handle.
    self.Tensor = ort.Tensor;
    return self;
  }

  encode(text: string): number[] {
    const toks = [
      '[CLS]',
      ...wordpiece(basicTokenize(text), this.vocab).slice(0, MAX_TOKENS - 2),
      '[SEP]',
    ];
    const unk = this.vocab.get('[UNK]') ?? 100;
    return toks.map((t) => this.vocab.get(t) ?? unk);
  }

  /** Raw embed (no prefix) → L2-normalised vector (dims floats, 5 dp). */
  async embed(text: string): Promise<number[]> {
    const ids = this.encode(text);
    const n = ids.length;
    const big = BigInt64Array.from(ids.map((v) => BigInt(v)));
    const ones = BigInt64Array.from(ids.map(() => 1n));
    const feeds: Record<string, any> = {
      input_ids: new this.Tensor('int64', big, [1, n]),
      attention_mask: new this.Tensor('int64', ones, [1, n]),
    };
    if (this.hasTokenTypeIds) {
      feeds.token_type_ids = new this.Tensor('int64', BigInt64Array.from(ids.map(() => 0n)), [
        1,
        n,
      ]);
    }
    const out = await this.session.run(feeds);
    const hidden = out[this.session.outputNames[0]]; // [1, n, dims]
    const d: number = hidden.dims[2];
    const data: Float32Array = hidden.data;
    const vec = new Array<number>(d).fill(0);
    if (this.spec.pooling === 'cls') {
      for (let j = 0; j < d; j++) vec[j] = data[j];
    } else {
      for (let t = 0; t < n; t++) for (let j = 0; j < d; j++) vec[j] += data[t * d + j];
      for (let j = 0; j < d; j++) vec[j] /= n;
    }
    let norm = 0;
    for (let j = 0; j < d; j++) norm += vec[j] * vec[j];
    norm = Math.sqrt(norm) || 1;
    for (let j = 0; j < d; j++) vec[j] = Math.round((vec[j] / norm) * 1e5) / 1e5;
    return vec;
  }

  /** Embed a stored memory (document side — never prefixed). */
  async embedPassage(text: string): Promise<number[]> {
    return this.embed(text);
  }

  /** Embed a search query (asymmetric models prepend their query prefix). */
  async embedQuery(text: string): Promise<number[]> {
    return this.embed(this.spec.queryPrefix ? this.spec.queryPrefix + (text ?? '') : text);
  }
}

/**
 * Embedding surface for a session — ONE definition shared by the extension
 * store and the MCP server so both produce identical vectors for a session
 * (same text, same provider → same embedding; RET-006 parity).
 */
export function sessionEmbedText(s: {
  summary: string;
  keyTopics: string[];
  decisions: string[];
}): string {
  return `${s.summary} ${s.keyTopics.join(' ')} ${s.decisions.join(' ')}`;
}

// ---------------------------------------------------------------------------
// Embedding-cache compatibility (RET-002)
// ---------------------------------------------------------------------------

export interface EmbeddingMeta {
  /** Canonical provider id (identity + model + preprocessing + dims). */
  provider: string;
  dims: number;
  /** contentHash of the session at embed time — content changes invalidate. */
  contentHash?: string;
}

/**
 * True when a cached vector may be compared under `providerId`: provider ids
 * equal, dimensions equal, and the vector was computed from the session's
 * CURRENT content. Anything else is treated as absent (controlled fallback —
 * never a wrong similarity score).
 */
export function embeddingCompatible(
  meta: EmbeddingMeta | undefined,
  vector: number[] | undefined,
  providerId: string,
  dims: number,
  currentContentHash?: string,
): boolean {
  if (!meta || !vector) return false;
  if (meta.provider !== providerId || meta.dims !== dims) return false;
  if (vector.length !== dims) return false;
  if (meta.contentHash && currentContentHash && meta.contentHash !== currentContentHash)
    return false;
  return true;
}
