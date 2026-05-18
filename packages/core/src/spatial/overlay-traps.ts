import type { AnalyzerOptions, FigmaFile, FigmaNode, InteractionAction, Issue, PrototypeGraph } from '../types.js';
import { buildGraph } from '../graph/builder.js';

let counter = 0;

export const overlayTrapAnalyzer = {
  name: 'overlay-traps',

  async analyze(file: FigmaFile, _options: AnalyzerOptions, graph?: PrototypeGraph): Promise<Issue[]> {
    const g = graph ?? buildGraph(file);
    const issues: Issue[] = [];
    counter = 0;

    // Build node lookup cache once — O(N) instead of O(N) per overlay
    const nodeCache = new Map<string, FigmaNode>();
    cacheNodes(file.document, nodeCache);

    // Find all screens that are destinations of OVERLAY navigation
    const overlayDestinations = new Set<string>();
    for (const edges of g.edges.values()) {
      for (const edge of edges) {
        if (edge.navigation === 'OVERLAY') {
          overlayDestinations.add(edge.destinationId);
        }
      }
    }

    // Check each overlay destination for CLOSE or BACK actions
    for (const destId of overlayDestinations) {
      const node = g.nodes.get(destId);
      if (!node) continue;

      // First check graph node flags (fast path)
      if (node.hasBackAction || node.hasCloseAction) continue;

      // Fall back to walking the Figma node tree for nested CLOSE/BACK
      const figmaNode = nodeCache.get(destId);
      const hasExit = figmaNode ? walkForExitActions(figmaNode) : false;

      if (!hasExit) {
        issues.push({
          id: `overlay-trap-${++counter}`,
          category: 'overlay-trap',
          severity: 'critical',
          confidence: 'certain',
          screenId: destId,
          screenName: node.name,
          message: `Overlay "${node.name}" has no CLOSE or BACK action — users will be trapped.`,
          evidence: { openedVia: 'OVERLAY', hasClose: false, hasBack: false },
        });
      }
    }

    return issues;
  },
};

function walkForExitActions(node: FigmaNode): boolean {
  for (const interaction of node.interactions ?? []) {
    if (actionsHaveExit(interaction.actions)) return true;
  }
  for (const child of node.children ?? []) {
    if (walkForExitActions(child)) return true;
  }
  return false;
}

/** Check actions for CLOSE/BACK, recursing into CONDITIONAL blocks */
function actionsHaveExit(actions: InteractionAction[]): boolean {
  for (const action of actions) {
    if (action.type === 'CLOSE' || action.type === 'BACK') return true;
    if (action.type === 'CONDITIONAL' && action.conditionalBlocks) {
      for (const block of action.conditionalBlocks) {
        if (actionsHaveExit(block.actions)) return true;
      }
    }
  }
  return false;
}

/** Build a flat id→node lookup from the document tree */
function cacheNodes(node: FigmaNode, cache: Map<string, FigmaNode>): void {
  cache.set(node.id, node);
  for (const child of node.children ?? []) {
    cacheNodes(child, cache);
  }
}
