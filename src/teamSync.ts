/**
 * Optional git-backed team sync (v1.20.0, clear chunks + origin trust v1.21.0).
 *
 * Two modes, both local-first, both using git as the only transport:
 *
 *  - SEALED (default): one AES-256-GCM envelope per export (passphrase-derived
 *    key; the scrypt salt travels in the envelope header). Repo readers
 *    without the passphrase see ciphertext.
 *  - CLEAR: one immutable JSON chunk per memory, named by content hash
 *    (`mem_<hash>.json`), so team memory becomes PR-reviewable and branch
 *    merges are pure file unions. Clear chunks pass an export-time redaction
 *    gateway (secret scrub + absolute-path sanitization, defense-in-depth on
 *    top of capture-time redaction) and can optionally anonymize authors.
 *
 * Shareability is conservative in both modes: `user`, `task` and `agent`
 * scoped memories never leave the machine, and retracted sessions are
 * excluded. Import is additive and idempotent (dedup by id and contentHash),
 * never overwrites a local session, and stamps `origin: 'team'` so ranking
 * can discount teammate-validated memory until local signals corroborate it.
 * Hydration is an EXPLICIT command on purpose — silently ingesting files from
 * a freshly pulled repository would hand memory-poisoning to anyone who can
 * open a pull request.
 *
 * Pure module — no vscode imports; callers do the file I/O.
 */
import { createHash } from 'crypto';
import {
  deriveKeyFromPassphrase,
  deserializeDb,
  generateSalt,
  isEncryptedEnvelope,
  serializeDb,
} from './storageCrypto';
import { redact } from './redactor';
import { Lesson } from './lessons';
import { CompressedSession } from './types';

export const SYNC_DIR = '.github/memory/sync';
const BUNDLE_KIND = 'ghcp-mem-sync-bundle';
const MAX_BUNDLE_SESSIONS = 5000;

interface SyncBundle {
  kind: typeof BUNDLE_KIND;
  version: 1;
  exportedAt: number;
  scopeLabel: string;
  sessions: CompressedSession[];
  lessons: Lesson[];
}

/** Scopes that may leave the machine. Narrower scopes are personal by design. */
const SHAREABLE = new Set(['organization', 'team', 'repository', 'branch']);

export function shareableSessions(sessions: readonly CompressedSession[]): CompressedSession[] {
  return sessions.filter(
    (session) => !session.retracted && SHAREABLE.has(session.scopeLevel ?? 'repository'),
  );
}

export function bundleFileName(scopeLabel: string, now = Date.now()): string {
  const slug =
    scopeLabel
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'repo';
  return `${slug}-${new Date(now).toISOString().slice(0, 10)}.ghcpmem`;
}

/** Serialize an encrypted bundle. The passphrase never appears in the output. */
export function exportBundle(
  input: {
    sessions: readonly CompressedSession[];
    lessons?: readonly Lesson[];
    scopeLabel: string;
  },
  passphrase: string,
  now = Date.now(),
): string {
  if (typeof passphrase !== 'string' || passphrase.length < 8)
    throw new Error('Team sync requires a passphrase of at least 8 characters');
  const sessions = shareableSessions(input.sessions).map(stripMachineLocalFields);
  if (sessions.length > MAX_BUNDLE_SESSIONS)
    throw new Error(`A bundle holds at most ${MAX_BUNDLE_SESSIONS} sessions`);
  const bundle: SyncBundle = {
    kind: BUNDLE_KIND,
    version: 1,
    exportedAt: now,
    scopeLabel: input.scopeLabel.slice(0, 200),
    sessions,
    lessons: [...(input.lessons ?? [])],
  };
  const salt = generateSalt();
  const key = deriveKeyFromPassphrase(passphrase, salt);
  return serializeDb(bundle, key, 'passphrase', salt);
}

export interface ImportResult {
  added: CompressedSession[];
  lessonsAdded: Lesson[];
  skippedDuplicates: number;
  scopeLabel: string;
  exportedAt: number;
}

