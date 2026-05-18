import type { AnalyzerOptions, FigmaFile, FigmaNode, Issue } from '../types.js';

let counter = 0;

export const scrollAnalyzer = {
  name: 'scroll',

  async analyze(file: FigmaFile, _options: AnalyzerOptions): Promise<Issue[]> {
    const issues: Issue[] = [];
    counter = 0;

    for (const page of file.document.children ?? []) {
      for (const frame of page.children ?? []) {
        if (frame.type === 'FRAME' || frame.type === 'COMPONENT' || frame.type === 'COMPONENT_SET') {
          checkScroll(frame, frame.id, frame.name, issues);
        }
      }
    }

    return issues;
  },
};

function checkScroll(
  node: FigmaNode,
  screenId: string,
  screenName: string,
  issues: Issue[],
): void {
  // Only check frames that clip content and don't have scroll enabled
  if (
    node.type === 'FRAME' &&
    node.clipsContent &&
    (!node.overflowDirection || node.overflowDirection === 'NONE') &&
    node.absoluteBoundingBox
  ) {
    const frameBottom = node.absoluteBoundingBox.y + node.absoluteBoundingBox.height;
    const frameRight = node.absoluteBoundingBox.x + node.absoluteBoundingBox.width;

    for (const child of node.children ?? []) {
      if (!child.absoluteBoundingBox) continue;

      const childBottom = child.absoluteBoundingBox.y + child.absoluteBoundingBox.height;
      const childRight = child.absoluteBoundingBox.x + child.absoluteBoundingBox.width;

      if (childBottom > frameBottom + 1 || childRight > frameRight + 1) {
        issues.push({
          id: `scroll-${++counter}`,
          category: 'scroll',
          severity: 'medium',
          screenId,
          screenName,
          message: `"${node.name}" has content extending beyond frame bounds but scroll is not enabled.`,
          evidence: {
            frameName: node.name,
            frameHeight: node.absoluteBoundingBox.height,
            contentExtendsTo: Math.max(childBottom - node.absoluteBoundingBox.y, 0),
            overflowDirection: node.overflowDirection ?? 'NONE',
          },
        });
        return; // One issue per frame is enough
      }
    }
  }

  // Recurse into children (nested frames can also have scroll issues)
  for (const child of node.children ?? []) {
    if (child.type === 'FRAME') {
      checkScroll(child, screenId, screenName, issues);
    }
  }
}
