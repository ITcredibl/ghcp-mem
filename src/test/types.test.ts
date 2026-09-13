import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeContentHash,
  globToRegex,
  isPathExcluded,
  isGeneratedMemoryFile,
  GENERATED_MEMORY_FILES,
} from '../types';

test('computeContentHash — deterministic for same inputs', () => {
  const a = computeContentHash({
    summary: 'fix bug',
    keyFiles: ['a.ts', 'b.ts'],
    keyTopics: ['x'],
    decisions: [],
    problemsSolved: [],
  });
  const b = computeContentHash({
    summary: 'fix bug',
    keyFiles: ['a.ts', 'b.ts'],
    keyTopics: ['x'],
    decisions: [],
    problemsSolved: [],
  });
  assert.equal(a, b);
  assert.equal(a.length, 64);
});

test('computeContentHash — invariant to array order', () => {
  const a = computeContentHash({
    summary: 'same',
    keyFiles: ['a.ts', 'b.ts', 'c.ts'],
    keyTopics: ['x', 'y'],
    decisions: ['d1', 'd2'],
    problemsSolved: [],
  });
  const b = computeContentHash({
    summary: 'same',
    keyFiles: ['c.ts', 'b.ts', 'a.ts'],
    keyTopics: ['y', 'x'],
    decisions: ['d2', 'd1'],
    problemsSolved: [],
  });
  assert.equal(a, b);
});

test('computeContentHash — differs when summary changes', () => {
  const a = computeContentHash({
    summary: 'v1',
    keyFiles: [],
    keyTopics: [],
    decisions: [],
    problemsSolved: [],
  });
  const b = computeContentHash({
    summary: 'v2',
    keyFiles: [],
    keyTopics: [],
    decisions: [],
    problemsSolved: [],
  });
  assert.notEqual(a, b);
});

test('globToRegex — star matches within segment', () => {
  const re = globToRegex('src/*.ts');
  assert.match('src/foo.ts', re);
  assert.doesNotMatch('src/sub/foo.ts', re);
});

test('globToRegex — double-star matches across segments', () => {
  const re = globToRegex('**/*.env');
  assert.match('.env', re);
  assert.match('config/.env', re);
  assert.match('a/b/c/.env', re);
});

test('globToRegex — question mark matches single char', () => {
  const re = globToRegex('file?.ts');
  assert.match('file1.ts', re);
  assert.doesNotMatch('file12.ts', re);
});

test('isPathExcluded — respects exclude patterns', () => {
  const excludes = ['**/*.env', '**/secrets/**'];
  assert.equal(isPathExcluded('config/.env', excludes), true);
  assert.equal(isPathExcluded('src/secrets/token.ts', excludes), true);
  assert.equal(isPathExcluded('src/app.ts', excludes), false);
});

test('isPathExcluded — generated memory files are always excluded (v1.18.3)', () => {
  // Even with NO user excludeGlobs, the extension's own output must never
  // be captured — that would feed memory back into memory.
  assert.equal(isPathExcluded('.github/instructions/session-memory.instructions.md', []), true);
  assert.equal(isPathExcluded('.github/memory/rules.md', []), true);
  assert.equal(isPathExcluded('CLAUDE.md', []), true);
  assert.equal(isPathExcluded('.cursor/rules/ghcp-mem.mdc', []), true);
  // Multi-root workspaces: asRelativePath prefixes the folder name.
  assert.equal(isPathExcluded('my-app/CLAUDE.md', []), true);
  assert.equal(
    isPathExcluded('my-app/.github/instructions/session-memory.instructions.md', []),
    true,
  );
  // Windows separators and case drift.
  assert.equal(isPathExcluded('.github\\memory\\rules.md', []), true);
  assert.equal(isPathExcluded('claude.md', []), true);
  // Near-misses stay capturable.
  assert.equal(isPathExcluded('docs/CLAUDE.md.bak', []), false);
  assert.equal(isPathExcluded('src/rules.md', []), false);
});

test('isGeneratedMemoryFile — matches the integrity checker target list', () => {
  for (const f of GENERATED_MEMORY_FILES) {
    assert.equal(isGeneratedMemoryFile(f), true, `expected generated file to match: ${f}`);
  }
  assert.equal(isGeneratedMemoryFile('README.md'), false);
});