/** Decrypt and merge a bundle against the existing store (returns what to add). */
export function importBundle(
  raw: string,
  passphrase: string,
  existing: { sessions: readonly CompressedSession[]; lessons?: readonly Lesson[] },
): ImportResult {
  if (!isEncryptedEnvelope(raw))
    throw new Error('Not a GHCP-MEM sync bundle (missing encryption envelope)');
  const salt = extractSalt(raw);
  const key = deriveKeyFromPassphrase(passphrase, salt);
  const bundle = deserializeDb<SyncBundle>(raw, key);
  if (!bundle) throw new Error('Wrong passphrase, or the bundle is corrupt');
  if (bundle.kind !== BUNDLE_KIND || bundle.version !== 1 || !Array.isArray(bundle.sessions))
    throw new Error('Unsupported sync bundle format');
  const knownIds = new Set(existing.sessions.map((session) => session.id));
  const knownHashes = new Set(
    existing.sessions.flatMap((session) => (session.contentHash ? [session.contentHash] : [])),
  );
  const added: CompressedSession[] = [];
  let skippedDuplicates = 0;
  for (const session of shareableSessions(bundle.sessions)) {
    if (knownIds.has(session.id) || (session.contentHash && knownHashes.has(session.contentHash))) {
      skippedDuplicates++;
      continue;
    }
    // Defensive re-strip + receiver stamp (covers bundles produced before
    // v1.21.1): a teammate's feedback must never read as LOCAL corroboration.
    added.push(stampTeamImport(session));
  }
  const knownLessonIds = new Set((existing.lessons ?? []).map((lesson) => lesson.id));
  const lessonsAdded = (bundle.lessons ?? []).filter((lesson) => !knownLessonIds.has(lesson.id));
  return {
    added,
    lessonsAdded,
    skippedDuplicates,
    scopeLabel: bundle.scopeLabel,
    exportedAt: bundle.exportedAt,
  };
}

function extractSalt(raw: string): Buffer {
  const header = JSON.parse(raw) as { salt?: string };
  if (typeof header.salt !== 'string' || !/^[a-f0-9]{16,128}$/i.test(header.salt))
    throw new Error('Sync bundle is missing its key-derivation salt');
  return Buffer.from(header.salt, 'hex');
}

// ── Clear mode: PR-reviewable, per-memory immutable chunks (v1.21.0) ────────

/** Clear chunks live beside the sealed bundles, in their own subdirectory. */
export const CLEAR_SYNC_DIR = `${SYNC_DIR}/clear`;
const CHUNK_KIND = 'ghcp-mem-sync-chunk';

export interface ClearChunk {
  kind: typeof CHUNK_KIND;
  version: 1;
  exportedAt: number;
  scopeLabel: string;
  session: CompressedSession;
}

const ABSOLUTE_PATH_RE = /(?:[A-Za-z]:\\|\/(?:Users|home|root|var|tmp|private)\/)[^\s"'`)\]},;]*/g;

/**
 * Fields that never leave the machine in ANY sync mode: machine-local
 * derivatives (embedding), this machine's feedback counters (usage — the
 * receiver's trust boundary depends on acceptance being LOCAL), and
 * import-lineage stamps the receiver must set itself.
 */
const SYNC_DROPPED_FIELDS = ['embedding', 'usage', 'origin', 'importedAt'] as const;

/** Identifier fields exempt from scrubbing — opaque ids/hashes, never prose. */
const SCRUB_EXEMPT_KEYS = new Set([
  'id',
  'contentHash',
  'supersedes',
  'supersededBy',
  'correctionOf',
]);

function cleanText(text: string): string {
  return redact(text, {
    redactSecrets: true,
    honorPrivateTags: true,
    detectHighEntropy: true,
  }).text.replace(ABSOLUTE_PATH_RE, '<REDACTED_PATH>');
}

/**
 * Recursively scrub EVERY string in the value — object keys included
 * (keyFileHashes keys are file paths) — so nested fields added in future
 * versions can never silently reopen the plaintext-export gap the v1.21.0
 * review found in `outcomes[].observations` and `decisionEvidence[].filePath`.
 */
function deepScrub(value: unknown, parentKey?: string): unknown {
  if (typeof value === 'string')
    return parentKey !== undefined && SCRUB_EXEMPT_KEYS.has(parentKey) ? value : cleanText(value);
  if (Array.isArray(value)) return value.map((entry) => deepScrub(entry, parentKey));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [cleanText(key), deepScrub(entry, key)]),
    );
  return value;
}

