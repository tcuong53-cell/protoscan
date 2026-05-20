// ProtoScan Figma Plugin — Prototype QA
// Runs inside Figma's sandbox. No Node.js, no fetch, no external deps.
// Accesses the Figma document directly via the Plugin API.
// 7 checks: dead-end, orphan, back-nav, overlay-trap, touch-target, overlap, scroll

interface PluginIssue {
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: string;
  screenName: string;
  screenId: string;
  message: string;
}

interface ScreenNode {
  id: string;
  name: string;
  sectionName: string | null;
  displayName: string;
  hasOutgoing: boolean;
  hasBackAction: boolean;
  hasCloseAction: boolean;
  isOverlayTarget: boolean;
  incomingCount: number;
}

interface InteractiveElement {
  nodeId: string;
  nodeName: string;
  screenId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

// Collect all screen-like frames from the page, traversing into SECTIONs recursively.
function getTopFrames(page: PageNode): Array<{ node: SceneNode; sectionName: string | null }> {
  const results: Array<{ node: SceneNode; sectionName: string | null }> = [];

  function walkChildren(children: readonly SceneNode[], sectionName: string | null) {
    for (const child of children) {
      if (child.type === 'FRAME' || child.type === 'COMPONENT' || child.type === 'COMPONENT_SET') {
        results.push({ node: child, sectionName });
      } else if (child.type === 'SECTION') {
        walkChildren(child.children, child.name);
      }
    }
  }

  walkChildren(page.children, null);
  return results;
}

// Collect all actions from a node tree
function collectActions(node: SceneNode, callback: (action: Action) => void) {
  if ('reactions' in node && node.reactions) {
    for (const reaction of node.reactions) {
      const actions = reaction.actions ?? (reaction.action ? [reaction.action] : []);
      for (const action of actions) {
        if (action) callback(action);
      }
    }
  }
  if ('children' in node) {
    for (const child of (node as FrameNode).children) {
      collectActions(child, callback);
    }
  }
}

function scanPrototype(): PluginIssue[] {
  const page = figma.currentPage;
  const issues: PluginIssue[] = [];

  const frameEntries = getTopFrames(page);
  const screens = new Map<string, ScreenNode>();

  for (const { node, sectionName } of frameEntries) {
    const displayName = sectionName ? `${node.name} (in ${sectionName})` : node.name;
    screens.set(node.id, {
      id: node.id, name: node.name, sectionName, displayName,
      hasOutgoing: false, hasBackAction: false, hasCloseAction: false,
      isOverlayTarget: false, incomingCount: 0,
    });
  }

  // Collect flow starting points
  const startingPointIds = new Set<string>();
  if (page.flowStartingPoints) {
    for (const sp of page.flowStartingPoints) startingPointIds.add(sp.nodeId);
  }

  // Walk all nodes: collect reactions, touch targets, interactive elements for overlap
  const overlayTargets = new Set<string>();
  const destinationIds = new Set<string>();
  const interactiveElements: InteractiveElement[] = [];

  function walkNode(node: SceneNode, parentScreenId: string | null) {
    if ('reactions' in node && node.reactions) {
      for (const reaction of node.reactions) {
        const actions = reaction.actions ?? (reaction.action ? [reaction.action] : []);
        for (const action of actions) {
          if (!action) continue;
          const screenData = parentScreenId ? screens.get(parentScreenId) : null;

          if (action.type === 'NODE' && action.destinationId) {
            if (screenData) screenData.hasOutgoing = true;
            destinationIds.add(action.destinationId);

            if (action.navigation === 'OVERLAY') {
              overlayTargets.add(action.destinationId);
            }

            // Track interactive element for overlap + touch-target checks
            // Use absoluteRenderBounds (Plugin API) — absoluteBoundingBox is REST-only
            const bb = ('absoluteRenderBounds' in node && node.absoluteRenderBounds)
              ? node.absoluteRenderBounds as { x: number; y: number; width: number; height: number }
              : ('width' in node && 'height' in node)
                ? { x: 0, y: 0, width: (node as any).width, height: (node as any).height }
                : null;
            if (bb) {
              interactiveElements.push({
                nodeId: node.id, nodeName: node.name,
                screenId: parentScreenId ?? node.id,
                x: bb.x, y: bb.y, width: bb.width, height: bb.height,
              });

              // Touch target check
              if (bb.width < 44 || bb.height < 44) {
                issues.push({
                  severity: 'high', category: 'touch-target',
                  screenName: screens.get(parentScreenId ?? '')?.displayName ?? 'Unknown',
                  screenId: parentScreenId ?? node.id,
                  message: `"${node.name}" is ${Math.round(bb.width)}x${Math.round(bb.height)}px (minimum: 44x44px)`,
                });
              }
            }
          } else if (action.type === 'BACK') {
            if (screenData) screenData.hasBackAction = true;
          } else if (action.type === 'CLOSE') {
            if (screenData) screenData.hasCloseAction = true;
          }
        }
      }
    }

    if ('children' in node) {
      for (const child of (node as FrameNode).children) {
        walkNode(child, parentScreenId ?? (screens.has(node.id) ? node.id : null));
      }
    }
  }

  for (const { node } of frameEntries) walkNode(node, node.id);

  // Count incoming connections
  for (const destId of destinationIds) {
    const screen = screens.get(destId);
    if (screen) screen.incomingCount++;
  }
  for (const targetId of overlayTargets) {
    const screen = screens.get(targetId);
    if (screen) screen.isOverlayTarget = true;
  }

  // BFS reachability from starting points
  const reachable = new Set<string>();
  const queue = [...startingPointIds];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    const entry = frameEntries.find((e) => e.node.id === id);
    if (!entry) continue;
    collectActions(entry.node, (action) => {
      if (action.type === 'NODE' && action.destinationId) queue.push(action.destinationId);
    });
  }

