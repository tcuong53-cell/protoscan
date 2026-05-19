import { describe, it, expect } from 'vitest';
import { touchTargetAnalyzer } from './touch-targets.js';
import { overlapAnalyzer } from './overlap.js';
import { scrollAnalyzer } from './scroll.js';
import { overlayTrapAnalyzer } from './overlay-traps.js';
import type { FigmaFile } from '../types.js';

function makeFile(pages: FigmaFile['document']['children']): FigmaFile {
  return {
    name: 'Test', lastModified: '2026-01-01', version: '1',
    document: { id: '0:0', name: 'Document', type: 'DOCUMENT', children: pages },
  };
}

// ─── Touch Targets ───

describe('touch-targets', () => {
  it('flags interactive elements smaller than 44px', async () => {
    const file = makeFile([{
      id: '1:0', name: 'Page', type: 'CANVAS',
      children: [{
        id: '2:0', name: 'Home', type: 'FRAME',
        children: [{
          id: '3:0', name: 'Tiny Button', type: 'RECTANGLE',
          absoluteBoundingBox: { x: 0, y: 0, width: 30, height: 28 },
          interactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE' as const, destinationId: '2:1', navigation: 'NAVIGATE' as const }] }],
        }],
      }],
    }]);

    const issues = await touchTargetAnalyzer.analyze(file, {});
    expect(issues.length).toBe(1);
    expect(issues[0].category).toBe('touch-target');
    expect(issues[0].message).toContain('30x28px');
  });

  it('does not flag elements >= 44px', async () => {
    const file = makeFile([{
      id: '1:0', name: 'Page', type: 'CANVAS',
      children: [{
        id: '2:0', name: 'Home', type: 'FRAME',
        children: [{
          id: '3:0', name: 'Big Button', type: 'RECTANGLE',
          absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 48 },
          interactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE' as const, destinationId: '2:1', navigation: 'NAVIGATE' as const }] }],
        }],
      }],
    }]);

    const issues = await touchTargetAnalyzer.analyze(file, {});
    expect(issues.length).toBe(0);
  });

  it('respects custom min size', async () => {
    const file = makeFile([{
      id: '1:0', name: 'Page', type: 'CANVAS',
      children: [{
        id: '2:0', name: 'Home', type: 'FRAME',
        children: [{
          id: '3:0', name: 'Medium Button', type: 'RECTANGLE',
          absoluteBoundingBox: { x: 0, y: 0, width: 40, height: 40 },
          interactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE' as const, destinationId: '2:1', navigation: 'NAVIGATE' as const }] }],
        }],
      }],
    }]);

    // Default 44px — should flag
    expect((await touchTargetAnalyzer.analyze(file, {})).length).toBe(1);
    // Custom 36px — should not flag
    expect((await touchTargetAnalyzer.analyze(file, { minTouchTarget: 36 })).length).toBe(0);
  });
});

// ─── Overlaps ───

describe('overlap', () => {
  it('flags overlapping interactive siblings', async () => {
    const file = makeFile([{
      id: '1:0', name: 'Page', type: 'CANVAS',
      children: [{
        id: '2:0', name: 'Home', type: 'FRAME',
        children: [
          {
            id: '3:0', name: 'Button A', type: 'RECTANGLE',
            absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 50 },
            interactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE' as const, destinationId: '2:1', navigation: 'NAVIGATE' as const }] }],
          },
          {
            id: '3:1', name: 'Button B', type: 'RECTANGLE',
            absoluteBoundingBox: { x: 80, y: 10, width: 100, height: 50 },
            interactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE' as const, destinationId: '2:2', navigation: 'NAVIGATE' as const }] }],
          },
        ],
      }],
    }]);

    const issues = await overlapAnalyzer.analyze(file, {});
    expect(issues.length).toBe(1);
    expect(issues[0].category).toBe('overlap');
    expect(issues[0].message).toContain('Button A');
    expect(issues[0].message).toContain('Button B');
  });

  it('does not flag non-overlapping siblings', async () => {
    const file = makeFile([{
      id: '1:0', name: 'Page', type: 'CANVAS',
      children: [{
        id: '2:0', name: 'Home', type: 'FRAME',
        children: [
          {
            id: '3:0', name: 'Button A', type: 'RECTANGLE',
            absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 50 },
            interactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE' as const, destinationId: '2:1', navigation: 'NAVIGATE' as const }] }],
          },
          {
            id: '3:1', name: 'Button B', type: 'RECTANGLE',
            absoluteBoundingBox: { x: 200, y: 0, width: 100, height: 50 },
            interactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE' as const, destinationId: '2:2', navigation: 'NAVIGATE' as const }] }],
          },
        ],
      }],
    }]);

    const issues = await overlapAnalyzer.analyze(file, {});
    expect(issues.length).toBe(0);
  });
});

