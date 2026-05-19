import type { AnalyzerOptions, FigmaFile, Issue, PrototypeGraph } from '../types.js';
import { buildGraph } from './builder.js';
import { STATE_VARIANT_PATTERN } from '../utils/filters.js';

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

/** Build a set of node IDs that are overlay destinations */
function getOverlayTargets(graph: PrototypeGraph): Set<string> {
  const targets = new Set<string>();
  for (const edges of graph.edges.values()) {
    for (const edge of edges) {
      if (edge.navigation === 'OVERLAY') targets.add(edge.destinationId);
    }
  }
  return targets;
}

/** Screens with no outgoing edges (no way to navigate away) */
function detectDeadEnds(graph: PrototypeGraph): Issue[] {
  const issues: Issue[] = [];
  const overlayTargets = getOverlayTargets(graph);

  for (const [nodeId, node] of graph.nodes) {
    const outgoing = graph.edges.get(nodeId) ?? [];

    // A screen has an exit if it has outgoing edges OR a BACK/CLOSE action
    const hasOutgoing = outgoing.length > 0;
    if (hasOutgoing || node.hasBackAction || node.hasCloseAction) continue;

    // Only flag screens that are destinations (reachable) but have no way out
    const isDestination = isScreenADestination(nodeId, graph);
    if (!isDestination && !node.hasInteractions) continue;

    // Smart heuristics: overlay targets close via tap-outside in Figma — not real dead-ends
    const isOverlay = overlayTargets.has(nodeId);

    // Fully disconnected frames (0 incoming, 0 outgoing, not a starting point) = spec/doc frames
    const isDisconnected = !isDestination && !node.isFlowStartingPoint;

    // Determine confidence based on heuristics
    const confidence = isOverlay || isDisconnected || STATE_VARIANT_PATTERN.test(node.name)
      ? 'low' as const
      : 'certain' as const;

    issues.push({
      id: nextId('dead-end'),
      category: 'dead-end',
      severity: confidence === 'low' ? 'medium' : 'critical',
      confidence,
      screenId: nodeId,
      screenName: node.name,
      message: isOverlay
        ? `Overlay "${node.name}" has no explicit close — users dismiss via tap-outside (likely OK).`
        : `Screen "${node.name}" has no outgoing interactions — users will get stuck here.`,
      evidence: { outgoingEdges: 0, isDestination, isOverlay, isDisconnected },
    });
  }

  return issues;
}

/** Screens unreachable from any flow starting point */
function detectOrphans(graph: PrototypeGraph): Issue[] {
  const issues: Issue[] = [];

  if (graph.startingPoints.length === 0) {
    // No flow starting points — can't determine orphans reliably
    if (graph.nodes.size > 0) {
      issues.push({
        id: nextId('orphan'),
        category: 'orphan',
        severity: 'medium',
        confidence: 'probable',
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

  // Flag unreachable screens
  for (const [nodeId, node] of graph.nodes) {
    if (!reachable.has(nodeId)) {
      // Archived screens: low severity + low confidence
      // Screens with no interactions at all: probably DS leftovers → low confidence
      // State variant screens (error/skeleton/loading/platform): probably documentation → low confidence
      const isLikelyDS = !node.hasInteractions && !node.isArchived;
      const isStateVariant = STATE_VARIANT_PATTERN.test(node.name);
      const severity = node.isArchived ? 'low' : 'high';
      const confidence = node.isArchived || isLikelyDS || isStateVariant ? 'low' : 'certain';

      issues.push({
        id: nextId('orphan'),
        category: 'orphan',
        severity,
        confidence,
        screenId: nodeId,
        screenName: node.name,
        message: node.isArchived
          ? `Archived screen "${node.name}" is unreachable (expected for archived screens).`
          : `Screen "${node.name}" is unreachable from any flow starting point.`,
        evidence: {
          reachableScreens: reachable.size,
          totalScreens: graph.nodes.size,
          isArchived: node.isArchived,
          hasInteractions: node.hasInteractions,
        },
      });
    }
  }

  return issues;
}

/** Screens that are navigated to but have no BACK action */
function detectMissingBackNav(graph: PrototypeGraph): Issue[] {
  const issues: Issue[] = [];

  // Collect all destination screens via NAVIGATE action, tracking inDegree
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
    // Skip designated flow starting points
    if (startingDestinations.has(destId)) continue;

    const destNode = graph.nodes.get(destId);
    if (!destNode) continue;

    // Skip screens that are themselves flow starting points (e.g. first onboarding slide
    // navigated to from a previous session or another flow)
    if (destNode.isFlowStartingPoint) continue;

    // Check if this screen has a BACK or CLOSE action
    const hasBack = destNode.hasBackAction || destNode.hasCloseAction;

    // Check if there's a direct edge back to any source
    const outgoing = graph.edges.get(destId) ?? [];
    const hasDirectReturn = outgoing.some((e) => sourceIds.includes(e.destinationId));

    if (!hasBack && !hasDirectReturn) {
      // Tab-bar roots and high-inDegree hub screens: downgrade to low confidence
      const isHubScreen = sourceIds.length > 3;
      const confidence = destNode.isTabRoot || isHubScreen ? 'low' : 'probable';

      issues.push({
        id: nextId('back-nav'),
        category: 'back-nav',
        severity: 'medium',
        confidence,
        screenId: destId,
        screenName: destNode.name,
        message: `Screen "${destNode.name}" has no back navigation to return to the previous screen.`,
        evidence: {
          navigatedFrom: sourceIds.map((id) => graph.nodes.get(id)?.name ?? id),
          hasBackAction: false,
          hasDirectReturn: false,
          isTabRoot: destNode.isTabRoot,
          inDegree: sourceIds.length,
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
        confidence: node.isArchived ? 'low' : 'certain',
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