/** Remove the fields that must never travel, in either sync mode. */
export function stripMachineLocalFields(session: CompressedSession): CompressedSession {
  const copy: Record<string, unknown> = { ...session };
  for (const field of SYNC_DROPPED_FIELDS) delete copy[field];
  // The receiver-owned `imported` flag never travels either direction.
  if (session.outcomes)
    copy.outcomes = session.outcomes.map(({ imported: _imported, ...outcome }) => outcome);
  return copy as unknown as CompressedSession;
}

/**
 * Receiver-side stamp applied to every synced session: lineage fields set by
 * THIS machine, and every carried outcome marked `imported` so it can never
 * masquerade as local corroboration regardless of its (sender-controlled)
 * timestamp.
 */
function stampTeamImport(session: CompressedSession): CompressedSession {
  const stripped = stripMachineLocalFields(session);
  return {
    ...stripped,
    importedAt: Date.now(),
    origin: 'team',
    ...(stripped.outcomes
      ? { outcomes: stripped.outcomes.map((outcome) => ({ ...outcome, imported: true as const })) }
      : {}),
  };
}

/**
 * Export-time redaction gateway (defense-in-depth on top of capture-time
 * redaction) for plaintext chunks: drop machine-local fields, then deep-scrub
 * every string surface that will land in git as plaintext.
 */
export function scrubForClearExport(
  session: CompressedSession,
  options: { anonymizeAuthors?: boolean } = {},
): CompressedSession {
  const scrubbed = deepScrub(stripMachineLocalFields(session)) as CompressedSession;
  if (options.anonymizeAuthors && scrubbed.author) {
    // Deterministic opaque alias: teammates can still correlate one author's
    // memories without learning who they are.
    const alias = createHash('sha256').update(scrubbed.author).digest('hex').slice(0, 8);
    scrubbed.author = `human:anon-${alias}`;
    if (scrubbed.outcomes)
      scrubbed.outcomes = scrubbed.outcomes.map((outcome) =>
        outcome.reportedBy
          ? {
              ...outcome,
              reportedBy: `human:anon-${createHash('sha256').update(outcome.reportedBy).digest('hex').slice(0, 8)}`,
            }
          : outcome,
      );
  }
  return scrubbed;
}

export function chunkFileName(session: Pick<CompressedSession, 'id' | 'contentHash'>): string {
  const hash =
    session.contentHash ?? createHash('sha256').update(session.id).digest('hex').slice(0, 16);
  return `mem_${hash.slice(0, 16)}.json`;
}

/**
 * Render shareable sessions as individual clear chunks. Returns the files to
 * write: merging branches that both exported is a non-destructive file union,
 * and identical content always produces the identical file name.
 */
export function exportClearChunks(
  input: {
    sessions: readonly CompressedSession[];
    scopeLabel: string;
    anonymizeAuthors?: boolean;
  },
  now = Date.now(),
): { fileName: string; content: string }[] {
  return shareableSessions(input.sessions).map((session) => {
    const scrubbed = scrubForClearExport(session, { anonymizeAuthors: input.anonymizeAuthors });
    const chunk: ClearChunk = {
      kind: CHUNK_KIND,
      version: 1,
      exportedAt: now,
      scopeLabel: input.scopeLabel.slice(0, 200),
      session: scrubbed,
    };
    return { fileName: chunkFileName(scrubbed), content: JSON.stringify(chunk, null, 2) + '\n' };
  });
}

