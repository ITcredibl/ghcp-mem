/**
 * v1.14.0 — git-history seeder tests.
 *
 * The seeder is the cold-start killer: it must (a) parse real git-log output
 * shapes robustly, (b) classify conventional + free-form commit subjects the
 * same way the live classifier buckets sessions, (c) redact secrets that were
 * pasted into commit messages, and (d) be idempotent via deterministic
 * content hashes so re-seeding never duplicates.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  gitLogArgs,
  parseGitLog,
  classifyCommitType,
  extractDecisions,
  commitsToSessions,
  ParsedCommit,
} from '../gitHistorySeeder';

const RS = '\x1e';
const FS = '\x1f';

function record(
  hash: string,
  author: string,
  atSec: number,
  subject: string,
  body: string,
  files: string[],
): string {
  return `${RS}${hash}${FS}${author}${FS}${atSec}${FS}${subject}${FS}${body}${FS}\n${files.join('\n')}\n`;
}

const BASE_OPTS = { workspaceId: 'ws://x', workspaceName: 'x' };

// ── gitLogArgs ────────────────────────────────────────────────────────────

test('gitLogArgs: clamps commit count to [1, 1000]', () => {
  assert.ok(gitLogArgs(0).includes('1'));
  assert.ok(gitLogArgs(99999).includes('1000'));
  assert.ok(gitLogArgs(200).includes('200'));
});

// ── parseGitLog ───────────────────────────────────────────────────────────

test('parseGitLog: parses multi-record output with files', () => {
  const raw =
    record('a'.repeat(40), 'Alice', 1750000000, 'feat(auth): add SSO', 'body here', [
      'src/auth.ts',
      'src/sso.ts',
    ]) + record('b'.repeat(40), 'Bob', 1750100000, 'fix: crash on login', '', ['src/auth.ts']);
  const commits = parseGitLog(raw);
  assert.equal(commits.length, 2);
  assert.equal(commits[0].author, 'Alice');
  assert.equal(commits[0].subject, 'feat(auth): add SSO');
  assert.deepEqual(commits[0].files, ['src/auth.ts', 'src/sso.ts']);
  assert.equal(commits[0].timestamp, 1750000000 * 1000);
  assert.equal(commits[1].files.length, 1);
});

test('parseGitLog: skips malformed/truncated records instead of throwing', () => {
  const good = record('c'.repeat(40), 'Ann', 1750000000, 'docs: update readme', '', ['README.md']);
  const commits = parseGitLog(`${RS}garbage-without-separators\n${good}${RS}${FS}${FS}`);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].subject, 'docs: update readme');
});

test('parseGitLog: empty input → empty array', () => {
  assert.deepEqual(parseGitLog(''), []);
});

// ── classifyCommitType ────────────────────────────────────────────────────

test('classifyCommitType: conventional prefixes map to observation types', () => {
  assert.equal(classifyCommitType('feat(scope): thing'), 'feature');
  assert.equal(classifyCommitType('feat!: breaking thing'), 'feature');
  assert.equal(classifyCommitType('fix: crash'), 'bugfix');
  assert.equal(classifyCommitType('revert: bad change'), 'bugfix');
  assert.equal(classifyCommitType('refactor: extract helper'), 'refactor');
  assert.equal(classifyCommitType('perf: memoise stats'), 'refactor');
  assert.equal(classifyCommitType('docs: changelog'), 'docs');
  assert.equal(classifyCommitType('test: cover janitor'), 'test');
  assert.equal(classifyCommitType('chore: bump deps'), 'chore');
  assert.equal(classifyCommitType('ci: fix workflow'), 'infra');
  assert.equal(classifyCommitType('release: v1.2.3'), 'deployment');
});

test('classifyCommitType: keyword heuristics for non-conventional subjects', () => {
  assert.equal(classifyCommitType('Fixed the login crash'), 'bugfix');
  assert.equal(classifyCommitType('Add support for dark mode'), 'feature');
  assert.equal(classifyCommitType('Update terraform modules for prod'), 'infra');
  assert.equal(classifyCommitType('Patch CVE-2026-1234 in parser'), 'security');
  assert.equal(classifyCommitType('Deploy v2 to production'), 'deployment');
  assert.equal(classifyCommitType('wip'), 'unknown');
});

// ── extractDecisions ──────────────────────────────────────────────────────

test('extractDecisions: finds decision-bearing lines in subject and body', () => {
  const c: ParsedCommit = {
    hash: 'x'.repeat(40),
    author: 'A',
    timestamp: 1,
    subject: 'switch to pnpm instead of npm for workspace installs',
    body: 'We decided to standardize on pnpm for speed.\nUnrelated line.',
    files: [],
  };
  const decisions = extractDecisions(c);
  assert.ok(decisions.length >= 2);
  assert.match(decisions[0], /switch to pnpm/);
});

test('extractDecisions: merge-PR commits read the body, not the boilerplate subject', () => {
  const c: ParsedCommit = {
    hash: 'y'.repeat(40),
    author: 'A',
    timestamp: 1,
    subject: 'Merge pull request #42 from org/feat-branch',
    body: 'Migrate from REST to GraphQL for the search endpoint',
    files: [],
  };
  const decisions = extractDecisions(c);
  assert.equal(decisions.length, 1);
  assert.match(decisions[0], /Migrate from REST to GraphQL/);
  assert.doesNotMatch(decisions[0] ?? '', /Merge pull request/);
});

// ── commitsToSessions ─────────────────────────────────────────────────────

function mkCommit(o: Partial<ParsedCommit> & { atSec: number }): ParsedCommit {
  return {
    hash: (o.hash ?? Math.random().toString(16).slice(2).padEnd(40, 'f')).slice(0, 40),
    author: o.author ?? 'Dev',
    timestamp: o.atSec * 1000,
    subject: o.subject ?? 'feat: something meaningful here',
    body: o.body ?? '',
    files: o.files ?? ['src/a.ts'],
  };
}

const DAY = 86_400;

test('commitsToSessions: groups same-day-same-author commits into one session', () => {
  const t0 = 1_750_000_000; // fixed epoch, avoids Date.now nondeterminism
  const commits = [
    mkCommit({ atSec: t0, subject: 'feat: add cart', author: 'Ann', hash: 'a'.repeat(40) }),
    mkCommit({
      atSec: t0 + 3600,
      subject: 'fix: cart total rounding',
      author: 'Ann',
      hash: 'b'.repeat(40),
    }),
    mkCommit({
      atSec: t0 + DAY * 2,
      subject: 'docs: cart readme',
      author: 'Ann',
      hash: 'c'.repeat(40),
    }),
  ];
  const { sessions } = commitsToSessions(commits, BASE_OPTS);
  assert.equal(sessions.length, 2);
  const grouped = sessions.find((s) => s.rawEventCount === 2)!;
  assert.match(grouped.summary, /add cart/);
  assert.match(grouped.summary, /1 related commit/);
  assert.ok(grouped.startTime < grouped.endTime);
});

test('commitsToSessions: deterministic content hashes → idempotent re-seed', () => {
  const commits = [
    mkCommit({ atSec: 1_750_000_000, hash: 'a'.repeat(40), subject: 'feat: first' }),
    mkCommit({ atSec: 1_750_000_100, hash: 'b'.repeat(40), subject: 'feat: second' }),
  ];
  const run1 = commitsToSessions(commits, BASE_OPTS);
  const run2 = commitsToSessions(commits, BASE_OPTS);
  assert.equal(run1.sessions[0].contentHash, run2.sessions[0].contentHash);
  assert.equal(run1.sessions[0].id, run2.sessions[0].id);
});

test('commitsToSessions: redacts secrets pasted into commit messages', () => {
  const commits = [
    mkCommit({
      atSec: 1_750_000_000,
      subject: 'fix: rotate key AKIAIOSFODNN7EXAMPLE in deploy script',
      hash: 'd'.repeat(40),
    }),
  ];
  const { sessions, redactionCount } = commitsToSessions(commits, BASE_OPTS);
  assert.ok(redactionCount >= 1);
  assert.match(sessions[0].summary, /\[REDACTED:aws-access-key\]/);
  assert.doesNotMatch(sessions[0].summary, /AKIAIOSFODNN7EXAMPLE/);
});

test('commitsToSessions: skips low-signal commits and merge-branch noise', () => {
  const commits = [
    mkCommit({ atSec: 1_750_000_000, subject: 'wip', hash: 'e'.repeat(40) }),
    mkCommit({ atSec: 1_750_000_100, subject: 'Merge branch main into dev', hash: 'f'.repeat(40) }),
    mkCommit({
      atSec: 1_750_000_200,
      subject: 'feat: real work happened here',
      hash: '1'.repeat(40),
    }),
  ];
  const result = commitsToSessions(commits, BASE_OPTS);
  assert.equal(result.commitsSkipped, 2);
  assert.equal(result.sessions.length, 1);
});

test('commitsToSessions: respects maxSessions cap', () => {
  const commits = Array.from({ length: 30 }, (_, i) =>
    mkCommit({
      atSec: 1_750_000_000 + i * DAY,
      subject: `feat: day ${i} work item`,
      hash: String(i).padStart(2, '0').repeat(20),
    }),
  );
  const { sessions } = commitsToSessions(commits, { ...BASE_OPTS, maxSessions: 5 });
  assert.equal(sessions.length, 5);
});

test('commitsToSessions: sessions are honestly labelled as heuristic reconstructions', () => {
  const { sessions } = commitsToSessions(
    [mkCommit({ atSec: 1_750_000_000, hash: 'a'.repeat(40) })],
    BASE_OPTS,
  );
  const s = sessions[0];
  assert.equal(s.compressorMode, 'fallback');
  assert.ok((s.confidence ?? 1) < 0.7, 'seeded confidence must sit below LM-compressed sessions');
  assert.ok(s.userTags.includes('git-history'));
  assert.ok(s.userTags.includes('seeded'));
});

test('commitsToSessions: topics from conventional scopes and top-level dirs', () => {
  const commits = [
    mkCommit({
      atSec: 1_750_000_000,
      subject: 'feat(checkout): split payment flow',
      files: ['src/checkout.ts', 'src/pay.ts', 'docs/pay.md'],
      hash: 'a'.repeat(40),
    }),
  ];
  const { sessions } = commitsToSessions(commits, BASE_OPTS);
  assert.ok(sessions[0].keyTopics.includes('checkout'));
  assert.ok(sessions[0].keyTopics.includes('src'));
});
