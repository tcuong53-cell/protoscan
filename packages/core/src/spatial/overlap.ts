import type { AnalyzerOptions, BoundingBox, FigmaFile, FigmaNode, Issue } from '../types.js';
import { isNonPrototypeFrame } from '../utils/filters.js';

let counter = 0;

export const overlapAnalyzer = {
  name: 'overlap',

  async analyze(file: FigmaFile, _options: AnalyzerOptions): Promise<Issue[]> {
    const issues: Issue[] = [];
    counter = 0;

    for (const page of file.document.children ?? []) {
      for (const frame of page.children ?? []) {
        if (
          (frame.type === 'FRAME' || frame.type === 'COMPONENT' || frame.type === 'COMPONENT_SET') &&
          !isNonPrototypeFrame(frame.name)
        ) {
          checkOverlaps(frame, frame.id, frame.name, issues);
        }
      }
    }

    return issues;
  },
};

function checkOverlaps(
  parent: FigmaNode,
  screenId: string,
  screenName: string,
  issues: Issue[],
): void {
  // Collect interactive children at this level
  const interactive: FigmaNode[] = [];
  for (const child of parent.children ?? []) {
    if (child.interactions?.length && child.absoluteBoundingBox) {
      interactive.push(child);
    }
    // Recurse into children
    checkOverlaps(child, screenId, screenName, issues);
  }

  // Check all pairs of interactive siblings for overlap
  for (let i = 0; i < interactive.length; i++) {
    for (let j = i + 1; j < interactive.length; j++) {
      const a = interactive[i].absoluteBoundingBox!;
      const b = interactive[j].absoluteBoundingBox!;
      const area = intersectionArea(a, b);

      if (area > 0) {
        issues.push({
          id: `overlap-${++counter}`,
          category: 'overlap',
          severity: 'medium',
          confidence: 'certain',
          screenId,
          screenName,
          message: `"${interactive[i].name}" and "${interactive[j].name}" overlap (${Math.round(area)}px² intersection).`,
          evidence: {
            nodeA: interactive[i].name,
            nodeB: interactive[j].name,
            overlapArea: Math.round(area),
          },
        });
      }
    }
  }
}

function intersectionArea(a: BoundingBox, b: BoundingBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);

  const width = x2 - x1;
  const height = y2 - y1;

  if (width <= 0 || height <= 0) return 0;
  return width * height;
}