/** Parse and merge a set of clear chunks against the existing store. */
export function importClearChunks(
  rawChunks: readonly string[],
  existing: { sessions: readonly CompressedSession[] },
): { added: CompressedSession[]; skippedDuplicates: number; invalid: number } {
  const knownIds = new Set(existing.sessions.map((session) => session.id));
  const knownHashes = new Set(
    existing.sessions.flatMap((session) => (session.contentHash ? [session.contentHash] : [])),
  );
  const added: CompressedSession[] = [];
  let skippedDuplicates = 0;
  let invalid = 0;
  for (const raw of rawChunks) {
    let chunk: ClearChunk;
    try {
      chunk = JSON.parse(raw) as ClearChunk;
    } catch {
      invalid++;
      continue;
    }
    if (chunk.kind !== CHUNK_KIND || chunk.version !== 1 || !chunk.session?.id) {
      invalid++;
      continue;
    }
    const [session] = shareableSessions([chunk.session]);
    if (!session) {
      invalid++;
      continue;
    }
    if (knownIds.has(session.id) || (session.contentHash && knownHashes.has(session.contentHash))) {
      skippedDuplicates++;
      continue;
    }
    knownIds.add(session.id);
    if (session.contentHash) knownHashes.add(session.contentHash);
    added.push(stampTeamImport(session));
  }
  return { added, skippedDuplicates, invalid };
}

// ── Legacy trust migration (v1.22.0, TRUST-001) ─────────────────────────────

export const TRUST_MIGRATION_V = 1;

/**
 * One-shot upgrade for stores written before receiver-owned trust (v1.21.2).
 * Conservative by design: on every team-origin session, usage counters are
 * removed (they may be the sender's — a local /accept re-earns full trust in
 * one click) and every unflagged outcome is stamped `imported` (pre-migration
 * data cannot distinguish a locally recorded outcome from a sender's, and
 * sender-controlled fields must never establish local trust). Audit history
 * is preserved — nothing is deleted except the ambiguous counters.
 *
 * MUST run at most once per store (see ContextDatabase.trustMigrationV):
 * after migration, unflagged outcomes on team rows are exactly how legitimate
 * LOCAL outcomes look, so a re-run would destroy real local corroboration.
 */
export function migrateTeamTrust(sessions: CompressedSession[]): number {
  let changed = 0;
  for (const session of sessions) {
    if (session.origin !== 'team') continue;
    if (session.usage) {
      delete session.usage;
      changed++;
    }
    for (const outcome of session.outcomes ?? []) {
      if (!outcome.imported) {
        outcome.imported = true;
        changed++;
      }
    }
  }
  return changed;
}

/** Apply the one-shot migration to a parsed database when its marker is absent. */
export function ensureTrustMigrated(db: {
  sessions: CompressedSession[];
  trustMigrationV?: number;
}): number {
  if (db.trustMigrationV === TRUST_MIGRATION_V) return 0;
  const changed = migrateTeamTrust(db.sessions);
  db.trustMigrationV = TRUST_MIGRATION_V;
  return changed;
}

// ── Origin trust (v1.21.0) ──────────────────────────────────────────────────

/**
 * Trust multiplier by where a memory entered this machine. Team-shared rows
 * start discounted (a teammate validated them, this machine has not) and earn
 * the discount back ONLY through RECEIVER-OWNED corroboration: an explicit
 * /accept (usage counters are stripped at export AND import, so any
 * acceptance is local by construction) or an improved outcome recorded on
 * this machine (every outcome that arrives via sync is stamped `imported` by
 * the receiver and never counts — a timestamp chosen by the sender cannot
 * establish local origin, as the v1.21.1 review's future-dated probe showed).
 */
export function originTrust(
  session: Pick<CompressedSession, 'origin' | 'usage' | 'outcomes'>,
): number {
  if (session.origin !== 'team') return 1;
  const locallyAccepted = (session.usage?.accepted ?? 0) > 0;
  const locallyImproved = (session.outcomes ?? []).some(
    (outcome) => outcome.status === 'improved' && !outcome.imported,
  );
  return locallyAccepted || locallyImproved ? 1 : 0.75;
}
