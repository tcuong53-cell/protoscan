// ProtoScan Figma Plugin — Prototype QA
// Runs inside Figma's sandbox. No Node.js, no fetch, no external deps.
// Accesses the Figma document directly via the Plugin API.

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

// Collect all screen-like frames from the page, traversing into SECTIONs recursively.
// Returns frames + components that can participate in prototype flows.
function getTopFrames(page: PageNode): Array<{ node: SceneNode; sectionName: string | null }> {
  const results: Array<{ node: SceneNode; sectionName: string | null }> = [];

  function isScreenNode(n: SceneNode): boolean {
    return n.type === 'FRAME' || n.type === 'COMPONENT' || n.type === 'COMPONENT_SET';
  }

  function walkChildren(children: readonly SceneNode[], sectionName: string | null) {
    for (const child of children) {
      if (isScreenNode(child)) {
        results.push({ node: child, sectionName });
      } else if (child.type === 'SECTION') {
        // Recurse into nested sections
        walkChildren(child.children, child.name);
      }
    }
  }

  walkChildren(page.children, null);
  return results;
}

// Collect destinations from a node tree (reusable for walkNode and BFS)
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

  // Collect screens (frames + components, including inside SECTIONs)
  const frameEntries = getTopFrames(page);
  const screens = new Map<string, ScreenNode>();

  for (const { node, sectionName } of frameEntries) {
    const displayName = sectionName ? `${node.name} (in ${sectionName})` : node.name;
    screens.set(node.id, {
      id: node.id,
      name: node.name,
      sectionName,
      displayName,
      hasOutgoing: false,
      hasBackAction: false,
      hasCloseAction: false,
      isOverlayTarget: false,
      incomingCount: 0,
    });
  }

  // Collect flow starting points
  const startingPointIds = new Set<string>();
  if (page.flowStartingPoints) {
    for (const sp of page.flowStartingPoints) {
      startingPointIds.add(sp.nodeId);
    }
  }

  // Walk all nodes and collect reactions (prototype connections)
  const overlayTargets = new Set<string>();
  const destinationIds = new Set<string>();

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

            // Check touch target size — only on nodes with explicit dimensions
            if ('width' in node && 'height' in node) {
              const n = node as SceneNode & { width: number; height: number };
              if (n.width < 44 || n.height < 44) {
                issues.push({
                  severity: 'high',
                  category: 'touch-target',
                  screenName: screens.get(parentScreenId ?? '')?.displayName ?? 'Unknown',
                  screenId: parentScreenId ?? node.id,
                  message: `Touch target too small: "${node.name}" is ${Math.round(n.width)}x${Math.round(n.height)}px (min 44x44)`,
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

  for (const { node } of frameEntries) {
    walkNode(node, node.id);
  }

  // Count incoming connections
  for (const destId of destinationIds) {
    const screen = screens.get(destId);
    if (screen) screen.incomingCount++;
  }

  // Mark overlay targets
  for (const targetId of overlayTargets) {
    const screen = screens.get(targetId);
    if (screen) screen.isOverlayTarget = true;
  }

  // BFS from starting points to find reachable screens
  const reachable = new Set<string>();
  const queue = [...startingPointIds];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (reachable.has(id)) continue;
    reachable.add(id);

    const entry = frameEntries.find((e) => e.node.id === id);
    if (!entry) continue;

    collectActions(entry.node, (action) => {
      if (action.type === 'NODE' && action.destinationId) {
        queue.push(action.destinationId);
      }
    });
  }

  // Detect issues with user-friendly messages (using displayName for section context)
  for (const [id, screen] of screens) {
    if (!screen.hasOutgoing && !screen.hasBackAction && !screen.hasCloseAction) {
      issues.push({
        severity: 'critical',
        category: 'dead-end',
        screenName: screen.displayName,
        screenId: id,
        message: `No way out: "${screen.displayName}" has no links, back, or close actions`,
      });
    }

    if (startingPointIds.size > 0 && !reachable.has(id) && !startingPointIds.has(id)) {
      issues.push({
        severity: 'high',
        category: 'orphan',
        screenName: screen.displayName,
        screenId: id,
        message: `Unreachable: "${screen.displayName}" can't be reached from any starting point`,
      });
    }

    if (screen.incomingCount > 0 && !screen.hasBackAction && !startingPointIds.has(id)) {
      issues.push({
        severity: 'medium',
        category: 'back-nav',
        screenName: screen.displayName,
        screenId: id,
        message: `No back button: "${screen.displayName}" — users can't return to previous screen`,
      });
    }

    if (screen.isOverlayTarget && !screen.hasCloseAction && !screen.hasBackAction) {
      issues.push({
        severity: 'critical',
        category: 'overlay-trap',
        screenName: screen.displayName,
        screenId: id,
        message: `Overlay trap: "${screen.displayName}" has no close or back — users get stuck`,
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

// Delay initial scan to let UI mount its onmessage handler
setTimeout(() => {
  const issues = scanPrototype();
  figma.ui.postMessage({ type: 'scan-results', issues, stats: buildStats(issues) });
}, 100);

// Handle messages from UI
figma.ui.onmessage = (msg: { type: string; nodeId?: string }) => {
  if (msg.type === 'focus-node' && msg.nodeId) {
    const targetId = msg.nodeId;
    const entry = getTopFrames(figma.currentPage).find((e) => e.node.id === targetId);
    if (entry) {
      try {
        figma.viewport.scrollAndZoomIntoView([entry.node]);
        figma.currentPage.selection = [entry.node];
      } catch (_e) {
        // Node may have been deleted — silently ignore
      }
    }
  } else if (msg.type === 'rescan') {
    const newIssues = scanPrototype();
    figma.ui.postMessage({ type: 'scan-results', issues: newIssues, stats: buildStats(newIssues) });
  } else if (msg.type === 'close') {
    figma.closePlugin();
  }
};
