/**
 * Git-history seeder — the cold-start killer (v1.14.0).
 *
 * GHCP-MEM's value historically accrued only after days of live capture,
 * but the repo's own git history already holds months of decisions, fixes,
 * and deployment context. This module mines `git log` into ready-to-store
 * CompressedSessions so `@mem /search why did we switch to X` answers
 * within 30 seconds of install.
 *
 * Design (mirrors ciSeeder.ts):
 *   - Pure, vscode-free module: parsing/classification/grouping are all
 *     deterministic functions over strings. The only I/O is `git log`,
 *     injected by the caller so tests never shell out.
 *   - One session per (calendar day × author) streak, not per commit —
 *     a day of commits reads like a real captured session and keeps the
 *     seeded row count well under `maxStoredSessions`.
 *   - Every summary/decision/topic passes through the same redactor used
 *     by live capture, so a secret pasted into a commit message years ago
 *     never reaches the store.
 *   - Deterministic content hashes: re-running the seeder produces the
 *     same hashes, and ContextStore.addSession dedups on contentHash —
 *     so seeding is idempotent by construction.
 *   - Honestly labelled: `compressorMode: 'fallback'` and a modest
 *     confidence, because these sessions are heuristic reconstructions,
 *     not evidence-grounded live captures. The trust scorer already
 *     treats fallback-mode sessions accordingly.
 */
import { createHash } from 'crypto';
import { redact } from './redactor';
import type { CompressedSession, ObservationType } from './types';

/** One parsed `git log` record. */
export interface ParsedCommit {
  hash: string;
  author: string;
  /** Unix seconds (git %at). */
  timestamp: number;
  subject: string;
  body: string;
  files: string[];
}

export interface SeedOptions {
  workspaceId: string;
  workspaceName: string;
  repoScope?: string;
  repoScopeLabel?: string;
  /** Cap on sessions produced (defense vs. maxStoredSessions eviction). Default 40. */
  maxSessions?: number;
  /** Skip commits whose subject is shorter than this after trimming. Default 8. */
  minSubjectLength?: number;
  /**
   * Store-entry timestamp stamped as `importedAt` on every produced session.
   * Retention ages seeded rows from this instant, not from their historical
   * commit times (see CompressedSession.importedAt). Injectable for
   * deterministic tests; callers pass Date.now().
   */
  now?: number;
}

export interface SeedResult {
  sessions: CompressedSession[];
  commitsConsidered: number;
  commitsSkipped: number;
  redactionCount: number;
}

/** Record/field separators used in the log format — see gitLogArgs(). */
const RECORD_SEP = '\x1e';
const FIELD_SEP = '\x1f';

/**
 * Arguments for the `git log` invocation the caller should run (via
 * execFile, never a shell). Kept here so the format string and the parser
 * can't drift apart.
 */
export function gitLogArgs(maxCommits: number): string[] {
  return [
    'log',
    `-n`,
    String(Math.max(1, Math.min(1000, maxCommits))),
    // %x1e record start, %x1f between fields; --name-only appends the
    // touched paths as plain lines after each record body.
    `--pretty=format:%x1e%H%x1f%an%x1f%at%x1f%s%x1f%b%x1f`,
    '--name-only',
  ];
}

/** Parse raw `git log` output produced with gitLogArgs()'s format. */
export function parseGitLog(raw: string): ParsedCommit[] {
  const out: ParsedCommit[] = [];
  for (const record of raw.split(RECORD_SEP)) {
    if (!record.trim()) continue;
    const parts = record.split(FIELD_SEP);
    if (parts.length < 6) continue; // malformed / truncated record
    const [hash, author, at, subject, body, fileBlock] = parts;
    const timestamp = Number.parseInt(at, 10);
    if (!hash.trim() || !Number.isFinite(timestamp)) continue;
    const files = fileBlock
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    out.push({
      hash: hash.trim(),
      author: author.trim(),
      timestamp: timestamp * 1000,
      subject: subject.trim(),
      body: body.trim(),
      files,
    });
  }
  return out;
}