  // === Graph checks ===
  for (const [id, screen] of screens) {
    if (!screen.hasOutgoing && !screen.hasBackAction && !screen.hasCloseAction) {
      issues.push({
        severity: 'critical', category: 'dead-end',
        screenName: screen.displayName, screenId: id,
        message: `"${screen.displayName}" has no links, back, or close actions`,
      });
    }

    if (startingPointIds.size > 0 && !reachable.has(id) && !startingPointIds.has(id)) {
      issues.push({
        severity: 'high', category: 'orphan',
        screenName: screen.displayName, screenId: id,
        message: `"${screen.displayName}" can't be reached from any starting point`,
      });
    }

    if (screen.incomingCount > 0 && !screen.hasBackAction && !startingPointIds.has(id)) {
      issues.push({
        severity: 'medium', category: 'back-nav',
        screenName: screen.displayName, screenId: id,
        message: `"${screen.displayName}" — users can't return to previous screen`,
      });
    }

    if (screen.isOverlayTarget && !screen.hasCloseAction && !screen.hasBackAction) {
      issues.push({
        severity: 'critical', category: 'overlay-trap',
        screenName: screen.displayName, screenId: id,
        message: `Overlay "${screen.displayName}" has no close or back — users get stuck`,
      });
    }
  }

  // === Overlap detection ===
  // Group interactive elements by screen, check for intersection
  const MIN_OVERLAP_AREA = 100; // ignore tiny overlaps (shadows, sub-pixel)
  const MAX_OVERLAP_ISSUES = 20;
  const MAX_ELEMENTS_PER_SCREEN = 100;
  let overlapCount = 0;

  const byScreen = new Map<string, InteractiveElement[]>();
  for (const el of interactiveElements) {
    const arr = byScreen.get(el.screenId) ?? [];
    arr.push(el);
    byScreen.set(el.screenId, arr);
  }
  for (const [screenId, elements] of byScreen) {
    if (elements.length > MAX_ELEMENTS_PER_SCREEN) continue;
    for (let i = 0; i < elements.length && overlapCount < MAX_OVERLAP_ISSUES; i++) {
      for (let j = i + 1; j < elements.length && overlapCount < MAX_OVERLAP_ISSUES; j++) {
        const a = elements[i], b = elements[j];
        const overlapX = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
        const overlapY = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
        const area = overlapX * overlapY;
        if (area >= MIN_OVERLAP_AREA) {
          issues.push({
            severity: 'medium', category: 'overlap',
            screenName: screens.get(screenId)?.displayName ?? 'Unknown',
            screenId,
            message: `"${a.nodeName}" and "${b.nodeName}" have overlapping tap areas (${Math.round(area)}px²) — users may trigger the wrong action`,
          });
          overlapCount++;
        }
      }
    }
  }

  // === Scroll detection ===
  // Check if frame content extends beyond bounds without scroll enabled
  const SCROLL_THRESHOLD = 44; // ignore minor overflow (shadows, decorative elements)
  for (const { node } of frameEntries) {
    if (node.type !== 'FRAME') continue;
    const frame = node as FrameNode;
    if (frame.overflowDirection && frame.overflowDirection !== 'NONE') continue;
    if (!('children' in frame) || frame.children.length === 0) continue;

    let maxChildBottom = 0;
    for (const child of frame.children) {
      if (!('visible' in child) || !(child as any).visible) continue; // skip hidden layers
      if ('y' in child && 'height' in child) {
        maxChildBottom = Math.max(maxChildBottom, (child as any).y + (child as any).height);
      }
    }

    const overflow = maxChildBottom - frame.height;
    if (overflow > SCROLL_THRESHOLD) {
      issues.push({
        severity: 'medium', category: 'scroll',
        screenName: screens.get(node.id)?.displayName ?? node.name,
        screenId: node.id,
        message: `"${node.name}" has content extending ${Math.round(overflow)}px beyond frame — scroll not enabled`,
      });
    }
  }

  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  issues.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
  return issues;
}

function buildStats(issues: PluginIssue[]) {
  return {
    screens: getTopFrames(figma.currentPage).length,
    startingPoints: figma.currentPage.flowStartingPoints?.length ?? 0,
    totalIssues: issues.length,
    bySeverity: {
      critical: issues.filter((i) => i.severity === 'critical').length,
      high: issues.filter((i) => i.severity === 'high').length,
      medium: issues.filter((i) => i.severity === 'medium').length,
      low: issues.filter((i) => i.severity === 'low').length,
    },
  };
}

// Plugin entry point
figma.showUI(__html__, { width: 440, height: 520, themeColors: true });

setTimeout(() => {
  const issues = scanPrototype();
  figma.ui.postMessage({ type: 'scan-results', issues, stats: buildStats(issues) });
}, 100);

figma.ui.onmessage = (msg: { type: string; nodeId?: string }) => {
  if (msg.type === 'focus-node' && msg.nodeId) {
    const entry = getTopFrames(figma.currentPage).find((e) => e.node.id === msg.nodeId);
    if (entry) {
      try {
        figma.viewport.scrollAndZoomIntoView([entry.node]);
        figma.currentPage.selection = [entry.node];
      } catch { /* node deleted */ }
    }
  } else if (msg.type === 'rescan') {
    const issues = scanPrototype();
    figma.ui.postMessage({ type: 'scan-results', issues, stats: buildStats(issues) });
  } else if (msg.type === 'close') {
    figma.closePlugin();
  }
};
