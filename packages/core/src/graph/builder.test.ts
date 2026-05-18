import { describe, it, expect } from 'vitest';
import { buildGraph } from './builder.js';
import type { FigmaFile } from '../types.js';

function makeFile(overrides: Partial<FigmaFile> = {}): FigmaFile {
  return {
    name: 'Test File',
    lastModified: '2026-01-01',
    version: '1',
    document: {
      id: '0:0',
      name: 'Document',
      type: 'DOCUMENT',
      children: [],
    },
    ...overrides,
  };
}

describe('buildGraph', () => {
  it('returns empty graph for file with no pages', () => {
    const graph = buildGraph(makeFile());
    expect(graph.nodes.size).toBe(0);
    expect(graph.edges.size).toBe(0);
    expect(graph.startingPoints).toEqual([]);
  });

  it('collects top-level frames as nodes', () => {
    const file = makeFile({
      document: {
        id: '0:0', name: 'Document', type: 'DOCUMENT',
        children: [{
          id: '1:0', name: 'Page 1', type: 'CANVAS',
          children: [
            { id: '2:0', name: 'Home', type: 'FRAME' },
            { id: '2:1', name: 'Settings', type: 'FRAME' },
          ],
        }],
      },
    });

    const graph = buildGraph(file);
    expect(graph.nodes.size).toBe(2);
    expect(graph.nodes.get('2:0')?.name).toBe('Home');
    expect(graph.nodes.get('2:1')?.name).toBe('Settings');
  });

  it('collects flow starting points', () => {
    const file = makeFile({
      document: {
        id: '0:0', name: 'Document', type: 'DOCUMENT',
        children: [{
          id: '1:0', name: 'Page 1', type: 'CANVAS',
          flowStartingPoints: [{ nodeId: '2:0', name: 'Main Flow' }],
          children: [
            { id: '2:0', name: 'Home', type: 'FRAME' },
          ],
        }],
      },
    });

    const graph = buildGraph(file);
    expect(graph.startingPoints).toEqual([{ nodeId: '2:0', name: 'Main Flow' }]);
  });

  it('builds edges from interactions', () => {
    const file = makeFile({
      document: {
        id: '0:0', name: 'Document', type: 'DOCUMENT',
        children: [{
          id: '1:0', name: 'Page 1', type: 'CANVAS',
          children: [
            {
              id: '2:0', name: 'Home', type: 'FRAME',
              children: [{
                id: '3:0', name: 'Button', type: 'RECTANGLE',
                interactions: [{
                  trigger: { type: 'ON_CLICK' },
                  actions: [{
                    type: 'NODE' as const,
                    destinationId: '2:1',
                    navigation: 'NAVIGATE' as const,
                  }],
                }],
              }],
            },
            { id: '2:1', name: 'Settings', type: 'FRAME' },
          ],
        }],
      },
    });

    const graph = buildGraph(file);
    const edges = graph.edges.get('2:0') ?? [];
    expect(edges.length).toBe(1);
    expect(edges[0].destinationId).toBe('2:1');
    expect(edges[0].navigation).toBe('NAVIGATE');
    expect(edges[0].trigger).toBe('ON_CLICK');
  });

  it('handles CONDITIONAL actions recursively', () => {
    const file = makeFile({
      document: {
        id: '0:0', name: 'Document', type: 'DOCUMENT',
        children: [{
          id: '1:0', name: 'Page 1', type: 'CANVAS',
          children: [
            {
              id: '2:0', name: 'Home', type: 'FRAME',
              interactions: [{
                trigger: { type: 'ON_CLICK' },
                actions: [{
                  type: 'CONDITIONAL' as const,
                  conditionalBlocks: [
                    {
                      condition: {},
                      actions: [{
                        type: 'NODE' as const,
                        destinationId: '2:1',
                        navigation: 'NAVIGATE' as const,
                      }],
                    },
                    {
                      condition: {},
                      actions: [{
                        type: 'NODE' as const,
                        destinationId: '2:2',
                        navigation: 'NAVIGATE' as const,
                      }],
                    },
                  ],
                }],
              }],
            },
            { id: '2:1', name: 'Page A', type: 'FRAME' },
            { id: '2:2', name: 'Page B', type: 'FRAME' },
          ],
        }],
      },
    });

    const graph = buildGraph(file);
    const edges = graph.edges.get('2:0') ?? [];
    expect(edges.length).toBe(2);
    expect(edges.map(e => e.destinationId).sort()).toEqual(['2:1', '2:2']);
  });

  it('handles COMPONENT_SET as screen type', () => {
    const file = makeFile({
      document: {
        id: '0:0', name: 'Document', type: 'DOCUMENT',
        children: [{
          id: '1:0', name: 'Page 1', type: 'CANVAS',
          children: [
            { id: '2:0', name: 'Button Variants', type: 'COMPONENT_SET' },
            { id: '2:1', name: 'Card', type: 'COMPONENT' },
          ],
        }],
      },
    });

    const graph = buildGraph(file);
    expect(graph.nodes.size).toBe(2);
    expect(graph.nodes.get('2:0')?.type).toBe('COMPONENT_SET');
    expect(graph.nodes.get('2:1')?.type).toBe('COMPONENT');
  });

  it('tracks hasBackAction and hasCloseAction on screens', () => {
    const file = makeFile({
      document: {
        id: '0:0', name: 'Document', type: 'DOCUMENT',
        children: [{
          id: '1:0', name: 'Page 1', type: 'CANVAS',
          children: [{
            id: '2:0', name: 'Screen', type: 'FRAME',
            children: [{
              id: '3:0', name: 'Back Btn', type: 'RECTANGLE',
              interactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'BACK' as const }] }],
            }],
          }],
        }],
      },
    });

    const graph = buildGraph(file);
    expect(graph.nodes.get('2:0')?.hasBackAction).toBe(true);
    expect(graph.nodes.get('2:0')?.hasCloseAction).toBe(false);
  });
});
