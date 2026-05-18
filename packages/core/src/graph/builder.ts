import type {
  FigmaFile,
  FigmaNode,
  FlowStartingPoint,
  GraphEdge,
  GraphNode,
  InteractionAction,
  PrototypeGraph,
} from '../types.js';
import { isNonPrototypeFrame, TAB_ROOT_CHILD_PATTERN } from '../utils/filters.js';

/**
 * Build a directed graph from Figma file interactions.
 * Single-pass: walks the document tree, collects screens as nodes,
 * and creates edges from prototype interactions in O(N).
 */

export interface BuildGraphOptions {
  /** Only scan these page IDs (default: auto-detect prototype pages) */
  pageIds?: string[];
}

export function buildGraph(file: FigmaFile, options?: BuildGraphOptions): PrototypeGraph {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge[]>();
  const startingPoints: FlowStartingPoint[] = [];

  const pages = file.document.children ?? [];
  const filteredPages = filterPages(pages, options?.pageIds);

  for (const page of filteredPages) {
    if (page.flowStartingPoints) {
      startingPoints.push(...page.flowStartingPoints);
    }

    collectScreens(page, page.id, undefined, undefined, nodes, edges);
  }

  // Mark flow starting points and tab-bar roots on collected nodes
  for (const sp of startingPoints) {
    const node = nodes.get(sp.nodeId);
    if (node) node.isFlowStartingPoint = true;
  }

  return { nodes, edges, startingPoints };
}

/** Filter pages: explicit IDs > auto-detect (skip non-prototype pages) */
function filterPages(pages: FigmaNode[], pageIds?: string[]): FigmaNode[] {
  // Explicit filter: user passed --pages
  if (pageIds?.length) {
    return pages.filter((p) => pageIds.includes(p.id));
  }

  // Auto-detect: if any page looks like a design/prototype page, skip non-prototype pages
  const hasPrototypePage = pages.some((p) => !isNonPrototypeFrame(p.name));
  if (hasPrototypePage && pages.length > 1) {
    const filtered = pages.filter((p) => !isNonPrototypeFrame(p.name));
    if (filtered.length > 0) return filtered;
  }

  // Fallback: scan everything
  return pages;
}

/** Recursively find screens inside pages, traversing SECTION nodes */
function collectScreens(
  parent: FigmaNode,
  pageId: string,
  sectionId: string | undefined,
  sectionName: string | undefined,
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge[]>,
): void {
  for (const child of parent.children ?? []) {
    if (child.type === 'SECTION') {
      // Skip sections that look like DS/annotation/inspection areas
      if (isNonPrototypeFrame(child.name)) continue;
      collectScreens(child, pageId, child.id, child.name, nodes, edges);
    } else if (child.type === 'FRAME' || child.type === 'COMPONENT' || child.type === 'COMPONENT_SET') {
      // Skip frames whose names match non-prototype patterns
      if (isNonPrototypeFrame(child.name)) continue;

      const ARCHIVED_PATTERN = /\b(archived?|deprecated|old|legacy)\b/i;
      const isTabRoot = detectTabRoot(child);

      nodes.set(child.id, {
        id: child.id,
        name: child.name,
        pageId,
        sectionId,
        sectionName,
        type: child.type,
        hasInteractions: false,
        hasBackAction: false,
        hasCloseAction: false,
        nullDestinationCount: 0,
        isArchived: ARCHIVED_PATTERN.test(child.name),
        isFlowStartingPoint: false,
        isTabRoot,
        boundingBox: child.absoluteBoundingBox,
      });
      collectInteractions(child, child.id, nodes, edges);
    }
  }
}

/** Detect if a frame is a tab-bar root by checking direct children for BottomNav component */
function detectTabRoot(frame: FigmaNode): boolean {
  for (const child of frame.children ?? []) {
    if (TAB_ROOT_CHILD_PATTERN.test(child.name)) return true;
  }
  return false;
}

/** Single-pass walk: collect interactions and build edges, tracking parent screen */
function collectInteractions(
  node: FigmaNode,
  screenId: string,
  nodes: Map<string, GraphNode>,
  edges: Map<string, GraphEdge[]>,
): void {
  if (node.interactions?.length) {
    const screenNode = nodes.get(screenId);
    if (screenNode) screenNode.hasInteractions = true;

    for (const interaction of node.interactions) {
      markBackCloseActions(screenId, interaction.actions, nodes);
      countNullDestinations(screenId, interaction.actions, nodes);

      const extracted = extractEdges(
        screenId,
        nodes.get(screenId)?.name ?? '',
        interaction.trigger.type,
        interaction.actions,
        node.absoluteBoundingBox,
      );

      const existing = edges.get(screenId) ?? [];
      existing.push(...extracted);
      edges.set(screenId, existing);
    }
  }

  for (const child of node.children ?? []) {
    collectInteractions(child, screenId, nodes, edges);
  }
}

/** Count interactions with null destinationId (incomplete prototyping) */
function countNullDestinations(
  screenId: string,
  actions: InteractionAction[],
  nodes: Map<string, GraphNode>,
): void {
  const node = nodes.get(screenId);
  if (!node) return;

  for (const action of actions) {
    if (action.type === 'NODE' && action.navigation && !action.destinationId) {
      node.nullDestinationCount++;
    }
    if (action.type === 'CONDITIONAL' && action.conditionalBlocks) {
      for (const block of action.conditionalBlocks) {
        countNullDestinations(screenId, block.actions, nodes);
      }
    }
  }
}

/** Mark screens that have BACK or CLOSE actions (these aren't edges but provide exits) */
function markBackCloseActions(
  screenId: string,
  actions: InteractionAction[],
  nodes: Map<string, GraphNode>,
): void {
  const node = nodes.get(screenId);
  if (!node) return;

  for (const action of actions) {
    if (action.type === 'BACK') node.hasBackAction = true;
    if (action.type === 'CLOSE') node.hasCloseAction = true;
    if (action.type === 'CONDITIONAL' && action.conditionalBlocks) {
      for (const block of action.conditionalBlocks) {
        markBackCloseActions(screenId, block.actions, nodes);
      }
    }
  }
}

/** Extract graph edges from interaction actions, handling CONDITIONAL recursion */
function extractEdges(
  sourceNodeId: string,
  sourceNodeName: string,
  trigger: string,
  actions: InteractionAction[],
  sourceElementBoundingBox?: import('../types.js').BoundingBox,
): GraphEdge[] {
  const edges: GraphEdge[] = [];

  for (const action of actions) {
    if (action.type === 'CONDITIONAL' && action.conditionalBlocks) {
      for (const block of action.conditionalBlocks) {
        edges.push(...extractEdges(sourceNodeId, sourceNodeName, trigger, block.actions, sourceElementBoundingBox));
      }
      continue;
    }

    if (action.destinationId && action.navigation) {
      edges.push({
        sourceNodeId,
        sourceNodeName,
        destinationId: action.destinationId,
        navigation: action.navigation,
        trigger,
        actionType: action.type,
        sourceElementBoundingBox,
      });
    }
  }

  return edges;
}
