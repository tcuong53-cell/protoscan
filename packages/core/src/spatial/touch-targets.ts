import type { AnalyzerOptions, FigmaFile, FigmaNode, Issue } from '../types.js';

let counter = 0;

export const touchTargetAnalyzer = {
  name: 'touch-targets',

  async analyze(file: FigmaFile, options: AnalyzerOptions): Promise<Issue[]> {
    const minSize = options.minTouchTarget ?? 44;
    if (minSize === 0) return [];

    const issues: Issue[] = [];
    counter = 0;

    for (const page of file.document.children ?? []) {
      for (const frame of page.children ?? []) {
        if (frame.type === 'FRAME' || frame.type === 'COMPONENT' || frame.type === 'COMPONENT_SET') {
          walkForTouchTargets(frame, frame.id, frame.name, minSize, issues);
        }
      }
    }

    return issues;
  },
};

function walkForTouchTargets(
  node: FigmaNode,
  screenId: string,
  screenName: string,
  minSize: number,
  issues: Issue[],
): void {
  if (node.interactions?.length && node.absoluteBoundingBox) {
    const { width, height } = node.absoluteBoundingBox;
    if (width < minSize || height < minSize) {
      issues.push({
        id: `touch-target-${++counter}`,
        category: 'touch-target',
        severity: 'high',
        screenId,
        screenName,
        nodeId: node.id,
        message: `"${node.name}" is ${width}x${height}px (minimum: ${minSize}x${minSize}px).`,
        evidence: { width, height, minSize, nodeName: node.name },
      });
    }
  }

  for (const child of node.children ?? []) {
    walkForTouchTargets(child, screenId, screenName, minSize, issues);
  }
}
