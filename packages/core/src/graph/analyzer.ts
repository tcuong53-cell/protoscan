import type { AnalyzerOptions, FigmaFile, Issue, PrototypeGraph } from '../types.js';
import { buildGraph } from './builder.js';

let issueCounter = 0;
function nextId(category: string): string {
  return `${category}-${++issueCounter}`;
}

/** Reset counter between scans */
export function resetIssueCounter(): void {
  issueCounter = 0;
}

export const graphAnalyzer = {
  name: 'graph',

  async analyze(file: FigmaFile, options: AnalyzerOptions, graph?: PrototypeGraph): Promise<Issue[]> {
    issueCounter = 0;
    const g = graph ?? buildGraph(file);
    const skip = new Set(options.skip ?? []);
    const issues: Issue[] = [];

    if (!skip.has('dead-end')) issues.push(...detectDeadEnds(g));
    if (!skip.has('orphan')) issues.push(...detectOrphans(g));
    if (!skip.has('back-nav')) issues.push(...detectMissingBackNav(g));
    if (!skip.has('incomplete-connection')) issues.push(...detectIncompleteConnections(g));

    return issues;
  },
};

/** Screens with no outgoing edges (no way to navigate away) */
function detectDeadEnds(graph: PrototypeGraph): Issue[] {
  const issues: Issue[] = [];

  for (const [nodeId, node] of graph.nodes) {
    const outgoing = graph.edges.get(nodeId) ?? [];

    // A screen has an exit if it has outgoing edges OR a BACK/CLOSE action
    const hasOutgoing = outgoing.length > 0;
    if (hasOutgoing || node.hasBackAction || node.hasCloseAction) continue;

    // Only flag screens that are destinations (reachable) but have no way out
    const isDestination = isScreenADestination(nodeId, graph);
    if (!isDestination && !node.hasInteractions) continue;

    issues.push({
      id: nextId('dead-end'),
      category: 'dead-end',
      severity: 'critical',
      screenId: nodeId,
      screenName: node.name,
      message: `Screen "${node.name}" has no outgoing interactions — users will get stuck here.`,
      evidence: { outgoingEdges: 0, isDestination },
    });
  }

  return issues;
}

/** Screens unreachable from any flow starting point */
function detectOrphans(graph: PrototypeGraph): Issue[] {
  const issues: Issue[] = [];

  if (graph.startingPoints.length === 0) {
    // No flow starting points — can't determine orphans reliably
    // Return a warning-level issue instead
    if (graph.nodes.size > 0) {
      issues.push({
        id: nextId('orphan'),
        category: 'orphan',
        severity: 'medium',
        screenId: '',
        screenName: '',
        message: 'No flow starting points defined — orphan detection may be incomplete. Add starting points in Figma prototype settings.',
        evidence: { startingPoints: 0, totalScreens: graph.nodes.size },
      });
    }
    return issues;
  }

  // BFS from all starting points
  const reachable = new Set<string>();
  const queue: string[] = [];

  for (const sp of graph.startingPoints) {
    if (graph.nodes.has(sp.nodeId)) {
      queue.push(sp.nodeId);
      reachable.add(sp.nodeId);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    const outgoing = graph.edges.get(current) ?? [];

    for (const edge of outgoing) {
      if (!reachable.has(edge.destinationId) && graph.nodes.has(edge.destinationId)) {
        reachable.add(edge.destinationId);
        queue.push(edge.destinationId);
      }
    }
  }

  // Flag unreachable screens (archived screens get downgraded to low)
  for (const [nodeId, node] of graph.nodes) {
    if (!reachable.has(nodeId)) {
      issues.push({
        id: nextId('orphan'),
        category: 'orphan',
        severity: node.isArchived ? 'low' : 'high',
        screenId: nodeId,
        screenName: node.name,
        message: node.isArchived
          ? `Archived screen "${node.name}" is unreachable (expected for archived screens).`
          : `Screen "${node.name}" is unreachable from any flow starting point.`,
        evidence: {
          reachableScreens: reachable.size,
          totalScreens: graph.nodes.size,
          isArchived: node.isArchived,
        },
      });
    }
  }

  return issues;
}

/** Screens that are navigated to but have no BACK action */
function detectMissingBackNav(graph: PrototypeGraph): Issue[] {
  const issues: Issue[] = [];

  // Collect all destination screens via NAVIGATE action
  const navigateDestinations = new Map<string, string[]>(); // destId → [sourceIds]

  for (const [sourceId, edges] of graph.edges) {
    for (const edge of edges) {
      if (edge.navigation === 'NAVIGATE' && graph.nodes.has(edge.destinationId)) {
        const sources = navigateDestinations.get(edge.destinationId) ?? [];
        sources.push(sourceId);
        navigateDestinations.set(edge.destinationId, sources);
      }
    }
  }

  // Exclude flow starting point destinations (first screen doesn't need BACK)
  const startingDestinations = new Set(graph.startingPoints.map((sp) => sp.nodeId));

  for (const [destId, sourceIds] of navigateDestinations) {
    if (startingDestinations.has(destId)) continue;

    const destNode = graph.nodes.get(destId);
    if (!destNode) continue;

    // Check if this screen has a BACK or CLOSE action (tracked on GraphNode, not edges)
    const hasBack = destNode.hasBackAction || destNode.hasCloseAction;

    // Check if there's a direct edge back to any source
    const outgoing = graph.edges.get(destId) ?? [];
    const hasDirectReturn = outgoing.some((e) => sourceIds.includes(e.destinationId));

    if (!hasBack && !hasDirectReturn) {
      issues.push({
        id: nextId('back-nav'),
        category: 'back-nav',
        severity: 'medium',
        screenId: destId,
        screenName: destNode.name,
        message: `Screen "${destNode.name}" has no back navigation to return to the previous screen.`,
        evidence: {
          navigatedFrom: sourceIds.map((id) => graph.nodes.get(id)?.name ?? id),
          hasBackAction: false,
          hasDirectReturn: false,
        },
      });
    }
  }

  return issues;
}

/** Screens with interactions that have null destinations (incomplete prototyping) */
function detectIncompleteConnections(graph: PrototypeGraph): Issue[] {
  const issues: Issue[] = [];

  for (const [nodeId, node] of graph.nodes) {
    if (node.nullDestinationCount > 0) {
      issues.push({
        id: nextId('incomplete-connection'),
        category: 'incomplete-connection',
        severity: node.isArchived ? 'low' : 'medium',
        screenId: nodeId,
        screenName: node.name,
        message: `Screen "${node.name}" has ${node.nullDestinationCount} interaction(s) with no destination — prototyping is incomplete.`,
        evidence: {
          nullDestinations: node.nullDestinationCount,
          isArchived: node.isArchived,
        },
      });
    }
  }

  return issues;
}

function isScreenADestination(nodeId: string, graph: PrototypeGraph): boolean {
  for (const edges of graph.edges.values()) {
    for (const edge of edges) {
      if (edge.destinationId === nodeId) return true;
    }
  }
  // Also check if it's a starting point destination
  return graph.startingPoints.some((sp) => sp.nodeId === nodeId);
}
