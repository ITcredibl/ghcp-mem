/**
 * Optional encrypted team sync (v1.20.0) — git-backed, local-first.
 *
 * A sync bundle is an AES-256-GCM envelope (passphrase-derived key; the scrypt
 * salt travels in the envelope header) around shareable sessions + lessons.
 * Bundles are plain files the team commits to a repository of their choosing —
 * GHCP-MEM never opens a socket and never requires a SaaS backend; git is the
 * transport the team already trusts.
 *
 * Shareability is conservative: `user`, `task` and `agent` scoped memories
 * never leave the machine, and retracted sessions are excluded. Import is
 * additive and idempotent (dedup by id and contentHash); it never overwrites
 * a local session.
 *
 * Pure module — no vscode imports; callers do the file I/O.
 */
import {
  deriveKeyFromPassphrase,
  deserializeDb,
  generateSalt,
  isEncryptedEnvelope,
  serializeDb,
} from './storageCrypto';
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
  const sessions = shareableSessions(input.sessions);
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
    added.push({ ...session, importedAt: Date.now() });
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
