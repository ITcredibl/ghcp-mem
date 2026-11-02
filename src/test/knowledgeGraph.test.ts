import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildKnowledgeGraph,
  neighborhood,
  neighborhoodToMermaid,
  pathBetween,
} from '../knowledgeGraph';
import { recordOutcome } from '../outcomes';
import { CompressedSession } from '../types';

function mkSession(o: Partial<CompressedSession> = {}): CompressedSession {
  return {
    id: o.id ?? Math.random().toString(36).slice(2),
    workspaceId: 'ws',
    workspaceName: 'ws',
    startTime: 1,
    endTime: 2,
    summary: o.summary ?? 'demo work',
    observationType: 'feature',
    keyFiles: o.keyFiles ?? [],
    keyTopics: [],
    decisions: o.decisions ?? [],
    problemsSolved: [],
    rawEventCount: 0,
    userTags: [],
    redactionCount: 0,
    ...o,
  };
}

test('knowledgeGraph: builds typed nodes and edges from memory only', () => {
  const session = mkSession({
    id: 'a',
    keyFiles: ['src/auth.ts'],
    decisions: ['use managed identity'],
    summary: 'auth work, see PR #122',
  });
  recordOutcome(session, { status: 'improved', decisionIndex: 0, observations: ['0 incidents'] });
  const graph = buildKnowledgeGraph([session]);
  assert.ok(graph.nodes.has('session:a'));
  assert.ok(graph.nodes.has('file:src/auth.ts'));
  assert.ok(graph.nodes.has('decision:a:0'));
  assert.ok(graph.nodes.has('pr:122'));
  const kinds = graph.edges.map((edge) => edge.kind).sort();
  assert.deepEqual(kinds, ['decided', 'evaluated_by', 'referenced_pr', 'touched']);
});

test('knowledgeGraph: supersession and correction edges link known sessions only', () => {
  const older = mkSession({ id: 'old' });
  const newer = mkSession({ id: 'new', supersedes: 'old' });
  const dangling = mkSession({ id: 'x', supersedes: 'missing' });
  const graph = buildKnowledgeGraph([older, newer, dangling]);
  assert.ok(
    graph.edges.some(
      (edge) =>
        edge.kind === 'supersedes' && edge.from === 'session:new' && edge.to === 'session:old',
    ),
  );
  assert.equal(graph.edges.filter((edge) => edge.to === 'session:missing').length, 0);
});

test('knowledgeGraph: neighborhood is bounded and rejects unknown nodes', () => {
  const sessions = [
    mkSession({ id: 'a', keyFiles: ['shared.ts'] }),
    mkSession({ id: 'b', keyFiles: ['shared.ts', 'other.ts'] }),
  ];
  const graph = buildKnowledgeGraph(sessions);
  const hood = neighborhood(graph, 'file:shared.ts', 1);
  const ids = hood.nodes.map((node) => node.id).sort();
  assert.deepEqual(ids, ['file:shared.ts', 'session:a', 'session:b']);
  assert.throws(() => neighborhood(graph, 'file:nope.ts'), /Unknown graph node/);
});

test('knowledgeGraph: pathBetween answers "why does X relate to Y"', () => {
  const graph = buildKnowledgeGraph([
    mkSession({ id: 'a', keyFiles: ['order.ts'], decisions: ['cache via redis'] }),
  ]);
  const path = pathBetween(graph, 'file:order.ts', 'decision:a:0').map((node) => node.id);
  assert.deepEqual(path, ['file:order.ts', 'session:a', 'decision:a:0']);
  assert.deepEqual(pathBetween(graph, 'file:order.ts', 'pr:999'), []);
});

test('knowledgeGraph: mermaid rendering is sanitized', () => {
  const graph = buildKnowledgeGraph([mkSession({ id: 'a', keyFiles: ['src/a.ts'] })]);
  const mermaid = neighborhoodToMermaid(neighborhood(graph, 'session:a', 1));
  assert.match(mermaid, /^flowchart TD/);
  assert.match(mermaid, /-->\|touched\|/);
  assert.ok(!mermaid.includes('src/a.ts["'), 'node ids must be sanitized for mermaid');
});