// ─── Scroll ───

describe('scroll', () => {
  it('flags frames with clipped content and no scroll', async () => {
    const file = makeFile([{
      id: '1:0', name: 'Page', type: 'CANVAS',
      children: [{
        id: '2:0', name: 'Product Page', type: 'FRAME',
        absoluteBoundingBox: { x: 0, y: 0, width: 375, height: 812 },
        clipsContent: true,
        overflowDirection: 'NONE' as const,
        children: [{
          id: '3:0', name: 'Long Content', type: 'RECTANGLE',
          absoluteBoundingBox: { x: 0, y: 0, width: 375, height: 1400 },
        }],
      }],
    }]);

    const issues = await scrollAnalyzer.analyze(file, {});
    expect(issues.length).toBe(1);
    expect(issues[0].category).toBe('scroll');
    expect(issues[0].screenName).toBe('Product Page');
  });

  it('does not flag when scroll is enabled', async () => {
    const file = makeFile([{
      id: '1:0', name: 'Page', type: 'CANVAS',
      children: [{
        id: '2:0', name: 'Product Page', type: 'FRAME',
        absoluteBoundingBox: { x: 0, y: 0, width: 375, height: 812 },
        clipsContent: true,
        overflowDirection: 'VERTICAL_SCROLLING' as const,
        children: [{
          id: '3:0', name: 'Long Content', type: 'RECTANGLE',
          absoluteBoundingBox: { x: 0, y: 0, width: 375, height: 1400 },
        }],
      }],
    }]);

    const issues = await scrollAnalyzer.analyze(file, {});
    expect(issues.length).toBe(0);
  });
});

// ─── Touch Targets (edge cases) ───

describe('touch-targets edge cases', () => {
  it('skips non-interactive elements', async () => {
    const file = makeFile([{
      id: '1:0', name: 'Page', type: 'CANVAS',
      children: [{
        id: '2:0', name: 'Home', type: 'FRAME',
        children: [{
          id: '3:0', name: 'Label', type: 'TEXT',
          absoluteBoundingBox: { x: 0, y: 0, width: 20, height: 12 },
          // no interactions
        }],
      }],
    }]);

    const issues = await touchTargetAnalyzer.analyze(file, {});
    expect(issues.length).toBe(0);
  });

  it('disabled when minTouchTarget is 0', async () => {
    const file = makeFile([{
      id: '1:0', name: 'Page', type: 'CANVAS',
      children: [{
        id: '2:0', name: 'Home', type: 'FRAME',
        children: [{
          id: '3:0', name: 'Tiny', type: 'RECTANGLE',
          absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
          interactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE' as const, destinationId: '2:1', navigation: 'NAVIGATE' as const }] }],
        }],
      }],
    }]);

    const issues = await touchTargetAnalyzer.analyze(file, { minTouchTarget: 0 });
    expect(issues.length).toBe(0);
  });
});

// ─── Scroll (edge cases) ───

describe('scroll edge cases', () => {
  it('does not flag when content fits within frame', async () => {
    const file = makeFile([{
      id: '1:0', name: 'Page', type: 'CANVAS',
      children: [{
        id: '2:0', name: 'Short Page', type: 'FRAME',
        absoluteBoundingBox: { x: 0, y: 0, width: 375, height: 812 },
        clipsContent: true,
        overflowDirection: 'NONE' as const,
        children: [{
          id: '3:0', name: 'Short Content', type: 'RECTANGLE',
          absoluteBoundingBox: { x: 0, y: 0, width: 375, height: 400 },
        }],
      }],
    }]);

    const issues = await scrollAnalyzer.analyze(file, {});
    expect(issues.length).toBe(0);
  });

  it('does not flag when clipsContent is false', async () => {
    const file = makeFile([{
      id: '1:0', name: 'Page', type: 'CANVAS',
      children: [{
        id: '2:0', name: 'Open Frame', type: 'FRAME',
        absoluteBoundingBox: { x: 0, y: 0, width: 375, height: 812 },
        clipsContent: false,
        overflowDirection: 'NONE' as const,
        children: [{
          id: '3:0', name: 'Long Content', type: 'RECTANGLE',
          absoluteBoundingBox: { x: 0, y: 0, width: 375, height: 1400 },
        }],
      }],
    }]);

    const issues = await scrollAnalyzer.analyze(file, {});
    expect(issues.length).toBe(0);
  });
});

