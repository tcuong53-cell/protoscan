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
  hasOutgoing: boolean;
  hasBackAction: boolean;
  hasCloseAction: boolean;
  isOverlayTarget: boolean;
  incomingCount: number;
  width: number;
  height: number;
}

function scanPrototype(): PluginIssue[] {
  const page = figma.currentPage;
  const issues: PluginIssue[] = [];

  // Collect top-level frames as screens
  const screens = new Map<string, ScreenNode>();
  const topFrames = page.children.filter(
    (n): n is FrameNode => n.type === 'FRAME',
  );

  for (const frame of topFrames) {
    screens.set(frame.id, {
      id: frame.id,
      name: frame.name,
      hasOutgoing: false,
      hasBackAction: false,
      hasCloseAction: false,
      isOverlayTarget: false,
      incomingCount: 0,
      width: frame.width,
      height: frame.height,
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
    // Check reactions on this node
    if ('reactions' in node && node.reactions) {
      for (const reaction of node.reactions) {
        const actions = reaction.actions ?? (reaction.action ? [reaction.action] : []);
        for (const action of actions) {
          if (!action) continue;

          const screenData = parentScreenId ? screens.get(parentScreenId) : null;

          if (action.type === 'NODE' && action.destinationId) {
            // NAVIGATE action
            if (screenData) screenData.hasOutgoing = true;
            destinationIds.add(action.destinationId);

            // Track overlay targets
            if (action.navigation === 'OVERLAY') {
              overlayTargets.add(action.destinationId);
            }

            // Check touch target size
            if ('width' in node && 'height' in node) {
              const w = (node as FrameNode).width;
              const h = (node as FrameNode).height;
              if (w < 44 || h < 44) {
                issues.push({
                  severity: 'high',
                  category: 'touch-target',
                  screenName: screens.get(parentScreenId ?? '')?.name ?? 'Unknown',
                  screenId: parentScreenId ?? node.id,
                  message: `"${node.name}" is ${Math.round(w)}×${Math.round(h)}px — below 44×44px minimum touch target`,
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

    // Recurse into children
    if ('children' in node) {
      for (const child of (node as FrameNode).children) {
        walkNode(child, parentScreenId ?? (screens.has(node.id) ? node.id : null));
      }
    }
  }

  for (const frame of topFrames) {
    walkNode(frame, frame.id);
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
    // Find all destinations from this screen's nodes
    const frame = topFrames.find((f) => f.id === id);
    if (!frame) continue;
    const frameDestinations = new Set<string>();
    function collectDests(node: SceneNode) {
      if ('reactions' in node && node.reactions) {
        for (const reaction of node.reactions) {
          const actions = reaction.actions ?? (reaction.action ? [reaction.action] : []);
          for (const action of actions) {
            if (action?.type === 'NODE' && action.destinationId) {
              frameDestinations.add(action.destinationId);
            }
          }
        }
      }
      if ('children' in node) {
        for (const child of (node as FrameNode).children) collectDests(child);
      }
    }
    collectDests(frame);
    for (const destId of frameDestinations) queue.push(destId);
  }

  // Detect issues
  for (const [id, screen] of screens) {
    // Dead-end: no outgoing connections and no back/close
    if (!screen.hasOutgoing && !screen.hasBackAction && !screen.hasCloseAction) {
      issues.push({
        severity: 'critical',
        category: 'dead-end',
        screenName: screen.name,
        screenId: id,
        message: `"${screen.name}" has no outgoing connections — users get stuck here`,
      });
    }

    // Orphan: not reachable from any starting point (only if starting points exist)
    if (startingPointIds.size > 0 && !reachable.has(id) && !startingPointIds.has(id)) {
      issues.push({
        severity: 'high',
        category: 'orphan',
        screenName: screen.name,
        screenId: id,
        message: `"${screen.name}" is unreachable from any flow starting point`,
      });
    }

    // Missing back navigation: has incoming but no back/close and is not a starting point
    if (screen.incomingCount > 0 && !screen.hasBackAction && !startingPointIds.has(id)) {
      issues.push({
        severity: 'medium',
        category: 'back-nav',
        screenName: screen.name,
        screenId: id,
        message: `"${screen.name}" has no back navigation — users can't return`,
      });
    }

    // Overlay trap: is an overlay target but has no close/back
    if (screen.isOverlayTarget && !screen.hasCloseAction && !screen.hasBackAction) {
      issues.push({
        severity: 'critical',
        category: 'overlay-trap',
        screenName: screen.name,
        screenId: id,
        message: `"${screen.name}" is an overlay with no close/back action — traps the user`,
      });
    }
  }

  // Sort by severity
  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  issues.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return issues;
}

// Plugin entry point
figma.showUI(__html__, { width: 400, height: 500, themeColors: true });

// Run scan immediately
const issues = scanPrototype();
const screenCount = figma.currentPage.children.filter((n) => n.type === 'FRAME').length;
const startingPoints = figma.currentPage.flowStartingPoints?.length ?? 0;

figma.ui.postMessage({
  type: 'scan-results',
  issues,
  stats: {
    screens: screenCount,
    startingPoints,
    totalIssues: issues.length,
    bySeverity: {
      critical: issues.filter((i) => i.severity === 'critical').length,
      high: issues.filter((i) => i.severity === 'high').length,
      medium: issues.filter((i) => i.severity === 'medium').length,
      low: issues.filter((i) => i.severity === 'low').length,
    },
  },
});

// Handle messages from UI
figma.ui.onmessage = (msg: { type: string; nodeId?: string }) => {
  if (msg.type === 'focus-node' && msg.nodeId) {
    const node = figma.getNodeById(msg.nodeId);
    if (node && 'x' in node) {
      figma.viewport.scrollAndZoomIntoView([node as SceneNode]);
      figma.currentPage.selection = [node as SceneNode];
    }
  } else if (msg.type === 'rescan') {
    const newIssues = scanPrototype();
    const newScreenCount = figma.currentPage.children.filter((n) => n.type === 'FRAME').length;
    figma.ui.postMessage({
      type: 'scan-results',
      issues: newIssues,
      stats: {
        screens: newScreenCount,
        startingPoints: figma.currentPage.flowStartingPoints?.length ?? 0,
        totalIssues: newIssues.length,
        bySeverity: {
          critical: newIssues.filter((i) => i.severity === 'critical').length,
          high: newIssues.filter((i) => i.severity === 'high').length,
          medium: newIssues.filter((i) => i.severity === 'medium').length,
          low: newIssues.filter((i) => i.severity === 'low').length,
        },
      },
    });
  } else if (msg.type === 'close') {
    figma.closePlugin();
  }
};