/**
 * Map a commit subject to an ObservationType. Conventional-commit prefixes
 * first, keyword heuristics second — same buckets the live rule classifier
 * uses, so seeded and captured sessions filter identically.
 */
export function classifyCommitType(subject: string): ObservationType {
  const s = subject.toLowerCase();
  const prefix = s.match(
    /^(feat|fix|refactor|perf|docs|test|chore|build|ci|revert|style|release|security|infra|config)(\(|:|!)/,
  )?.[1];
  switch (prefix) {
    case 'feat':
      return 'feature';
    case 'fix':
    case 'revert':
      return 'bugfix';
    case 'refactor':
    case 'perf':
    case 'style':
      return 'refactor';
    case 'docs':
      return 'docs';
    case 'test':
      return 'test';
    case 'chore':
    case 'build':
      return 'chore';
    case 'ci':
      return 'infra';
    case 'release':
      return 'deployment';
    case 'security':
      return 'security';
    case 'infra':
      return 'infra';
    case 'config':
      return 'config';
  }
  if (/\b(cve|vulnerab|security|secret|redact|sanitiz)/.test(s)) return 'security';
  if (/\b(deploy|release|publish|ship)\b/.test(s)) return 'deployment';
  if (/\b(terraform|bicep|k8s|kubernetes|helm|docker|pipeline|workflow|github actions)\b/.test(s))
    return 'infra';
  if (/\b(fix(es|ed)?|bug|crash|regression|hotfix)\b/.test(s)) return 'bugfix';
  if (/\b(add(s|ed)?|implement|introduce|support)\b/.test(s)) return 'feature';
  if (/\b(refactor|rename|extract|simplify|clean\s?up)\b/.test(s)) return 'refactor';
  if (/\b(doc|readme|changelog)\b/.test(s)) return 'docs';
  if (/\btest(s|ing)?\b/.test(s)) return 'test';
  return 'unknown';
}

/** Decision-bearing phrasing worth promoting into `decisions`. */
const DECISION_MARKERS =
  /\b(switch(?:ed|ing)? to|instead of|migrat(?:e|ed|ing) (?:from|to)|adopt(?:ed|ing)?|replac(?:e|ed|ing) .+ with|drop(?:ped|ping)? support|deprecat(?:e|ed|ing)|revert(?:ed|ing)?|decided? to|standardiz(?:e|ed|ing) on|mov(?:e|ed|ing) (?:from|away from|to))\b/i;

/**
 * Pull decision statements out of a commit. Merge-PR subjects defer to the
 * body's first meaningful line (the subject is just "Merge pull request #N…").
 */
export function extractDecisions(commit: ParsedCommit): string[] {
  const out: string[] = [];
  const isMerge = /^merge (pull request|branch)/i.test(commit.subject);
  const candidates = isMerge
    ? commit.body.split('\n').map((l) => l.trim())
    : [commit.subject, ...commit.body.split('\n').map((l) => l.trim())];
  for (const line of candidates) {
    if (line.length < 12 || line.length > 300) continue;
    if (DECISION_MARKERS.test(line)) out.push(line);
    if (out.length >= 3) break;
  }
  return out;
}

/** Extract `feat(scope):`-style scopes plus a few high-signal path segments as topics. */
function topicsOf(commits: ParsedCommit[]): string[] {
  const topics = new Set<string>();
  for (const c of commits) {
    const scope = c.subject.match(/^[a-z]+\(([a-z0-9/_-]{2,30})\)[!:]/i)?.[1];
    if (scope) topics.add(scope.toLowerCase());
  }
  // Top-level dirs of touched files carry subsystem signal (src, docs, infra…).
  const dirCounts = new Map<string, number>();
  for (const c of commits) {
    for (const f of c.files) {
      const top = f.split('/')[0];
      if (top && top !== f) dirCounts.set(top, (dirCounts.get(top) ?? 0) + 1);
    }
  }
  [...dirCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .forEach(([d]) => topics.add(d));
  return [...topics].slice(0, 8);
}

const REDACT_OPTS = { redactSecrets: true, honorPrivateTags: false, detectHighEntropy: true };

/** Deterministic content hash — same recipe class as ciSeeder, keyed on the day's commits. */
function seedContentHash(daySummary: string, hashes: string[]): string {
  return createHash('sha256')
    .update(`git-history-seed\n${daySummary}\n${hashes.join(',')}`)
    .digest('hex');
}

/**
 * Group commits into (calendar day × author) sessions and build redacted
 * CompressedSessions. Deterministic: same history in → same sessions out.
 */
export function commitsToSessions(commits: ParsedCommit[], opts: SeedOptions): SeedResult {
  const minLen = opts.minSubjectLength ?? 8;
  const maxSessions = Math.max(1, opts.maxSessions ?? 40);

  const considered = commits.length;
  const usable = commits.filter(
    (c) => c.subject.trim().length >= minLen && !/^merge branch/i.test(c.subject),
  );

  // Group newest-first log output by day+author, preserving order.
  const groups = new Map<string, ParsedCommit[]>();
  for (const c of usable) {
    const day = new Date(c.timestamp).toISOString().slice(0, 10);
    const key = `${day}|${c.author}`;
    const g = groups.get(key);
    if (g) g.push(c);
    else groups.set(key, [c]);
  }

  let redactionCount = 0;
  const scrub = (s: string): string => {
    const r = redact(s, REDACT_OPTS);
    redactionCount += r.redactionCount;
    return r.text;
  };

  const sessions: CompressedSession[] = [];
  for (const [key, group] of groups) {
    if (sessions.length >= maxSessions) break;
    const day = key.slice(0, 10);
    const times = group.map((c) => c.timestamp);
    // Majority observation type across the day's commits.
    const typeCounts = new Map<ObservationType, number>();
    for (const c of group) {
      const t = classifyCommitType(c.subject);
      typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
    }
    const observationType =
      [...typeCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown';

    const subjects = group.map((c) => c.subject);
    const headline = subjects[0];
    const rest = subjects.slice(1, 6);
    const summary = scrub(
      rest.length
        ? `${headline} — plus ${group.length - 1} related commit(s): ${rest.join('; ')}`
        : headline,
    );

    const decisions = [...new Set(group.flatMap(extractDecisions))].slice(0, 5).map(scrub);
    const keyFiles = [...new Set(group.flatMap((c) => c.files))].slice(0, 10);
    const keyTopics = topicsOf(group);

    sessions.push({
      id: `gitseed-${group[0].hash.slice(0, 12)}`,
      workspaceId: opts.workspaceId,
      workspaceName: opts.workspaceName,
      startTime: Math.min(...times),
      endTime: Math.max(...times),
      summary,
      observationType,
      keyFiles,
      keyTopics,
      decisions,
      problemsSolved: [],
      rawEventCount: group.length,
      userTags: ['git-history', 'seeded'],
      redactionCount,
      contentHash: seedContentHash(
        `${day}|${headline}`,
        group.map((c) => c.hash),
      ),
      repoScope: opts.repoScope,
      repoScopeLabel: opts.repoScopeLabel,
      compressorMode: 'fallback',
      // Heuristic reconstruction, not evidence-grounded live capture — score
      // it below LM-compressed sessions so live memory outranks history when
      // both match a query.
      confidence: 0.55,
      // Retention must age this row from when it entered the store — its
      // endTime is a historical commit date by design.
      importedAt: opts.now ?? Date.now(),
    });
  }

  return {
    sessions,
    commitsConsidered: considered,
    commitsSkipped: considered - usable.length,
    redactionCount,
  };
}