// ─── Overlay Traps ───

describe('overlay-traps', () => {
  it('flags overlays without CLOSE or BACK', async () => {
    const file = makeFile([{
      id: '1:0', name: 'Page', type: 'CANVAS',
      flowStartingPoints: [{ nodeId: '2:0', name: 'Flow' }],
      children: [
        {
          id: '2:0', name: 'Home', type: 'FRAME',
          children: [{
            id: '3:0', name: 'Open Modal', type: 'RECTANGLE',
            interactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE' as const, destinationId: '2:1', navigation: 'OVERLAY' as const }] }],
          }],
        },
        {
          id: '2:1', name: 'Trapped Modal', type: 'FRAME',
          children: [
            { id: '3:1', name: 'Some Text', type: 'TEXT' },
          ],
        },
      ],
    }]);

    const issues = await overlayTrapAnalyzer.analyze(file, {});
    expect(issues.length).toBe(1);
    expect(issues[0].category).toBe('overlay-trap');
    expect(issues[0].severity).toBe('critical');
    expect(issues[0].screenName).toBe('Trapped Modal');
  });

  it('does not flag overlays with CLOSE action', async () => {
    const file = makeFile([{
      id: '1:0', name: 'Page', type: 'CANVAS',
      flowStartingPoints: [{ nodeId: '2:0', name: 'Flow' }],
      children: [
        {
          id: '2:0', name: 'Home', type: 'FRAME',
          children: [{
            id: '3:0', name: 'Open Modal', type: 'RECTANGLE',
            interactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE' as const, destinationId: '2:1', navigation: 'OVERLAY' as const }] }],
          }],
        },
        {
          id: '2:1', name: 'Good Modal', type: 'FRAME',
          children: [{
            id: '3:1', name: 'Close Button', type: 'RECTANGLE',
            interactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'CLOSE' as const }] }],
          }],
        },
      ],
    }]);

    const issues = await overlayTrapAnalyzer.analyze(file, {});
    expect(issues.length).toBe(0);
  });

  it('does not flag overlays with BACK action', async () => {
    const file = makeFile([{
      id: '1:0', name: 'Page', type: 'CANVAS',
      flowStartingPoints: [{ nodeId: '2:0', name: 'Flow' }],
      children: [
        {
          id: '2:0', name: 'Home', type: 'FRAME',
          children: [{
            id: '3:0', name: 'Open Modal', type: 'RECTANGLE',
            interactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE' as const, destinationId: '2:1', navigation: 'OVERLAY' as const }] }],
          }],
        },
        {
          id: '2:1', name: 'Modal with Back', type: 'FRAME',
          children: [{
            id: '3:1', name: 'Back Btn', type: 'RECTANGLE',
            interactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'BACK' as const }] }],
          }],
        },
      ],
    }]);

    const issues = await overlayTrapAnalyzer.analyze(file, {});
    expect(issues.length).toBe(0);
  });

  it('does not flag overlays with CLOSE inside CONDITIONAL (audit fix #3)', async () => {
    const file = makeFile([{
      id: '1:0', name: 'Page', type: 'CANVAS',
      flowStartingPoints: [{ nodeId: '2:0', name: 'Flow' }],
      children: [
        {
          id: '2:0', name: 'Home', type: 'FRAME',
          children: [{
            id: '3:0', name: 'Open Modal', type: 'RECTANGLE',
            interactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE' as const, destinationId: '2:1', navigation: 'OVERLAY' as const }] }],
          }],
        },
        {
          id: '2:1', name: 'Conditional Modal', type: 'FRAME',
          children: [{
            id: '3:1', name: 'Smart Close', type: 'RECTANGLE',
            interactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{
              type: 'CONDITIONAL' as const,
              conditionalBlocks: [{
                condition: {},
                actions: [{ type: 'CLOSE' as const }],
              }],
            }] }],
          }],
        },
      ],
    }]);

    const issues = await overlayTrapAnalyzer.analyze(file, {});
    expect(issues.length).toBe(0);
  });
});
