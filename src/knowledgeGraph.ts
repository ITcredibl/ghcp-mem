/**
 * Engineering knowledge graph (v1.20.0) — one typed graph over everything the
 * store already knows, so "why does X depend on Y" becomes traversal instead
 * of text retrieval.
 *
 * Nodes: sessions, files, decisions, PRs (parsed from text/branch refs) and
 * recorded outcomes. Edges: touched, decided, supersedes, corrects,
 * referenced_pr and evaluated_by. The graph is derived purely from stored
 * memory — it never claims code-level dependency facts it has not observed.
 *
 * Pure module — no vscode imports.
 */
import { CompressedSession } from './types';
import { parsePrRefs } from './prLineage';

export type GraphNodeKind = 'session' | 'file' | 'decision' | 'pr' | 'outcome';
export type GraphEdgeKind =
  | 'touched'
  | 'decided'
  | 'supersedes'
  | 'corrects'
  | 'referenced_pr'
  | 'evaluated_by';

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: GraphEdgeKind;
}

export interface KnowledgeGraph {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
}

const MAX_SESSIONS = 2000;

function addNode(graph: KnowledgeGraph, node: GraphNode): void {
  if (!graph.nodes.has(node.id)) graph.nodes.set(node.id, node);
}

function addEdge(graph: KnowledgeGraph, edge: GraphEdge): void {
  graph.edges.push(edge);
}

export function buildKnowledgeGraph(sessions: readonly CompressedSession[]): KnowledgeGraph {
  const graph: KnowledgeGraph = { nodes: new Map(), edges: [] };
  const rows = sessions.slice(0, MAX_SESSIONS);
  const ids = new Set(rows.map((session) => session.id));
  for (const session of rows) {
    const sessionNode = `session:${session.id}`;
    addNode(graph, {
      id: sessionNode,
      kind: 'session',
      label: `[${session.observationType}] ${session.summary.slice(0, 80)}`,
    });
    for (const file of session.keyFiles) {
      const fileNode = `file:${file}`;
      addNode(graph, { id: fileNode, kind: 'file', label: file });
      addEdge(graph, { from: sessionNode, to: fileNode, kind: 'touched' });
    }
    for (const [index, decision] of session.decisions.entries()) {
      const decisionNode = `decision:${session.id}:${index}`;
      addNode(graph, { id: decisionNode, kind: 'decision', label: decision.slice(0, 120) });
      addEdge(graph, { from: sessionNode, to: decisionNode, kind: 'decided' });
      for (const outcome of session.outcomes ?? []) {
        if (outcome.decisionIndex === index) {
          const outcomeNode = `outcome:${session.id}:${index}:${outcome.observedAt}`;
          addNode(graph, {
            id: outcomeNode,
            kind: 'outcome',
            label: `${outcome.status}: ${outcome.observations.join('; ').slice(0, 100)}`,
          });
          addEdge(graph, { from: decisionNode, to: outcomeNode, kind: 'evaluated_by' });
        }
      }
    }
    if (session.supersedes && ids.has(session.supersedes))
      addEdge(graph, {
        from: sessionNode,
        to: `session:${session.supersedes}`,
        kind: 'supersedes',
      });
    if (session.correctionOf && ids.has(session.correctionOf))
      addEdge(graph, {
        from: sessionNode,
        to: `session:${session.correctionOf}`,
        kind: 'corrects',
      });
    for (const pr of parsePrRefs(`${session.summary} ${session.decisions.join(' ')}`)) {
      const prNode = `pr:${pr}`;
      addNode(graph, { id: prNode, kind: 'pr', label: `PR #${pr}` });
      addEdge(graph, { from: sessionNode, to: prNode, kind: 'referenced_pr' });
    }
  }
  return graph;
}

export interface Neighborhood {
  center: GraphNode;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Undirected breadth-first neighborhood around `nodeId`, bounded by depth and size. */
export function neighborhood(graph: KnowledgeGraph, nodeId: string, depth = 2): Neighborhood {
  const center = graph.nodes.get(nodeId);
  if (!center) throw new Error(`Unknown graph node: ${nodeId}`);
  const boundedDepth = Math.max(1, Math.min(4, depth));
  const seen = new Set<string>([nodeId]);
  let frontier = [nodeId];
  const keptEdges: GraphEdge[] = [];
  for (let step = 0; step < boundedDepth && frontier.length; step++) {
    const next: string[] = [];
    for (const edge of graph.edges) {
      const touchesFrontier = frontier.includes(edge.from) || frontier.includes(edge.to);
      if (!touchesFrontier) continue;
      keptEdges.push(edge);
      for (const endpoint of [edge.from, edge.to]) {
        if (!seen.has(endpoint) && seen.size < 200) {
          seen.add(endpoint);
          next.push(endpoint);
        }
      }
    }
    frontier = next;
  }
  const uniqueEdges = [...new Map(keptEdges.map((e) => [`${e.from}|${e.kind}|${e.to}`, e]))].map(
    ([, e]) => e,
  );
  return {
    center,
    nodes: [...seen].flatMap((id) => {
      const node = graph.nodes.get(id);
      return node ? [node] : [];
    }),
    edges: uniqueEdges.filter((edge) => seen.has(edge.from) && seen.has(edge.to)),
  };
}

/** Shortest undirected path between two nodes (BFS); empty when unconnected. */
export function pathBetween(graph: KnowledgeGraph, fromId: string, toId: string): GraphNode[] {
  if (!graph.nodes.has(fromId) || !graph.nodes.has(toId)) return [];
  const previous = new Map<string, string>([[fromId, '']]);
  let frontier = [fromId];
  while (frontier.length && !previous.has(toId)) {
    const next: string[] = [];
    for (const edge of graph.edges) {
      for (const [a, b] of [
        [edge.from, edge.to],
        [edge.to, edge.from],
      ]) {
        if (frontier.includes(a) && !previous.has(b)) {
          previous.set(b, a);
          next.push(b);
        }
      }
    }
    frontier = next;
  }
  if (!previous.has(toId)) return [];
  const path: GraphNode[] = [];
  for (let cursor = toId; cursor; cursor = previous.get(cursor) ?? '') {
    const node = graph.nodes.get(cursor);
    if (node) path.unshift(node);
  }
  return path;
}

/** Render a neighborhood as a Mermaid flowchart (ids sanitized for Mermaid). */
export function neighborhoodToMermaid(hood: Neighborhood): string {
  const safe = (id: string) => id.replace(/[^a-zA-Z0-9]/g, '_');
  const lines = ['flowchart TD'];
  for (const node of hood.nodes) {
    const label = node.label.replace(/["\n]/g, "'").slice(0, 60);
    lines.push(`  ${safe(node.id)}["${node.kind}: ${label}"]`);
  }
  for (const edge of hood.edges) {
    lines.push(`  ${safe(edge.from)} -->|${edge.kind}| ${safe(edge.to)}`);
  }
  return lines.join('\n');
}
