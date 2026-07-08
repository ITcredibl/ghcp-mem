/**
 * Storage encryption (v1.16.0) — the last enterprise blocker.
 *
 * Every review cycle since v1.6 flagged the same objection: compressed
 * session records sit in plaintext in `~/.ghcp-mem/sessions.json`, in the
 * globalState SQLite, and in rolling backups. This module supplies the
 * envelope; key acquisition lives in the extension (VS Code SecretStorage
 * for `os-keychain` mode, scrypt-derived for `passphrase` mode) so this
 * file stays pure Node crypto — usable by the headless MCP server and the
 * CI seeder with zero vscode imports and zero native deps.
 *
 * Envelope format (versioned, self-describing JSON):
 *   {
 *     "kind": "ghcp-mem-encrypted",
 *     "v": 1,
 *     "mode": "os-keychain" | "passphrase",
 *     "salt": "<hex>",            // passphrase mode only — scrypt salt
 *     "iv": "<hex>",              // 12-byte GCM nonce, fresh per write
 *     "tag": "<hex>",             // GCM auth tag — tamper-evident
 *     "data": "<base64>"          // AES-256-GCM ciphertext of the JSON db
 *   }
 *
 * Design notes:
 *   - AES-256-GCM: authenticated encryption — a flipped bit in the file
 *     fails the tag check loudly instead of yielding silently corrupt JSON.
 *   - Fresh random IV per write; the envelope is rewritten atomically by the
 *     existing tmp+rename path, so nonce reuse across crashes is impossible.
 *   - scrypt (N=2^15, r=8, p=1) for passphrase derivation — Node built-in,
 *     ~50ms on activation, memory-hard against GPU guessing.
 *   - Detection is a cheap prefix check so the hot read path pays nothing
 *     for plaintext stores.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'crypto';

export type EncryptionMode = 'os-keychain' | 'passphrase';

export const ENVELOPE_KIND = 'ghcp-mem-encrypted';
export const ENVELOPE_VERSION = 1;
export const KEY_BYTES = 32;
const IV_BYTES = 12;
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

export interface EnvelopeHeader {
  kind: typeof ENVELOPE_KIND;
  v: number;
  mode: EncryptionMode;
  salt?: string;
  iv: string;
  tag: string;
  data: string;
}

/** Cheap detection — envelope files always start with this exact prefix. */
const ENVELOPE_PREFIX = `{"kind":"${ENVELOPE_KIND}"`;

export function isEncryptedEnvelope(raw: string): boolean {
  return raw.startsWith(ENVELOPE_PREFIX);
}

/** Parse just the header (no decryption) — used to learn mode/salt for prompts. */
export function parseEnvelopeHeader(raw: string): EnvelopeHeader | null {
  if (!isEncryptedEnvelope(raw)) return null;
  try {
    const h = JSON.parse(raw) as EnvelopeHeader;
    if (h.kind !== ENVELOPE_KIND || typeof h.iv !== 'string' || typeof h.data !== 'string') {
      return null;
    }
    return h;
  } catch {
    return null;
  }
}

export function generateKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

export function generateSalt(): Buffer {
  return randomBytes(16);
}

/** scrypt KDF — deterministic for (passphrase, salt); ~50ms, memory-hard. */
export function deriveKeyFromPassphrase(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    // 128*N*r = exactly 32MiB, which collides with Node's default maxmem
    // ceiling (the check is `128*N*r*p > maxmem` at the boundary). Give the
    // KDF explicit headroom rather than silently weakening N.
    maxmem: 64 * 1024 * 1024,
  });
}

export function encryptEnvelope(
  plaintext: string,
  key: Buffer,
  mode: EncryptionMode,
  salt?: Buffer,
): string {
  if (key.length !== KEY_BYTES) throw new Error(`key must be ${KEY_BYTES} bytes`);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const envelope: EnvelopeHeader = {
    kind: ENVELOPE_KIND,
    v: ENVELOPE_VERSION,
    mode,
    ...(salt ? { salt: salt.toString('hex') } : {}),
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    data: data.toString('base64'),
  };
  // Key order matters for the prefix check — "kind" must serialize first,
  // which JSON.stringify guarantees by property insertion order above.
  return JSON.stringify(envelope);
}

/** Throws on wrong key, tampered ciphertext, or malformed envelope. */
export function decryptEnvelope(raw: string, key: Buffer): string {
  const h = parseEnvelopeHeader(raw);
  if (!h) throw new Error('not a ghcp-mem encrypted envelope');
  if (h.v !== ENVELOPE_VERSION) throw new Error(`unsupported envelope version ${h.v}`);
  if (key.length !== KEY_BYTES) throw new Error(`key must be ${KEY_BYTES} bytes`);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(h.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(h.tag, 'hex'));
  const out = Buffer.concat([
    decipher.update(Buffer.from(h.data, 'base64')),
    decipher.final(), // throws "Unsupported state or unable to authenticate data" on tamper/wrong key
  ]);
  return out.toString('utf8');
}

/**
 * Constant-time key comparison for verification flows (e.g. re-prompted
 * passphrase against a cached key). Never compare key material with ===.
 */
export function keysEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Serialize a database object for storage: encrypted envelope when a key is
 * present, compact plaintext JSON otherwise. Single entry point so the
 * store's three write surfaces (globalState, disk mirror, backups) cannot
 * diverge on format.
 */
export function serializeDb(
  db: unknown,
  key: Buffer | undefined,
  mode: EncryptionMode | undefined,
  salt?: Buffer,
): string {
  const json = JSON.stringify(db);
  if (!key) return json;
  return encryptEnvelope(json, key, mode ?? 'os-keychain', salt);
}

/**
 * Parse a raw store payload that may be plaintext JSON or an envelope.
 * Returns null (never throws) when the payload is encrypted and the key is
 * absent/wrong — callers decide whether that's a lockout error or a prompt.
 */
export function deserializeDb<T>(raw: string, key?: Buffer): T | null {
  try {
    if (isEncryptedEnvelope(raw)) {
      if (!key) return null;
      return JSON.parse(decryptEnvelope(raw, key)) as T;
    }
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
